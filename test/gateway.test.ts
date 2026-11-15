import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import { createGateway, targetUrl } from '../src/gateway.js';
import { GatewayError, type ProviderResolver, type GatewayOptions } from '../src/types.js';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}
async function close(server: http.Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
const options: GatewayOptions = {
  host: '127.0.0.1', port: 0, selections: { codex: { mode: 'follow' }, claude: { mode: 'follow' } },
  headerTimeoutMs: 2000, shutdownGraceMs: 20,
};
async function fixture(handler: http.RequestListener, extra: Partial<GatewayOptions> = {}) {
  const upstream = http.createServer(handler); const port = await listen(upstream);
  const resolver: ProviderResolver = { resolve: app => ({ id: app, name: 'fixture', baseUrl: `http://127.0.0.1:${port}${app === 'codex' ? '/v1' : ''}`, headers: app === 'codex' ? { authorization: 'Bearer fixture-secret' } as Record<string, string> : { 'x-api-key': 'fixture-secret' } }) };
  const gateway = createGateway(resolver, { ...options, ...extra });
  const address = await gateway.start();
  return { upstream, gateway, base: `http://127.0.0.1:${address.port}`, cleanup: async () => { await gateway.stop(); await close(upstream); } };
}
function raw(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks: Buffer[] = [];response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('base path mapping keeps protocol paths and escaped query parameters', () => {
  assert.equal(targetUrl('https://example.com/v1/', '/v1/responses?a=%2F&b=1&b=2').href, 'https://example.com/v1/responses?a=%2F&b=1&b=2');
  assert.equal(targetUrl('https://example.com/backend-api/codex', '/v1/responses').pathname, '/backend-api/codex/responses');
  assert.equal(targetUrl('https://example.com', '/v1/responses').pathname, '/responses');
  assert.equal(targetUrl('https://example.com/anthropic', '/v1/messages', 'claude').pathname, '/anthropic/v1/messages');
});

test('request bytes, method, query, headers and real credential reach upstream; no key and dummy key work', async () => {
  const body = '{ "model":"test", "input":"你好", "tools": [{"type":"function"}] }';
  let count = 0;
  const f = await fixture(async (request, response) => {
    count++;
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses?x=%2F&x=2');
    assert.equal(request.headers.authorization, 'Bearer fixture-secret'); assert.equal(request.headers['x-api-key'], undefined);
    assert.equal(request.headers['x-private-hop'], undefined); assert.equal(request.headers['openai-beta'], 'responses=v1');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body);
    response.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'fixture-id' }); response.end('{"ok":true}');
  });
  try {
    for (const key of ['', '12345678']) {
      const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const request = http.request(`${f.base}/codex/v1/responses?x=%2F&x=2`, { method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-api-key': 'untrusted', connection: 'x-private-hop', 'x-private-hop': 'remove-me', 'openai-beta': 'responses=v1' } }, response => {
          let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: data }));
        }); request.on('error', reject); request.end(body);
      });
      assert.equal(result.status, 201); assert.equal(result.headers['x-request-id'], 'fixture-id'); assert.equal(result.body, '{"ok":true}');
    }
    assert.equal(count, 2);
  } finally { await f.cleanup(); }
});

test('Claude auth and beta/version headers are preserved correctly', async () => {
  const f = await fixture((request, response) => {
    assert.equal(request.url, '/v1/messages'); assert.equal(request.headers['x-api-key'], 'fixture-secret');
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers['anthropic-beta'], 'tools-2024-04-04');
    assert.equal(request.headers['anthropic-version'], '2023-06-01'); response.end('{}');
  });
  try {
    const result = await fetch(`${f.base}/claude/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer 12345678', 'anthropic-beta': 'tools-2024-04-04' }, body: '{}' });
    assert.equal(result.status, 200); await result.text();
  } finally { await f.cleanup(); }
});

test('SSE first event arrives before upstream completes, with bytes intact', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const first = 'event: response.output_text.delta\ndata: {"delta":"你好"}\n\n';
  const last = 'data: [DONE]\n\n';
  const f = await fixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(first);
    await gate; response.end(last);
  });
  try {
    const result = await fetch(`${f.base}/codex/v1/responses`);
    const reader = result.body!.getReader(); const chunk = await reader.read();
    assert.equal(Buffer.from(chunk.value!).toString(), first); finish();
    let text = ''; for (;;) { const item = await reader.read(); if (item.done) break; text += Buffer.from(item.value).toString(); }
    assert.equal(text, last);
  } finally { finish(); await f.cleanup(); }
});

test('compressed response and upstream error body are forwarded without decoding', async () => {
  const bytes = gzipSync('{"error":{"message":"fixture upstream failure"}}');
  const f = await fixture((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'retry-after': '3', 'content-length': bytes.length }); response.end(bytes);
  });
  try { const result = await raw(`${f.base}/codex/v1/responses`); assert.equal(result.status, 429); assert.equal(result.headers['retry-after'], '3'); assert.deepEqual(result.body, bytes); }
  finally { await f.cleanup(); }
});

test('WebSocket handshake, text and binary frames are transparently tunneled', async () => {
  const f = await fixture((_req, res) => { res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  f.upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/v1/responses?model=fixture'); assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    assert.equal(req.headers['openai-beta'], 'responses_websockets=2026-02-06');
    wss.handleUpgrade(req, socket, head, ws => { ws.on('message', (data, binary) => ws.send(data, { binary })); });
  });
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/codex/v1/responses?model=fixture`, { headers: { authorization: 'Bearer 12345678', 'openai-beta': 'responses_websockets=2026-02-06' } });
  try {
    await once(ws, 'open');
    const text = once(ws, 'message'); ws.send('你好'); const [data, binary] = await text; assert.equal(data.toString(), '你好'); assert.equal(binary, false);
    const bytes = once(ws, 'message'); ws.send(Buffer.from([0, 1, 255])); const [binaryData, isBinary] = await bytes; assert.deepEqual(binaryData, Buffer.from([0, 1, 255])); assert.equal(isBinary, true);
    ws.close(); await once(ws, 'close');
  } finally { ws.terminate(); wss.close(); await f.cleanup(); }
});

