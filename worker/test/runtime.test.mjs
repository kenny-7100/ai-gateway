import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Workers runtime forwards authenticated HTTP and WebSocket traffic', { timeout: 20000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    {
      name: 'gateway', modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-11-19',
      bindings: { CODEX_BASE_URL: 'https://fixture.example/v1', CLAUDE_BASE_URL: 'https://fixture.example', UPSTREAM_HEADER_TIMEOUT_MS: '2000', SHARED_API_KEY: 'runtime-shared', CODEX_UPSTREAM_HEADERS: JSON.stringify({ authorization: 'Bearer fixture-key' }) },
      outboundService: 'upstream',
    },
    {
      name: 'upstream', modules: true, compatibilityDate: '2026-11-19',
      script: `export default { async fetch(request) {
        if (request.headers.get('authorization') !== 'Bearer fixture-key') return new Response('bad auth', {status:401});
        if (request.headers.get('upgrade') === 'websocket') {
          const [client, server] = Object.values(new WebSocketPair()); server.accept();
          server.addEventListener('message', event => server.send(event.data));
          return new Response(null, {status:101, webSocket:client});
        }
        return Response.json({path:new URL(request.url).pathname, body:await request.text()});
      } }`,
    },
  ] }));
  try {
    assert.equal((await mf.dispatchFetch('https://gateway.example/health')).status, 200);
    assert.equal((await mf.dispatchFetch('https://gateway.example/codex/v1/models')).status, 401);
    const response = await mf.dispatchFetch('https://gateway.example/codex/v1/responses', {
      method: 'POST', headers: { authorization: 'Bearer fixture-key' }, body: '{"input":"fixture"}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: '/v1/responses', body: '{"input":"fixture"}' });
    const upgraded = await mf.dispatchFetch('https://gateway.example/codex/v1/responses', {
      headers: { authorization: 'Bearer runtime-shared', upgrade: 'websocket' },
    });
    assert.equal(upgraded.status, 101);
    const ws = upgraded.webSocket;
    assert.ok(ws);
    ws.accept();
    const echoed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket timeout')), 2000);
      ws.addEventListener('message', event => { clearTimeout(timer); resolve(event.data); }, { once: true });
    });
    ws.send('fixture echo');
    assert.equal(await echoed, 'fixture echo');
    ws.close(1000);
  } finally { await mf.dispose(); }
});
