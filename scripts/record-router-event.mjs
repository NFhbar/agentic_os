#!/usr/bin/env node
// Dual-write wrapper for router events. Invoked by the `os` skill after every
// dispatch. Atomically appends one line to vault/raw/router-log.jsonl AND
// inserts a row in events.db. Replaces the previous JSONL-only append so that
// real-time Insights captures CLI-driven activity (was previously visible only
// after the next backfill).
//
// Usage:
//   node scripts/record-router-event.mjs \
//     --intent "<original user phrase>" \
//     [--skill <matched-skill-name>] \
//     [--confidence high|low|miss] \
//     [--fallback asked-user]
//
// Why a node script over a Bash heredoc: keeps the JSON shape canonical
// (one place to evolve), keeps the events.db helper import out of the
// skill body, and gives us a single atomic operation per dispatch.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEvent } from './events-db.mjs';
import { extractFromIntent } from './extract-event-attribution.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_PATH = join(REPO_ROOT, 'vault', 'raw', 'router-log.jsonl');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    // Treat lone --foo as a boolean (no value follows or next is another flag).
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const intent = args.intent;
  if (!intent || intent === true) {
    console.error('record-router-event: --intent is required');
    process.exit(2);
  }
  const skill = typeof args.skill === 'string' ? args.skill : null;
  const confidence = typeof args.confidence === 'string' ? args.confidence : 'miss';
  const fallback = typeof args.fallback === 'string' ? args.fallback : null;
  const ts = new Date().toISOString();

  // 1. JSONL line — keep the historical shape so existing readers (Activity
  //    view, audit, backfill) don't churn.
  const line = {
    ts,
    intent,
    matched_skill: skill,
    confidence,
    fallback,
  };
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(line) + '\n');

  // Attribution via the shared helper.
  const { change_id, project, report_id } = extractFromIntent(intent);

  // 2. Structured row.
  recordEvent({
    ts,
    kind: 'router',
    action: 'route',
    source: 'cli',
    skill,
    change_id,
    project,
    report_id,
    status: skill ? 'success' : confidence === 'miss' ? 'unmatched' : 'success',
    description: `intent: ${intent}`,
  });
}

main();
