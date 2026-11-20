import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, type Env } from '../src/index.ts';

const env: Env = {
  CODEX_BASE_URL: 'https://openai.example/backend-api/codex',
  CLAUDE_BASE_URL: 'https://anthropic.example/prefix',
};
const neverFetch = async () => { throw new Error('must not fetch'); };

test('missing credentials, malformed auth, unknown routes and invalid configuration never reach upstream', async () => {
  for (const path of ['/codex/v1/models', '/claude/v1/messages']) {
    const result = await handleRequest(new Request(`https://gateway.example${path}`), env, neverFetch);
    assert.equal(result.status, 401);
  }
  const malformed = await handleRequest(new Request('https://gateway.example/codex/v1/models', { headers: { authorization: 'Basic secret' } }), env, neverFetch);
  assert.equal(malformed.status, 401);
  assert.equal((await handleRequest(new Request('https://gateway.example/other'), env, neverFetch)).status, 404);
  const health = await handleRequest(new Request('https://gateway.example/health'), env, neverFetch);
  assert.equal(health.status, 200);
  assert.equal((await handleRequest(new Request('https://gateway.example/health'), { ...env, CODEX_BASE_URL: 'https://secret@example.com' }, neverFetch)).status, 503);
});

test('Codex preserves request bytes, model, path and query; forwards only the intended credential', async () => {
  const body = '{ "model": "client-model", "input": "你好", "stream": true }';
  const result = await handleRequest(new Request('https://gateway.example/codex/v1/responses?x=%2F&x=2', {
    method: 'POST', body,
    headers: { authorization: 'Bearer caller-secret', 'x-api-key': 'other-secret', cookie: 'private=1', 'openai-beta': 'responses=v1', connection: 'x-private-hop', 'x-private-hop': 'remove' },
  }), env, async input => {
    const request = input as Request;
    assert.equal(request.url, 'https://openai.example/backend-api/codex/responses?x=%2F&x=2');
    assert.equal(request.method, 'POST');
    assert.equal(await request.text(), body);
    assert.equal(request.headers.get('authorization'), 'Bearer caller-secret');
    for (const name of ['x-api-key', 'cookie', 'connection', 'x-private-hop']) assert.equal(request.headers.get(name), null);
    assert.equal(request.headers.get('openai-beta'), 'responses=v1');
    assert.equal(request.redirect, 'manual');
    return new Response('upstream error', { status: 429, headers: { 'retry-after': '3', 'set-cookie': 'secret=1' } });
  });
  assert.equal(result.status, 429);
  assert.equal(await result.text(), 'upstream error');
  assert.equal(result.headers.get('retry-after'), '3');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('Claude supports API key or Bearer and keeps version/beta headers', async () => {
  for (const apiKey of [true, false]) {
    const headers = apiKey
      ? { 'x-api-key': 'claude-secret', authorization: 'Bearer unrelated', 'anthropic-version': '2023-06-01' }
      : { authorization: 'Bearer claude-secret', 'anthropic-version': '2023-06-01' };
    const result = await handleRequest(new Request('https://gateway.example/claude/v1/messages', {
      method: 'POST', body: '{}', headers: { ...headers, 'anthropic-beta': 'fixture' },
    }), env, async input => {
      const request = input as Request;
      assert.equal(request.url, 'https://anthropic.example/prefix/v1/messages');
      assert.equal(request.headers.get(apiKey ? 'x-api-key' : 'authorization'), apiKey ? 'claude-secret' : 'Bearer claude-secret');
      assert.equal(request.headers.get(apiKey ? 'authorization' : 'x-api-key'), null);
      assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
      assert.equal(request.headers.get('anthropic-beta'), 'fixture');
      return new Response('{}');
    });
    assert.equal(result.status, 200);
  }
});

test('SSE is returned before completion and header timeout does not terminate the stream', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n')); } });
  const response = await handleRequest(new Request('https://gateway.example/codex/v1/responses', { headers: { authorization: 'Bearer secret' } }), { ...env, UPSTREAM_HEADER_TIMEOUT_MS: '10' }, async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  await new Promise(resolve => setTimeout(resolve, 30));
  source.enqueue(new TextEncoder().encode('data: last\n\n')); source.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
  assert.equal((await reader.read()).done, true);
});

test('redirects are rejected and failures do not expose credentials or URLs', async () => {
  const request = () => new Request('https://gateway.example/codex/v1/models', { headers: { authorization: 'Bearer private-secret' } });
  const redirect = await handleRequest(request(), env, async () => new Response(null, { status: 307, headers: { location: 'https://other.example' } }));
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get('location'), null);
  const error = await handleRequest(request(), env, async () => { throw new Error('private-secret https://private.example'); });
  assert.equal(error.status, 502);
  assert.ok(!(await error.text()).includes('private'));
  const loop = await handleRequest(request(), { ...env, CODEX_BASE_URL: 'https://gateway.example/v1' }, neverFetch);
  assert.equal(loop.status, 503);
});

test('header timeout and client cancellation abort the upstream request', async () => {
  for (const abortClient of [true, false]) {
    const controller = new AbortController();
    const pending = handleRequest(new Request('https://gateway.example/codex/v1/models', {
      headers: { authorization: 'Bearer secret' }, signal: controller.signal,
    }), { ...env, UPSTREAM_HEADER_TIMEOUT_MS: '20' }, async input => {
      const request = input as Request;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    if (abortClient) controller.abort();
    assert.equal((await pending).status, 502);
  }
});

test('shared key resolves per-app stored credentials and never reaches upstream', async () => {
  const configured = { ...env, SHARED_API_KEY: 'fixture-shared', CODEX_UPSTREAM_HEADERS: JSON.stringify({ authorization: 'Bearer stored-codex' }), CLAUDE_UPSTREAM_HEADERS: JSON.stringify({ 'x-api-key': 'stored-claude' }) };
  for (const [app, auth] of [['codex', { authorization: 'Bearer fixture-shared' }], ['claude', { 'x-api-key': 'fixture-shared' }], ['claude', { authorization: 'Bearer fixture-shared' }]] as const) {
    const result = await handleRequest(new Request(`https://gateway.example/${app}/v1/models`, { headers: auth }), configured, async input => {
      const headers = (input as Request).headers;
      assert.equal(headers.get(app === 'codex' ? 'authorization' : 'x-api-key'), app === 'codex' ? 'Bearer stored-codex' : 'stored-claude');
      assert.equal(headers.get(app === 'codex' ? 'x-api-key' : 'authorization'), null);
      assert.ok(!JSON.stringify([...headers]).includes('fixture-shared'));
      return new Response('{}');
    });
    assert.equal(result.status, 200);
  }
  for (const stored of [undefined, 'broken', '{}', '{"authorization":123}']) {
    const result = await handleRequest(new Request('https://gateway.example/codex/v1/models', { headers: { authorization: 'Bearer fixture-shared' } }), { ...configured, CODEX_UPSTREAM_HEADERS: stored }, neverFetch);
    assert.equal(result.status, 503);
    assert.ok(!(await result.text()).includes('stored-codex'));
  }
  const passthrough = await handleRequest(new Request('https://gateway.example/codex/v1/models', { headers: { authorization: 'Bearer own-key' } }), configured, async input => {
    assert.equal((input as Request).headers.get('authorization'), 'Bearer own-key');
    return new Response('{}');
  });
  assert.equal(passthrough.status, 200);
});

test('disabled header timeout permits long reasoning and preserves Codex response metadata', async () => {
  const result = await handleRequest(new Request('https://gateway.example/codex/v1/responses', {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json', 'x-codex-turn-state': 'opaque-turn', 'session_id': 'opaque-session' },
    body: JSON.stringify({ model: 'fixture', reasoning: { effort: 'high' }, previous_response_id: 'previous', tools: [{ type: 'function', name: 'fixture', parameters: { type: 'object' } }], stream: true }),
  }), { ...env, UPSTREAM_HEADER_TIMEOUT_MS: '0' }, async input => {
    const request = input as Request;
    assert.equal(request.headers.get('x-codex-turn-state'), 'opaque-turn');
    assert.equal(request.headers.get('session_id'), 'opaque-session');
    const body = await request.json();
    assert.equal(body.reasoning.effort, 'high');
    assert.equal(body.previous_response_id, 'previous');
    assert.equal(body.tools[0].name, 'fixture');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(request.signal.aborted, false);
    return new Response('data: fixture\n\n', { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'next-turn', 'x-request-id': 'request-id', 'x-ratelimit-remaining-requests': '42' } });
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-codex-turn-state'), 'next-turn');
  assert.equal(result.headers.get('x-request-id'), 'request-id');
  assert.equal(result.headers.get('x-ratelimit-remaining-requests'), '42');
  assert.equal(await result.text(), 'data: fixture\n\n');
});

test('cancelling the returned SSE reader cancels the original upstream body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); }, cancel() { cancelled = true; } });
  const response = await handleRequest(new Request('https://gateway.example/codex/v1/responses', { headers: { authorization: 'Bearer secret' } }), env, async () => new Response(stream));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('dated Codex API root appends native API paths without an extra v1', async () => {
  const configured = { ...env, SHARED_API_KEY: 'fixture-shared', CODEX_UPSTREAM_HEADERS: JSON.stringify({ authorization: 'Bearer stored-codex' }) };
  for (const path of ['/models', '/responses', '/responses/fixture/compact', '/chat/completions']) {
    const result = await handleRequest(new Request(`https://doc.jimao.uk/summary-20261121${path}?x=%2F&x=2`, {
      headers: { authorization: 'Bearer fixture-shared' },
    }), configured, async input => {
      const request = input as Request;
      assert.equal(request.url, `https://openai.example/backend-api/codex${path}?x=%2F&x=2`);
      assert.equal(request.headers.get('authorization'), 'Bearer stored-codex');
      return new Response('{}');
    });
    assert.equal(result.status, 200);
  }
  const unauthenticated = await handleRequest(new Request('https://doc.jimao.uk/summary-20261121/models'), configured, neverFetch);
  assert.equal(unauthenticated.status, 401);
  const unrelated = await handleRequest(new Request('https://doc.jimao.uk/summary-202611210/models'), configured, neverFetch);
  assert.equal(unrelated.status, 404);
});
