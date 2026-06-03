// Tier 1 unit tests for the run-failure recognizer + entity-link picker.
//
// `recognizeOrphanLike` classifies failed runs into "died-but-likely-
// succeeded" buckets so the Runs view can render a softer warning instead
// of the misleading red ✗ exit ?. `entityLink` picks the most relevant
// linked-entity destination from the run's tags. Both are tiny pure
// functions that pinch off real UX gaps — they deserve coverage so the
// next addition to either set (a new known failure-mode prefix, a new
// linked-entity priority) doesn't accidentally regress the existing cases.
//
// Was extracted from RunRow.tsx to orphan-recognizer.ts in this session —
// same separation pattern as automation-state-machine.ts.

import { describe, expect, it } from 'vitest';
import {
  entityLink,
  recognizeOrphanLike,
} from '../../../domains/meta/app/src/components/orphan-recognizer.js';
import type { RunRecord } from '../../../domains/meta/app/src/lib/runs.js';

// Minimal stub builder. Only the fields these functions read are required;
// the rest are filled with conservative defaults. Cast at the end so TS
// accepts the narrowed shape.
function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r_test',
    started_at: '2026-06-02T00:00:00Z',
    ended_at: null,
    state: 'failed',
    exit_status: null,
    pid: null,
    skill: null,
    change_id: null,
    project: null,
    repo: null,
    domain: null,
    title: null,
    prompt: '',
    output_path: '',
    duration_ms: null,
    error: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    tokens_cache_hit: null,
    tokens_cache_write: null,
    model: null,
    ...overrides,
  } as RunRecord;
}

describe('recognizeOrphanLike — non-failure states', () => {
  it.each(['running', 'queued', 'done', 'cancelled'] as const)(
    'returns null when state is "%s"',
    (state) => {
      const r = makeRun({ state, error: 'orphan-sweep: PID not alive' });
      expect(recognizeOrphanLike(r)).toBeNull();
    },
  );
});

describe('recognizeOrphanLike — orphan-sweep pattern', () => {
  it('classifies "orphan-sweep: PID not alive" as orphan-sweep', () => {
    const r = makeRun({
      state: 'failed',
      error: 'orphan-sweep: PID not alive',
    });
    const result = recognizeOrphanLike(r);
    expect(result?.kind).toBe('orphan-sweep');
    expect(result?.label).toBe('Subprocess died unexpectedly');
    expect(result?.hint).toContain('OOM');
    expect(result?.hint).toContain('verify the linked entity');
  });

  it('matches any error string starting with "orphan-sweep:"', () => {
    // The prefix is the contract; the suffix can vary as different sweep
    // modes evolve (boot vs periodic, future variants).
    const r = makeRun({
      state: 'failed',
      error: 'orphan-sweep: stale row reaped on boot',
    });
    expect(recognizeOrphanLike(r)?.kind).toBe('orphan-sweep');
  });
});

describe('recognizeOrphanLike — wall-time-cap pattern', () => {
  it('classifies "killed: wall-time cap exceeded (25m)" as wall-time-cap', () => {
    const r = makeRun({
      state: 'failed',
      error: 'killed: wall-time cap exceeded (25m)',
    });
    const result = recognizeOrphanLike(r);
    expect(result?.kind).toBe('wall-time-cap');
    expect(result?.label).toBe('Wall-time cap exceeded');
    expect(result?.hint).toContain('cap');
    expect(result?.hint).toContain('verify the linked entity');
  });

  it('handles different cap values in the error', () => {
    const r = makeRun({
      state: 'failed',
      error: 'killed: wall-time cap exceeded (45m)',
    });
    expect(recognizeOrphanLike(r)?.kind).toBe('wall-time-cap');
  });
});

describe('recognizeOrphanLike — other failure modes (pass-through)', () => {
  it('returns null for an unknown failed error', () => {
    const r = makeRun({
      state: 'failed',
      error: 'Error: skill returned exit 1 with stderr ...',
    });
    expect(recognizeOrphanLike(r)).toBeNull();
  });

  it('returns null when error is null on a failed run', () => {
    const r = makeRun({ state: 'failed', error: null });
    expect(recognizeOrphanLike(r)).toBeNull();
  });

  it('returns null when error is empty string on a failed run', () => {
    const r = makeRun({ state: 'failed', error: '' });
    expect(recognizeOrphanLike(r)).toBeNull();
  });
});

describe('entityLink — preference ordering', () => {
  it('prefers change_id over project when both are set', () => {
    const r = makeRun({ change_id: 'fix-y', project: 'p1' });
    expect(entityLink(r)).toEqual({ href: '/changes/fix-y', label: 'change fix-y' });
  });

  it('falls back to project when change_id is absent', () => {
    const r = makeRun({ change_id: null, project: 'mull-version-2' });
    expect(entityLink(r)).toEqual({
      href: '/projects/mull-version-2',
      label: 'project mull-version-2',
    });
  });

  it('returns null when neither change_id nor project is set', () => {
    const r = makeRun({ change_id: null, project: null });
    expect(entityLink(r)).toBeNull();
  });

  it('returns null when change_id is empty string', () => {
    // Defensive: empty strings should be treated as absent. (Truthy check
    // in the source means current behavior is correct on this case.)
    const r = makeRun({ change_id: '', project: 'p1' });
    expect(entityLink(r)).toEqual({ href: '/projects/p1', label: 'project p1' });
  });
});
