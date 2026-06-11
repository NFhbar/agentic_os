#!/usr/bin/env node
// Import per-turn token usage from a Claude Code session JSONL into events.db.
//
// Closes the observability gap: in-session events (user typing `/os …` or
// freeform chat) consume tokens but don't go through any subprocess we can
// meter from the outside. Claude Code itself records the usage in its session
// transcript at:
//
//   ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl
//
// This script walks that file, buckets it by user-string-message (each user
// prompt → one bucket of subsequent assistant work + tool results), computes
// tokens + cost per bucket, and inserts one events.db row per bucket with
// kind='session'.
//
// Usage:
//   node scripts/import-session-usage.mjs                    # imports latest session for this project
//   node scripts/import-session-usage.mjs --session <path>   # specific session file
//   node scripts/import-session-usage.mjs --all              # all sessions for this project
//   node scripts/import-session-usage.mjs --dry-run          # show what would be inserted
//   node scripts/import-session-usage.mjs --recompute-costs  # re-price existing session rows
//   node scripts/import-session-usage.mjs --backfill-skills  # repair slash attribution on existing rows
//
// Idempotent: re-running on the same session inserts no new rows (dedupe_key
// in events-db.mjs is content-addressed).
//
// Cost is computed via scripts/models-registry.mjs (the single pricing
// source — rates + math live there, validated against CLI-reported
// total_cost_usd). Models not in the registry get tokens captured but
// cost_usd left null.
//
// --recompute-costs exists because historical rows were priced under a
// wrong rate table (pre-4.5 Opus list price, 3× overstatement — found by
// the Fable self-review): it re-prices every kind='session' row from its
// stored token counts using the current registry. Dispatched-run rows are
// untouched — their cost_usd came from the CLI itself.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { recordEvent } from './events-db.mjs';
import { extractFromPrompt } from './extract-event-attribution.mjs';
import { computeCost } from './models-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Map the current cwd to the Claude Code sessions directory.
// Claude Code sanitizes paths by replacing /, _ (and other non-[a-zA-Z0-9-])
// characters with `-`. The leading slash becomes a leading dash.
//   /Users/alice/Code/agentic_os
//     → -Users-alice-Code-agentic-os
function sanitizeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}
const SESSIONS_DIR = join(
  homedir(),
  '.claude',
  'projects',
  sanitizeCwd(REPO_ROOT),
);

// Pricing lives in scripts/models-registry.mjs — computeCost is imported
// above. (This file used to carry its own RATES duplicate of the registry;
// the two drifted in lockstep-by-hand until the Fable self-review flagged
// it. One table, one math site now.)

// Extract a skill name from a slash-command user message.
//
// Claude Code stores slash invocations in transcripts as XML, e.g.:
//   <command-message>os</command-message>
//   <command-name>/os</command-name>
//   <command-args>brief</command-args>
// <command-name> is canonical (carries the leading slash). The bare "/name"
// form is kept as a fallback for older transcripts. Until 2026-06-11 only
// the bare form was matched, so every XML-form invocation — including all
// `/os` router dispatches — imported as an anonymous interactive-turn
// (Fable review Finding 2.1); `--backfill-skills` repairs those rows.
//
// We attribute to the literal slash-command's skill, not the dispatched
// skill. Sub-attribution (router → dispatched) is captured via
// record-router-event.mjs for OS-aware slash commands.
export function extractSlashSkill(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const name = trimmed.match(/<command-name>\/?([a-z][a-z0-9-]*)/);
  if (name) return name[1];
  if (trimmed.startsWith('<command-message>')) {
    const msg = trimmed.match(/^<command-message>([a-z][a-z0-9-]*)/);
    if (msg) return msg[1];
  }
  if (!trimmed.startsWith('/')) return null;
  // Must look like a slash command — short token after the slash
  const m = trimmed.match(/^\/([a-z][a-z0-9-]*)\b/);
  return m ? m[1] : null;
}

