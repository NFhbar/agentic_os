import type { Dirent } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import { startRun } from './runs.js';
import type { RunEntry, ScheduleSummary } from './schedules.types.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./schedules.types.js per standard-shared-types.
export type {
  RunEntry,
  RunOutcome,
  ScheduleStatus,
  ScheduleSummary,
  SchedulesListResponse,
} from './schedules.types.js';

// ---------------------------------------------------------------------------
// Cron logic — mirror of scripts/scheduler-tick.mjs. Kept inline so the route
// doesn't reach into the cross-app scripts/ tree. If we ever extract a shared
// package this duplication goes away.
// ---------------------------------------------------------------------------

function parseCronField(expr: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of expr.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number.parseInt(stepStr, 10) : 1;
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      from = a;
      to = b;
    } else {
      const n = Number.parseInt(range, 10);
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

function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected 5-field cron, got ${fields.length} ("${expr}")`);
  }
  const [m, h, dom, mon, dow] = fields;
  if (!parseCronField(m, 0, 59).has(date.getMinutes())) return false;
  if (!parseCronField(h, 0, 23).has(date.getHours())) return false;
  if (!parseCronField(mon, 1, 12).has(date.getMonth() + 1)) return false;
  const domWild = dom.trim() === '*';
  const dowWild = dow.trim() === '*';
  const domMatch = parseCronField(dom, 1, 31).has(date.getDate());
  const dowMatch = parseCronField(dow, 0, 6).has(date.getDay());
  if (domWild && dowWild) return true;
  if (domWild) return dowMatch;
  if (dowWild) return domMatch;
  return domMatch || dowMatch;
}

export function nextRun(expr: string, after: Date = new Date()): Date | null {
  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = 60 * 24 * 366;
  for (let i = 0; i < limit; i++) {
    const t = new Date(start.getTime() + i * 60000);
    try {
      if (cronMatches(expr, t)) return t;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function discoverSchedules(): Promise<Array<Omit<ScheduleSummary, 'last_run'>>> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  const out: Array<Omit<ScheduleSummary, 'last_run'>> = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { fm, parseError } = parseFrontmatter(content);
    if (parseError) continue;
    if (fm.type !== 'runbook') continue;
    if (typeof fm.schedule !== 'string' || typeof fm.prompt !== 'string') continue;
    const next = nextRun(fm.schedule);
    out.push({
      id: typeof fm.id === 'string' ? fm.id : null,
      path: relative(REPO_ROOT, file),
      title: typeof fm.title === 'string' ? fm.title : (fm.id ?? '(untitled)'),
      domain: typeof fm.domain === 'string' ? fm.domain : null,
      schedule: fm.schedule,
      prompt: fm.prompt,
      trigger: typeof fm.trigger === 'string' ? fm.trigger : null,
      next_run: next ? next.toISOString() : null,
      project: typeof fm.project === 'string' ? fm.project : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run-log parsing — read vault/raw/scheduled-runs.jsonl, return entries
// ---------------------------------------------------------------------------

export async function readRunLog(limit = 200): Promise<RunEntry[]> {
  const path = join(REPO_ROOT, 'vault', 'raw', 'scheduled-runs.jsonl');
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter((l) => l.trim());
  const out: RunEntry[] = [];
  // Walk backwards — newest entries appended at end.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as RunEntry);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

const RUN_LOG = join(REPO_ROOT, 'vault', 'raw', 'scheduled-runs.jsonl');

export const schedulesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/schedules — list of scheduled runbooks + a top-level status
  // summary so Overview can render the Scheduler card with a single fetch.
  fastify.get('/', async () => {
    const [schedules, runs] = await Promise.all([discoverSchedules(), readRunLog(500)]);
    const lastById = new Map<string, RunEntry>();
    for (const r of runs) {
      if (!r.id) continue;
      if (!lastById.has(r.id)) lastById.set(r.id, r); // runs is newest-first
    }

    const annotated = schedules.map<ScheduleSummary>((s) => ({
      ...s,
      last_run: s.id && lastById.has(s.id) ? extractLastRun(lastById.get(s.id) as RunEntry) : null,
    }));

    // Status summary — what Overview's Scheduler card needs at a glance.
    // Count only `fired` entries (or legacy entries with no outcome field):
    // skipped runs are healthy precondition-gates, not failures. Without this
    // guard, schedules with sparse work (e.g. PR-CI poll when no PRs are open)
    // light up the Scheduler card with bogus "failures" every tick.
    const dayAgoMs = Date.now() - 24 * 3600 * 1000;
    const last24h = runs.filter((r) => Date.parse(r.ts) >= dayAgoMs);
    const fired24h = last24h.filter((r) => !r.outcome || r.outcome === 'fired');
    const failures24h = fired24h.filter((r) => r.exit !== 0);

    // Next fire across all schedules (skip schedules without a valid next_run).
    let nextFire: { id: string | null; ts: string } | null = null;
    for (const s of annotated) {
      if (!s.next_run) continue;
      if (!nextFire || s.next_run.localeCompare(nextFire.ts) < 0) {
        nextFire = { id: s.id, ts: s.next_run };
      }
    }

    return {
      schedules: annotated,
      status: {
        count: annotated.length,
        next_fire: nextFire,
        last_24h: { runs: last24h.length, failures: failures24h.length },
      },
    };
  });

  // GET /api/schedules/runs?id=<id>&limit=20 — recent runs (filtered by id if provided).
  fastify.get<{ Querystring: { id?: string; limit?: string } }>('/runs', async (req) => {
    const id = req.query.id;
    const limit = req.query.limit ? Math.min(Number.parseInt(req.query.limit, 10) || 20, 200) : 20;
    let runs = await readRunLog(500);
    if (id) runs = runs.filter((r) => r.id === id);
    return { runs: runs.slice(0, limit) };
  });

  // POST /api/schedules/run-now { id } — fire a schedule manually, bypassing
  // the cron-due check. Dispatches through the canonical startRun() path so
  // manual fires get a runs-table row, drawer streaming, watchdog coverage,
  // and events.db cost capture — the bespoke SSE spawn this replaces had
  // none of those. The scheduled-runs.jsonl line is still appended when the
  // run finishes, so the Recent-runs list keeps manual fires.
  fastify.post<{ Body: { id: string } }>('/run-now', async (req, reply) => {
    const { id } = req.body;
    const schedules = await discoverSchedules();
    const target = schedules.find((s) => s.id === id);
    if (!target) {
      reply.code(404);
      return { ok: false, error: `schedule "${id}" not found` };
    }

    const startedAt = new Date();
    let runId: string | null = null;
    const result = await startRun({
      prompt: target.prompt,
      title: `Run now: ${target.title}`,
      tags: { skill: target.id ?? undefined },
      onFinished: (s) => {
        const preview =
          s.stdout_preview.length > 4096
            ? s.stdout_preview.slice(0, 4096) + '\n…[truncated]'
            : s.stdout_preview;
        const entry = {
          ts: startedAt.toISOString(),
          id: target.id,
          schedule: target.schedule,
          prompt: target.prompt,
          project: target.project ?? null,
          outcome: 'fired' as const,
          exit: s.exit_status,
          duration_ms: s.duration_ms,
          stdout_preview: preview,
          stderr: (s.stderr ?? '').slice(0, 2048),
          manual: true,
          run_id: runId ?? undefined,
        };
        void mkdir(dirname(RUN_LOG), { recursive: true })
          .then(() => appendFile(RUN_LOG, JSON.stringify(entry) + '\n'))
          .catch((e) => console.error('schedules: run-now log append failed', e));
      },
    });
    if (!result.ok) {
      if ('blocking' in result) {
        reply.code(409);
        return { ok: false, error: 'blocked', blocking: result.blocking };
      }
      reply.code(500);
      return { ok: false, error: result.error };
    }
    runId = result.run_id;
    return { ok: true, run_id: result.run_id };
  });
};

export function extractLastRun(r: RunEntry): ScheduleSummary['last_run'] {
  return {
    ts: r.ts,
    exit: r.exit,
    duration_ms: r.duration_ms,
    stdout_preview: r.stdout_preview,
    stderr: r.stderr,
    outcome: r.outcome,
    skip_reason: r.skip_reason,
  };
}
