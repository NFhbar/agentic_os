#!/usr/bin/env node
// Scheduler tick. Reads runbook entries with `schedule:` + `prompt:` frontmatter
// from vault/wiki/**, decides which are due now, and fires each via `claude -p`.
//
// Designed to be invoked every minute by launchd (or any cron-equivalent).
// Idempotent within the same minute via .claude/state/schedule-runs.json
// (dedupe key = id + minute floor).
//
// Modes:
//   node scripts/scheduler-tick.mjs              tick (fire due jobs)
//   node scripts/scheduler-tick.mjs --dry-run    list due jobs without firing
//   node scripts/scheduler-tick.mjs --list       list all schedules + next run
//   node scripts/scheduler-tick.mjs --run-id ID  force-fire one schedule by id
//
// Requires the root `npm install` (js-yaml, via the shared frontmatter
// parser) — install.sh runs it; everything else is node built-ins.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClaude } from './dispatch-claude.mjs';
import { recordEvent } from './events-db.mjs';
import { extractSkill } from './extract-event-attribution.mjs';
import { superviseRuns } from './runs-supervisor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WIKI_DIR = join(REPO_ROOT, 'vault', 'wiki');
const STATE_PATH = join(REPO_ROOT, '.claude', 'state', 'schedule-runs.json');
const LOG_PATH = join(REPO_ROOT, 'vault', 'raw', 'scheduled-runs.jsonl');

// ---------------------------------------------------------------------------
// Frontmatter parsing — shared real-YAML parser (scripts/frontmatter.mjs).
// The old flat parser here stripped only OUTER quotes, so single-quoted
// prompts with doubled-apostrophe escapes (''running'') reached `claude -p`
// still doubled. Real YAML unescapes them correctly.
// ---------------------------------------------------------------------------

import { parseFrontmatter } from './frontmatter.mjs';

function walkMd(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cron parsing (5-field: minute hour day-of-month month day-of-week).
// Supports: * | N | N-M | */N | A,B,C combinations of the above.
// ---------------------------------------------------------------------------

function parseCronField(expr, min, max) {
  const values = new Set();
  for (const part of expr.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let from;
    let to;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      from = a;
      to = b;
    } else {
      const n = parseInt(range, 10);
      from = n;
      to = n;
    }
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new Error(`invalid cron field segment: "${part}"`);
    }
    for (let v = from; v <= to; v += step) {
      if (v >= min && v <= max) values.add(v);
    }
  }
  return values;
}

