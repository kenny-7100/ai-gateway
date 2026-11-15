import 'dotenv/config';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(root, '.runtime');
const pidFile = resolve(runtime, 'gateway.pid');
const entry = resolve(root, 'src/index.ts');
const command = process.argv[2];
function running() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 1) return undefined;
    // Check identity before sending any signal; never kill a reused, unrelated PID.
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return args.includes(entry) && args.includes('--import tsx') ? pid : undefined;
  } catch { return undefined; }
}
try {
  if (process.platform === 'win32') throw new Error();
  if (command === 'start') {
    if (running()) { console.log('Gateway is already running.'); }
    else {
      mkdirSync(runtime, { recursive: true, mode: 0o700 });
      const log = openSync(resolve(runtime, 'gateway.log'), 'a', 0o600);
      const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, detached: true, stdio: ['ignore', log, log, 'ipc'], env: process.env });
      closeSync(log);
      await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
      writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
      try {
        // Readiness belongs to this child, not to an unrelated process using the same port.
        await new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error()), 8000);
          child.once('exit', () => { clearTimeout(timer); rej(new Error()); });
          child.once('message', message => {
            clearTimeout(timer);
            if (message?.event === 'ready') res(); else rej(new Error());
          });
        });
      } catch {
        if (running()) process.kill(-child.pid, 'SIGTERM');
        try { unlinkSync(pidFile); } catch {}
        throw new Error();
      } finally {
        if (child.connected) child.disconnect();
        child.unref();
      }
      console.log('Gateway started. Logs: .runtime/gateway.log');
    }
  } else if (command === 'stop') {
    const pid = running();
    if (pid) {
      process.kill(-pid, 'SIGTERM');
      console.log('Gateway shutdown requested; active connections receive the configured grace period.');
    } else { console.log('Gateway is not running.'); }
    try { unlinkSync(pidFile); } catch {}
  } else if (command === 'status') {
    console.log(running() ? 'Gateway is running.' : 'Gateway is not running.');
  } else { console.error('Usage: node scripts/service.mjs start|stop|status'); process.exitCode = 1; }
} catch {
  console.error('Service operation failed. Check port, runtime directory and gateway configuration.');
  process.exitCode = 1;
}
