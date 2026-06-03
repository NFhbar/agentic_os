#!/usr/bin/env node
// events-db-tag-changes — backfill change_id + project + domain on existing
// events.db rows by re-parsing the JSONL audit logs that hold the original
// prompts / intents. Idempotent: only updates rows that don't already have
// the field set.
//
// Why this exists: the original event-recording code didn't extract change_id
// from prompt bodies, so events written before the action.ts /
// record-router-event.mjs fix have null change_id even when the prompt
// clearly named a change. This script catches them up.
//
// Usage:
//   node scripts/events-db-tag-changes.mjs           (apply)
//   node scripts/events-db-tag-changes.mjs --dry-run (preview)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  extractFromIntent,
  extractFromPath,
  extractFromPrompt,
} from './extract-event-attribution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');
const DASHBOARD_LOG = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');
const ROUTER_LOG = join(REPO_ROOT, 'vault', 'raw', 'router-log.jsonl');

const dryRun = process.argv.includes('--dry-run');

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((x) => x != null);
}

if (!existsSync(DB_PATH)) {
  console.error(`events.db not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);

// Index by ts → { change_id, project, domain } from the JSONL audit logs.
const tagsByTs = new Map();
function setTag(ts, key, value) {
  if (!ts || !value) return;
  if (!tagsByTs.has(ts)) tagsByTs.set(ts, {});
  const t = tagsByTs.get(ts);
  if (t[key] == null) t[key] = value;
}

for (const row of readJsonl(DASHBOARD_LOG)) {
  // 1) Prompt body (ai-prompt-shaped rows from action.ts)
  const fromPrompt = extractFromPrompt(row.prompt);
  setTag(row.ts, 'change_id', fromPrompt.change_id);
  setTag(row.ts, 'project', fromPrompt.project);
  setTag(row.ts, 'domain', fromPrompt.domain);

  // 2) Structured args (record-dashboard-action rows include args.change /
  //    args.project / args.domain from the skill's --args JSON)
  if (row.args && typeof row.args === 'object') {
    if (typeof row.args.change === 'string') setTag(row.ts, 'change_id', row.args.change);
    if (typeof row.args.project === 'string') setTag(row.ts, 'project', row.args.project);
    if (typeof row.args.domain === 'string') setTag(row.ts, 'domain', row.args.domain);
  }

  // 3) files_touched — when a file path matches the canonical change layout
  //    (vault/wiki/<domain>/change/<id>.md) we can recover both id + domain.
  if (Array.isArray(row.files_touched)) {
    for (const f of row.files_touched) {
      const a = extractFromPath(f);
      if (a.change_id) {
        setTag(row.ts, 'change_id', a.change_id);
        setTag(row.ts, 'domain', a.domain);
        break;
      }
    }
  }
}
for (const row of readJsonl(ROUTER_LOG)) {
  const a = extractFromIntent(row.intent);
  setTag(row.ts, 'change_id', a.change_id);
  setTag(row.ts, 'project', a.project);
}

// Find events.db rows whose ts matches and whose target field is null.
let updates = 0;
let scanned = 0;
const updateStmt = db.prepare(
  `UPDATE events
   SET change_id = COALESCE(change_id, @change_id),
       project   = COALESCE(project,   @project),
       domain    = COALESCE(domain,    @domain)
   WHERE ts = @ts
     AND (
       (@change_id IS NOT NULL AND change_id IS NULL) OR
       (@project   IS NOT NULL AND project   IS NULL) OR
       (@domain    IS NOT NULL AND domain    IS NULL)
     )`,
);

// Adjacency pass: change-scoped events that have no text columns to extract
// from (no prompt, no description, files_touched empty) can still be
// attributed via temporal proximity to a router event for the same change.
// Pre-fix events landed without change_id even when the user clearly typed
// `/os write change <id>` moments before — the router log carries the id,
// the dashboard event doesn't, but they're adjacent.
const ADJACENCY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const adjacencyDb = new DatabaseSync(DB_PATH);
const untaggedScoped = adjacencyDb
  .prepare(`
    SELECT id, ts, skill
    FROM events
    WHERE change_id IS NULL
      AND skill IN ('dev-write-change','dev-review-change','dev-open-pr','dev-close-change','dev-pr-review','dev-address-comments')
  `)
  .all();
adjacencyDb.close();

// Build a sorted list of (ts, change_id) pairs from router log entries we
// already extracted. This gives us a quick nearest-match lookup.
const routerTags = Array.from(tagsByTs.entries())
  .filter(([, tags]) => tags.change_id)
  .map(([ts, tags]) => ({ ts, ms: Date.parse(ts), change_id: tags.change_id, project: tags.project }))
  .sort((a, b) => a.ms - b.ms);

function findAdjacent(eventTs) {
  const eventMs = Date.parse(eventTs);
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const r of routerTags) {
    const delta = Math.abs(r.ms - eventMs);
    if (delta < bestDelta && delta <= ADJACENCY_WINDOW_MS) {
      bestDelta = delta;
      best = r;
    }
  }
  return best;
}

for (const ev of untaggedScoped) {
  const match = findAdjacent(ev.ts);
  if (!match) continue;
  // Seed tagsByTs with this event's timestamp so the main UPDATE loop below
  // picks it up. Don't overwrite values that may have been set from JSONL.
  if (!tagsByTs.has(ev.ts)) tagsByTs.set(ev.ts, {});
  const t = tagsByTs.get(ev.ts);
  if (!t.change_id) t.change_id = match.change_id;
  if (!t.project && match.project) t.project = match.project;
}

for (const [ts, tags] of tagsByTs) {
  scanned++;
  if (dryRun) {
    const existing = db.prepare('SELECT change_id, project, domain FROM events WHERE ts = ?').all(ts);
    for (const row of existing) {
      const willChange =
        (tags.change_id && row.change_id == null) ||
        (tags.project && row.project == null) ||
        (tags.domain && row.domain == null);
      if (willChange) {
        updates++;
        console.log(`would update ts=${ts}:`, tags);
      }
    }
    continue;
  }
  const result = updateStmt.run({
    ts,
    change_id: tags.change_id ?? null,
    project: tags.project ?? null,
    domain: tags.domain ?? null,
  });
  updates += result.changes;
}

const taggedNow = db.prepare('SELECT COUNT(*) AS n FROM events WHERE change_id IS NOT NULL').get();
const total = db.prepare('SELECT COUNT(*) AS n FROM events').get();

db.close();

console.log(
  `${dryRun ? '[dry-run] ' : ''}scanned ${scanned} JSONL timestamps, ${updates} event row${updates === 1 ? '' : 's'} updated`,
);
console.log(`events.db: ${taggedNow.n} of ${total.n} events now tagged with change_id`);