function trimPreview(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function parseTs(s) {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function isUserStringMessage(line) {
  if (line.type !== 'user') return false;
  const content = line.message?.content;
  return typeof content === 'string';
}

function isAssistantWithUsage(line) {
  if (line.type !== 'assistant') return false;
  return Boolean(line.message?.usage);
}

function importSession(sessionPath, { dryRun = false } = {}) {
  const text = readFileSync(sessionPath, 'utf8');
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, '');
  const lines = text.split('\n').filter(Boolean);

  let buckets = [];
  let current = null;

  function closeBucket() {
    if (!current) return;
    // Skip empty buckets (user message with no assistant work — happens at session end)
    if (current.tokens.input === 0 && current.tokens.output === 0) {
      current = null;
      return;
    }
    buckets.push(current);
    current = null;
  }

  for (const raw of lines) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isUserStringMessage(line)) {
      closeBucket();
      const content = line.message.content;
      current = {
        startTs: line.timestamp,
        endTs: line.timestamp,
        userMessage: content,
        slashSkill: extractSlashSkill(content),
        sessionId: line.sessionId || sessionId,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        model: null,
      };
    } else if (isAssistantWithUsage(line)) {
      if (!current) continue; // orphan assistant message
      const u = line.message.usage;
      current.tokens.input += u.input_tokens || 0;
      current.tokens.output += u.output_tokens || 0;
      current.tokens.cache_read += u.cache_read_input_tokens || 0;
      current.tokens.cache_write += u.cache_creation_input_tokens || 0;
      current.model = line.message.model || current.model;
      current.endTs = line.timestamp;
    }
  }
  closeBucket();

  // Emit events
  let inserted = 0;
  let deduped = 0;
  let costless = 0;
  for (const b of buckets) {
    const cost = computeCost(b.model, b.tokens);
    if (cost == null) costless++;
    const durationMs = (parseTs(b.endTs) ?? 0) - (parseTs(b.startTs) ?? 0);
    const isSlash = Boolean(b.slashSkill);
    const payload = {
      ts: b.startTs,
      kind: 'session',
      action: isSlash ? 'slash-command' : 'interactive-turn',
      source: 'in-session',
      skill: b.slashSkill,
      ...extractFromPrompt(b.userMessage),
      model: b.model,
      tokens_in: b.tokens.input,
      tokens_out: b.tokens.output,
      tokens_cache_hit: b.tokens.cache_read,
      tokens_cache_write: b.tokens.cache_write,
      cost_usd: cost,
      duration_ms: durationMs > 0 ? durationMs : null,
      status: 'success',
      description: trimPreview(b.userMessage.replace(/\s+/g, ' '), 200),
      prompt: trimPreview(b.userMessage, 4096),
      origin_log: `import:session:${b.sessionId}`,
      // Include the bucket span in raw so dedupe is content-addressed across re-runs
      raw: JSON.stringify({
        sessionId: b.sessionId,
        start: b.startTs,
        end: b.endTs,
        model: b.model,
        tokens: b.tokens,
      }),
    };

    if (dryRun) {
      inserted++;
      continue;
    }
    const r = recordEvent(payload);
    if (r.error) {
      // Already logged to stderr by helper
    } else if (r.deduped) {
      deduped++;
    } else {
      inserted++;
    }
  }

  return {
    sessionPath,
    sessionId,
    totalBuckets: buckets.length,
    inserted,
    deduped,
    costless,
  };
}

