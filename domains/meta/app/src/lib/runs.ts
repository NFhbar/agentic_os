// Client transport for the /api/runs surface. Wraps fetch + JSON; the SSE
// subscription reuses the existing runStream() helper from lib/api so a single
// stream consumer covers both /api/action and /api/runs/:id/stream.
//
// Wire-shape types re-exported from the server's source-of-truth per
// standard-shared-types. The client's `StartRunResult` shape (optional
// fields) is a thin wrapper around the server's discriminated union — see
// startRun() below where the unwrap happens.

import { type ActionChunk, getJson, postJson, runStream } from './api';

export type {
  RunFilter,
  RunOrigin,
  RunRecord,
  RunState,
  RunTags,
} from '../../server/routes/runs.types';

import type { RunFilter, RunRecord, RunTags } from '../../server/routes/runs.types';

// Display label for a run: prefix `[<origin>]` for non-human origins so the
// dispatcher is visible at a glance. Marker-aware — skips when the title
// already carries a known-origin prefix, so legacy `[automation] …` titles
// (written before origin became structural) render once, never doubled.
const ORIGIN_MARKER = /^\[(?:human|automation|scheduler|driver)\]/;

export function deriveRunLabel(run: RunRecord): string {
  const base = run.title ?? run.skill ?? '(untitled run)';
  if (!run.origin || run.origin === 'human') return base;
  if (ORIGIN_MARKER.test(base)) return base;
  return `[${run.origin}] ${base}`;
}

// Client-side parse of the server's discriminated StartRunResult union.
// The server returns either `{ ok: true, run_id }` OR `{ ok: false, error,
// blocking? }`. This optional-field shape is what existing client callers
// expect — they read `result.run_id` / `result.error` directly. Future
// cleanup: migrate callers to the discriminated union from runs.types.ts.
export interface StartRunResult {
  run_id?: string;
  error?: string;
  blocking?: { run_id: string; skill: string | null };
}

function toQuery(filter: RunFilter): string {
  const params = new URLSearchParams();
  if (filter.state) params.set('state', filter.state);
  if (filter.skill) params.set('skill', filter.skill);
  if (filter.change_id) params.set('change_id', filter.change_id);
  if (filter.project) params.set('project', filter.project);
  if (filter.repo) params.set('repo', filter.repo);
  if (filter.domain) params.set('domain', filter.domain);
  if (filter.origin) params.set('origin', filter.origin);
  if (filter.since) params.set('since', filter.since);
  if (filter.until) params.set('until', filter.until);
  if (filter.limit != null) params.set('limit', String(filter.limit));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function startRun(body: {
  prompt: string;
  title?: string;
  tags?: RunTags;
}): Promise<StartRunResult> {
  const r = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 409 carries a structured blocking payload — surface it without throwing.
  if (r.status === 409) {
    return (await r.json()) as StartRunResult;
  }
  if (!r.ok) {
    return { error: `start run failed: ${r.status}` };
  }
  return (await r.json()) as StartRunResult;
}

export async function cancelRun(id: string): Promise<{ ok: boolean; error?: string }> {
  return postJson<{ ok: boolean; error?: string }>(`/api/runs/${id}/cancel`, {});
}

export async function getRun(
  id: string,
): Promise<{ run: RunRecord; recent_chunks: Array<Record<string, unknown>> }> {
  return getJson<{ run: RunRecord; recent_chunks: Array<Record<string, unknown>> }>(
    `/api/runs/${id}`,
  );
}

export async function listRuns(filter: RunFilter = {}): Promise<{ runs: RunRecord[] }> {
  return getJson<{ runs: RunRecord[] }>(`/api/runs${toQuery(filter)}`);
}

export async function countRuns(filter: RunFilter = {}): Promise<{ n: number }> {
  return getJson<{ n: number }>(`/api/runs/count${toQuery(filter)}`);
}

export function subscribeRun(id: string): AsyncGenerator<ActionChunk> {
  return runStream(`/api/runs/${id}/stream`, {});
}
