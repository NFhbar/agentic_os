// Unit tests for deriveRunLabel — the render-time `[origin]` title prefix.
// Origin is a structural property of a run (who dispatched it); the prefix is
// derived here, never stored in the title. The marker-aware idempotency case
// is load-bearing: legacy rows written before origin was structural still
// carry a literal `[automation]` in their title, and must not double-prefix.

import { describe, expect, it } from 'vitest';
import { deriveRunLabel } from '../../../domains/meta/app/src/lib/runs.js';
import type { RunRecord } from '../../../domains/meta/app/src/lib/runs.js';

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r_test',
    started_at: '2026-06-16T00:00:00Z',
    ended_at: null,
    state: 'done',
    exit_status: 0,
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
    origin: null,
    ...overrides,
  } as RunRecord;
}

describe('deriveRunLabel', () => {
  it('returns the bare title for human origin', () => {
    expect(deriveRunLabel(makeRun({ title: 'do a thing', origin: 'human' }))).toBe('do a thing');
  });

  it('returns the bare title for a legacy null origin', () => {
    expect(deriveRunLabel(makeRun({ title: 'do a thing', origin: null }))).toBe('do a thing');
  });

  it('prefixes the origin for automation/scheduler/driver', () => {
    expect(deriveRunLabel(makeRun({ title: 'dev-write-change foo', origin: 'automation' }))).toBe(
      '[automation] dev-write-change foo',
    );
    expect(deriveRunLabel(makeRun({ title: 'Run now: nightly', origin: 'scheduler' }))).toBe(
      '[scheduler] Run now: nightly',
    );
    expect(deriveRunLabel(makeRun({ title: 'drive step', origin: 'driver' }))).toBe(
      '[driver] drive step',
    );
  });

  it('does not double-prefix a title that already carries a marker', () => {
    // Legacy row: origin resolved to a non-human value but the title was
    // written with a literal prefix in the pre-structural era.
    expect(
      deriveRunLabel(makeRun({ title: '[automation] dev-write-change foo', origin: 'automation' })),
    ).toBe('[automation] dev-write-change foo');
  });

  it('falls back to skill then a placeholder when there is no title', () => {
    expect(deriveRunLabel(makeRun({ title: null, skill: 'dev-pr-review', origin: 'automation' }))).toBe(
      '[automation] dev-pr-review',
    );
    expect(deriveRunLabel(makeRun({ title: null, skill: null, origin: 'human' }))).toBe(
      '(untitled run)',
    );
  });
});
