// Tier 1 unit tests for the change-automation state machine's decider.
//
// `decideNextChangeStep` is the pure-function core of the per-change
// orchestrator. Given the change's current state + the outcome of the most
// recent dispatched run, it returns the next gesture: dispatch, park, or
// complete. Every row of [[standard-automation-loop]]'s transition table
// should be exercised here.
//
// Why this test matters: this function encodes the loop semantics. A bug
// here (e.g. cap off-by-one, missing case for a new pr_review_status value)
// would silently misroute automation. Same class of issue as Task #417
// (research-status enum drift) — pure-function tests are the cheapest
// preventative.

import { describe, expect, it } from 'vitest';
import { decideNextChangeStep } from '../../../domains/meta/app/server/routes/automation-state-machine.js';

describe('decideNextChangeStep — failure path', () => {
  it('parks with skill-failure when last_exit is non-zero', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 1,
      pr_review_status: null,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^skill-failure:/);
      expect(d.reason).toContain('execute');
      expect(d.reason).toContain('exited 1');
    }
  });

  it('parks with skill-failure for null exit (orphan-death case)', () => {
    // The auto-tick hook treats null-exit subprocesses as failure (-1),
    // so decideNextChangeStep sees a non-zero. Mirrors what the orchestrator
    // actually passes when a subprocess dies orphan-style.
    const d = decideNextChangeStep({
      current_step: 'address-comments',
      iteration_count: 3,
      iteration_cap: 4,
      last_exit: -1,
      pr_review_status: 'needs-changes',
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toContain('address-comments');
      expect(d.reason).toContain('-1');
    }
  });

  it('failure handling takes precedence over cap-reached', () => {
    // If both conditions are true, failure path wins. Tests the early-return
    // ordering — if cap-reached fired first it would never get to failure.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 4, // at cap
      iteration_cap: 4,
      last_exit: 2, // also failed
      pr_review_status: 'needs-changes',
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^skill-failure:/);
    }
  });

  it('failure with current_step null still surfaces the step in the reason', () => {
    // Edge case: first dispatch failed somehow. The step is documented as
    // "<unknown step>" in the reason.
    const d = decideNextChangeStep({
      current_step: null,
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 1,
      pr_review_status: null,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toContain('<unknown step>');
    }
  });
});

describe('decideNextChangeStep — happy-path transitions', () => {
  it('null current_step → dispatch execute (first run)', () => {
    const d = decideNextChangeStep({
      current_step: null,
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'execute' });
  });

  it('execute completed → dispatch open-pr', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'open-pr' });
  });

  it('open-pr completed → dispatch pr-review', () => {
    const d = decideNextChangeStep({
      current_step: 'open-pr',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'pr-review' });
  });

  it('address-comments completed → dispatch pr-review', () => {
    const d = decideNextChangeStep({
      current_step: 'address-comments',
      iteration_count: 2,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(d).toEqual({ action: 'dispatch', step: 'pr-review' });
  });
});

describe('decideNextChangeStep — pr-review verdict branching', () => {
  it('pr_review_status: pending → complete (no blockers)', () => {
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'pending',
    });
    expect(d).toEqual({ action: 'complete' });
  });

  it('pr_review_status: ready-for-human → complete', () => {
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 2,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'ready-for-human',
    });
    expect(d).toEqual({ action: 'complete' });
  });

  it('pr_review_status: null → complete (no review yet means no blockers either)', () => {
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
    });
    expect(d).toEqual({ action: 'complete' });
  });

  it('pr_review_status: needs-changes + below cap → dispatch address-comments', () => {
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 2,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(d).toEqual({ action: 'dispatch', step: 'address-comments' });
  });

  it('pr_review_status: needs-changes + at cap → park (iteration-cap-reached)', () => {
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 4,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^iteration-cap-reached:/);
      expect(d.reason).toContain('4 loops');
    }
  });

  it('pr_review_status: needs-changes + above cap (defensive) → park', () => {
    // Should never happen in practice (counter is monotonic + bumped by 1)
    // but the >= check should hold for any value past the cap.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 7,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toContain('7 loops');
    }
  });

  it('cap-edge: count exactly equal to cap fires the park (>=, not strictly >)', () => {
    // Documents the off-by-one boundary explicitly: at iteration_count ===
    // iteration_cap, the cap fires. Worth pinning since "cap of N" intuition
    // can read either way.
    const atCap = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 4,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(atCap.action).toBe('park');
    const belowCap = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 3,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(belowCap.action).toBe('dispatch');
  });
});

describe('decideNextChangeStep — no-op-loop guard (Task #427)', () => {
  // Background: when pr-review verdict is needs-changes but every comment on
  // the latest pass is status:new, dispatching address-comments is a no-op
  // (the skill refuses to act per its SKILL.md gate). The state machine then
  // re-dispatches pr-review on unchanged head (Task #428) and loops. Guard:
  // park with needs-triage when comments_to_address === 0.

  it('parks with needs-triage when needs-changes + comments_to_address is 0', () => {
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
      comments_to_address: 0,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^needs-triage:/);
      expect(d.reason).toContain('accept/dismiss');
    }
  });

  it('dispatches address-comments when needs-changes + comments_to_address > 0', () => {
    // Canonical happy path: comments are curated and ready to be folded in.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 1,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
      comments_to_address: 5,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'address-comments' });
  });

  it('falls through to existing behavior when comments_to_address is null (unknown)', () => {
    // Null = caller didn't compute it (e.g. no pr_review_path). Preserves
    // backwards-compat for callers that don't supply the field.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 1,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
      comments_to_address: null,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'address-comments' });
  });

  it('omitting comments_to_address entirely preserves backwards compat', () => {
    // The field is optional — older callers (or this test suite's pre-existing
    // rows) should keep working unchanged.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 1,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
    });
    expect(d).toEqual({ action: 'dispatch', step: 'address-comments' });
  });

  it('needs-triage park fires BEFORE iteration-cap check', () => {
    // If both conditions are true (cap reached AND zero comments curated),
    // surface needs-triage — it's a more actionable reason than cap-reached
    // and indicates the cap was being burned on no-op loops.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 4,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes',
      comments_to_address: 0,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^needs-triage:/);
    }
  });

  it('clean approve verdict ignores comments_to_address (terminal)', () => {
    // The guard only applies to the needs-changes branch. A clean review
    // completes regardless of count.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'ready-for-human',
      comments_to_address: 0,
    });
    expect(d).toEqual({ action: 'complete' });
  });
});

describe('decideNextChangeStep — forward-compat (unknown step)', () => {
  it('parks safely on an unknown current_step value', () => {
    // The canonical v1 step vocabulary is execute / open-pr / pr-review /
    // address-comments. If a future loop introduces a new step kind but
    // the decider hasn't been updated, the default branch should park —
    // NOT dispatch or complete blindly. Tests the forward-compat safety.
    const d = decideNextChangeStep({
      current_step: 'deploy', // hypothetical future step
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^unknown-step:/);
      expect(d.reason).toContain('deploy');
    }
  });
});

describe('decideNextChangeStep — purity', () => {
  it('does not mutate its inputs', () => {
    const args = {
      current_step: 'pr-review' as string | null,
      iteration_count: 2,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'needs-changes' as string | null,
    };
    const before = JSON.stringify(args);
    decideNextChangeStep(args);
    expect(JSON.stringify(args)).toBe(before);
  });

  it('is deterministic — same inputs, same output', () => {
    const args = {
      current_step: 'execute' as string | null,
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null as string | null,
    };
    const a = decideNextChangeStep(args);
    const b = decideNextChangeStep(args);
    expect(a).toEqual(b);
  });
});
