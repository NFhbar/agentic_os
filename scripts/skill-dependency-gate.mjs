#!/usr/bin/env node
// Skill dependency gate — "may this skill be refactored right now?", answered
// from live state rather than from memory.
//
// Refactoring a skill that live work is currently riding is how half-migrated
// lifecycles happen: a change sits in `in-progress` against the old procedure,
// a nightly runbook fires the skill at 07:00 while its SKILL.md is mid-rewrite,
// or a compaction lands the same week the skill ran twenty times and nobody
// has a baseline to compare against. This gate is the precondition for any
// skill-refactor program.
//
// Blocked when ANY of:
//   1. non-terminal entries ride the lifecycle the skill serves
//      (change / project / research-report — see LIFECYCLE_SKILLS)
//   2. a scheduled runbook references it (by name, or via an `/os <intent>`
//      phrase that OS.md's vocabulary routes to it)
//   3. run traffic for it within the last N days (default 14)
//
// Usage:
//   node scripts/skill-dependency-gate.mjs <skill>
//   node scripts/skill-dependency-gate.mjs <skill> --days 30
//   node scripts/skill-dependency-gate.mjs <skill> --json
//
// Exit 1 with reasons when blocked, 0 with an OK line when clear.
//
// The decision core (evaluateSkillDependencies + its helpers) is pure and
// sqlite-free — it takes already-shaped rows so it can be unit-tested; the CLI
// half below does the wiki walk and the events.db read. node:sqlite is imported
// lazily inside readRuns for the same reason runs-finalize.mjs does it:
// vitest's resolver cannot load it, and the core has to stay importable.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGE_SCOPED_SKILLS,
  PROJECT_SCOPED_SKILLS,
  REPORT_SCOPED_SKILLS,
} from './extract-event-attribution.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

// ---------------------------------------------------------------------------
// Decision core (pure).
// ---------------------------------------------------------------------------

export const DEFAULT_TRAFFIC_WINDOW_DAYS = 14;

// Which lifecycle each skill serves. The core of each set is the event
// attribution set (scripts/extract-event-attribution.mjs) — the same
// skill → entity mapping the audit already enforces on event rows. Those sets
// deliberately exclude the create/close skills, because for attribution the
// entity id is the skill's *output*; for dependency purposes those skills
// still ride the lifecycle, so they're added back here.
export const LIFECYCLE_SKILLS = {
  change: new Set([
    ...CHANGE_SCOPED_SKILLS,
    'dev-add-change',
    'dev-revise-plan',
    'dev-mark-pr-ready',
    'dev-pr-review-publish',
    'dev-pull-pr-comments',
  ]),
  project: new Set([
    ...PROJECT_SCOPED_SKILLS,
    'meta-add-project',
    'meta-close-project',
    'meta-reopen-project',
  ]),
  'research-report': new Set([
    ...REPORT_SCOPED_SKILLS,
    'meta-add-research-note',
    'meta-mark-research-approved',
  ]),
};

// Statuses that mean "this entry is no longer riding the lifecycle". Research
// reports have no true terminal status (they can always be updated again), so
// the resting states — the ones where no skill is expected to act next — play
// that role.
export const LIFECYCLE_TERMINAL_STATUSES = {
  change: new Set(['merged', 'abandoned']),
  project: new Set(['completed', 'cancelled']),
  'research-report': new Set(['approved', 'updated']),
};

export function lifecycleForSkill(skill) {
  for (const [lifecycle, skills] of Object.entries(LIFECYCLE_SKILLS)) {
    if (skills.has(skill)) return lifecycle;
  }
  return null;
}

// Word-boundary match so `dev-pr-review` doesn't claim a reference that is
// really to `dev-pr-review-publish`.
function mentionsSkill(text, skill) {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, 'i').test(String(text ?? ''));
}

