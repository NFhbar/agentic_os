// Per-skill wall-time cap derivation (scripts/dispatch-claude.mjs). The old
// uniform 25-minute cap sat below meta-curate's measured 41-minute average;
// these pin the replacement rule: frontmatter > 2×p95 history > 25m floor,
// 240m ceiling throughout.

import { describe, expect, it } from 'vitest';
import {
  WALL_CAP_CEILING_MINUTES,
  WALL_CAP_FLOOR_MINUTES,
  deriveCapMs,
} from '../../../scripts/dispatch-claude.mjs';

const MIN = 60_000;

describe('deriveCapMs', () => {
  it('explicit frontmatter wins over history', () => {
    expect(
      deriveCapMs({ frontmatterMinutes: 60, durationsMs: [1 * MIN, 2 * MIN, 3 * MIN] }),
    ).toBe(60 * MIN);
  });

  it('frontmatter is clamped to the ceiling', () => {
    expect(deriveCapMs({ frontmatterMinutes: 9999, durationsMs: [] })).toBe(
      WALL_CAP_CEILING_MINUTES * MIN,
    );
  });

  it('no frontmatter + thin history → floor', () => {
    expect(deriveCapMs({ frontmatterMinutes: null, durationsMs: [40 * MIN] })).toBe(
      WALL_CAP_FLOOR_MINUTES * MIN,
    );
    expect(deriveCapMs({ frontmatterMinutes: null, durationsMs: [] })).toBe(
      WALL_CAP_FLOOR_MINUTES * MIN,
    );
  });

  it('history-derived: 2×p95 when above the floor (curate-class survives)', () => {
    // Ten runs clustered around 41 minutes — the meta-curate shape that the
    // uniform 25m cap would have killed.
    const durations = [35, 38, 40, 41, 41, 42, 43, 44, 45, 46].map((m) => m * MIN);
    const cap = deriveCapMs({ frontmatterMinutes: null, durationsMs: durations });
    expect(cap).toBeGreaterThan(46 * MIN); // above every observed healthy run
    expect(cap).toBe(2 * 46 * MIN); // 2 × p95 (p95 of 10 samples = the max here)
  });

  it('history-derived never drops below the floor', () => {
    const durations = [1, 1, 2, 2, 3, 3].map((m) => m * MIN);
    expect(deriveCapMs({ frontmatterMinutes: null, durationsMs: durations })).toBe(
      WALL_CAP_FLOOR_MINUTES * MIN,
    );
  });

  it('history-derived is clamped to the ceiling (hang outliers do not run away)', () => {
    const durations = [30, 35, 40, 45, 21.6 * 60].map((m) => m * MIN); // 21.6h outlier
    expect(deriveCapMs({ frontmatterMinutes: null, durationsMs: durations })).toBe(
      WALL_CAP_CEILING_MINUTES * MIN,
    );
  });
});
