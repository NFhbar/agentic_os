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
import {
  type ArtifactObservation,
  composeArtifactDetail,
  decideNextChangeStep,
  evaluateArtifactMovement,
} from '../../../domains/meta/app/server/routes/automation-state-machine.js';
import type { ChangeAutomationDispatchBaseline } from '../../../domains/meta/app/server/routes/changes.types.js';

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

describe('evaluateArtifactMovement', () => {
  // Artifact-verified advance (2026-06-12 incident). The pure judgment over
  // caller-gathered observations: true = moved, false = determinate
  // no-movement (park), null = unknown (gate inert).

  const baseline: ChangeAutomationDispatchBaseline = {
    head_sha: 'abc1234def',
    pr_url: null,
    pass_count: 1,
  };

  function obs(partial: Partial<ArtifactObservation>): ArtifactObservation {
    return {
      head: null,
      head_error: null,
      pr_url: null,
      pass_count: null,
      pr_review_path_set: false,
      ...partial,
    };
  }

  it('execute + ref-not-found → false (blocker-1 replay: branch absent after a clean-exit refusal)', () => {
    // The change branch never got created — determinate no-movement, NOT a
    // degraded read. This is the case that let the 2026-06-12 ghost advance
    // survive an earlier design.
    const m = evaluateArtifactMovement(
      'execute',
      { head_sha: null, pr_url: null, pass_count: null },
      obs({ head: null, head_error: 'ref-not-found' }),
    );
    expect(m).toBe(false);
  });

  it('execute + degraded read → null (gate inert — infrastructure hiccups never false-park)', () => {
    const m = evaluateArtifactMovement('execute', baseline, obs({ head_error: 'degraded' }));
    expect(m).toBe(null);
  });

  it('execute + head moved → true', () => {
    const m = evaluateArtifactMovement('execute', baseline, obs({ head: 'fff9999aaa' }));
    expect(m).toBe(true);
  });

  it('execute + head unchanged → false', () => {
    const m = evaluateArtifactMovement('execute', baseline, obs({ head: 'abc1234def' }));
    expect(m).toBe(false);
  });

  it('address-comments follows the same head rules as execute', () => {
    expect(
      evaluateArtifactMovement('address-comments', baseline, obs({ head: 'abc1234def' })),
    ).toBe(false);
    expect(
      evaluateArtifactMovement('address-comments', baseline, obs({ head: 'fff9999aaa' })),
    ).toBe(true);
  });

  it('open-pr + pr_url still null → false', () => {
    const m = evaluateArtifactMovement('open-pr', baseline, obs({ pr_url: null }));
    expect(m).toBe(false);
  });

  it('open-pr + pr_url unchanged (already linked) → true — the artifact exists, idempotent no-op is satisfied', () => {
    // dev-open-pr stops politely (exit 0, no mutation) when pr_url is set.
    // The postcondition is "a PR exists and is linked", not "pr_url moved" —
    // requiring movement would make open-pr impassable on re-drives.
    const withPr: ChangeAutomationDispatchBaseline = {
      ...baseline,
      pr_url: 'https://github.com/x/y/pull/1',
    };
    const m = evaluateArtifactMovement(
      'open-pr',
      withPr,
      obs({ pr_url: 'https://github.com/x/y/pull/1' }),
    );
    expect(m).toBe(true);
  });

  it('open-pr + pr_url newly set → true', () => {
    const m = evaluateArtifactMovement(
      'open-pr',
      baseline,
      obs({ pr_url: 'https://github.com/x/y/pull/2' }),
    );
    expect(m).toBe(true);
  });

  it('pr-review + pass_count not incremented → false', () => {
    const m = evaluateArtifactMovement(
      'pr-review',
      baseline,
      obs({ pr_review_path_set: true, pass_count: 1 }),
    );
    expect(m).toBe(false);
  });

  it('pr-review + pass_count incremented → true', () => {
    const m = evaluateArtifactMovement(
      'pr-review',
      baseline,
      obs({ pr_review_path_set: true, pass_count: 2 }),
    );
    expect(m).toBe(true);
  });

  it('pr-review + pr_review_path not set → false (no review entry = no new pass)', () => {
    const m = evaluateArtifactMovement(
      'pr-review',
      baseline,
      obs({ pr_review_path_set: false, pass_count: null }),
    );
    expect(m).toBe(false);
  });

  it.each(['execute', 'open-pr', 'pr-review', 'address-comments'])(
    'no baseline → null for step %s (legacy in-flight automations stay gate-inert)',
    (step) => {
      const m = evaluateArtifactMovement(step, null, obs({ head: 'fff9999aaa' }));
      expect(m).toBe(null);
    },
  );

  describe('degraded baseline snapshot (pass-2 comment 1 regression)', () => {
    // The dispatch-time head read failed (git/spawn hiccup), so head_sha null
    // means "unknown", not "branch absent". Pre-fix, a later non-null head
    // read as movement and a refusing run silently advanced (fail-open).
    const degradedBaseline: ChangeAutomationDispatchBaseline = {
      head_sha: null,
      head_degraded: true,
      pr_url: null,
      pass_count: null,
    };

    it.each(['execute', 'address-comments'])(
      '%s + degraded baseline + observed head set → verification-unavailable, NOT true',
      (step) => {
        const m = evaluateArtifactMovement(step, degradedBaseline, obs({ head: 'fff9999aaa' }));
        expect(m).toBe('verification-unavailable');
        expect(m).not.toBe(true);
      },
    );

    it('observed ref-not-found wins over a degraded baseline (determinate: no commits now)', () => {
      const m = evaluateArtifactMovement(
        'execute',
        degradedBaseline,
        obs({ head_error: 'ref-not-found' }),
      );
      expect(m).toBe(false);
    });

    it('degraded on BOTH sides → null (e.g. no branch configured — gate stays inert)', () => {
      const m = evaluateArtifactMovement(
        'execute',
        degradedBaseline,
        obs({ head_error: 'degraded' }),
      );
      expect(m).toBe(null);
    });

    it('open-pr / pr-review ignore head_degraded (their artifacts are not the branch head)', () => {
      expect(
        evaluateArtifactMovement(
          'open-pr',
          degradedBaseline,
          obs({ pr_url: 'https://github.com/x/y/pull/2' }),
        ),
      ).toBe(true);
      expect(
        evaluateArtifactMovement(
          'pr-review',
          { ...degradedBaseline, pass_count: 1 },
          obs({ pr_review_path_set: true, pass_count: 2 }),
        ),
      ).toBe(true);
    });

    it('head_degraded false (or absent — legacy baselines) keeps the plain comparison', () => {
      expect(
        evaluateArtifactMovement(
          'execute',
          { head_sha: 'abc1234def', head_degraded: false, pr_url: null, pass_count: null },
          obs({ head: 'fff9999aaa' }),
        ),
      ).toBe(true);
      expect(evaluateArtifactMovement('execute', baseline, obs({ head: 'fff9999aaa' }))).toBe(true);
    });
  });

  it('unknown step → null (forward-compat, same posture as the decider default branch)', () => {
    const m = evaluateArtifactMovement('deploy', baseline, obs({ head: 'fff9999aaa' }));
    expect(m).toBe(null);
  });
});

