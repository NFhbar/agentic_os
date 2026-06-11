// Single source of truth for `claude -p` subprocess dispatch.
//
// Every place the OS spawns a claude subprocess (canonical runs route, legacy
// action route, scheduler tick) builds its invocation here, so per-run
// concerns — effort + model resolution today, wall-time caps tomorrow — are
// wired once instead of per spawn site. The audit check
// `dispatch-spawn-outside-helper` ERRORs on any spawn('claude', …) outside
// this file.
//
// Resolution precedence (mirrors the Settings app's documented chain):
//   1. The skill's own SKILL.md frontmatter (`effort:` / `model:`)
//   2. .claude/settings.local.json   (per-install override, gitignored)
//   3. .claude/settings.json         (team-tracked baseline)
//   4. null → omit the flag (Claude Code's own default applies)
//
// CRITICAL: `claude -p` does NOT read effortLevel/model from settings files
// on its own — without explicit flags the subprocess silently runs at the
// CLI default. This gap shipped twice (dashboard paths until 0.4.0, the
// cron path until this helper), which is why dispatch args are built in
// exactly one place now.
//
// Pure node built-ins — launchd-context scripts import this directly.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Minimal scalar frontmatter reader — only top-level `key: value` string
// lines, which is all effort/model resolution needs. Full parser
// consolidation is a separate change (one-shared-frontmatter-parser).
function readScalarField(text, key) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  for (const raw of m[1].split('\n')) {
    const kv = raw.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv || kv[1] !== key) continue;
    let v = kv[2].trim();
    if (!v.startsWith('"') && !v.startsWith("'")) {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v || null;
  }
  return null;
}