export function cronMatches(expr, date) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected 5-field cron, got ${fields.length} ("${expr}")`);
  }
  const [m, h, dom, mon, dow] = fields;
  if (!parseCronField(m, 0, 59).has(date.getMinutes())) return false;
  if (!parseCronField(h, 0, 23).has(date.getHours())) return false;
  if (!parseCronField(mon, 1, 12).has(date.getMonth() + 1)) return false;
  // Standard cron quirk: if BOTH day-of-month and day-of-week are
  // restricted (neither is *), the job runs when EITHER matches (OR-logic).
  // If exactly one is *, only the other gates the run.
  const domWild = dom.trim() === '*';
  const dowWild = dow.trim() === '*';
  const domMatch = parseCronField(dom, 1, 31).has(date.getDate());
  const dowMatch = parseCronField(dow, 0, 6).has(date.getDay());
  if (domWild && dowWild) return true;
  if (domWild) return dowMatch;
  if (dowWild) return domMatch;
  return domMatch || dowMatch;
}

export function nextRun(expr, after = new Date()) {
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  // Brute force forward by minute. Cap at ~1 year so a malformed cron
  // (e.g. "0 0 31 2 *" — Feb 31, impossible) terminates.
  const limit = 60 * 24 * 366;
  for (let i = 0; i < limit; i++) {
    const t = new Date(start.getTime() + i * 60000);
    if (cronMatches(expr, t)) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schedule discovery — walk wiki, return runbooks with schedule + prompt.
// ---------------------------------------------------------------------------

export function discoverSchedules() {
  const schedules = [];
  for (const file of walkMd(WIKI_DIR)) {
    const content = readFileSync(file, 'utf8');
    const { fm } = parseFrontmatter(content);
    if (fm.type !== 'runbook') continue;
    if (!fm.schedule || !fm.prompt) continue;
    schedules.push({
      id: fm.id ?? null,
      path: relative(REPO_ROOT, file),
      title: fm.title ?? fm.id ?? '(untitled)',
      domain: fm.domain ?? null,
      schedule: fm.schedule,
      prompt: fm.prompt,
      // Optional project scoping: when set, the schedule only fires if the
      // named project's status is "active". See standard-project-workflow.md.
      project: fm.project ?? null,
      // Optional precondition: a manifest query that must match >= min entries
      // before the tick spawns Claude for this schedule. Skips empty fires when
      // there's no data for the runbook to act on. See standard-scheduled-jobs.md.
      precondition_query: fm.precondition_query ?? null,
      precondition_min: fm.precondition_min
        ? parseInt(fm.precondition_min, 10)
        : 1,
    });
  }
  return schedules;
}

// Build an id → status map of all projects in the wiki. Used by the tick to
// gate project-scoped scheduled runbooks. Re-read each tick (cheap: ~ms for
// typical project counts).
export function discoverProjectStatuses() {
  const out = new Map();
  for (const file of walkMd(WIKI_DIR)) {
    const content = readFileSync(file, 'utf8');
    const { fm } = parseFrontmatter(content);
    if (fm.type !== 'project') continue;
    if (!fm.id) continue;
    out.set(fm.id, fm.status ?? 'active');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Precondition — optional pre-fire manifest query that skips empty work.
// Lets runbooks declare "only fire if there's something for me to act on" in
// their frontmatter, so the scheduler doesn't spawn Claude for no-op runs.
// See standard-scheduled-jobs.md § Preconditions.
//
// Query grammar (flat, AND-of-clauses, whitespace-separated):
//   field=value           equality
//   field=value1|value2   OR-list (any value matches; 'null' matches unset)
//   field=set             field present + non-empty
//   field=null            field unset/null/empty string
//
// Example: 'type=change status=in-review pr_url=set ci_state=null|running'
// ---------------------------------------------------------------------------

function parsePreconditionQuery(query) {
  const clauses = [];
  for (const part of query.trim().split(/\s+/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const field = part.slice(0, eq);
    const rhs = part.slice(eq + 1);
    if (rhs === 'set') {
      clauses.push({ field, op: 'isSet' });
    } else if (rhs === 'null') {
      clauses.push({ field, op: 'isNull' });
    } else {
      clauses.push({ field, op: 'equals', values: rhs.split('|') });
    }
  }
  return clauses;
}

function clauseMatches(entry, clause) {
  const v = entry[clause.field];
  const empty = v === null || v === undefined || v === '';
  if (clause.op === 'isSet') return !empty;
  if (clause.op === 'isNull') return empty;
  // equals — 'null' as a value matches empty/missing entries
  if (empty) return clause.values.includes('null');
  return clause.values.includes(String(v));
}

export function countManifestMatches(query) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'vault', '.index', 'manifest.json'), 'utf8'),
    );
  } catch {
    return null; // manifest unavailable — caller decides whether to fire
  }
  const entries = manifest.entries ?? [];
  const clauses = parsePreconditionQuery(query);
  return entries.filter((e) => clauses.every((c) => clauseMatches(e, c))).length;
}

// ---------------------------------------------------------------------------
// State (last-run dedupe).
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { runs: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function minuteFloor(date) {
  return Math.floor(date.getTime() / 60000);
}

// ---------------------------------------------------------------------------
// Firing — spawn `claude -p`, capture stdout, log result.
// ---------------------------------------------------------------------------

async function fireJob(schedule) {
  const startedAt = new Date();
  const startedMs = Date.now();
  // Spawn via the shared dispatch helper (scripts/dispatch-claude.mjs) so
  // cron-fired runs honor the same effort/model resolution as dashboard
  // dispatches — Settings → Effort/Model + per-skill SKILL.md frontmatter.
  // stream-json + verbose: each stdout line is a JSON event carrying
  // model/tokens/cost metadata.
  const scheduledSkill = extractSkill(schedule.prompt);
  const { child } = await spawnClaude(schedule.prompt, scheduledSkill, {
    logPrefix: 'scheduler',
  });
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrAll = '';
    let combinedText = ''; // accumulated assistant text — cleaner artifact than raw event stream
    // Captured from the final result event (may stay null if the run doesn't
    // emit one — older claude versions or interrupted runs).
    let model = null;
    let tokensIn = null;
    let tokensOut = null;
    let tokensCacheRead = null;
    let tokensCacheWrite = null;
    let costUsd = null;
    let claudeDurationMs = null;
    let isError = false;

    function consumeLine(line) {
      if (!line) return;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        // Defensive: forward non-JSON content into combinedText so we never
        // silently drop output.
        combinedText += line + '\n';
        return;
      }
      if (evt.type === 'assistant') {
        const content = evt.message?.content ?? [];
        for (const part of content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            combinedText += part.text;
          }
        }
      } else if (evt.type === 'result') {
        const usage = evt.usage ?? {};
        tokensIn = usage.input_tokens ?? null;
        tokensOut = usage.output_tokens ?? null;
        tokensCacheRead = usage.cache_read_input_tokens ?? null;
        tokensCacheWrite = usage.cache_creation_input_tokens ?? null;
        costUsd = evt.total_cost_usd ?? null;
        claudeDurationMs = evt.duration_ms ?? null;
        isError = Boolean(evt.is_error);
        const modelUsage = evt.modelUsage;
        if (modelUsage) {
          const keys = Object.keys(modelUsage);
          if (keys.length > 0) model = keys[0];
        }
      }
      // Ignore type:system, type:rate_limit_event, etc.
    }

    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString('utf8');
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        consumeLine(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
      }
    });
    child.stderr.on('data', (c) => {
      stderrAll += c.toString('utf8');
    });
    child.on('close', (code) => {
      // Drain any trailing partial line (no newline terminator).
      if (stdoutBuf) consumeLine(stdoutBuf);

      const wallMs = Date.now() - startedMs;
      const preview =
        combinedText.length > 4096 ? combinedText.slice(0, 4096) + '\n…[truncated]' : combinedText;
      const entry = {
        ts: startedAt.toISOString(),
        id: schedule.id,
        schedule: schedule.schedule,
        prompt: schedule.prompt,
        // Persist project scoping in the run log so status reports can
        // filter scheduler activity per-project. null for global schedules.
        project: schedule.project ?? null,
        // outcome marker — pairs with the 'skipped' outcome emitted when a
        // precondition fails. Lets monitoring consumers (morning brief, etc.)
        // distinguish "fired" from "skipped" via a single field rather than
        // having to inspect exit codes / inferences.
        outcome: 'fired',
        exit: code,
        duration_ms: claudeDurationMs ?? wallMs,
        stdout_preview: preview,
        stderr: stderrAll.slice(0, 2048),
      };
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
      recordEvent({
        ts: entry.ts,
        kind: 'schedule',
        action: 'schedule-fire',
        source: 'launchd',
        skill: schedule.id,
        project: schedule.project ?? null,
        model,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        tokens_cache_hit: tokensCacheRead,
        tokens_cache_write: tokensCacheWrite,
        cost_usd: costUsd,
        exit_status: code,
        duration_ms: entry.duration_ms,
        status: code === 0 && !isError ? 'success' : 'error',
        prompt: schedule.prompt,
        stdout_preview: combinedText,
        stderr: stderrAll || null,
        description: `cron="${schedule.schedule}"`,
      });
      resolve(entry);
    });
    child.on('error', (e) => {
      const wallMs = Date.now() - startedMs;
      const entry = {
        ts: startedAt.toISOString(),
        id: schedule.id,
        schedule: schedule.schedule,
        prompt: schedule.prompt,
        project: schedule.project ?? null,
        outcome: 'spawn-error',
        exit: null,
        duration_ms: wallMs,
        stdout_preview: '',
        stderr: `spawn error: ${e.message}`,
      };
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
      recordEvent({
        ts: entry.ts,
        kind: 'schedule',
        action: 'schedule-fire',
        source: 'launchd',
        skill: schedule.id,
        project: schedule.project ?? null,
        exit_status: null,
        duration_ms: entry.duration_ms,
        status: 'error',
        prompt: schedule.prompt,
        stderr: entry.stderr,
        description: `cron="${schedule.schedule}"`,
      });
      resolve(entry);
    });
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function fmt(d) {
  if (!d) return '(never)';
  // Show local time since the cron matcher works in local time too —
  // displaying UTC here would just confuse the comparison.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} local`;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const listOnly = args.includes('--list');
  const runIdIdx = args.indexOf('--run-id');
  const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : null;

  const schedules = discoverSchedules();

  if (listOnly) {
    if (schedules.length === 0) {
      console.log('(no scheduled runbooks found)');
      return;
    }
    for (const s of schedules) {
      const next = nextRun(s.schedule);
      console.log(`${s.id}  schedule="${s.schedule}"  next=${fmt(next)}  prompt=${JSON.stringify(s.prompt)}`);
    }
    return;
  }

  if (runId) {
    const target = schedules.find((s) => s.id === runId);
    if (!target) {
      console.error(`schedule id "${runId}" not found`);
      process.exit(1);
    }
    console.log(`firing ${target.id} (forced)`);
    const result = await fireJob(target);
    console.log(`done exit=${result.exit} duration=${result.duration_ms}ms`);
    return;
  }

  const now = new Date();
  const nowMinute = minuteFloor(now);
  const state = loadState();
  state.runs ??= {};

  // Run supervision — liveness + wall-cap for detached `claude` children
  // (see scripts/runs-supervisor.mjs). Lives in the tick because launchd
  // keeps firing when the dashboard server is down; this is what makes runs
  // durable rather than children of a dev server. Runs every tick, before
  // the due-schedule early return.
  try {
    const sup = await superviseRuns();
    if (sup.reaped || sup.terminated || sup.escalated) {
      console.error(
        `supervisor: reaped=${sup.reaped} wall-cap-terminated=${sup.terminated} escalated=${sup.escalated}`,
      );
    }
  } catch (e) {
    console.error(`supervisor error: ${e.message}`);
  }

  // Project-scoped runbooks fire only when the named project's status is
  // "active". Skip silently otherwise — pausing a project pauses its work.
  // If the project doesn't exist at all, also skip (audit's
  // schedule-project-exists check surfaces this).
  const projectStatuses = discoverProjectStatuses();

  const due = [];
  for (const s of schedules) {
    try {
      if (!cronMatches(s.schedule, now)) continue;
    } catch (e) {
      console.error(`skip ${s.id}: ${e.message}`);
      continue;
    }
    if (s.project) {
      const status = projectStatuses.get(s.project);
      if (status !== 'active') {
        console.error(
          `skip ${s.id}: project "${s.project}" status=${status ?? 'missing'} (only fires when active)`,
        );
        recordEvent({
          ts: now.toISOString(),
          kind: 'schedule',
          action: 'schedule-skip',
          source: 'launchd',
          skill: s.id,
          project: s.project,
          status: 'skipped',
          description: `project status=${status ?? 'missing'}`,
        });
        continue;
      }
    }
    // Optional precondition: only fire if the manifest has enough matching
    // entries for the runbook to act on. Skips empty fires. See
    // standard-scheduled-jobs.md § Preconditions.
    if (s.precondition_query) {
      const matches = countManifestMatches(s.precondition_query);
      if (matches === null) {
        // Manifest missing/unreadable — fire defensively so the runbook can
        // surface the underlying problem rather than silently stalling.
        console.error(
          `warn ${s.id}: precondition manifest unavailable — firing anyway`,
        );
      } else if (matches < s.precondition_min) {
        const reason = `precondition: ${matches} matches < min ${s.precondition_min}`;
        console.error(
          `skip ${s.id}: precondition not met (${matches} matches, need ${s.precondition_min})`,
        );
        // Dual-write the skip: events.db AND scheduled-runs.jsonl. The JSONL
        // line is the one monitoring consumers (runbook-morning-brief, the
        // Schedules tab, the Health digest) actually read. Without it, skips
        // are invisible to JSONL-based heuristics — which leads to "scheduler
        // appears silent for hours" false alarms when in fact every tick
        // fired but had nothing to do.
        //
        // Schema mirrors the fire-path entry (line 370) but adds outcome +
        // skip_reason fields so consumers can distinguish "fired" from
        // "skipped" without having to inspect exit codes.
        const skipEntry = {
          ts: now.toISOString(),
          id: s.id,
          schedule: s.schedule,
          prompt: s.prompt,
          project: s.project ?? null,
          outcome: 'skipped',
          skip_reason: reason,
        };
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, JSON.stringify(skipEntry) + '\n');
        recordEvent({
          ts: now.toISOString(),
          kind: 'schedule',
          action: 'schedule-skip',
          source: 'launchd',
          skill: s.id,
          project: s.project ?? null,
          status: 'skipped',
          description: reason,
        });
        continue;
      }
    }
    const last = state.runs[s.id]?.lastRunMinute;
    if (last === nowMinute) continue; // already fired this minute
    due.push(s);
  }

  if (dryRun) {
    console.log(`now=${fmt(now)}  total=${schedules.length}  due=${due.length}`);
    for (const s of due) {
      console.log(
        `  - ${s.id}  schedule="${s.schedule}"${s.project ? `  project=${s.project}` : ''}`,
      );
    }
    return;
  }

  if (due.length === 0) return;

  await Promise.all(
    due.map(async (s) => {
      state.runs[s.id] = { lastRunMinute: nowMinute, lastRunIso: now.toISOString() };
      saveState(state); // persist before firing so a crash mid-fire still dedupes
      const result = await fireJob(s);
      state.runs[s.id].lastExit = result.exit;
      state.runs[s.id].lastDurationMs = result.duration_ms;
      saveState(state);
    }),
  );
}

// Only run when invoked directly (allow importing functions for tests).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
