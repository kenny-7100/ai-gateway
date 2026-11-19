/** Compare real error responses and WebSocket support without printing bodies/credentials. */
import 'dotenv/config';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CCSwitchResolver } from '../src/cc-switch.js';
import { proxyUrl } from '../src/config.js';

const report = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
let failed = false;
try {
  const resolver = new CCSwitchResolver(process.env.CC_SWITCH_DIR ?? join(homedir(), '.cc-switch'));
  const provider = resolver.resolve('codex', { mode: 'follow' }); resolver.close();
  const shared = process.env.GATEWAY_SHARED_API_KEY;
  if (!shared) throw new Error();
  const proxy = proxyUrl(process.env.UPSTREAM_PROXY ?? 'system');
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  const endpoints = [
    { target: 'direct', base: provider.baseUrl, headers: provider.headers },
    { target: 'worker', base: 'https://docs.jimao.uk/codex/v1', headers: { authorization: `Bearer ${shared}` } },
  ];
  try {
    for (const mode of ['invalid_model', 'invalid_key', 'missing_route']) {
      const results = [];
      for (const endpoint of endpoints) {
        const body = JSON.stringify({ model: 'parity-nonexistent-model-7b50d1', input: 'Reply OK.', stream: false });
        const path = mode === 'invalid_key' ? '/models' : mode === 'missing_route' ? '/parity-nonexistent-route-7b50d1' : '/responses';
        const response = await new Promise<{ status: number; body: string; contentType?: string; retryAfter?: string }>((resolve, reject) => {
          const request = https.request(endpoint.base.replace(/\/$/, '') + path, {
            method: mode === 'invalid_model' ? 'POST' : 'GET', agent,
            headers: { ...(mode === 'invalid_key' ? { authorization: 'Bearer parity-invalid-key' } : endpoint.headers), 'content-type': 'application/json' },
            signal: AbortSignal.timeout(60000),
          }, incoming => {
            let text = '';
            incoming.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) incoming.destroy(); });
            incoming.on('error', reject);
            incoming.on('end', () => resolve({ status: incoming.statusCode!, body: text, contentType: incoming.headers['content-type'], retryAfter: incoming.headers['retry-after'] }));
          });
          request.on('error', reject); request.end(mode === 'invalid_model' ? body : undefined);
        });
        results.push(response);
      }
      const [direct, worker] = results;
      // SudoCode may include request IDs in errors; compare stable error semantics.
      const stable = (body: string) => {
        try { const parsed = JSON.parse(body); return JSON.stringify({ type: parsed.error?.type, code: parsed.error?.code, message: parsed.error?.message?.replace(/\(request id:.*?\)/gi, '') }); }
        catch {
          // WAF HTML contains per-request Ray IDs, IPs and timestamps.
          const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
          return title ? JSON.stringify({ html_title: title }) : body;
        }
      };
      const passed = direct!.status >= 400 && direct!.status === worker!.status && stable(direct!.body) === stable(worker!.body);
      report({ check: mode, direct_status: direct!.status, worker_status: worker!.status, error_semantics_equal: stable(direct!.body) === stable(worker!.body), passed });
      failed ||= !passed;
    }
    const websocketResults = [];
    for (const endpoint of endpoints) {
      const result = await new Promise<{ status: number; upgraded: boolean }>((resolve, reject) => {
        const ws = new WebSocket(endpoint.base.replace(/^https:/, 'wss:').replace(/\/$/, '') + '/responses', {
          headers: { ...endpoint.headers, 'openai-beta': 'responses_websockets=2026-02-06' }, agent, handshakeTimeout: 20000,
        });
        ws.on('open', () => { ws.close(); resolve({ status: 101, upgraded: true }); });
        ws.on('unexpected-response', (_request, response) => {
          response.resume(); resolve({ status: response.statusCode!, upgraded: false }); ws.terminate();
        });
        ws.on('error', reject);
      });
      websocketResults.push(result);
      report({ check: 'websocket_handshake', target: endpoint.target, ...result });
    }
    const passed = websocketResults[0]!.status === websocketResults[1]!.status;
    report({ check: 'websocket_support_equivalent', passed, real_generation_verified: false });
    failed ||= !passed;
  } finally { agent?.destroy(); }
} catch { report({ check: 'transport', passed: false, error: 'acceptance_failed_no_sensitive_details' }); failed = true; }
process.exitCode = failed ? 1 : 0;
