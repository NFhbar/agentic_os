// Pins the models registry to CLI ground truth. The fixtures below are real
// dispatched-run result events from events.db whose cost_usd was reported by
// `claude` itself (stream-json total_cost_usd) — the registry's job is to
// reproduce that number from token counts. If a rate drifts from what the
// CLI bills, these fail. Method + validation history: models-registry.mjs
// header. (Discovered via the Fable self-review: the registry carried the
// pre-4.5 Opus list price, overstating every computed session cost 3×.)

import { describe, expect, it } from 'vitest';
import { computeCost, pricingFor } from '../../scripts/models-registry.mjs';

describe('models-registry pricing', () => {
  it('strips [context-window] suffixes', () => {
    expect(pricingFor('claude-opus-4-7[1m]')).toEqual(pricingFor('claude-opus-4-7'));
  });

  it('reproduces CLI-reported cost for an opus-4-7 run', () => {
    // events.db: kind=dashboard, cost_usd reported by the CLI = 0.94892675
    expect(
      computeCost('claude-opus-4-7[1m]', {
        input: 19,
        output: 14097,
        cache_read: 523976,
        cache_write: 53507,
      }),
    ).toBeCloseTo(0.94892675, 6);
  });

  it('reproduces CLI-reported cost for a fable-5 run', () => {
    // events.db: kind=dashboard, cost_usd reported by the CLI = 3.19449075
    expect(
      computeCost('claude-fable-5', {
        input: 40,
        output: 65757,
        cache_read: 1847994,
        cache_write: 100219,
      }),
    ).toBeCloseTo(3.19449075, 6);
  });

  it('returns null for unknown models instead of guessing', () => {
    expect(
      computeCost('claude-unknown-9', { input: 1, output: 1, cache_read: 0, cache_write: 0 }),
    ).toBeNull();
  });
});