describe('composeArtifactDetail — park-reason wording', () => {
  // Pure wording composer for the skill-refused park reason. Pinned directly
  // (not just via the artifact_detail plumbing row) now that it lives in the
  // zero-I/O state-machine module.

  function obs(partial: Partial<ArtifactObservation>): ArtifactObservation {
    return {
      head: null,
      head_error: null,
      pr_url: null,
      pass_count: null,
      pr_review_path_set: false,
      ...partial,
    };
  }

  it('execute + ref-not-found → "branch <x> has no commits (ref not found)"', () => {
    const d = composeArtifactDetail('execute', obs({ head_error: 'ref-not-found' }), 'feat/x', null);
    expect(d).toBe('branch feat/x has no commits (ref not found)');
  });

  it('execute + head unchanged → short-sha wording', () => {
    const d = composeArtifactDetail('execute', obs({ head: 'abc1234def5678' }), 'feat/x', null);
    expect(d).toBe('no new commits on feat/x (head still abc1234)');
  });

  it('address-comments follows the same wording as execute', () => {
    const d = composeArtifactDetail('address-comments', obs({ head: null }), null, null);
    expect(d).toBe('no new commits on <unknown branch> (head still unknown)');
  });

  it('open-pr → pr_url-not-set wording (the only reachable no-movement case)', () => {
    const d = composeArtifactDetail('open-pr', obs({}), 'feat/x', null);
    expect(d).toBe('pr_url not set on the change entry');
  });

  it('pr-review + linked entry → stale pass_count wording', () => {
    const d = composeArtifactDetail(
      'pr-review',
      obs({ pr_review_path_set: true, pass_count: 1 }),
      null,
      null,
    );
    expect(d).toBe('no new review pass (pass_count still 1)');
  });

  it('pr-review + no linked entry → no-entry wording', () => {
    const d = composeArtifactDetail('pr-review', obs({}), null, null);
    expect(d).toBe('no pr-review entry linked');
  });

  it('appends the run summary when available', () => {
    const d = composeArtifactDetail(
      'execute',
      obs({ head_error: 'ref-not-found' }),
      'feat/x',
      '✗ EXECUTE refused — state mismatch',
    );
    expect(d).toBe(
      'branch feat/x has no commits (ref not found); run summary: "✗ EXECUTE refused — state mismatch"',
    );
  });

  it('unknown step + run summary → summary-only detail', () => {
    const d = composeArtifactDetail('deploy', obs({}), null, 'refused');
    expect(d).toBe('run summary: "refused"');
  });

  it('unknown step + no summary → null', () => {
    expect(composeArtifactDetail('deploy', obs({}), null, null)).toBe(null);
  });

  it('verification-unavailable → degraded-baseline wording (observation facts not asserted)', () => {
    const d = composeArtifactDetail(
      'execute',
      obs({ head: 'fff9999aaa' }),
      'feat/x',
      null,
      'verification-unavailable',
    );
    expect(d).toBe(
      'dispatch baseline for feat/x was degraded (head read failed at dispatch) — movement cannot be established',
    );
  });

  it('verification-unavailable + summary appends the run summary like the no-movement path', () => {
    const d = composeArtifactDetail(
      'address-comments',
      obs({ head: 'fff9999aaa' }),
      null,
      'follow-up pushed',
      'verification-unavailable',
    );
    expect(d).toBe(
      'dispatch baseline for <unknown branch> was degraded (head read failed at dispatch) — movement cannot be established; run summary: "follow-up pushed"',
    );
  });
});

