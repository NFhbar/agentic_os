// /api/pr-review/dashboard-metrics — aggregated metrics for the Dashboard tab.
//
// Queries events.db for pr-review events (semantic outcomes) + ai-prompt
// events (cost/tokens, filtered to skill=dev-pr-review) within a configurable
// window and computes:
//   - reviews_count + delta vs prior window
//   - issues_found (sum of comment_count) + delta
//   - avg_duration_seconds + delta (uses ai-prompt duration_ms — the canonical
//     end-to-end wall time of a dev-pr-review skill invocation)
//   - acceptance_rate (fraction of result=approved) + delta
//   - cost_usd_total + delta
//   - sparklines: reviews_by_day, issues_by_day
//   - severity_breakdown, category_breakdown (aggregates within window)
//   - top_repos (review counts grouped by repo)
//
// Returns one JSON blob the Dashboard renders directly — no further joins
// needed on the frontend.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';

const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

interface ReviewArgs {
  pr?: string;
  change?: string | null;
  pass?: number;
  result?: 'approved' | 'request-changes' | 'comment' | 'none';
  comment_count?: number;
  severity_breakdown?: Record<string, number>;
  category_breakdown?: Record<string, number>;
}

const STANDARD_SEVERITIES = ['bug', 'nit', 'suggestion', 'blocker'] as const;
const STANDARD_CATEGORIES = ['logic', 'security', 'performance', 'style', 'tests', 'docs'] as const;

// Parse a pr-review event's args JSON safely. Returns null when malformed.
function parseReviewArgs(raw: unknown): ReviewArgs | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ReviewArgs) : null;
  } catch {
    return null;
  }
}

// Parse a PR URL out of args.pr to extract owner/repo for top-repos grouping.
function parseRepoFromArgs(args: ReviewArgs | null): { owner: string; repo: string } | null {
  if (!args?.pr || typeof args.pr !== 'string') return null;
  const m = args.pr.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?\/pull\/\d+/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function daySlot(ts: string): string {
  // YYYY-MM-DD bucket key for sparkline binning.
  return ts.slice(0, 10);
}

function safeNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : fallback;
}

interface MetricsPayload {
  window: { days: number; from: string; to: string };
  reviews_count: number;
  reviews_count_delta: number;
  issues_found: number;
  issues_found_delta: number;
  avg_duration_seconds: number | null;
  avg_duration_seconds_delta: number | null;
  acceptance_rate: number | null;
  acceptance_rate_delta: number | null;
  cost_usd_total: number;
  cost_usd_total_delta: number;
  reviews_by_day: number[];
  issues_by_day: number[];
  severity_breakdown: Record<string, number>;
  category_breakdown: Record<string, number>;
  top_repos: Array<{ owner: string; repo: string; review_count: number }>;
}

