import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GatewayOptions, Selection } from './types.js';
import { GatewayError } from './types.js';

function number(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new GatewayError('invalid_numeric_configuration');
  return result;
}
function selection(value?: string): Selection {
  return !value || value === 'follow' ? { mode: 'follow' } : { mode: 'fixed', id: value };
}
export function proxyUrl(mode: string): string | undefined {
  if (mode === 'direct') return undefined;
  if (mode === 'system') {
    const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (env) return proxyUrl(env);
    if (process.platform !== 'darwin') return undefined;
    let settings: string;
    try { settings = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 }); }
    catch { throw new GatewayError('system_proxy_unavailable'); }
    const enabled = settings.match(/^\s*HTTPSEnable\s*:\s*(\d+)/m)?.[1];
    if (enabled !== '1') return undefined;
    const host = settings.match(/^\s*HTTPSProxy\s*:\s*(\S+)/m)?.[1];
    const port = settings.match(/^\s*HTTPSPort\s*:\s*(\d+)/m)?.[1];
    if (!host || !port) throw new GatewayError('invalid_system_proxy');
    return proxyUrl(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
  try {
    const url = new URL(mode);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch { throw new GatewayError('invalid_upstream_proxy'); }
}
export function loadConfig(): { directory: string; options: GatewayOptions } {
  return {
    directory: process.env.CC_SWITCH_DIR ?? join(homedir(), '.cc-switch'),
    options: {
      host: process.env.HOST ?? '0.0.0.0',
      port: number(process.env.PORT, 8787, 1, 65535),
      selections: { codex: selection(process.env.CODEX_PROVIDER), claude: selection(process.env.CLAUDE_PROVIDER) },
      proxyUrl: proxyUrl(process.env.UPSTREAM_PROXY ?? 'system'),
      headerTimeoutMs: number(process.env.UPSTREAM_HEADER_TIMEOUT_MS, 120000, 1, 3600000),
      shutdownGraceMs: number(process.env.SHUTDOWN_GRACE_MS, 10000, 0, 300000),
      log: process.env.LOG_LEVEL === 'silent' ? undefined : record => process.stdout.write(`${JSON.stringify(record)}\n`),
    },
  };
}
