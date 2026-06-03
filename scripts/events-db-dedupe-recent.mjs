#!/usr/bin/env node
// One-time + reusable dedupe for events.db (with symmetric JSONL prune).
//
// Finds rows with the same (action, skill, files_touched) signature and
// keeps only the most recent row per signature. Older duplicates are
// deleted from BOTH events.db AND vault/raw/dashboard-actions.jsonl so the
// dual-write parity audit stays clean. (The "JSONL is append-only" rule is
// a soft convention — this is an intentional maintenance operation that
// opts in to symmetric mutation.)
//
// Modes:
//   --apply                — delete duplicates from events.db + JSONL
//   --prune-jsonl-orphans  — JSONL has lines not in events.db (e.g. after a
//                            previous dedupe that didn't touch JSONL). Drop
//                            those orphan lines to restore parity.
// Default: dry-run that lists what would change but writes nothing.
//
// Use cases:
//   - Cleaning up after StrictMode-induced duplicate dispatches
//   - Manual cleanup when retries produced effectively-identical events
//   - Restoring dual-write parity after a partial dedupe

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');
const JSONL_PATH = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');

const apply = process.argv.includes('--apply');
const pruneOnly = process.argv.includes('--prune-jsonl-orphans');

const db = new DatabaseSync(DB_PATH);

// -- Helpers ----------------------------------------------------------------

// Match a JSONL line to an events.db row by (ts, action). Both sides write
// these identically in record-dashboard-action.mjs / action.ts, so this is
// the canonical join key for dual-write parity.
function eventKey(ts, action) {
  return `${ts}::${action}`;
}

function readJsonl() {
  let raw;
  try {
    raw = readFileSync(JSONL_PATH, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push({ raw: line, parsed: JSON.parse(line) });
    } catch {
      out.push({ raw: line, parsed: null });
    }
  }
  return out;
}

function writeJsonl(lines) {
  const body = lines.map((l) => l.raw).join('\n');
  writeFileSync(JSONL_PATH, body.endsWith('\n') ? body : body + '\n');
}

// -- Prune-only mode --------------------------------------------------------

if (pruneOnly) {
  const allRows = db.prepare('SELECT ts, action FROM events').all();
  const dbKeys = new Set(allRows.map((r) => eventKey(r.ts, r.action)));
  const lines = readJsonl();
  const kept = [];
  const orphans = [];
  for (const l of lines) {
    if (!l.parsed || !l.parsed.ts || !l.parsed.action) {
      // Malformed / missing required fields — keep as-is (don't risk dropping
      // legitimate-but-unparseable history).
      kept.push(l);
      continue;
    }
    const k = eventKey(l.parsed.ts, l.parsed.action);
    if (dbKeys.has(k)) {
      kept.push(l);
    } else {
      orphans.push(l);
    }
  }
  console.log(`JSONL lines: ${lines.length}`);
  console.log(`events.db rows: ${dbKeys.size}`);
  console.log(`Orphan JSONL lines (no matching events.db row): ${orphans.length}`);
  for (const o of orphans.slice(0, 20)) {
    console.log(
      `  drop ts=${o.parsed.ts} action=${o.parsed.action} ${JSON.stringify(o.parsed.args ?? o.parsed.prompt ?? '').slice(0, 60)}`,
    );
  }
  if (orphans.length > 20) console.log(`  … and ${orphans.length - 20} more`);
  if (orphans.length === 0) {
    console.log('Nothing to prune.');
    process.exit(0);
  }
  if (!apply) {
    console.log('\nDry-run. Re-run with --apply to prune.');
    process.exit(0);
  }
  writeJsonl(kept);
  console.log(`\n✓ Pruned ${orphans.length} orphan lines from JSONL.`);
  process.exit(0);
}

// -- Default dedupe mode ----------------------------------------------------

// Build groups by (action, skill, files_touched). Same paths + same skill =
// same outcome → duplicates. Skip NULL files_touched (dispatch-layer events
// like ai-prompt that don't claim file ownership keep their own semantics).
const rows = db
  .prepare(
    `SELECT id, ts, action, skill, files_touched
     FROM events
     WHERE files_touched IS NOT NULL AND files_touched != ''
     ORDER BY action, skill, files_touched, ts DESC`,
  )
  .all();

const groups = new Map();
for (const r of rows) {
  const key = `${r.action}|${r.skill ?? ''}|${r.files_touched}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const toDelete = [];
for (const [key, members] of groups) {
  if (members.length < 2) continue;
  const sorted = [...members].sort((a, b) => b.ts.localeCompare(a.ts));
  const keep = sorted[0];
  const drop = sorted.slice(1);
  toDelete.push(...drop);
  console.log(
    `[${key.slice(0, 60)}…] keep id=${keep.id} (${keep.ts}), drop ${drop.length}: ${drop.map((d) => `id=${d.id}@${d.ts}`).join(', ')}`,
  );
}

console.log(`\n${toDelete.length} rows would be deleted.`);

if (toDelete.length === 0) {
  console.log('Nothing to dedupe.');
  process.exit(0);
}

if (!apply) {
  console.log('\nDry-run. Re-run with --apply to delete (events.db + matching JSONL lines).');
  process.exit(0);
}

// Delete from events.db
const stmt = db.prepare('DELETE FROM events WHERE id = ?');
db.exec('BEGIN');
let count = 0;
for (const r of toDelete) {
  stmt.run(r.id);
  count++;
}
db.exec('COMMIT');
console.log(`\n✓ Deleted ${count} duplicate rows from events.db.`);

// Symmetric prune: drop matching JSONL lines so dual-write parity stays clean.
const toDeleteKeys = new Set(toDelete.map((r) => eventKey(r.ts, r.action)));
const lines = readJsonl();
const kept = lines.filter((l) => {
  if (!l.parsed || !l.parsed.ts || !l.parsed.action) return true;
  return !toDeleteKeys.has(eventKey(l.parsed.ts, l.parsed.action));
});
const droppedLines = lines.length - kept.length;
writeJsonl(kept);
console.log(`✓ Pruned ${droppedLines} matching lines from JSONL.`);
