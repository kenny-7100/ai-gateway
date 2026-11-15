import 'dotenv/config';
import { loadConfig } from './config.js';
import { CCSwitchResolver } from './cc-switch.js';
import { createGateway } from './gateway.js';

try {
  const { directory, options } = loadConfig();
  const resolver = new CCSwitchResolver(directory);
  const gateway = createGateway(resolver, options);
  try {
    const address = await gateway.start();
    process.stdout.write(`${JSON.stringify({ event: 'listening', ...address, proxy: options.proxyUrl ? 'configured' : 'direct' })}\n`);
  } catch { resolver.close(); throw new Error(); }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await gateway.stop();
    resolver.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.send?.({ event: 'ready' });
} catch {
  // No raw errors: third party libraries may put credentials/URLs in error messages.
  process.stderr.write('Gateway startup failed. Check port, proxy settings and CC Switch database availability.\n');
  process.exitCode = 1;
}