async function readJsonKey(path, key) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const v = parsed?.[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function readSkillField(skillName, key) {
  try {
    const text = await readFile(
      join(REPO_ROOT, '.claude', 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    return readScalarField(text, key);
  } catch {
    return null;
  }
}

export async function resolveEffortForRun(skillName) {
  if (skillName) {
    const fromSkill = await readSkillField(skillName, 'effort');
    if (fromSkill && VALID_EFFORTS.has(fromSkill)) return fromSkill;
  }
  const fromLocal = await readJsonKey(
    join(REPO_ROOT, '.claude', 'settings.local.json'),
    'effortLevel',
  );
  if (fromLocal && VALID_EFFORTS.has(fromLocal)) return fromLocal;
  const fromProject = await readJsonKey(join(REPO_ROOT, '.claude', 'settings.json'), 'effortLevel');
  return fromProject && VALID_EFFORTS.has(fromProject) ? fromProject : null;
}

export async function resolveModelForRun(skillName) {
  if (skillName) {
    const fromSkill = await readSkillField(skillName, 'model');
    if (fromSkill) return fromSkill;
  }
  const fromLocal = await readJsonKey(join(REPO_ROOT, '.claude', 'settings.local.json'), 'model');
  if (fromLocal) return fromLocal;
  return await readJsonKey(join(REPO_ROOT, '.claude', 'settings.json'), 'model');
}

// ---------------------------------------------------------------------------
// Wall-time cap resolution — per-skill, derived from measured durations.
//
// The old uniform 25-minute cap was sized to an anecdote ("longest legitimate
// run we've seen, ~15 min") while meta-curate runs averaged 41 minutes —
// migrating long skills onto the watchdog path would have killed every
// healthy run. Precedence:
//   1. `wall_time_cap_minutes:` SKILL.md frontmatter (explicit per-skill)
//   2. history-derived: 2 × p95 of the skill's successful durations in
//      events.db (runs + dispatched events), when ≥5 samples exist
//   3. floor: 25 minutes
// Everything is clamped to a 240-minute ceiling — beyond that, a hung child
// costs more than any legitimate run is worth.
// ---------------------------------------------------------------------------

export const WALL_CAP_FLOOR_MINUTES = 25;
export const WALL_CAP_CEILING_MINUTES = 240;
const WALL_CAP_HISTORY_MIN_SAMPLES = 5;

// Pure derivation — unit-tested in tests/unit/dispatch/wall-cap.test.ts.
export function deriveCapMs({ frontmatterMinutes, durationsMs }) {
  if (Number.isFinite(frontmatterMinutes) && frontmatterMinutes > 0) {
    return Math.min(frontmatterMinutes, WALL_CAP_CEILING_MINUTES) * 60_000;
  }
  const floor = WALL_CAP_FLOOR_MINUTES * 60_000;
  if (!durationsMs || durationsMs.length < WALL_CAP_HISTORY_MIN_SAMPLES) return floor;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return Math.max(floor, Math.min(2 * p95, WALL_CAP_CEILING_MINUTES * 60_000));
}

// Successful durations only — failed/capped runs would bias the percentile.
// Runs dispatched through startRun appear in BOTH halves (runs row + its
// ai-prompt event); duplicating the whole distribution leaves percentiles
// unchanged, so no dedup is attempted. node:sqlite is imported lazily so
// this module stays loadable by vitest (its resolver can't handle
// node:sqlite) and stays light for callers that never resolve caps.
async function skillDurationsMs(skillName) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(REPO_ROOT, '.claude', 'state', 'events.db'), {
      readOnly: true,
    });
    try {
      const rows = db
        .prepare(
          `SELECT duration_ms FROM runs
            WHERE skill = ? AND duration_ms IS NOT NULL
              AND state IN ('done','died-after-writeback')
           UNION ALL
           SELECT duration_ms FROM events
            WHERE skill = ? AND duration_ms IS NOT NULL AND status = 'success'
              AND kind IN ('dashboard','schedule')`,
        )
        .all(skillName, skillName);
      return rows.map((r) => r.duration_ms);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

const _capCache = new Map(); // skill -> { capMs, at }
const CAP_CACHE_TTL_MS = 10 * 60_000;

export async function resolveWallTimeCapMs(skillName) {
  const key = skillName ?? '';
  const hit = _capCache.get(key);
  if (hit && Date.now() - hit.at < CAP_CACHE_TTL_MS) return hit.capMs;
  let frontmatterMinutes = null;
  if (skillName) {
    const v = await readSkillField(skillName, 'wall_time_cap_minutes');
    const n = v != null ? Number.parseInt(v, 10) : Number.NaN;
    if (Number.isFinite(n) && n > 0) frontmatterMinutes = n;
  }
  const durationsMs =
    skillName && frontmatterMinutes == null ? await skillDurationsMs(skillName) : [];
  const capMs = deriveCapMs({ frontmatterMinutes, durationsMs });
  _capCache.set(key, { capMs, at: Date.now() });
  return capMs;
}

// Build the full `claude` argv for a headless skill dispatch.
export async function buildClaudeArgs(prompt, skillName, { model: modelOverride = null } = {}) {
  const [effort, model] = await Promise.all([
    resolveEffortForRun(skillName ?? null),
    modelOverride ? Promise.resolve(modelOverride) : resolveModelForRun(skillName ?? null),
  ]);
  const args = [
    '-p',
    prompt,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (effort) args.push('--effort', effort);
  if (model) args.push('--model', model);
  return { args, effort, model };
}

// Spawn the subprocess — the ONLY spawn('claude', …) in the repo.
//
// opts.stdio / opts.detached exist for the durable-runs path: the canonical
// runs route redirects stdout/stderr to journal files and detaches, so the
// child survives a server restart (pipes would EPIPE the child when the
// parent dies). Defaults preserve the attached-pipe behavior for the legacy
// action route and the scheduler (migrate path-by-path).
export async function spawnClaude(
  prompt,
  skillName,
  { logPrefix = 'dispatch', stdio = ['ignore', 'pipe', 'pipe'], detached = false, model: modelOverride = null } = {},
) {
  const { args, effort, model } = await buildClaudeArgs(prompt, skillName, { model: modelOverride });
  if (effort || model) {
    // stderr: callers like eval-skill-edit's replay subcommand print JSON
    // on stdout; the dispatch log must not corrupt it.
    console.error(
      `${logPrefix}: spawning ${skillName ?? '(unknown skill)'}${effort ? ` --effort ${effort}` : ''}${model ? ` --model ${model}` : ''}`,
    );
  }
  const child = spawn('claude', args, {
    cwd: REPO_ROOT,
    stdio,
    detached,
  });
  return { child, args, effort, model };
}