// Everything a runbook prompt says after a `/os` token, lowercased. Runbooks
// mostly fire routed intents (`/os audit followups`) rather than skill names,
// so a name-only scan would miss most of the real references.
export function osIntentSegments(text) {
  return [...String(text ?? '').matchAll(/\/os\s+([^\n"']*)/g)].map((m) => m[1].toLowerCase());
}

/**
 * Does a scheduled runbook reference `skill`?
 * @param {{text: string}} runbook       full entry text (frontmatter + body)
 * @param {string} skill
 * @param {string[]} [routingPhrases]    OS.md intent phrases that route to `skill`
 */
export function runbookReferencesSkill(runbook, skill, routingPhrases = []) {
  const text = runbook?.text ?? '';
  if (mentionsSkill(text, skill)) return true;
  if (routingPhrases.length === 0) return false;
  const segments = osIntentSegments(text);
  return segments.some((seg) => routingPhrases.some((p) => seg.includes(p.toLowerCase())));
}

function refLine(entry) {
  return entry.status ? `${entry.id} (${entry.status})` : entry.id;
}

function capped(list, limit = 5) {
  const shown = list.slice(0, limit);
  if (list.length > limit) shown.push(`…and ${list.length - limit} more`);
  return shown;
}

/**
 * Pure decision core.
 *
 * @param {object} input
 * @param {string} input.skill
 * @param {number} [input.nowMs]
 * @param {number} [input.days]                            traffic window
 * @param {Array<{id: string, path?: string, status?: string|null}>} [input.entries]
 *        every entry of the skill's lifecycle — terminal filtering happens here
 * @param {Array<{id: string, path?: string, text: string}>} [input.runbooks]
 *        scheduled runbooks only (a `schedule:` + `prompt:` runbook entry)
 * @param {Array<{id?: string, startedAt: string}>} [input.runs]
 *        runs attributed to this skill — window filtering happens here
 * @param {string[]} [input.routingPhrases]                OS.md phrases routing to `skill`
 * @returns {{skill, lifecycle, days, blocked, reasons: Array<{kind, detail, refs}>}}
 */
export function evaluateSkillDependencies({
  skill,
  nowMs = Date.now(),
  days = DEFAULT_TRAFFIC_WINDOW_DAYS,
  entries = [],
  runbooks = [],
  runs = [],
  routingPhrases = [],
}) {
  const lifecycle = lifecycleForSkill(skill);
  const reasons = [];

  if (lifecycle) {
    const terminal = LIFECYCLE_TERMINAL_STATUSES[lifecycle];
    const live = entries.filter((e) => !terminal.has(String(e.status ?? '')));
    if (live.length > 0) {
      reasons.push({
        kind: 'live-lifecycle-entry',
        detail: `${live.length} non-terminal ${lifecycle} ${live.length === 1 ? 'entry rides' : 'entries ride'} the ${lifecycle} lifecycle this skill serves`,
        refs: capped(live.map(refLine)),
      });
    }
  }

  const referencing = runbooks.filter((rb) => runbookReferencesSkill(rb, skill, routingPhrases));
  if (referencing.length > 0) {
    reasons.push({
      kind: 'scheduled-runbook',
      detail: `${referencing.length} scheduled runbook(s) reference this skill — a refactor lands mid-fire`,
      refs: capped(referencing.map((rb) => rb.id)),
    });
  }

  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  const recent = runs
    .map((r) => ({ ...r, startedMs: Date.parse(String(r.startedAt ?? '')) }))
    .filter((r) => Number.isFinite(r.startedMs) && r.startedMs >= cutoffMs);
  if (recent.length > 0) {
    const latest = recent.reduce((a, b) => (b.startedMs > a.startedMs ? b : a));
    reasons.push({
      kind: 'recent-run-traffic',
      detail: `${recent.length} run(s) in the last ${days} days (latest ${new Date(latest.startedMs).toISOString()})`,
      refs: capped(recent.map((r) => r.id ?? String(r.startedAt))),
    });
  }

  return { skill, lifecycle, days, blocked: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// CLI half — wiki walk + events.db read.
// ---------------------------------------------------------------------------

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

// One pass over the wiki: lifecycle entries of `type` + every scheduled runbook.
function readWiki(entryType) {
  const entries = [];
  const runbooks = [];
  for (const file of walkMd(join(REPO_ROOT, 'vault', 'wiki'))) {
    let content;
    let fm;
    try {
      content = readFileSync(file, 'utf8');
      ({ fm } = parseFrontmatter(content));
    } catch {
      continue;
    }
    if (!fm) continue;
    const rel = relative(REPO_ROOT, file);
    if (entryType && fm.type === entryType) {
      entries.push({ id: fm.id ?? rel, path: rel, status: fm.status ?? null });
    }
    if (fm.type === 'runbook' && fm.schedule && fm.prompt) {
      runbooks.push({ id: fm.id ?? rel, path: rel, text: content });
    }
  }
  return { entries, runbooks };
}

// Intent phrases OS.md routes to `skill`. Same table shape checkRouter parses.
function routingPhrasesFor(skill) {
  const phrases = [];
  const osMdPath = join(REPO_ROOT, 'OS.md');
  if (!existsSync(osMdPath)) return phrases;
  const lines = readFileSync(osMdPath, 'utf8').split('\n');
  let i = lines.findIndex((l) => /^#{2,4}\s+Intent vocabulary/i.test(l));
  if (i < 0) return phrases;
  while (i < lines.length && !lines[i].trim().startsWith('|')) i++;
  i += 2; // skip header + separator
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    const cells = lines[i].trim().split('|').slice(1, -1).map((c) => c.trim());
    const target = cells.length >= 2 ? cells[1].match(/`([^`]+)`/) : null;
    if (target && target[1] === skill) {
      for (const m of cells[0].matchAll(/`([^`]+)`/g)) phrases.push(m[1]);
    }
    i++;
  }
  return phrases;
}

// Runs attributed to `skill`, within the window. `runs.skill` is stamped at
// dispatch (scripts/runs-db.mjs startRun); legacy rows without it are invisible
// here, which is the conservative direction for a gate that blocks on traffic.
async function readRuns(skill, sinceIso) {
  if (!existsSync(EVENTS_DB_PATH)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH);
  } catch {
    return [];
  }
  try {
    return db
      .prepare('SELECT id, started_at FROM runs WHERE skill = ? AND started_at >= ? ORDER BY started_at')
      .all(skill, sinceIso)
      .map((r) => ({ id: r.id, startedAt: r.started_at }));
  } catch {
    return []; // runs table absent — covered by the audit's runs-db checks
  } finally {
    db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : DEFAULT_TRAFFIC_WINDOW_DAYS;
  // Positional: the first non-flag arg that isn't --days' value.
  const skill = args.find((a, idx) => !a.startsWith('--') && !(daysIdx >= 0 && idx === daysIdx + 1));

  if (!skill) {
    console.error('usage: node scripts/skill-dependency-gate.mjs <skill> [--days N] [--json]');
    process.exit(1);
  }
  if (!Number.isFinite(days) || days < 0) {
    console.error(`--days must be a non-negative integer (got "${args[daysIdx + 1]}")`);
    process.exit(1);
  }
  if (!existsSync(join(REPO_ROOT, '.claude', 'skills', skill, 'SKILL.md'))) {
    // A typo must not read as "clear to refactor".
    console.error(`unknown skill "${skill}" — no .claude/skills/${skill}/SKILL.md`);
    process.exit(1);
  }

  const nowMs = Date.now();
  const lifecycle = lifecycleForSkill(skill);
  const { entries, runbooks } = readWiki(lifecycle);
  const sinceIso = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  const result = evaluateSkillDependencies({
    skill,
    nowMs,
    days,
    entries,
    runbooks,
    runs: await readRuns(skill, sinceIso),
    routingPhrases: routingPhrasesFor(skill),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.blocked) {
    console.error(`BLOCKED  ${skill} — ${result.reasons.length} reason(s)`);
    for (const r of result.reasons) {
      console.error(`  [${r.kind}] ${r.detail}`);
      for (const ref of r.refs) console.error(`      - ${ref}`);
    }
  } else {
    const lifecyclePart = lifecycle ? `${lifecycle} lifecycle clear` : 'no lifecycle entries ride it';
    console.log(
      `OK  ${skill} — safe to refactor (${lifecyclePart}, no scheduled runbook references, no runs in the last ${days} days)`,
    );
  }
  process.exit(result.blocked ? 1 : 0);
}

// Only run when invoked directly (allow importing the core for tests).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
