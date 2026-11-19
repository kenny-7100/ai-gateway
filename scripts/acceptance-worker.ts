/** Real Worker acceptance. Credentials stay in memory; output contains only safe summaries. */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { parse } from 'smol-toml';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { createInterface } from 'node:readline';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CCSwitchResolver } from '../src/cc-switch.js';
import { proxyUrl } from '../src/config.js';
import type { App } from '../src/types.js';

const args = process.argv.slice(2);
const prepare = args.includes('--prepare');
const shared = args.includes('--shared');
const sharedKey = process.env.GATEWAY_SHARED_API_KEY;
const apps: App[] = args.includes('--all') ? ['codex', 'claude'] : ['codex'];
const directory = process.env.CC_SWITCH_DIR ?? join(homedir(), '.cc-switch');
const configPath = new URL('../worker/wrangler.jsonc', import.meta.url);
const secrets: string[] = [];
function report(value: Record<string, unknown>) {
  let text = JSON.stringify(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  process.stdout.write(text + '\n');
}

let failed = false;
try {
  if (shared && !sharedKey) throw new Error('shared key required');
  if (sharedKey) secrets.push(sharedKey);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const resolver = new CCSwitchResolver(directory);
  const db = new Database(join(directory, 'cc-switch.db'), { readonly: true, fileMustExist: true });
  const selected = [];
  try {
    for (const app of apps) {
      const provider = resolver.resolve(app, { mode: 'follow' });
      secrets.push(...Object.values(provider.headers));
      for (const value of Object.values(provider.headers)) secrets.push(value.replace(/^Bearer\s+/i, ''));
      const row = db.prepare('SELECT settings_config FROM providers WHERE app_type = ? AND id = ?').get(app, provider.id) as { settings_config: string };
      const settings = JSON.parse(row.settings_config);
      const model = app === 'codex'
        ? (parse(settings.config) as Record<string, unknown>).model
        : settings.env?.ANTHROPIC_MODEL;
      if (typeof model !== 'string' || !model) throw new Error('configured model missing');
      const variable = app === 'codex' ? 'CODEX_BASE_URL' : 'CLAUDE_BASE_URL';
      const url = new URL(provider.baseUrl);
      if (url.protocol !== 'https:') throw new Error('HTTPS upstream required');
      if (prepare) config.vars[variable] = provider.baseUrl;
      const matches = config.vars[variable].replace(/\/$/, '') === provider.baseUrl.replace(/\/$/, '');
      report({ check: 'provider_configuration', app, model, upstream_host: url.hostname, upstream_matches: matches });
      if (!matches) throw new Error('upstream mismatch; prepare and redeploy first');
      selected.push({ app, model, headers: provider.headers });
    }
  } finally { db.close(); resolver.close(); }
  if (prepare) {
    // Persist URLs only, never credentials or the source settings_config.
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    report({ check: 'prepare', passed: true, credentials_written: false, deployment_required: true });
  } else {
    const proxy = proxyUrl(process.env.UPSTREAM_PROXY ?? 'system');
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    try {
      for (const { app, model, headers } of selected) {
        for (const mode of ['models', 'generate', 'stream']) {
          const start = Date.now();
          const result: Record<string, unknown> = { check: mode, app, model };
          try {
            const streaming = mode === 'stream';
            const payload = mode === 'models' ? undefined : app === 'codex'
              ? { model, input: 'Reply with exactly OK.', stream: streaming }
              : { model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], stream: streaming };
            const path = mode === 'models' ? 'models' : app === 'codex' ? 'responses' : 'messages';
            const url = `https://docs.jimao.uk/${app}/v1/${path}`;
            const body = payload === undefined ? undefined : JSON.stringify(payload);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 180000);
            try {
              const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
                const request = https.request(url, {
                  method: body ? 'POST' : 'GET', agent, signal: controller.signal,
                  headers: { ...(shared ? app === 'codex' ? { authorization: `Bearer ${sharedKey}` } : { 'x-api-key': sharedKey! } : headers), 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
                }, resolve);
                request.on('error', reject);
                request.end(body);
              });
              result.http_status = response.statusCode;
              if (response.statusCode !== 200) {
                response.resume();
                result.passed = false;
              } else if (streaming) {
                let completed = false;
                let error = false;
                let text = '';
                let events = 0;
                for await (const line of createInterface({ input: response, crlfDelay: Infinity })) {
                  if (!line.startsWith('data:')) continue;
                  const raw = line.slice(5).trim();
                  if (!raw || raw === '[DONE]') continue;
                  const event = JSON.parse(raw);
                  if (events++ === 0) result.first_event_ms = Date.now() - start;
                  completed ||= ['response.completed', 'message_stop'].includes(event.type);
                  error ||= ['error', 'response.failed', 'response.incomplete'].includes(event.type);
                  if (event.type === 'response.output_text.delta') text += event.delta ?? '';
                  if (event.type === 'content_block_delta') text += event.delta?.text ?? '';
                }
                result.events = events;
                result.completed = completed;
                result.output_ok = text.trim() === 'OK';
                result.passed = completed && !error && result.output_ok;
              } else {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of response) {
                  size += chunk.length;
                  if (size > 4 * 1024 * 1024) { response.destroy(); throw new Error('response too large'); }
                  chunks.push(Buffer.from(chunk));
                }
                const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (mode === 'models') {
                  result.model_listed = Array.isArray(data.data) && data.data.some((item: { id?: string }) => item.id === model);
                  result.passed = result.model_listed;
                } else {
                  const text = app === 'codex'
                    ? (data.output ?? []).flatMap((item: { content?: { text?: string }[] }) => item.content ?? []).map((item: { text?: string }) => item.text ?? '').join('')
                    : (data.content ?? []).map((item: { text?: string }) => item.text ?? '').join('');
                  result.completed = app === 'codex' ? data.status === 'completed' : data.type === 'message' && data.stop_reason === 'end_turn';
                  result.output_ok = text.trim() === 'OK';
                  result.passed = result.completed && result.output_ok;
                }
              }
            } finally { clearTimeout(timer); }
          } catch { result.passed = false; result.error = 'acceptance_request_failed'; }
          result.elapsed_ms = Date.now() - start;
          failed ||= result.passed !== true;
          report(result);
        }
      }
    } finally { agent?.destroy(); }
  }
} catch {
  report({ check: 'configuration', passed: false, error: 'check_current_provider_model_and_upstream_configuration' });
  failed = true;
}
process.exitCode = failed ? 1 : 0;
