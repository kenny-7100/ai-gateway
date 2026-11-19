/** Isolated real Codex differential acceptance. Never emit credentials/raw CLI output. */
import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { parse } from 'smol-toml';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CCSwitchResolver } from '../src/cc-switch.js';
import { proxyUrl } from '../src/config.js';

let failed = false;
const report = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
try {
  const directory = process.env.CC_SWITCH_DIR ?? join(homedir(), '.cc-switch');
  const resolver = new CCSwitchResolver(directory);
  const provider = resolver.resolve('codex', { mode: 'follow' }); resolver.close();
  const db = new Database(join(directory, 'cc-switch.db'), { readonly: true });
  const row = db.prepare("SELECT settings_config FROM providers WHERE app_type='codex' AND id=?").get(provider.id) as { settings_config: string };
  db.close();
  const model = (parse(JSON.parse(row.settings_config).config) as { model: string }).model;
  if (!model || !process.env.GATEWAY_SHARED_API_KEY) throw new Error();
  const proxy = proxyUrl(process.env.UPSTREAM_PROXY ?? 'system');
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  try {
    for (const target of ['direct', 'worker'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'codex-parity-'));
      const upstream = target === 'direct' ? provider.baseUrl : 'https://docs.jimao.uk/codex/v1';
      const credentials = target === 'direct' ? provider.headers : { authorization: `Bearer ${process.env.GATEWAY_SHARED_API_KEY}` };
      const observed: { path: string; model?: string; effort?: string; stream?: boolean; tools?: number; status?: number; cancelled?: boolean }[] = [];
      let cancelOnData = false;
      let activeChild: ReturnType<typeof spawn> | undefined;
      const server = http.createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        let parsed: any = {};
        try { parsed = JSON.parse(body.toString()); } catch {}
        const record = { path: (request.url ?? '').split('?')[0]!, model: parsed.model, effort: parsed.reasoning?.effort, stream: parsed.stream, tools: parsed.tools?.length, status: undefined as number | undefined, cancelled: false };
        observed.push(record);
        const headers = { ...request.headers, ...credentials };
        delete headers.host; delete headers.connection;
        const remote = https.request(upstream.replace(/\/$/, '') + request.url, { method: request.method, headers, agent }, incoming => {
          record.status = incoming.statusCode;
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.once('data', () => { if (cancelOnData) activeChild?.kill('SIGINT'); });
          incoming.pipe(response);
        });
        remote.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        response.on('close', () => { record.cancelled = !response.writableFinished; remote.destroy(); });
        remote.end(body);
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const port = (server.address() as import('node:net').AddressInfo).port;
      const config = `model_provider = "parity"\nmodel = ${JSON.stringify(model)}\nmodel_reasoning_effort = "medium"\n[model_providers.parity]\nname = "Parity"\nbase_url = "http://127.0.0.1:${port}"\nenv_key = "PARITY_CLIENT_KEY"\nwire_api = "responses"\n`;
      writeFileSync(join(root, 'config.toml'), config, { mode: 0o600 });
      writeFileSync(join(root, 'fixture.txt'), 'PARITY_TOOL_OK\n', { mode: 0o600 });
      async function run(name: string, prompt: string, resume?: string) {
        const before = observed.length;
        const started = Date.now();
        const argv = resume
          ? ['exec', 'resume', '--skip-git-repo-check', '--json', resume, prompt]
          : ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', root, '--json', prompt];
        if (name === 'reasoning_high') argv.splice(1, 0, '-c', 'model_reasoning_effort="high"');
        if (name === 'invalid_model') argv.splice(1, 0, '-m', 'parity-nonexistent-model-7b50d1', '-c', 'model_providers.parity.request_max_retries=0', '-c', 'model_providers.parity.stream_max_retries=0');
        const child = spawn(process.env.CODEX_BIN ?? 'codex', argv, {
          cwd: root, env: { ...process.env, CODEX_HOME: root, PARITY_CLIENT_KEY: 'observer-placeholder' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        activeChild = child;
        cancelOnData = name === 'cancel';
        let output = ''; let stderr = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => child.kill('SIGTERM'), 150000);
        const [code] = await once(child, 'exit'); clearTimeout(timer);
        const events: any[] = [];
        for (const line of output.split('\n')) { try { events.push(JSON.parse(line)); } catch {} }
        const items = events.filter(event => event.type === 'item.completed').map(event => event.item);
        // Codex emits commentary before tools; only the final message is the answer.
        const text = (items.filter(item => item.type === 'agent_message').at(-1)?.text ?? '').trim();
        const expected = name === 'multi_turn' ? 'PARITY_MEMORY_OK' : name === 'tools' ? 'PARITY_TOOL_OK' : 'OK';
        const toolUsed = items.some(item => ['command_execution', 'mcp_tool_call'].includes(item.type));
        if (name === 'cancel') await new Promise(resolve => setTimeout(resolve, 200));
        const records = observed.slice(before);
        const passed = name === 'cancel'
          ? records.some(record => record.status === 200 && record.cancelled) && !events.some(event => event.type === 'turn.completed')
          : name === 'invalid_model'
            ? code !== 0 && records.some(record => record.status === 400) && events.some(event => ['error', 'turn.failed'].includes(event.type))
            : code === 0 && events.some(event => event.type === 'turn.completed') && text === expected && (name !== 'tools' || toolUsed) && (name !== 'reasoning_high' || records.some(record => record.effort === 'high'));
        report({ target, check: name, passed, exit_code: code, completed: events.some(event => event.type === 'turn.completed'), output_ok: text === expected, tool_used: toolUsed, requests: records, elapsed_ms: Date.now() - started,
          error_events: events.filter(event => ['error', 'turn.failed'].includes(event.type)).length,
          tool_results: items.filter(item => item.type === 'command_execution').map(item => ({ status: item.status, exit_code: item.exit_code, fixture_read: (item.aggregated_output ?? '').includes('PARITY_TOOL_OK'), sandbox_error: /sandbox|operation not permitted/i.test(item.aggregated_output ?? '') })),
          stderr_present: !!stderr,
        });
        failed ||= !passed;
        return events.find(event => event.type === 'thread.started')?.thread_id as string | undefined;
      }
      try {
        if (!process.argv.includes('--only-tools')) {
          const thread = await run('basic', 'Remember this marker for the next turn: PARITY_MEMORY_OK. Reply with exactly OK. Do not call tools.');
          if (thread) await run('multi_turn', 'What marker did I ask you to remember? Reply with that marker only. Do not call tools.', thread);
          else failed = true;
        }
        await run('tools', 'Read fixture.txt in the current directory using a shell tool, then reply with its exact contents only. You must actually call the tool.');
        if (!process.argv.includes('--only-tools')) {
          await run('reasoning_high', 'Reply with exactly OK. Do not call tools.');
          await run('cancel', 'Output every integer from 1 to 10000, one per line. Do not call tools.');
          await run('invalid_model', 'Reply with exactly OK. Do not call tools.');
        }
      } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally { agent?.destroy(); }
} catch {
  report({ check: 'parity', passed: false, error: 'acceptance_failed_no_sensitive_details' }); failed = true;
}
process.exitCode = failed ? 1 : 0;
