#!/usr/bin/env node
// Idempotent SQLite schema bootstrap for the `runs` table.
//
// The `runs` table lives alongside `events` in .claude/state/events.db — they
// share the WAL writer and the dashboard's existing DB connection. `runs`
// captures one row per skill dispatch (write-change, review-change, pr-review,
// …); output streams to `.claude/state/runs/<id>.jsonl`. See runs-as-process
// change for the full design rationale.
//
// Re-runs are no-ops: CREATE ... IF NOT EXISTS throughout.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH } from './events-db-init.mjs';

// Who dispatched a run. Stamped at create time; NULL on legacy rows reads as
// `human` at the derive/display layer. Mirror this list as the `RunOrigin`
// type union in domains/meta/app/server/routes/runs.types.ts (that file is
// types-only and cannot import this runtime value).
export const RUN_ORIGINS = ['human', 'automation', 'scheduler', 'driver'];

export const RUNS_EXPECTED_COLUMNS = [
  'id',
  'started_at',
  'ended_at',
  'state',
  'exit_status',
  'pid',
  'skill',
  'change_id',
  'project',
  'repo',
  'domain',
  'title',
  'prompt',
  'output_path',
  'duration_ms',
  'error',
  // Cost / model observability — captured from the stream-json `result`
  // event when the underlying claude subprocess finishes. Lets the run
  // surfaces (drawer, Processes page) show $/tokens without joining
  // back to events.db.
  'cost_usd',
  'tokens_in',
  'tokens_out',
  'tokens_cache_hit',
  'tokens_cache_write',
  'model',
  // Who dispatched this run — human | automation | scheduler | driver.
  // Stamped at create time; NULL (legacy rows) reads as `human`.
  'origin',
  // Set when post-terminal side-effects (events.db row, automation hooks)
  // have fired for this run. Row finalization and hook firing are split:
  // the supervisor (scheduler tick) can finalize a row while the server is
  // down; the server fires hooks idempotently for any terminal row where
  // this is NULL. Prevents both double-firing and parked-forever automation.
  'hooks_fired_at',
];

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  state               TEXT NOT NULL,
  exit_status         INTEGER,
  pid                 INTEGER,
  skill               TEXT,
  change_id           TEXT,
  project             TEXT,
  repo                TEXT,
  domain              TEXT,
  title               TEXT,
  prompt              TEXT NOT NULL,
  output_path         TEXT NOT NULL,
  duration_ms         INTEGER,
  error               TEXT,
  cost_usd            REAL,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  tokens_cache_hit    INTEGER,
  tokens_cache_write  INTEGER,
  model               TEXT,
  origin              TEXT
);`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS runs_state ON runs(state)',
  'CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at)',
  'CREATE INDEX IF NOT EXISTS runs_change ON runs(change_id)',
  'CREATE INDEX IF NOT EXISTS runs_project ON runs(project)',
  'CREATE INDEX IF NOT EXISTS runs_repo ON runs(repo)',
  'CREATE INDEX IF NOT EXISTS runs_skill ON runs(skill)',
];

// Idempotent column additions. Older databases predate these columns; this
// migrates them in place. SQLite's ADD COLUMN never fails if the column
// already exists in our table_info check below.
const COLUMN_MIGRATIONS = [
  { col: 'cost_usd', sql: 'ALTER TABLE runs ADD COLUMN cost_usd REAL' },
  { col: 'tokens_in', sql: 'ALTER TABLE runs ADD COLUMN tokens_in INTEGER' },
  { col: 'tokens_out', sql: 'ALTER TABLE runs ADD COLUMN tokens_out INTEGER' },
  { col: 'tokens_cache_hit', sql: 'ALTER TABLE runs ADD COLUMN tokens_cache_hit INTEGER' },
  { col: 'tokens_cache_write', sql: 'ALTER TABLE runs ADD COLUMN tokens_cache_write INTEGER' },
  { col: 'model', sql: 'ALTER TABLE runs ADD COLUMN model TEXT' },
  { col: 'origin', sql: 'ALTER TABLE runs ADD COLUMN origin TEXT' },
  { col: 'hooks_fired_at', sql: 'ALTER TABLE runs ADD COLUMN hooks_fired_at TEXT' },
];

export function initRunsTable(db) {
  db.exec(CREATE_TABLE);
  for (const ix of INDEXES) db.exec(ix);
  // Live migrations — additive only; preserves existing data.
  const existing = new Set(
    db.prepare('PRAGMA table_info(runs)').all().map((r) => r.name),
  );
  for (const m of COLUMN_MIGRATIONS) {
    if (!existing.has(m.col)) db.exec(m.sql);
  }
  // One-time backfill, only on the migration that introduces hooks_fired_at:
  // pre-migration terminal rows already had their events + automation hooks
  // fired by the in-process close handler — stamp them so the server's
  // unhooked-runs poll doesn't re-fire history.
  if (!existing.has('hooks_fired_at')) {
    db.exec(
      `UPDATE runs SET hooks_fired_at = COALESCE(ended_at, started_at)
        WHERE state NOT IN ('queued','running') AND hooks_fired_at IS NULL`,
    );
  }
  return db;
}

export function liveRunsColumns(path = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(path);
  const rows = db.prepare('PRAGMA table_info(runs)').all();
  db.close();
  return rows.map((r) => r.name);
}

function main() {
  const args = process.argv.slice(2);
  const db = new DatabaseSync(DEFAULT_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  initRunsTable(db);
  if (args.includes('--print-schema')) {
    const rows = db.prepare('PRAGMA table_info(runs)').all();
    for (const r of rows) {
      console.log(`${String(r.cid).padStart(2, ' ')}  ${r.name.padEnd(22, ' ')} ${r.type}`);
    }
  } else {
    const count = db.prepare('SELECT count(*) AS n FROM runs').get();
    console.log(`runs table ready in ${DEFAULT_DB_PATH} (rows=${count.n})`);
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
