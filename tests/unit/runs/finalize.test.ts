// Terminal-state inference for runs finalized from on-disk evidence
// (scripts/runs-finalize.mjs). The inference is the encoded version of the
// old manual guidance "verify the linked entity, don't trust the 'failed'
// badge alone" — these tests pin the decision table.

import { describe, expect, it } from 'vitest';
import { inferTerminalState } from '../../../scripts/runs-finalize.mjs';

const result = (isError: boolean) => ({
  isError,
  costUsd: 1.23,
  durationMs: 1000,
  tokensIn: 1,
  tokensOut: 2,
  tokensCacheRead: 3,
  tokensCacheWrite: 4,
  model: 'claude-test',
});

describe('inferTerminalState', () => {
  it('result event without error → done, exit 0', () => {
    expect(inferTerminalState({ result: result(false), fresh: false, errorMarker: null })).toEqual(
      { state: 'done', exit_status: 0 },
    );
  });

  it('result event with is_error → failed, exit 1', () => {
    expect(inferTerminalState({ result: result(true), fresh: false, errorMarker: null })).toEqual({
      state: 'failed',
      exit_status: 1,
    });
  });

  it('no result event + fresh artifact → died-after-writeback', () => {
    expect(inferTerminalState({ result: null, fresh: true, errorMarker: null })).toEqual({
      state: 'died-after-writeback',
      exit_status: null,
    });
  });

  it('no result event + stale artifact → failed', () => {
    expect(inferTerminalState({ result: null, fresh: false, errorMarker: null })).toEqual({
      state: 'failed',
      exit_status: null,
    });
  });

  it('cancel marker wins over everything (detached cancel after restart)', () => {
    expect(
      inferTerminalState({ result: result(false), fresh: true, errorMarker: 'cancelled by user' }),
    ).toEqual({ state: 'cancelled', exit_status: null });
  });

  it('wall-cap kill marker does not masquerade as cancelled', () => {
    expect(
      inferTerminalState({
        result: null,
        fresh: false,
        errorMarker: 'killed: wall-time cap exceeded (25m)',
      }),
    ).toEqual({ state: 'failed', exit_status: null });
  });
});
