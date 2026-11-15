import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { GatewayError, type App, type GatewayOptions, type ProviderResolver } from './types.js';

const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function clean(headers: IncomingHttpHeaders, upgrade = false): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionHeaders = String(result.connection ?? '').split(',').map(s => s.trim().toLowerCase());
  for (const key of [...hop, ...connectionHeaders]) {
    if (upgrade && (key === 'connection' || key === 'upgrade')) continue;
    delete result[key];
  }
  return result;
}
function route(raw: string): { app: App; path: string } {
  const match = raw.match(/^\/(codex|claude)(\/[^#]*)$/);
  if (!match) throw new GatewayError('route_not_found', 404);
  const app = match[1] as App;
  const path = match[2]!;
  if (app === 'codex' && !/^\/v1(?:\/|\?|$)/.test(path)) throw new GatewayError('route_not_found', 404);
  return { app, path };
}
/** Append without URL normalization: preserve escaped paths, query strings and trailing slashes. */
export function targetUrl(baseUrl: string, path: string, app: App = 'codex'): URL {
  const base = new URL(baseUrl);
  const suffix = base.pathname.replace(/\/$/, '');
  const relative = path.replace(/^\/v1(?=\/|\?|$)/, '');
  // Codex base_url is the API root (often /v1, but sometimes /backend-api/codex
  // or just /). Claude ANTHROPIC_BASE_URL is the origin/prefix before /v1.
  // Match each SDK's semantics rather than guessing from the provider's path.
  const finalPath = suffix + (app === 'codex' ? relative || '/' : path);
  const q = finalPath.indexOf('?');
  base.pathname = q < 0 ? finalPath : finalPath.slice(0, q);
  base.search = q < 0 ? '' : finalPath.slice(q);
  return base;
}
function errorBody(code: string): string { return JSON.stringify({ error: { type: 'gateway_error', code, message: code } }); }
function fail(response: ServerResponse, code: string, status: number): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(errorBody(code));
}
function socketFail(socket: Duplex, status: number, code: string): void {
  if (socket.destroyed) return;
  const body = errorBody(code);
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
function writeHead(socket: Duplex, response: IncomingMessage, upgrade: boolean): void {
  const headers = clean(response.headers, upgrade);
  const lines = [`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) for (const item of Array.isArray(value) ? value : [String(value)]) lines.push(`${key}: ${item}`);
  }
  socket.write(lines.join('\r\n') + '\r\n\r\n');
}

/** Embeddable lifecycle. Resolver ownership remains with the caller. */
export function createGateway(resolver: ProviderResolver, options: GatewayOptions) {
  const sockets = new Set<Duplex>();
  const agents = options.proxyUrl ? {
    http: new HttpProxyAgent(options.proxyUrl), https: new HttpsProxyAgent(options.proxyUrl),
  } : undefined;
  const server = http.createServer();
  server.requestTimeout = 0; // Long uploads/streams are valid AI API traffic.
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  function prepare(request: IncomingMessage, upgrade: boolean) {
    const { app, path } = route(request.url ?? '/');
    const provider = resolver.resolve(app, options.selections[app]);
    const target = targetUrl(provider.baseUrl, path, app);
    const headers = clean(request.headers, upgrade);
    for (const key of ['host', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie']) delete headers[key];
    Object.assign(headers, provider.headers);
    headers.host = target.host;
    // Prevent default Python clients being treated differently by some upstream WAFs.
    if (!headers['user-agent']) headers['user-agent'] = 'cc-switch-ai-gateway/0.1';
    if (app === 'claude' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(target, {
      method: request.method,
      headers,
      agent: agents ? (target.protocol === 'https:' ? agents.https : agents.http) : undefined,
    });
    const timer = setTimeout(() => upstream.destroy(new Error('header_timeout')), options.headerTimeoutMs);
    const clear = () => clearTimeout(timer);
    upstream.once('response', clear);
    upstream.once('upgrade', clear);
    upstream.once('close', clear);
    return { app, upstream };
  }

  server.on('request', (request, response) => {
    if (stopping) { fail(response, 'gateway_stopping', 503); return; }
    if (request.url === '/health' && request.method === 'GET') {
      const status: Record<string, unknown> = {};
      let ready = true;
      for (const app of ['codex', 'claude'] as const) {
        try {
          const provider = resolver.resolve(app, options.selections[app]);
          status[app] = { ready: true, provider: provider.name, mode: options.selections[app].mode };
        } catch { status[app] = { ready: false }; ready = false; }
      }
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'degraded', routes: status }));
      return;
    }
    const start = Date.now();
    try {
      const { app, upstream } = prepare(request, false);
      upstream.on('response', remote => {
        response.writeHead(remote.statusCode ?? 502, clean(remote.headers));
        response.flushHeaders();
        // Do not decompress, parse SSE, buffer, or rewrite upstream data.
        pipeline(remote, response, () => {});
      });
      upstream.on('error', () => fail(response, 'upstream_connection_failed', 502));
      request.on('aborted', () => upstream.destroy());
      request.on('error', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      response.on('finish', () => options.log?.({ event: 'request', app, status: response.statusCode, durationMs: Date.now() - start }));
      request.pipe(upstream);
    } catch (error) {
      const safe = error instanceof GatewayError ? error : new GatewayError('gateway_request_failed', 502);
      fail(response, safe.code, safe.status);
    }
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (stopping) { socketFail(socket, 503, 'gateway_stopping'); return; }
    if (String(request.headers.upgrade).toLowerCase() !== 'websocket') { socketFail(socket, 400, 'unsupported_upgrade'); return; }
    try {
      const { app, upstream } = prepare(request, true);
      let remoteSocket: Duplex | undefined;
      upstream.on('upgrade', (response, remote, remoteHead) => {
        remoteSocket = remote;
        remote.on('error', () => { remote.destroy(); socket.destroy(); });
        remote.on('close', () => socket.destroy());
        writeHead(socket, response, true);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
        options.log?.({ event: 'upgrade', app, status: 101 });
      });
      upstream.on('response', response => {
        // Preserve non-101 rejection body; use close-delimited framing on this raw socket.
        writeHead(socket, response, false);
        response.on('error', () => socket.destroy());
        response.pipe(socket);
      });
      upstream.on('error', () => {
        if (remoteSocket) socket.destroy(); else socketFail(socket, 502, 'upstream_connection_failed');
      });
      socket.on('close', () => { upstream.destroy(); remoteSocket?.destroy(); });
      upstream.end();
    } catch (error) {
      const safe = error instanceof GatewayError ? error : new GatewayError('gateway_request_failed', 502);
      socketFail(socket, safe.status, safe.code);
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socketFail(socket, 400, 'invalid_http_request'));
  return {
    server,
    async start(): Promise<{ host: string; port: number }> {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.host);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new GatewayError('listen_failed');
      return { host: options.host, port: address.port };
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, options.shutdownGraceMs);
        server.close(() => { clearTimeout(timer); agents?.http.destroy(); agents?.https.destroy(); resolve(); });
        server.closeIdleConnections();
      });
      return stopPromise;
    },
  };
}
