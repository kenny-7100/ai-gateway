#!/usr/bin/env python3
"""Real API smoke test. Prints only status/latency/booleans, never response bodies.
Run locally or pipe this script to a LAN device's python3 over SSH.
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('--base', required=True)
parser.add_argument('--app', choices=['codex', 'claude', 'all'], default='codex')
parser.add_argument('--codex-model', default='gpt-6.1-sol')
parser.add_argument('--claude-model', default='claude-opus-5-5')
args = parser.parse_args()
base = args.base.rstrip('/')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
failed = False

def check(name, path, payload=None, key=None, stream=False, expected_model=None):
    global failed
    headers = {'User-Agent': 'ai-gateway-acceptance/1.0'}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    if key:
        headers['Authorization'] = 'Bearer ' + key
        headers['x-api-key'] = key
    request = urllib.request.Request(base + path, headers=headers,
        data=json.dumps(payload).encode() if payload is not None else None)
    start = time.monotonic()
    result = {'check': name}
    try:
        with opener.open(request, timeout=150) as response:
            result['http_status'] = response.status
            if stream:
                first = None
                terminal = False
                events = 0
                upstream_error = False
                for line in response:
                    if line.startswith(b'data:'):
                        events += 1
                        if first is None:
                            first = round((time.monotonic() - start) * 1000)
                        raw = line[5:].strip()
                        if raw == b'[DONE]':
                            terminal = True
                        else:
                            try:
                                event = json.loads(raw)
                                terminal = terminal or event.get('type') in ['response.completed', 'message_stop']
                                upstream_error = upstream_error or event.get('type') in ['error', 'response.failed']
                            except (ValueError, AttributeError):
                                pass
                result.update(events=events, first_event_ms=first, completed=terminal, upstream_error=upstream_error)
                ok = terminal and not upstream_error and events > 0
            else:
                data = json.loads(response.read())
                if expected_model:
                    ok = any(item.get('id') == expected_model for item in data.get('data', []))
                    result['configured_model_listed'] = ok
                elif path == '/health':
                    ok = data.get('status') == 'ready'
                elif path.startswith('/codex'):
                    ok = data.get('status') == 'completed' and bool(data.get('output'))
                    result['completed'] = ok
                else:
                    ok = data.get('type') == 'message' and bool(data.get('content'))
                    result['completed'] = ok
            result['passed'] = response.status == 200 and ok
    except urllib.error.HTTPError as error:
        result.update(http_status=error.code, passed=False)
    except Exception as error:
        result.update(error_type=type(error).__name__, passed=False)
    result['elapsed_ms'] = round((time.monotonic() - start) * 1000)
    failed = failed or not result['passed']
    print(json.dumps(result), flush=True)

check('health', '/health')
apps = [('codex', args.codex_model), ('claude', args.claude_model)]
for app, model in apps:
    if args.app not in [app, 'all']:
        continue
    for key in [None, '12345678']:
        check(app + '_models_' + ('dummy_key' if key else 'no_key'), '/' + app + '/v1/models', key=key, expected_model=model)
for streaming in [False, True]:
    if args.app in ['codex', 'all']:
        check('codex_' + ('stream_dummy_key' if streaming else 'nonstream_no_key'), '/codex/v1/responses',
        {'model': args.codex_model, 'input': 'Reply with exactly OK.', 'max_output_tokens': 128, 'stream': streaming},
        key='12345678' if streaming else None, stream=streaming)
    if args.app in ['claude', 'all']:
        check('claude_' + ('stream_dummy_key' if streaming else 'nonstream_no_key'), '/claude/v1/messages',
        {'model': args.claude_model, 'max_tokens': 32, 'messages': [{'role': 'user', 'content': 'Reply with exactly OK.'}], 'stream': streaming},
        key='12345678' if streaming else None, stream=streaming)
sys.exit(1 if failed else 0)
