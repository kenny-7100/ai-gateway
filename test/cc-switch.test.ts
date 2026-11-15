import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CCSwitchResolver } from '../src/cc-switch.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-test-'));
  const db = new Database(join(dir, 'cc-switch.db'));
  db.exec('CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER)');
  const codex = (base: string, key: string) => JSON.stringify({ auth: { OPENAI_API_KEY: key }, config: `model_provider = "custom"\n[model_providers.custom]\nbase_url = "${base}"\nwire_api = "responses"` });
  const insert = db.prepare('INSERT INTO providers VALUES (?, ?, ?, ?, ?)');
  insert.run('a', 'codex', 'A', codex('https://a.invalid/v1', 'fixture-a'), 1);
  insert.run('b', 'codex', 'B', codex('https://b.invalid/v1', 'fixture-b'), 0);
  insert.run('c', 'claude', 'C', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://c.invalid', ANTHROPIC_AUTH_TOKEN: 'fixture-c' } }), 1);
  const resolver = new CCSwitchResolver(dir);
  return { db, resolver, cleanup: () => { resolver.close(); db.close(); rmSync(dir, { recursive: true }); } };
}
test('follow sees external updates; fixed provider remains independent; token rotation is read immediately', () => {
  const f = fixture();
  try {
    assert.equal(f.resolver.resolve('codex', { mode: 'follow' }).id, 'a');
    f.db.exec("UPDATE providers SET is_current = (id = 'b') WHERE app_type = 'codex'");
    assert.equal(f.resolver.resolve('codex', { mode: 'follow' }).id, 'b');
    assert.equal(f.resolver.resolve('codex', { mode: 'fixed', id: 'a' }).headers.authorization, 'Bearer fixture-a');
    assert.equal(f.resolver.resolve('claude', { mode: 'follow' }).headers.authorization, 'Bearer fixture-c');
    f.db.prepare("UPDATE providers SET settings_config = replace(settings_config, 'fixture-a', 'fixture-rotated') WHERE id='a'").run();
    assert.equal(f.resolver.resolve('codex', { mode: 'fixed', id: 'a' }).headers.authorization, 'Bearer fixture-rotated');
    f.db.exec("DELETE FROM providers WHERE id='a'");
    assert.throws(() => f.resolver.resolve('codex', { mode: 'fixed', id: 'a' }), /provider_not_found/);
  } finally { f.cleanup(); }
});
test('malformed sensitive config and missing/OAuth credentials fail without exposing content', () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE providers SET settings_config = ? WHERE id='a'").run('{fixture-secret invalid');
    assert.throws(() => f.resolver.resolve('codex', { mode: 'follow' }), /^Error: provider_config_unavailable$/);
    f.db.prepare("UPDATE providers SET settings_config = ? WHERE id='a'").run(JSON.stringify({ auth: { tokens: { access_token: 'fixture-secret' } }, config: 'model_provider="openai"' }));
    assert.throws(() => f.resolver.resolve('codex', { mode: 'follow' }), /provider_api_credentials_missing/);
    f.db.exec("UPDATE providers SET is_current=1 WHERE app_type='codex'");
    assert.throws(() => f.resolver.resolve('codex', { mode: 'follow' }), /ambiguous_provider_selection/);
  } finally { f.cleanup(); }
});