function listSessions() {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const p = join(SESSIONS_DIR, f);
      return { path: p, mtimeMs: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function parseArgs(argv) {
  const out = {
    dryRun: false,
    all: false,
    session: null,
    recomputeCosts: false,
    backfillSkills: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--recompute-costs') out.recomputeCosts = true;
    else if (a === '--backfill-skills') out.backfillSkills = true;
    else if (a === '--session') {
      out.session = argv[++i];
    }
  }
  return out;
}

// Re-price every kind='session' row from its stored token counts using the
// current registry. Token counts are authoritative (read from transcripts);
// cost_usd was derived from them — deriving again is safe and idempotent.
// Dispatched-run rows (kind='dashboard'/'schedule') are never touched: their
// cost_usd came from the CLI's own result event, which is the ground truth
// the registry is validated against.
async function recomputeSessionCosts() {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(dbPath)) {
    console.error(`events.db not found at ${dbPath}`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT id, model, tokens_in, tokens_out, tokens_cache_hit, tokens_cache_write, cost_usd FROM events WHERE kind='session'",
    )
    .all();
  const update = db.prepare('UPDATE events SET cost_usd = ? WHERE id = ?');
  let updated = 0;
  let unchanged = 0;
  let noRate = 0;
  let oldTotal = 0;
  let newTotal = 0;
  for (const r of rows) {
    oldTotal += r.cost_usd ?? 0;
    const cost = computeCost(r.model, {
      input: r.tokens_in,
      output: r.tokens_out,
      cache_read: r.tokens_cache_hit,
      cache_write: r.tokens_cache_write,
    });
    if (cost == null) {
      noRate++;
      newTotal += r.cost_usd ?? 0;
      continue;
    }
    newTotal += cost;
    if (r.cost_usd === cost) {
      unchanged++;
    } else {
      update.run(cost, r.id);
      updated++;
    }
  }
  db.close();
  console.log(
    `recomputed session costs — rows=${rows.length} updated=${updated} unchanged=${unchanged} no-rate=${noRate}`,
  );
  console.log(`  total session cost_usd: $${oldTotal.toFixed(2)} → $${newTotal.toFixed(2)}`);
}

// Repair skill attribution on already-imported rows whose user message was
// the XML slash-command form the old matcher missed. The stored `prompt`
// column carries the message (4096-char trim — the XML header is at the
// front, so parsing it is safe). Also flips action → 'slash-command' so
// per-action analytics stop counting these as freeform turns.
async function backfillSlashAttribution() {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(dbPath)) {
    console.error(`events.db not found at ${dbPath}`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT id, prompt FROM events WHERE kind='session' AND skill IS NULL AND prompt LIKE '<command-%'",
    )
    .all();
  const update = db.prepare("UPDATE events SET skill = ?, action = 'slash-command' WHERE id = ?");
  let updated = 0;
  let unparsed = 0;
  for (const r of rows) {
    const skill = extractSlashSkill(r.prompt ?? '');
    if (!skill) {
      unparsed++;
      continue;
    }
    update.run(skill, r.id);
    updated++;
  }
  db.close();
  console.log(
    `backfilled slash attribution — candidates=${rows.length} updated=${updated} unparsed=${unparsed}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.recomputeCosts) {
    await recomputeSessionCosts();
    return;
  }
  if (args.backfillSkills) {
    await backfillSlashAttribution();
    return;
  }
  let sessions;
  if (args.session) {
    if (!existsSync(args.session)) {
      console.error(`session file not found: ${args.session}`);
      process.exit(2);
    }
    sessions = [{ path: args.session }];
  } else {
    const list = listSessions();
    if (list.length === 0) {
      console.error(`no session files found at ${SESSIONS_DIR}`);
      process.exit(1);
    }
    sessions = args.all ? list : [list[0]];
  }

  console.log(
    `importing ${sessions.length} session(s) — ${args.dryRun ? 'DRY RUN, no writes' : 'writing to events.db'}`,
  );
  let totalInserted = 0;
  let totalDeduped = 0;
  let totalBuckets = 0;
  let totalCostless = 0;
  for (const s of sessions) {
    const r = importSession(s.path, { dryRun: args.dryRun });
    console.log(
      `  ${basename(s.path)}  buckets=${r.totalBuckets}  inserted=${r.inserted}  deduped=${r.deduped}  no-cost=${r.costless}`,
    );
    totalInserted += r.inserted;
    totalDeduped += r.deduped;
    totalBuckets += r.totalBuckets;
    totalCostless += r.costless;
  }
  console.log(
    `total — buckets=${totalBuckets}  inserted=${totalInserted}  deduped=${totalDeduped}  no-cost=${totalCostless}`,
  );
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