export const prReviewMetricsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { window?: string } }>('/', async (req, reply) => {
    if (!existsSync(EVENTS_DB_PATH)) {
      reply.code(500);
      return { ok: false, error: 'events.db missing' };
    }

    // Parse + clamp window — days, default 7, max 90.
    const windowDays = Math.max(1, Math.min(90, Number.parseInt(req.query.window ?? '7', 10) || 7));
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
    const priorStart = new Date(now.getTime() - 2 * windowDays * 24 * 3600 * 1000);
    const windowStartIso = windowStart.toISOString();
    const priorStartIso = priorStart.toISOString();
    const nowIso = now.toISOString();

    const db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
    try {
      // Pull pr-review events (semantic) + ai-prompt events for dev-pr-review
      // (operational cost/duration) in one sweep covering both the current
      // and prior windows. Two windows for delta computation.
      const reviewRows = db
        .prepare(
          `SELECT ts, change_id, files_touched, raw, status, exit_status,
              json_extract(events.raw, '$.args') AS args_json
           FROM events
           WHERE action = 'pr-review' AND ts >= ?
           ORDER BY ts ASC`,
        )
        .all(priorStartIso) as Array<{
        ts: string;
        change_id: string | null;
        files_touched: string | null;
        raw: string;
        status: string | null;
        exit_status: number | null;
        args_json: string | null;
      }>;

      const aiPromptRows = db
        .prepare(
          `SELECT ts, cost_usd, duration_ms
           FROM events
           WHERE action = 'ai-prompt' AND skill = 'dev-pr-review' AND ts >= ?
           ORDER BY ts ASC`,
        )
        .all(priorStartIso) as Array<{
        ts: string;
        cost_usd: number | null;
        duration_ms: number | null;
      }>;

      // --- Bucketing pass --------------------------------------------------

      const inCurrent = (ts: string) => ts >= windowStartIso;
      const inPrior = (ts: string) => ts >= priorStartIso && ts < windowStartIso;

      // Build a day-slot list for the current window's sparklines.
      const daySlots: string[] = [];
      for (let i = windowDays - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
        daySlots.push(daySlot(d.toISOString()));
      }
      const slotIndex = new Map(daySlots.map((s, i) => [s, i]));

      const reviewsByDay = new Array<number>(windowDays).fill(0);
      const issuesByDay = new Array<number>(windowDays).fill(0);
      const severityBreakdown: Record<string, number> = {};
      const categoryBreakdown: Record<string, number> = {};
      for (const s of STANDARD_SEVERITIES) severityBreakdown[s] = 0;
      for (const c of STANDARD_CATEGORIES) categoryBreakdown[c] = 0;
      categoryBreakdown.other = 0;

      const repoCounts = new Map<string, { owner: string; repo: string; count: number }>();
      let currentReviewsCount = 0;
      let priorReviewsCount = 0;
      let currentIssuesFound = 0;
      let priorIssuesFound = 0;
      let currentApprovedCount = 0;
      let priorApprovedCount = 0;

      for (const row of reviewRows) {
        const args = parseReviewArgs(row.args_json);
        const commentCount = safeNum(args?.comment_count);
        const isCurrent = inCurrent(row.ts);
        const isPrior = inPrior(row.ts);

        if (isCurrent) {
          currentReviewsCount++;
          currentIssuesFound += commentCount;
          if (args?.result === 'approved') currentApprovedCount++;

          const slot = daySlot(row.ts);
          const idx = slotIndex.get(slot);
          if (idx !== undefined) {
            reviewsByDay[idx]++;
            issuesByDay[idx] += commentCount;
          }

          // Severity / category breakdowns: sum the per-event blobs.
          if (args?.severity_breakdown) {
            for (const [k, v] of Object.entries(args.severity_breakdown)) {
              if (STANDARD_SEVERITIES.includes(k as (typeof STANDARD_SEVERITIES)[number])) {
                severityBreakdown[k] = (severityBreakdown[k] ?? 0) + safeNum(v);
              }
            }
          }
          if (args?.category_breakdown) {
            for (const [k, v] of Object.entries(args.category_breakdown)) {
              if (STANDARD_CATEGORIES.includes(k as (typeof STANDARD_CATEGORIES)[number])) {
                categoryBreakdown[k] = (categoryBreakdown[k] ?? 0) + safeNum(v);
              } else {
                categoryBreakdown.other = (categoryBreakdown.other ?? 0) + safeNum(v);
              }
            }
          }

          // Top-repos grouping — keyed by `${owner}/${repo}` case-preserving.
          const repo = parseRepoFromArgs(args);
          if (repo) {
            const key = `${repo.owner}/${repo.repo}`;
            const existing = repoCounts.get(key);
            if (existing) existing.count++;
            else repoCounts.set(key, { owner: repo.owner, repo: repo.repo, count: 1 });
          }
        } else if (isPrior) {
          priorReviewsCount++;
          priorIssuesFound += commentCount;
          if (args?.result === 'approved') priorApprovedCount++;
        }
      }

      // Cost + duration from ai-prompt events.
      let currentCost = 0;
      let priorCost = 0;
      const currentDurations: number[] = [];
      const priorDurations: number[] = [];
      for (const row of aiPromptRows) {
        const isCurrent = inCurrent(row.ts);
        const isPrior = inPrior(row.ts);
        const cost = safeNum(row.cost_usd);
        const dur = safeNum(row.duration_ms);
        if (isCurrent) {
          currentCost += cost;
          if (dur > 0) currentDurations.push(dur);
        } else if (isPrior) {
          priorCost += cost;
          if (dur > 0) priorDurations.push(dur);
        }
      }

      const avgDurationSec = currentDurations.length
        ? Math.round(currentDurations.reduce((s, d) => s + d, 0) / currentDurations.length / 1000)
        : null;
      const avgDurationSecPrior = priorDurations.length
        ? Math.round(priorDurations.reduce((s, d) => s + d, 0) / priorDurations.length / 1000)
        : null;

      const acceptanceRate =
        currentReviewsCount > 0 ? currentApprovedCount / currentReviewsCount : null;
      const acceptanceRatePrior =
        priorReviewsCount > 0 ? priorApprovedCount / priorReviewsCount : null;

      const topRepos = [...repoCounts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((r) => ({ owner: r.owner, repo: r.repo, review_count: r.count }));

      const payload: MetricsPayload = {
        window: { days: windowDays, from: windowStartIso, to: nowIso },
        reviews_count: currentReviewsCount,
        reviews_count_delta: currentReviewsCount - priorReviewsCount,
        issues_found: currentIssuesFound,
        issues_found_delta: currentIssuesFound - priorIssuesFound,
        avg_duration_seconds: avgDurationSec,
        avg_duration_seconds_delta:
          avgDurationSec !== null && avgDurationSecPrior !== null
            ? avgDurationSec - avgDurationSecPrior
            : null,
        acceptance_rate: acceptanceRate,
        acceptance_rate_delta:
          acceptanceRate !== null && acceptanceRatePrior !== null
            ? acceptanceRate - acceptanceRatePrior
            : null,
        cost_usd_total: Number(currentCost.toFixed(4)),
        cost_usd_total_delta: Number((currentCost - priorCost).toFixed(4)),
        reviews_by_day: reviewsByDay,
        issues_by_day: issuesByDay,
        severity_breakdown: severityBreakdown,
        category_breakdown: categoryBreakdown,
        top_repos: topRepos,
      };
      return payload;
    } finally {
      db.close();
    }
  });
};