test('WebSocket upgrade rejection retains upstream status and body', async () => {
  const f = await fixture((_request, response) => { response.writeHead(403, { 'content-type': 'application/json' }); response.end('{"error":"fixture rejected"}'); });
  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/codex/v1/responses`);
      ws.on('error', reject);
      ws.on('unexpected-response', (_request, response) => {
        let body = ''; response.on('data', chunk => { body += chunk; });
        response.on('end', () => { resolve({ status: response.statusCode!, body }); ws.terminate(); });
        ws.removeListener('error', reject); ws.on('error', () => {});
      });
    });
    assert.deepEqual(result, { status: 403, body: '{"error":"fixture rejected"}' });
  } finally { await f.cleanup(); }
});

test('disconnect cancels upstream streaming response', async () => {
  let disconnected!: () => void; const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const f = await fixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: first\n\n');
    response.once('close', disconnected);
  });
  try {
    await new Promise<void>((resolve, reject) => { http.get(`${f.base}/codex/v1/responses`, response => { response.once('data', () => { response.destroy(); resolve(); }); }).on('error', reject); });
    await closed;
  } finally { await f.cleanup(); }
});

test('health omits credentials and resolver errors do not leak their input', async () => {
  const resolver: ProviderResolver = { resolve: () => { throw new Error('fixture-secret'); } };
  const gateway = createGateway(resolver, options); const { port } = await gateway.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(health.status, 503); assert.ok(!(await health.text()).includes('fixture-secret'));
    const result = await fetch(`http://127.0.0.1:${port}/codex/v1/models`); assert.equal(result.status, 502); assert.ok(!(await result.text()).includes('fixture-secret'));
    const unknown = await fetch(`http://127.0.0.1:${port}/other`); assert.equal(unknown.status, 404);
  } finally { await gateway.stop(); }
});

test('upstream timeout fails once without retrying or leaking errors', async () => {
  let count = 0;
  const f = await fixture(() => { count++; }, { headerTimeoutMs: 30 });
  try { const response = await fetch(`${f.base}/codex/v1/responses`); assert.equal(response.status, 502); assert.equal(count, 1); await response.text(); }
  finally { await f.cleanup(); }
});

test('HTTP upstream proxy is explicitly used', async () => {
  let requests = 0;
  const proxy = http.createServer((request, response) => { requests++; assert.equal(request.url, 'http://fixture.invalid/v1/models'); response.end('{"data":[]}'); });
  const proxyPort = await listen(proxy);
  const resolver: ProviderResolver = { resolve: () => ({ id: 'test', name: 'test', baseUrl: 'http://fixture.invalid/v1', headers: { authorization: 'Bearer fixture-secret' } }) };
  const gateway = createGateway(resolver, { ...options, proxyUrl: `http://127.0.0.1:${proxyPort}` }); const { port } = await gateway.start();
  try { const response = await fetch(`http://127.0.0.1:${port}/codex/v1/models`); assert.equal(response.status, 200); await response.text(); assert.equal(requests, 1); }
  finally { await gateway.stop(); await close(proxy); }
});

test('graceful stop is idempotent and ends persistent streams', async () => {
  const f = await fixture((_request, response) => { response.writeHead(200); response.write('first'); });
  const response = await fetch(`${f.base}/codex/v1/responses`); await response.body!.getReader().read();
  await Promise.all([f.gateway.stop(), f.gateway.stop()]); await close(f.upstream);
});
