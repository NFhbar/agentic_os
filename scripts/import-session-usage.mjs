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
//
// Idempotent: re-running on the same session inserts no new rows (dedupe_key
// in events-db.mjs is content-addressed).
//
// Cost is computed from a rate table per model (see RATES below). Models not in
// the table get tokens captured but cost_usd left null. Update RATES when
// Anthropic publishes new pricing or you add support for a new model.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { recordEvent } from './events-db.mjs';
import { extractFromPrompt } from './extract-event-attribution.mjs';

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

// Per-million-token rates in USD. Update as pricing evolves. Models not listed
// here get tokens captured but cost_usd null (we don't guess).
const RATES = {
  // Mythos-class — Anthropic's flagship tier above Opus (released 2026-06-09).
  // Same pricing applies to Fable 5 (general release) and Mythos 5 (restricted).
  'claude-fable-5': { input: 10.0, output: 50.0, cache_read: 1.0, cache_write_1h: 12.5 },
  'claude-mythos-5': { input: 10.0, output: 50.0, cache_read: 1.0, cache_write_1h: 12.5 },
  // Opus 4.x family — high-cost / high-capability
  'claude-opus-4-8': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  'claude-opus-4-7': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  'claude-opus-4-5': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  // Sonnet 4.x family — mid-cost
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_1h: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_1h: 3.75 },
  // Haiku 4.x family — low-cost
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cache_read: 0.08, cache_write_1h: 1.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0, cache_read: 0.08, cache_write_1h: 1.0 },
};

function lookupRate(model) {
  if (!model) return null;
  // Strip bracketed context-window suffix (e.g. "claude-opus-4-7[1m]")
  const normalized = model.replace(/\[[^\]]+\]$/, '');
  return RATES[normalized] ?? null;
}

function computeCost(model, tokens) {
  const r = lookupRate(model);
  if (!r) return null;
  const M = 1_000_000;
  const cost =
    ((tokens.input || 0) * r.input) / M +
    ((tokens.output || 0) * r.output) / M +
    ((tokens.cache_read || 0) * r.cache_read) / M +
    ((tokens.cache_write || 0) * r.cache_write_1h) / M;
  // Round to 6 decimals — sub-cent precision is enough; full float drift looks bad
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// Extract a skill name from a slash-command user message.
//   "/os add change"          → "os"
//   "/dev-write-change foo"   → "dev-write-change"
//   "/help"                   → "help" (Claude Code builtin; still useful to track)
//   "hello world"             → null (not a slash command)
// We attribute to the literal slash-command's skill, not the dispatched skill.
// Sub-attribution (router → dispatched) is captured via record-router-event.mjs
// for OS-aware slash commands; for ad-hoc /<name> we just keep the surface name.
function extractSlashSkill(text) {
  if (!text) return null;
  const trimmed = text.trim();
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
  const out = { dryRun: false, all: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--session') {
      out.session = argv[++i];
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
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
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
