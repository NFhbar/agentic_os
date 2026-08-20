// Dispatch dedupe for the session importer
// (scripts/session-dispatch-match.mjs, consumed by
// scripts/import-session-usage.mjs).
//
// A dashboard-dispatched run is `claude -p` in a subprocess, and that
// subprocess writes a session transcript shaped exactly like an interactive
// turn. Imported naively, every dispatch lands in events.db twice with two
// different cost figures, and any rollup summing both kinds double-counts it.
//
// The matcher decides which turns are really dispatches. Its bias is the point
// of these tests: skipping a genuine interactive turn destroys cost data that
// nothing can reconstruct, while missing a dispatch leaves a duplicate that is
// still visible and still fixable — so every uncertainty must resolve to "not
// a dispatch".

import { describe, expect, it } from 'vitest';
import {
  DISPATCH_DURATION_TOLERANCE_MS,
  DISPATCH_START_TOLERANCE_MS,
  extractRunId,
  findDispatchMatch,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../scripts/session-dispatch-match.mjs';

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

interface Dispatch {
  id: string;
  started_ms: number;
  duration_ms: number;
}

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'r_11111111-2222-3333-4444-555555555555',
  started_ms: T0,
  duration_ms: 60_000,
  ...over,
});

describe('extractRunId', () => {
  it('finds a uuid-shaped run id embedded in transcript text', () => {
    expect(extractRunId('resuming run r_11111111-2222-3333-4444-555555555555 for the change')).toBe(
      'r_11111111-2222-3333-4444-555555555555',
    );
  });

  it('finds the no-crypto fallback id shape', () => {
    expect(extractRunId('run_id: r_1755690000000-k3j9fx')).toBe('r_1755690000000-k3j9fx');
  });

  it('returns null on text with no run id', () => {
    expect(extractRunId('please review the PR')).toBeNull();
    expect(extractRunId(null)).toBeNull();
  });
});

describe('findDispatchMatch — run-id basis', () => {
  it('an id present in the index matches regardless of clocks', () => {
    const d = dispatch({ started_ms: T0 + 10 * 60_000, duration_ms: 1 });
    const got = findDispatchMatch({ runId: d.id, startMs: T0, durationMs: 60_000 }, [d]);
    expect(got).toEqual({ run_id: d.id, basis: 'run-id' });
  });

  it('an id NOT in the index falls through to adjacency rather than matching', () => {
    const d = dispatch();
    // Unknown id, but the clocks line up — adjacency still gets its say.
    const got = findDispatchMatch(
      { runId: 'r_deadbeef-0000-0000-0000-000000000000', startMs: T0, durationMs: 60_000 },
      [d],
    );
    expect(got).toEqual({ run_id: d.id, basis: 'adjacency' });
  });
});

describe('findDispatchMatch — adjacency basis', () => {
  it('matches when start and duration are both inside tolerance', () => {
    const d = dispatch();
    expect(
      findDispatchMatch(
        { runId: null, startMs: T0 + 3000, durationMs: 60_000 + 1500 },
        [d],
      ),
    ).toEqual({ run_id: d.id, basis: 'adjacency' });
  });

  it('accepts the exact tolerance boundary on both axes', () => {
    const d = dispatch();
    expect(
      findDispatchMatch(
        {
          runId: null,
          startMs: T0 + DISPATCH_START_TOLERANCE_MS,
          durationMs: 60_000 + DISPATCH_DURATION_TOLERANCE_MS,
        },
        [d],
      ),
    ).toMatchObject({ basis: 'adjacency' });
  });

  it('refuses when the start is outside tolerance even with an identical duration', () => {
    const d = dispatch();
    expect(
      findDispatchMatch(
        { runId: null, startMs: T0 + DISPATCH_START_TOLERANCE_MS + 1, durationMs: 60_000 },
        [d],
      ),
    ).toBeNull();
  });

  it('refuses when the duration is outside tolerance even with an identical start', () => {
    const d = dispatch();
    expect(
      findDispatchMatch(
        { runId: null, startMs: T0, durationMs: 60_000 + DISPATCH_DURATION_TOLERANCE_MS + 1 },
        [d],
      ),
    ).toBeNull();
  });

  it('refuses when either side has no duration — start alone is not evidence', () => {
    // A user typing during the second a dispatch launches would otherwise be
    // swept up and have its cost deleted.
    expect(
      findDispatchMatch({ runId: null, startMs: T0, durationMs: Number.NaN }, [dispatch()]),
    ).toBeNull();
    expect(
      findDispatchMatch({ runId: null, startMs: T0, durationMs: 60_000 }, [
        dispatch({ duration_ms: Number.NaN }),
      ]),
    ).toBeNull();
  });

  it('picks the nearer start when two dispatches sit inside the window', () => {
    const near = dispatch({ id: 'r_near', started_ms: T0 + 500 });
    const far = dispatch({ id: 'r_far', started_ms: T0 + 4000 });
    expect(
      findDispatchMatch({ runId: null, startMs: T0, durationMs: 60_000 }, [far, near]),
    ).toEqual({ run_id: 'r_near', basis: 'adjacency' });
  });
});

describe('findDispatchMatch — degenerate inputs', () => {
  it('an empty or missing index never matches', () => {
    expect(findDispatchMatch({ runId: 'r_x', startMs: T0, durationMs: 1 }, [])).toBeNull();
    expect(findDispatchMatch({ runId: 'r_x', startMs: T0, durationMs: 1 }, null)).toBeNull();
  });

  it('a turn with no usable clock and no id never matches', () => {
    expect(
      findDispatchMatch({ runId: null, startMs: Number.NaN, durationMs: Number.NaN }, [dispatch()]),
    ).toBeNull();
    expect(findDispatchMatch({}, [dispatch()])).toBeNull();
  });

  it('tolerances are overridable for callers with a different clock budget', () => {
    const d = dispatch();
    const turn = { runId: null, startMs: T0 + 30_000, durationMs: 60_000 };
    expect(findDispatchMatch(turn, [d])).toBeNull();
    expect(findDispatchMatch(turn, [d], { startToleranceMs: 60_000 })).toMatchObject({
      basis: 'adjacency',
    });
  });
});
