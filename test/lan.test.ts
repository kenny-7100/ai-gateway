import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { createGateway } from '../src/gateway.js';
import type { ProviderResolver } from '../src/types.js';

// Opt in with LAN_SSH=my-mac LAN_HOST=<this machine's IP> npm test.
// Fixture credentials are synthetic. No CC Switch configuration is read or changed.
test('LAN Claude HTTP/SSE and WebSocket work from a separate SSH device', { skip: !process.env.LAN_SSH || !process.env.LAN_HOST, timeout: 30000 }, async () => {
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-lan-key');
    let body = ''; for await (const chunk of request) body += chunk;
    const data = JSON.parse(body || '{}');
    if (data.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 20);
    } else { response.setHeader('content-type', 'application/json'); response.end('{"type":"message","content":[{"type":"text","text":"OK"}]}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = (upstream.address() as import('node:net').AddressInfo).port;
  const resolver: ProviderResolver = { resolve: () => ({ id: 'fixture', name: 'fixture', baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: 'Bearer synthetic-lan-key' } }) };
  const gateway = createGateway(resolver, { host: '0.0.0.0', port: 0, selections: { codex: { mode: 'follow' }, claude: { mode: 'follow' } }, headerTimeoutMs: 3000, shutdownGraceMs: 30 });
  const address = await gateway.start();
  const wss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-lan-key');
    wss.handleUpgrade(request, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  });
  const base = `http://${process.env.LAN_HOST}:${address.port}`;
  const python = `import urllib.request,json\nop=urllib.request.build_opener(urllib.request.ProxyHandler({}))\nbase=${JSON.stringify(base)}\nfor stream in [False,True]:\n for key in [None,'12345678']:\n  headers={'content-type':'application/json'}\n  if key:headers['x-api-key']=key\n  r=op.open(urllib.request.Request(base+'/claude/v1/messages',data=json.dumps({'stream':stream}).encode(),headers=headers),timeout=5)\n  body=r.read()\n  assert r.status==200\n  assert b'message_stop' in body if stream else json.loads(body)['type']=='message'\nprint('lan_http_sse_passed')\n`;
  const node = `const ws=new WebSocket(${JSON.stringify(base.replace('http:', 'ws:') + '/codex/v1/responses')});const t=setTimeout(()=>process.exit(1),5000);ws.onopen=()=>ws.send('fixture');ws.onmessage=e=>{if(String(e.data)!=='fixture')process.exit(1);clearTimeout(t);ws.close();console.log('lan_ws_passed')};ws.onerror=()=>process.exit(1);`;
  try {
    // Only fixed shell commands; generated source is passed on stdin, never interpolated into shell text.
    const run = (command: string, source: string) => new Promise<string>((resolve, reject) => {
      const child = execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', process.env.LAN_SSH!, command], { timeout: 15000 }, (error, stdout) => error ? reject(new Error('remote_fixture_failed')) : resolve(stdout));
      child.stdin!.end(source);
    });
    assert.match(await run('python3 -', python), /lan_http_sse_passed/);
    const command = process.env.LAN_NODE ?? 'node';
    if (!/^[a-zA-Z0-9_./-]+$/.test(command)) throw new Error('invalid_LAN_NODE');
    assert.match(await run(`${command} --input-type=module -`, node), /lan_ws_passed/);
  } finally {
    for (const client of wss.clients) client.terminate(); wss.close(); await gateway.stop();
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
