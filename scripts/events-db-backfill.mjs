#!/usr/bin/env node
// Seed events.db from the historical JSONL logs in vault/raw/.
// Safe to re-run: INSERT OR IGNORE on dedupe_key skips duplicates.
//
//   node scripts/events-db-backfill.mjs            # backfill all
//   node scripts/events-db-backfill.mjs --dry-run  # count mappable lines

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEvent } from './events-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RAW_DIR = join(REPO_ROOT, 'vault', 'raw');

// One entry per JSONL log file. The mapper translates a parsed JSONL line
// into the recordEvent payload shape.
const SOURCES = [
  {
    name: 'router-log.jsonl',
    path: join(RAW_DIR, 'router-log.jsonl'),
    map: (j) => ({
      ts: j.ts,
      kind: 'router',
      action: 'route',
      source: 'cli',
      skill: j.matched_skill ?? null,
      description: j.intent ? `intent: ${j.intent}` : null,
      status: j.matched_skill ? 'success' : 'unmatched',
    }),
  },
  {
    name: 'dashboard-actions.jsonl',
    path: join(RAW_DIR, 'dashboard-actions.jsonl'),
    map: (j) => {
      const action = j.action ?? 'unknown';
      let skill = null;
      // ai-prompt rows that target a skill embed it in the prompt body via
      // "Skill location: .claude/skills/<name>/SKILL.md". Extract when possible
      // so the Insights view's per-skill counts include backfilled history.
      if (action === 'ai-prompt' && typeof j.prompt === 'string') {
        const m = j.prompt.match(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/);
        if (m) skill = m[1];
      }
      return {
        ts: j.ts,
        kind: 'dashboard',
        action,
        source: 'dashboard',
        skill,
        exit_status: j.exit_status ?? null,
        files_touched: j.files_touched ?? null,
        prompt: j.prompt ?? null,
        status:
          j.exit_status == null ? null : j.exit_status === 0 ? 'success' : 'error',
      };
    },
  },
  {
    name: 'scheduled-runs.jsonl',
    path: join(RAW_DIR, 'scheduled-runs.jsonl'),
    map: (j) => ({
      ts: j.ts,
      kind: 'schedule',
      action: 'schedule-fire',
      source: 'launchd',
      skill: j.id ?? null,
      project: j.project ?? null,
      exit_status: j.exit ?? null,
      duration_ms: j.duration_ms ?? null,
      prompt: j.prompt ?? null,
      stdout_preview: j.stdout_preview ?? null,
      stderr: j.stderr ?? null,
      description: j.schedule ? `schedule="${j.schedule}"` : null,
      status:
        j.exit == null ? 'unknown' : j.exit === 0 ? 'success' : 'error',
    }),
  },
];

function backfillOne(source, { dryRun }) {
  if (!existsSync(source.path)) {
    return { name: source.name, file_missing: true, considered: 0, inserted: 0, deduped: 0, failed: 0 };
  }
  const lines = readFileSync(source.path, 'utf8').split('\n').filter(Boolean);
  let inserted = 0;
  let deduped = 0;
  let failed = 0;
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      failed++;
      continue;
    }
    const payload = {
      ...source.map(parsed),
      origin_log: `backfill:${source.name}`,
      raw: line,
    };
    if (dryRun) {
      inserted++;
      continue;
    }
    const r = recordEvent(payload);
    if (r.error) failed++;
    else if (r.deduped) deduped++;
    else inserted++;
  }
  return {
    name: source.name,
    considered: lines.length,
    inserted,
    deduped,
    failed,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const results = SOURCES.map((s) => backfillOne(s, { dryRun }));
  const pad = (s, n) => String(s).padEnd(n, ' ');
  console.log(
    `${pad('file', 28)} ${pad('considered', 10)} ${pad('inserted', 10)} ${pad('deduped', 10)} ${pad('failed', 8)}`,
  );
  for (const r of results) {
    if (r.file_missing) {
      console.log(`${pad(r.name, 28)} (missing — skipped)`);
    } else {
      console.log(
        `${pad(r.name, 28)} ${pad(r.considered, 10)} ${pad(r.inserted, 10)} ${pad(r.deduped, 10)} ${pad(r.failed, 8)}`,
      );
    }
  }
  if (dryRun) console.log('\n(dry-run — no rows written)');
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
