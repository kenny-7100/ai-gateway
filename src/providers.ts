import 'dotenv/config';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
try {
  const db = new Database(join(process.env.CC_SWITCH_DIR ?? join(homedir(), '.cc-switch'), 'cc-switch.db'), { readonly: true, fileMustExist: true });
  try {
    const providers = db.prepare("SELECT app_type AS app, id, name, is_current AS current FROM providers WHERE app_type IN ('codex', 'claude') ORDER BY app_type, sort_index").all();
    process.stdout.write(`${JSON.stringify(providers, null, 2)}\n`);
  } finally { db.close(); }
} catch {
  process.stderr.write('Cannot list providers. Check CC_SWITCH_DIR and database availability.\n');
  process.exitCode = 1;
}
