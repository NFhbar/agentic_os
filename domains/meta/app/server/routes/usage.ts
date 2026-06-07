// /api/usage — dashboard mirror of Claude Code's `/usage` slash command.
//
// Data source: events.db rows with kind='session', populated by
// scripts/import-session-usage.mjs. That script walks the local session
// transcripts at ~/.claude/projects/<sanitized-cwd>/*.jsonl and buckets each
// user prompt → assistant turn into a row with tokens + computed cost.
//
// Two endpoints:
//
//   GET  /api/usage?window=24h|7d   — aggregates from events.db (no sync)
//   POST /api/usage/sync            — runs import-session-usage.mjs --all to
//                                     refresh events.db with the latest
//                                     transcript data, returns counts
//
// Aggregates mirror what `/usage` displays: totals (cost, tokens, duration,
// turn count), by-skill, by-model. Per-day series is included as a small
// trend extension — cheap to compute and useful for spotting runaway runs.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts
import { queryEvents } from '../../../../../scripts/events-db.mjs';
import { REPO_ROOT } from '../repo.js';

type WindowSpec = '24h' | '7d' | '30d';
const WINDOW_MS: Record<WindowSpec, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface SessionEventRow {
  id: number;
  ts: string;
  kind: string;
  skill: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_hit: number | null;
  tokens_cache_write: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

interface Totals {
  turns: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  duration_ms: number;
}

interface BySkillRow {
  skill: string;
  turns: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

interface ByModelRow {
  model: string;
  turns: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

interface ByDayRow {
  day: string; // YYYY-MM-DD (UTC)
  turns: number;
  cost_usd: number;
}

interface UsageResponse {
  window: WindowSpec;
  since: string;
  totals: Totals;
  by_skill: BySkillRow[];
  by_model: ByModelRow[];
  by_day: ByDayRow[];
  sample_count: number;
  truncated: boolean;
}

const QUERY_LIMIT = 5000;

function emptyTotals(): Totals {
  return {
    turns: 0,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    duration_ms: 0,
  };
}

function aggregate(rows: SessionEventRow[]): {
  totals: Totals;
  by_skill: BySkillRow[];
  by_model: ByModelRow[];
  by_day: ByDayRow[];
} {
  const totals = emptyTotals();
  const skillMap = new Map<string, BySkillRow>();
  const modelMap = new Map<string, ByModelRow>();
  const dayMap = new Map<string, ByDayRow>();

  for (const r of rows) {
    totals.turns += 1;
    totals.cost_usd += r.cost_usd ?? 0;
    totals.tokens_in += r.tokens_in ?? 0;
    totals.tokens_out += r.tokens_out ?? 0;
    totals.tokens_cache_read += r.tokens_cache_hit ?? 0;
    totals.tokens_cache_write += r.tokens_cache_write ?? 0;
    totals.duration_ms += r.duration_ms ?? 0;

    const skill = r.skill ?? '(interactive)';
    const sRow = skillMap.get(skill) ?? {
      skill,
      turns: 0,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
    };
    sRow.turns += 1;
    sRow.cost_usd += r.cost_usd ?? 0;
    sRow.tokens_in += r.tokens_in ?? 0;
    sRow.tokens_out += r.tokens_out ?? 0;
    skillMap.set(skill, sRow);

    if (r.model) {
      const mRow = modelMap.get(r.model) ?? {
        model: r.model,
        turns: 0,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
      };
      mRow.turns += 1;
      mRow.cost_usd += r.cost_usd ?? 0;
      mRow.tokens_in += r.tokens_in ?? 0;
      mRow.tokens_out += r.tokens_out ?? 0;
      modelMap.set(r.model, mRow);
    }

    const day = r.ts.slice(0, 10);
    const dRow = dayMap.get(day) ?? { day, turns: 0, cost_usd: 0 };
    dRow.turns += 1;
    dRow.cost_usd += r.cost_usd ?? 0;
    dayMap.set(day, dRow);
  }

  return {
    totals,
    by_skill: [...skillMap.values()].sort((a, b) => b.cost_usd - a.cost_usd),
    by_model: [...modelMap.values()].sort((a, b) => b.cost_usd - a.cost_usd),
    by_day: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

function parseWindow(raw: string | undefined): WindowSpec {
  if (raw === '7d' || raw === '30d' || raw === '24h') return raw;
  return '24h';
}

export const usageRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { window?: string } }>('/', async (req): Promise<UsageResponse> => {
    const window = parseWindow(req.query?.window);
    const since = new Date(Date.now() - WINDOW_MS[window]).toISOString();
    const rows = queryEvents({
      kind: 'session',
      since,
      limit: QUERY_LIMIT,
    }) as SessionEventRow[];
    const { totals, by_skill, by_model, by_day } = aggregate(rows);
    return {
      window,
      since,
      totals,
      by_skill,
      by_model,
      by_day,
      sample_count: rows.length,
      truncated: rows.length >= QUERY_LIMIT,
    };
  });

  // POST /sync — run import-session-usage.mjs --all to pull newest transcript
  // data into events.db. Returns counts. Long-ish (a few seconds for a busy
  // project) — UI shows a spinner.
  fastify.post('/sync', async (_req, reply) => {
    const scriptPath = join(REPO_ROOT, 'scripts', 'import-session-usage.mjs');
    return await new Promise((resolve) => {
      const child = spawn('node', [scriptPath, '--all'], {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => {
        stdout += b.toString();
      });
      child.stderr.on('data', (b) => {
        stderr += b.toString();
      });
      child.on('error', (e) => {
        reply.code(500);
        resolve({ ok: false, error: e.message, stderr });
      });
      child.on('close', (code) => {
        // Parse the trailing "total — buckets=N  inserted=M  deduped=K..."
        // line for a clean payload. Falls back to raw stdout if parsing
        // fails (the user can still read it in the UI).
        const m = stdout.match(
          /total — buckets=(\d+)\s+inserted=(\d+)\s+deduped=(\d+)\s+no-cost=(\d+)/,
        );
        const parsed = m
          ? {
              buckets: Number(m[1]),
              inserted: Number(m[2]),
              deduped: Number(m[3]),
              no_cost: Number(m[4]),
            }
          : null;
        if (code !== 0) reply.code(500);
        resolve({
          ok: code === 0,
          exit_code: code,
          parsed,
          stdout_tail: stdout.split('\n').slice(-15).join('\n'),
          stderr: stderr.slice(-2000),
        });
      });
    });
  });
};
