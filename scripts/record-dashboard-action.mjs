#!/usr/bin/env node
// Generic dual-write wrapper for dashboard actions originating from skill
// bodies. The dashboard's HTTP routes already dual-write (routes/action.ts,
// routes/edit.ts) and dedicated wrappers exist for fixed-shape events
// (record-dashboard-launch.mjs, record-router-event.mjs). This wrapper
// covers everything else — the "audit log for a skill that just did something"
// pattern that previously appended to dashboard-actions.jsonl directly.
//
// Usage:
//   node scripts/record-dashboard-action.mjs \
//     --action <name> \                       (required, e.g. 'ingest-repo')
//     [--skill <skill-name>] \                (events.db attribution)
//     [--args '<json-object>'] \              (free-form payload, kept verbatim in JSONL)
//     [--files-touched '<json-array>'] \      (e.g. '["vault/wiki/foo.md"]')
//     [--exit-status <n>] \                   (defaults to 0)
//     [--description <one-line text>]         (events.db `description` column)
//
// Atomic: JSONL append + events.db INSERT in one process. If the events.db
// insert fails, the JSONL still gets the line — telemetry is best-effort and
// the audit trail in JSONL is the canonical compatibility surface.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEvent } from './events-db.mjs';
import {
  extractFromPath,
  extractFromPrompt,
  extractFromReportId,
  extractFromReviewId,
  mergeAttributions,
} from './extract-event-attribution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_PATH = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = typeof args.action === 'string' ? args.action : null;
  if (!action) {
    console.error('record-dashboard-action: --action is required');
    process.exit(2);
  }
  const skill = typeof args.skill === 'string' ? args.skill : null;
  const description = typeof args.description === 'string' ? args.description : null;
  const exitStatusRaw = args['exit-status'];
  const exitStatus =
    typeof exitStatusRaw === 'string' && exitStatusRaw.length > 0
      ? parseInt(exitStatusRaw, 10)
      : 0;

  const ts = new Date().toISOString();

  // JSONL line — preserve historical shape; only include fields the caller
  // actually provided so old consumers (Activity view, audits) don't see
  // unexpected nulls.
  const line = { ts, action };
  if (typeof args.args === 'string') {
    const parsed = safeJsonParse(args.args);
    line.args = parsed != null ? parsed : args.args;
  }
  let filesArr = null;
  if (typeof args['files-touched'] === 'string') {
    const parsed = safeJsonParse(args['files-touched']);
    filesArr = Array.isArray(parsed) ? parsed : [args['files-touched']];
    line.files_touched = filesArr;
  }
  line.exit_status = exitStatus;

  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(line) + '\n');

  // Best-effort attribution via the shared helper. Three signals, first
  // non-null wins: structured args (skills pass --args JSON), description
  // text, change-shaped paths in files_touched.
  const parsedArgs = line.args && typeof line.args === 'object' ? line.args : null;
  // Research skills' input schemas declare the arg as `report_id`, but
  // some dispatchers / older audit paths pass it as `report`. Accept both
  // for parity with extractFromPrompt() which already tries both keys.
  const argsReportId =
    parsedArgs && typeof parsedArgs.report_id === 'string'
      ? parsedArgs.report_id
      : parsedArgs && typeof parsedArgs.report === 'string'
        ? parsedArgs.report
        : null;
  const attrFromArgs = parsedArgs
    ? {
        change_id: typeof parsedArgs.change === 'string' ? parsedArgs.change : null,
        project: typeof parsedArgs.project === 'string' ? parsedArgs.project : null,
        domain: typeof parsedArgs.domain === 'string' ? parsedArgs.domain : null,
        report_id: argsReportId,
      }
    : null;
  // Review-side skills (publish, comment-mutate) carry args.review instead of
  // args.change. Resolve the review's owning change_id via the manifest so
  // those events still attribute to the right change. Falls back to null for
  // external PR reviews (no linked change).
  const attrFromReview =
    parsedArgs && typeof parsedArgs.review === 'string'
      ? extractFromReviewId(parsedArgs.review)
      : null;
  // Research-side skills carry args.report_id (canonical) or args.report
  // (legacy); resolve the owning project via the manifest so report-scoped
  // events still roll up to the project. Falls back to null when the report
  // has no project.
  const attrFromReport = argsReportId ? extractFromReportId(argsReportId) : null;
  const attrFromDescription = extractFromPrompt(description ?? '');
  let attrFromFiles = { change_id: null, domain: null };
  for (const f of filesArr ?? []) {
    const a = extractFromPath(f);
    if (a.change_id) {
      attrFromFiles = a;
      break;
    }
  }
  const attr = mergeAttributions(
    attrFromArgs,
    attrFromReview,
    attrFromReport,
    attrFromDescription,
    attrFromFiles,
  );

  // events.db row. Pass `args` so downstream consumers (e.g. the dashboard
  // metrics endpoint that calls json_extract(raw, '$.args')) can read the
  // structured payload without re-reading the JSONL audit trail. The
  // recordEvent helper JSON-stringifies the whole payload into the `raw`
  // column when no explicit `raw` is given, so `args` lives there.
  recordEvent({
    ts,
    kind: 'dashboard',
    action,
    source: 'skill',
    skill,
    change_id: attr.change_id,
    project: attr.project,
    report_id: attr.report_id,
    domain: attr.domain,
    exit_status: exitStatus,
    status: exitStatus === 0 ? 'success' : 'error',
    files_touched: filesArr,
    description,
    args: parsedArgs,
  });

  // Manifest rebuild on vault writes. The PostToolUse hook only fires for
  // the host Claude Code session — vault writes made by skills running in
  // `claude -p` subprocesses bypass it, leaving the manifest stale until
  // the next host-side write. Detect any vault/wiki/ path in files_touched
  // and run the rebuild script synchronously here so downstream consumers
  // (the audit, the dashboard's manifest reads) see fresh data.
  //
  // Best-effort: failures are swallowed (the canonical write already
  // succeeded; a stale manifest gets surfaced by the audit's
  // `manifest-stale` info finding and a manual rebuild is one command).
  const touchedVaultWiki = (filesArr ?? []).some(
    (f) => typeof f === 'string' && f.startsWith('vault/wiki/'),
  );
  if (touchedVaultWiki) {
    try {
      spawnSync('node', [join(REPO_ROOT, '.claude', 'hooks', 'rebuild-vault-index.mjs')], {
        stdio: 'ignore',
        cwd: REPO_ROOT,
      });
    } catch {
      /* manifest is best-effort; audit will catch staleness */
    }
  }
}

main();