describe('decideNextChangeStep — artifact-verified advance (skill-refused park)', () => {
  it('execute + exit 0 + artifact_moved false → park skill-refused (incident replay: open-pr unreachable)', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved: false,
    });
    expect(d.action).toBe('park');
    expect(d).not.toEqual({ action: 'dispatch', step: 'open-pr' });
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^skill-refused:/);
      expect(d.reason).toContain('execute exited 0 without artifact movement');
    }
  });

  it.each(['open-pr', 'address-comments'])(
    '%s + exit 0 + artifact_moved false → park skill-refused',
    (step) => {
      const d = decideNextChangeStep({
        current_step: step,
        iteration_count: 1,
        iteration_cap: 4,
        last_exit: 0,
        pr_review_status: null,
        artifact_moved: false,
      });
      expect(d.action).toBe('park');
      if (d.action === 'park') {
        expect(d.reason).toMatch(/^skill-refused:/);
      }
    },
  );

  it('pr-review + artifact_moved false → park, NOT complete', () => {
    // A pr-review run that produced no new pass must not be read as "no
    // blockers → complete" — the review never happened.
    const d = decideNextChangeStep({
      current_step: 'pr-review',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: 'pending',
      artifact_moved: false,
    });
    expect(d.action).toBe('park');
    expect(d).not.toEqual({ action: 'complete' });
  });

  it('artifact_moved true → existing behavior (back-compat)', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved: true,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'open-pr' });
  });

  it('artifact_moved null → existing behavior (degraded read / no baseline)', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved: null,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'open-pr' });
  });

  it('omitting artifact_moved entirely preserves backwards compat', () => {
    const d = decideNextChangeStep({
      current_step: 'open-pr',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'pr-review' });
  });

  it('skill-failure takes precedence over skill-refused', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 2,
      pr_review_status: null,
      artifact_moved: false,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^skill-failure:/);
    }
  });

  it('artifact_detail appears in the park reason (refusal summary plumbing)', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved: false,
      artifact_detail:
        'no new commits on feat/x (head still abc1234); run summary: "✗ EXECUTE refused — state mismatch"',
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toContain('no new commits on feat/x');
      expect(d.reason).toContain('EXECUTE refused — state mismatch');
    }
  });

  it('Reset → Start with existing PR: open-pr idempotent no-op advances to pr-review, does not park forever', () => {
    // Pass-1 comment 1 regression. A change whose PR already exists (e.g. an
    // execute refusal parked the loop post-open-pr, operator did Reset →
    // Start) re-runs open-pr; dev-open-pr no-ops with exit 0 and pr_url
    // unchanged. The satisfied postcondition (a linked PR exists) must
    // advance the loop, not re-park skill-refused every cycle.
    const prUrl = 'https://github.com/x/y/pull/8';
    const artifact_moved = evaluateArtifactMovement(
      'open-pr',
      { head_sha: 'abc1234def', pr_url: prUrl, pass_count: null },
      {
        head: 'abc1234def',
        head_error: null,
        pr_url: prUrl,
        pass_count: null,
        pr_review_path_set: false,
      },
    );
    expect(artifact_moved).toBe(true);
    const d = decideNextChangeStep({
      current_step: 'open-pr',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved,
    });
    expect(d).toEqual({ action: 'dispatch', step: 'pr-review' });
  });

  it('verification-unavailable + exit 0 → park with a distinct verification-unavailable reason', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved: 'verification-unavailable',
      artifact_detail:
        'dispatch baseline for feat/x was degraded (head read failed at dispatch) — movement cannot be established',
    });
    expect(d.action).toBe('park');
    expect(d).not.toEqual({ action: 'dispatch', step: 'open-pr' });
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^verification-unavailable:/);
      expect(d.reason).toContain('cannot verify execute artifact movement');
      expect(d.reason).toContain('dispatch baseline for feat/x was degraded');
    }
  });

  it('skill-failure takes precedence over verification-unavailable', () => {
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 3,
      pr_review_status: null,
      artifact_moved: 'verification-unavailable',
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^skill-failure:/);
    }
  });

  it('degraded-baseline replay end-to-end: refusing run can no longer silently advance (pass-2 comment 1 pin)', () => {
    // Incident shape: dispatch-time git hiccup → baseline {head_sha: null,
    // head_degraded: true}; branch actually had commits, the dispatched run
    // refused (exit 0, head unchanged). Pre-fix: head ≠ null read as moved →
    // advance. Post-fix: park as unverifiable.
    const artifact_moved = evaluateArtifactMovement(
      'execute',
      { head_sha: null, head_degraded: true, pr_url: null, pass_count: null },
      {
        head: 'abc1234def',
        head_error: null,
        pr_url: null,
        pass_count: null,
        pr_review_path_set: false,
      },
    );
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved,
    });
    expect(d.action).toBe('park');
    expect(d).not.toEqual({ action: 'dispatch', step: 'open-pr' });
    if (d.action === 'park') {
      expect(d.reason).toMatch(/^verification-unavailable:/);
    }
  });

  it('start re-evaluate: execute + baseline present + no movement → park, NOT dispatch open-pr (blocker-2 pin)', () => {
    // The Resume → Start front-door bypass: start's re-evaluate branch now
    // supplies artifact_moved from the persisted baseline, so a skill-refused
    // park at execute cannot be skipped past into open-pr by restarting.
    const observed = {
      head: null,
      head_error: 'ref-not-found' as const,
      pr_url: null,
      pass_count: null,
      pr_review_path_set: false,
    };
    const artifact_moved = evaluateArtifactMovement(
      'execute',
      { head_sha: null, pr_url: null, pass_count: null },
      observed,
    );
    const d = decideNextChangeStep({
      current_step: 'execute',
      iteration_count: 0,
      iteration_cap: 4,
      last_exit: 0,
      pr_review_status: null,
      artifact_moved,
    });
    expect(d.action).toBe('park');
    expect(d).not.toEqual({ action: 'dispatch', step: 'open-pr' });
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
