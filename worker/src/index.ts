export interface Env {
  CODEX_BASE_URL: string;
  CLAUDE_BASE_URL: string;
  UPSTREAM_HEADER_TIMEOUT_MS?: string;
  SHARED_API_KEY?: string;
  CODEX_UPSTREAM_HEADERS?: string;
  CLAUDE_UPSTREAM_HEADERS?: string;
}

class GatewayError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function fail(code: string, status: number): Response {
  return Response.json({ error: { type: 'gateway_error', code, message: code } }, {
    status, headers: { 'cache-control': 'no-store' },
  });
}

function baseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new GatewayError('invalid_upstream_configuration', 503); }
}

function cleanHeaders(input: Headers, websocket: boolean): Headers {
  const headers = new Headers(input);
  const connection = (headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connection]) {
    if (websocket && (name === 'connection' || name === 'upgrade')) continue;
    headers.delete(name);
  }
  return headers;
}

/** Only fixed, operator-configured upstreams receive caller credentials. */
export async function handleRequest(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const incoming = new URL(request.url);
    if (incoming.pathname === '/health' && request.method === 'GET') {
      baseUrl(env.CODEX_BASE_URL);
      baseUrl(env.CLAUDE_BASE_URL);
      return Response.json({ status: 'ready' }, { headers: { 'cache-control': 'no-store' } });
    }
    const match = incoming.pathname.match(/^\/(codex|claude)(\/v1(?:\/.*)?)$/);
    if (!match) return fail('route_not_found', 404);
    const app = match[1]!;
    const path = match[2]!;
    const bearer = request.headers.get('authorization');
    const validBearer = bearer !== null && /^Bearer\s+\S+$/i.test(bearer);
    const apiKey = request.headers.get('x-api-key')?.trim();
    if (app === 'codex' ? !validBearer : !apiKey && !validBearer) {
      return fail('api_key_required', 401);
    }
    const target = baseUrl(app === 'codex' ? env.CODEX_BASE_URL : env.CLAUDE_BASE_URL);
    if (target.origin === incoming.origin) throw new GatewayError('upstream_loop_detected', 503);
    target.pathname = target.pathname.replace(/\/$/, '') + (app === 'codex' ? path.slice(3) || '/' : path);
    target.search = incoming.search;

    const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    const headers = cleanHeaders(request.headers, websocket);
    for (const name of ['host', 'cookie', 'authorization', 'x-api-key', 'x-goog-api-key', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry']) headers.delete(name);
    const callerKey = app === 'claude' && apiKey ? apiKey : bearer!.replace(/^Bearer\s+/i, '');
    if (env.SHARED_API_KEY && callerKey === env.SHARED_API_KEY) {
      let stored: Record<string, unknown>;
      try {
        stored = JSON.parse((app === 'codex' ? env.CODEX_UPSTREAM_HEADERS : env.CLAUDE_UPSTREAM_HEADERS) ?? 'null');
        if (!stored || Array.isArray(stored) || typeof stored !== 'object'
          || !Object.keys(stored).length || Object.values(stored).some(value => typeof value !== 'string')
          || !(stored.authorization || (app === 'claude' && stored['x-api-key']))) throw new Error();
        for (const [name, value] of Object.entries(stored)) headers.set(name, value as string);
      } catch { throw new GatewayError('shared_credentials_unavailable', 503); }
    } else if (app === 'claude' && apiKey) headers.set('x-api-key', apiKey);
    else headers.set('authorization', bearer!);
    if (app === 'claude' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');

    const timeout = Number(env.UPSTREAM_HEADER_TIMEOUT_MS ?? '0');
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 3600000) {
      throw new GatewayError('invalid_timeout_configuration', 503);
    }
    const controller = new AbortController();
    // The client/upstream owns request lifetime by default, including long reasoning.
    if (timeout > 0) timer = setTimeout(() => controller.abort(), timeout);
    const upstreamRequest = new Request(new Request(target, request), {
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    const upstream = await fetcher(upstreamRequest);
    // Returning the original response lets Workers tunnel upgraded WebSockets.
    if (upstream.status === 101) return upstream;
    // Never follow redirects with the caller's credential. Clients must use the configured route.
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
      await upstream.body?.cancel();
      return fail('upstream_redirect_rejected', 502);
    }
    const responseHeaders = cleanHeaders(upstream.headers, false);
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.delete('set-cookie');
    // No JSON/SSE parsing or buffering; retain the upstream stream and encoding.
    return new Response(upstream.body, {
      status: upstream.status, statusText: upstream.statusText, headers: responseHeaders,
      encodeBody: 'manual',
    });
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.code, error.status);
    // Fetch errors can contain URLs or credentials. Never log/return their contents.
    return fail('upstream_connection_failed', 502);
  } finally {
    // Timeout applies only before headers; long SSE responses keep streaming.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> { return handleRequest(request, env); },
} satisfies ExportedHandler<Env>;
