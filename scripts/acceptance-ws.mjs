// Node >=22 built-in WebSocket. No real credentials or response text are printed.
const [base = 'http://127.0.0.1:8787', model = 'gpt-6.1-sol'] = process.argv.slice(2);
const start = Date.now();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/codex/v1/responses`);
let done = false;
const timer = setTimeout(() => finish(false, 'timeout'), 150000);
function finish(passed, reason) {
  if (done) return;
  done = true; clearTimeout(timer);
  console.log(JSON.stringify({ check: 'codex_websocket_no_key', passed, reason, elapsed_ms: Date.now() - start }));
  ws.close(); process.exitCode = passed ? 0 : 1;
}
ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'response.create', model, input: 'Reply with exactly OK.', max_output_tokens: 128 })));
ws.addEventListener('message', event => {
  try {
    const data = JSON.parse(String(event.data));
    if (data.type === 'response.completed') finish(true, 'response.completed');
    if (data.type === 'error' || data.type === 'response.failed') finish(false, 'upstream_error_event');
  } catch { finish(false, 'invalid_json'); }
});
ws.addEventListener('error', () => finish(false, 'connection_error'));
ws.addEventListener('close', () => { if (!done) finish(false, 'closed_before_completion'); });
