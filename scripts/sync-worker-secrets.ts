/** Upload current credentials via stdin. Never print or persist secret values. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CCSwitchResolver } from '../src/cc-switch.js';

try {
  const sharedKey = process.env.GATEWAY_SHARED_API_KEY;
  if (!sharedKey || /\s/.test(sharedKey)) throw new Error();
  const resolver = new CCSwitchResolver(process.env.CC_SWITCH_DIR ?? join(homedir(), '.cc-switch'));
  const secrets: Record<string, string> = { SHARED_API_KEY: sharedKey };
  try {
    const config = JSON.parse(readFileSync(new URL('../worker/wrangler.jsonc', import.meta.url), 'utf8'));
    for (const app of ['codex', 'claude'] as const) {
      const provider = resolver.resolve(app, { mode: 'follow' });
      const prefix = app.toUpperCase();
      if (config.vars[`${prefix}_BASE_URL`].replace(/\/$/, '') !== provider.baseUrl.replace(/\/$/, '')) throw new Error();
      if (!(provider.headers.authorization || (app === 'claude' && provider.headers['x-api-key']))) throw new Error();
      secrets[`${prefix}_UPSTREAM_HEADERS`] = JSON.stringify(provider.headers);
    }
  } finally { resolver.close(); }
  const cwd = fileURLToPath(new URL('../worker/', import.meta.url));
  const { GATEWAY_SHARED_API_KEY: _shared, ...childEnv } = process.env;
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'bulk'], {
    cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Wrangler output is intentionally discarded: only publish the exit status.
  child.stdout.resume(); child.stderr.resume();
  child.stdin.on('error', () => {});
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  });
  child.stdin.end(JSON.stringify(secrets));
  if (await completed !== 0) throw new Error();
  console.log(JSON.stringify({ check: 'sync_worker_secrets', passed: true, uploaded: Object.keys(secrets), credentials_written_to_files: false }));
} catch {
  console.error(JSON.stringify({ check: 'sync_worker_secrets', passed: false, error: 'verify_shared_key_cloudflare_login_and_matching_upstreams' }));
  process.exitCode = 1;
}
