// App-DB helper — per-app SQLite store under .claude/state/apps/<id>.db.
//
// Each app declares its schema in its manifest (see standard-app-architecture.md
// § 3 and standard-app-persistence.md). The shell calls openAppDb(id, { schema })
// at boot to apply it idempotently. App code calls openAppDb(id) at runtime
// for the connection (cached process-wide).
//
// Pure Node — uses node:sqlite (built-in since Node ≥ 22.5).

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const APPS_DIR = join(REPO_ROOT, '.claude', 'state', 'apps');

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const _connections = new Map(); // id → DatabaseSync

/**
 * Open or create the app's SQLite database, optionally applying a schema.
 *
 *   openAppDb('pr-review', { schema: 'CREATE TABLE IF NOT EXISTS prs (...)' })
 *
 * First call creates the DB and applies the schema. Subsequent calls return
 * the cached connection (no schema re-application — schemas use CREATE … IF
 * NOT EXISTS anyway, so re-application is a no-op).
 *
 * The schema parameter is optional. App runtime code typically calls
 *   openAppDb('pr-review')
 * and relies on the shell having already applied the schema at boot.
 */
export function openAppDb(id, opts = {}) {
  if (typeof id !== 'string' || !APP_ID_PATTERN.test(id)) {
    throw new Error(`openAppDb: invalid app id "${id}" — must match /^[a-z][a-z0-9-]*$/`);
  }
  const cached = _connections.get(id);
  if (cached) {
    if (opts.schema) cached.exec(opts.schema);
    return cached;
  }
  const path = join(APPS_DIR, `${id}.db`);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL gives concurrent reads while a single writer is appending.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  if (opts.schema) db.exec(opts.schema);
  _connections.set(id, db);
  return db;
}

/**
 * Close + remove the cached connection for an app. Mostly for tests / clean
 * uninstalls. Does NOT delete the .db file — that's a separate filesystem op.
 */
export function closeAppDb(id) {
  const db = _connections.get(id);
  if (!db) return;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  _connections.delete(id);
}

/**
 * List every app DB currently on disk. Used by audit + diagnostics.
 * Returns: [{ id, path, sizeBytes, mtimeMs }]
 */
export function listAppDbs() {
  if (!existsSync(APPS_DIR)) return [];
  const out = [];
  for (const name of readdirSync(APPS_DIR)) {
    if (!name.endsWith('.db')) continue;
    const id = name.slice(0, -3);
    if (!APP_ID_PATTERN.test(id)) continue; // skip non-app files
    const path = join(APPS_DIR, name);
    try {
      const s = statSync(path);
      out.push({ id, path, sizeBytes: s.size, mtimeMs: s.mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export { APPS_DIR };
