#!/usr/bin/env python3
"""Run Codex CLI in an isolated home; emit summaries only, never raw CLI output."""
import argparse
import collections
import json
import os
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--base', required=True)
parser.add_argument('--model', default='gpt-6.1-sol')
parser.add_argument('--codex', default='codex')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ai-gateway-client-') as directory:
    env = dict(os.environ, CODEX_HOME=directory, GATEWAY_API_KEY='12345678')
    executable = shutil.which(args.codex) or args.codex
    command = [executable, 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--cd', directory,
        '-c', 'model_provider="gateway"', '-c', 'model=' + json.dumps(args.model),
        '-c', 'model_providers.gateway.name="AI Gateway"',
        '-c', 'model_providers.gateway.base_url=' + json.dumps(args.base.rstrip('/') + '/codex/v1'),
        '-c', 'model_providers.gateway.env_key="GATEWAY_API_KEY"',
        '-c', 'model_providers.gateway.wire_api="responses"',
        '--json', 'Reply with exactly OK. Do not call any tools.']
    try:
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=150)
        events = []
        output_ok = False
        for line in result.stdout.splitlines():
            try:
                item = json.loads(line)
                events.append(item.get('type', 'unknown'))
                if item.get('type') == 'item.completed':
                    output_ok = output_ok or item.get('item', {}).get('text', '').strip() == 'OK'
            except ValueError:
                pass
        known = ['thread.started', 'turn.started', 'item.completed', 'turn.completed', 'turn.failed', 'error']
        counts = {k: events.count(k) for k in known if k in events}
        passed = result.returncode == 0 and output_ok and 'turn.completed' in events
        print(json.dumps({'check': 'real_codex_cli', 'passed': passed, 'exit_code': result.returncode, 'events': counts, 'expected_output': output_ok}))
        sys.exit(0 if passed else 1)
    except Exception as error:
        print(json.dumps({'check': 'real_codex_cli', 'passed': False, 'error_type': type(error).__name__}))
        sys.exit(1)
