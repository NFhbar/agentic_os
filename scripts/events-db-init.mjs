#!/usr/bin/env node
// Idempotent SQLite schema bootstrap for the OS event store.
//
// Creates .claude/state/events.db (and the directory if missing) with the
// `events` table + indexes defined in standard-event-store.md.
//
// Pure Node — uses node:sqlite (stable since Node 22.5).
//   node scripts/events-db-init.mjs
//   node scripts/events-db-init.mjs --print-schema   # dump the live schema
//
// Re-runs are no-ops: CREATE ... IF NOT EXISTS throughout.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRunsTable } from './runs-db-init.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
export const DEFAULT_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

// Canonical schema. Keep in sync with standard-event-store.md's column list —
// the `events-db-schema-current` audit check diffs this against the live DB.
export const EXPECTED_COLUMNS = [
  'id',
  'ts',
  'dedupe_key',
  'kind',
  'action',
  'source',
  'skill',
  'project',
  'change_id',
  'report_id',
  'domain',
  'model',
  'tokens_in',
  'tokens_out',
  'tokens_cache_hit',
  'tokens_cache_write',
  'cost_usd',
  'duration_ms',
  'exit_status',
  'status',
  'description',
  'files_touched',
  'prompt',
  'stdout_preview',
  'stderr',
  'origin_log',
  'raw',
];

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  source TEXT,
  skill TEXT,
  project TEXT,
  change_id TEXT,
  report_id TEXT,
  domain TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache_hit INTEGER,
  tokens_cache_write INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  exit_status INTEGER,
  status TEXT,
  description TEXT,
  files_touched TEXT,
  prompt TEXT,
  stdout_preview TEXT,
  stderr TEXT,
  origin_log TEXT,
  raw TEXT
);`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS events_ts ON events(ts)',
  'CREATE INDEX IF NOT EXISTS events_kind ON events(kind)',
  'CREATE INDEX IF NOT EXISTS events_skill ON events(skill)',
  'CREATE INDEX IF NOT EXISTS events_project ON events(project)',
  'CREATE INDEX IF NOT EXISTS events_change ON events(change_id)',
  'CREATE INDEX IF NOT EXISTS events_report ON events(report_id)',
  'CREATE INDEX IF NOT EXISTS events_model ON events(model)',
  'CREATE INDEX IF NOT EXISTS events_rate_limit ON events(kind, action, ts, source)',
];

export function initDb(path = DEFAULT_DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL gives us concurrent readers (dashboard) while a single writer
  // (scheduler / dashboard / cli) is appending. Cheap to set; persisted.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(CREATE_TABLE);
  // Migrate: backfill report_id column on existing DBs — drop after next breaking schema change.
  const cols = db.prepare('PRAGMA table_info(events)').all().map((r) => r.name);
  if (!cols.includes('report_id')) {
    db.exec('ALTER TABLE events ADD COLUMN report_id TEXT');
  }
  for (const ix of INDEXES) db.exec(ix);
  initRunsTable(db);
  return db;
}

export function liveColumns(path = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(path);
  const rows = db.prepare('PRAGMA table_info(events)').all();
  db.close();
  return rows.map((r) => r.name);
}

function main() {
  const args = process.argv.slice(2);
  const db = initDb();
  if (args.includes('--print-schema')) {
    const rows = db.prepare('PRAGMA table_info(events)').all();
    for (const r of rows) {
      console.log(`${String(r.cid).padStart(2, ' ')}  ${r.name.padEnd(22, ' ')} ${r.type}`);
    }
  } else {
    const count = db.prepare('SELECT count(*) AS n FROM events').get();
    console.log(`events.db ready at ${DEFAULT_DB_PATH} (rows=${count.n})`);
  }
  db.close();
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
