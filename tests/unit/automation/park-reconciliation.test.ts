// Park reconciliation for the change-automation orchestrator. The pure
// `decideParkReconciliation` decides whether a stale automation block should
// unpark (a park whose step completed out-of-band) or complete-terminal (a
// merged/abandoned change with a live block), STATE-ONLY — the caller never
// dispatches from a poll.
//
// The load-bearing property is the UNPARK CONJUNCTION: movement since the
// park's own dispatch AND the parked step's postcondition per the classifier.
// Two negative cases pin why it must be a conjunction — the wall-cap
// partial-completion class (movement true, postcondition unmet) and the
// stale-postcondition re-review park (postcondition met by a prior pass,
// movement false) must BOTH stay parked.

import { describe, expect, it } from 'vitest';
import { decideParkReconciliation } from '../../../domains/meta/app/server/routes/automation-state-machine.js';
import type { ArtifactObservation } from '../../../domains/meta/app/server/routes/automation-state-machine.js';
import type { ChangeAutomationDispatchBaseline } from '../../../domains/meta/app/server/routes/changes.types.js';

function obs(o: Partial<ArtifactObservation>): ArtifactObservation {
  return {
    head: null,
    head_error: null,
    pr_url: null,
    pass_count: null,
    pr_review_path_set: false,
    ...o,
  };
}

function baseline(b: Partial<ChangeAutomationDispatchBaseline>): ChangeAutomationDispatchBaseline {
  return { head_sha: null, head_degraded: false, pr_url: null, pass_count: null, ...b };
}

describe('decideParkReconciliation — unpark', () => {
  it('skill-refused park at open-pr unparks when pr_url lands out-of-band', () => {
    const d = decideParkReconciliation({
      change_status: 'in-review',
      phase: 'paused',
      paused_reason: 'skill-refused: open-pr exited 0 without artifact movement — pr_url not set',
      current_step: 'open-pr',
      baseline: baseline({ head_sha: 'abc', pr_url: null }),
      observed: obs({ head: 'abc', pr_url: 'https://github.com/o/r/pull/13' }),
      latest_pass_acted: false,
    });
    expect(d.action).toBe('unpark');
  });

  it('skill-failure park at pr-review unparks when a new pass exists (verdict-state resume-loop replay)', () => {
    // The verdict-state #1 loop: a non-zero pr-review exit parked skill-failure
    // while a NEW pass had actually landed. Unpark clears the park (and — via
    // the I/O wrapper's action contract — nulls last_run_id so the stale
    // non-zero exit can't re-drive a re-park on the next Start).
    const d = decideParkReconciliation({
      change_status: 'in-review',
      phase: 'paused',
      paused_reason: 'skill-failure: pr-review exited 1',
      current_step: 'pr-review',
      baseline: baseline({ head_sha: 'abc', pr_url: 'pr', pass_count: 0 }),
      observed: obs({ head: 'abc', pr_url: 'pr', pass_count: 1, pr_review_path_set: true }),
      latest_pass_acted: false,
    });
    expect(d.action).toBe('unpark');
  });

  it('skill-failure park at execute with commits but change_status still planning does NOT unpark', () => {
    // Wall-cap partial-completion: commits landed (movement TRUE) but EXECUTE
    // never ran its status writeback (status still planning → classifier null,
    // postcondition UNMET). Must stay parked — advancing would open a PR on
    // incomplete work.
    const d = decideParkReconciliation({
      change_status: 'planning',
      phase: 'paused',
      paused_reason: 'skill-failure: execute exited 137',
      current_step: 'execute',
      baseline: baseline({ head_sha: 'old' }),
      observed: obs({ head: 'new' }),
      latest_pass_acted: false,
    });
    expect(d.action).toBe('none');
  });

  it('skill-refused park at pr-review with a prior pass but no new pass does NOT unpark', () => {
    // Stale-postcondition converse: pass_count > 0 already held at park time
    // (postcondition satisfiable by the PRIOR pass — classifier would return
    // pr-review), but no NEW pass landed (movement FALSE). A postcondition-only
    // bar would unpark → the next Start re-parks. The conjunction keeps it
    // parked; this is why the bar is movement AND postcondition.
    const d = decideParkReconciliation({
      change_status: 'in-review',
      phase: 'paused',
      paused_reason:
        'skill-refused: pr-review exited 0 without artifact movement — no new review pass (pass_count still 1)',
      current_step: 'pr-review',
      baseline: baseline({ head_sha: 'abc', pr_url: 'pr', pass_count: 1 }),
      observed: obs({ head: 'abc', pr_url: 'pr', pass_count: 1, pr_review_path_set: true }),
      latest_pass_acted: false,
    });
    expect(d.action).toBe('none');
  });

  it('absent baseline never unparks (legacy in-flight parks recover via Resume/Reset)', () => {
    const d = decideParkReconciliation({
      change_status: 'in-review',
      phase: 'paused',
      paused_reason: 'skill-refused: open-pr exited 0 without artifact movement — pr_url not set',
      current_step: 'open-pr',
      baseline: null,
      observed: obs({ pr_url: 'https://github.com/o/r/pull/13' }),
      latest_pass_acted: false,
    });
    expect(d.action).toBe('none');
  });
});

describe('decideParkReconciliation — never-reconcile exclusions', () => {
  // A both-bars-satisfied open-pr state: pr_url landed out-of-band (movement
  // true) AND the classifier returns open-pr (postcondition met). Under a
  // skill-refused/skill-failure reason this WOULD unpark — so it isolates the
  // reason-prefix exclusion.
  const bothBars = {
    change_status: 'in-review',
    phase: 'paused' as const,
    current_step: 'open-pr',
    baseline: baseline({ head_sha: 'abc', pr_url: null }),
    observed: obs({ head: 'abc', pr_url: 'https://github.com/o/r/pull/13' }),
    latest_pass_acted: false,
  };

  it('needs-triage / user-paused / iteration-cap / verification-unavailable / dispatch-failure parks never auto-unpark', () => {
    const reasons = [
      'user-paused',
      'needs-triage: latest pr-review pass has comments to triage',
      'iteration-cap-reached: 4 loops',
      'verification-unavailable: cannot verify open-pr artifact movement — baseline degraded',
      'dispatch-failure: ⊘ Re-review debounced — head unchanged since pass 2',
    ];
    for (const paused_reason of reasons) {
      const d = decideParkReconciliation({ ...bothBars, paused_reason });
      expect(d.action, `reason "${paused_reason}" must not auto-unpark`).toBe('none');
    }
    // Control: the SAME both-bars state DOES unpark under skill-refused, so the
    // exclusions above are the reason-prefix filter, not an unmet bar.
    expect(
      decideParkReconciliation({
        ...bothBars,
        paused_reason: 'skill-refused: open-pr exited 0 without artifact movement — pr_url not set',
      }).action,
    ).toBe('unpark');
  });
});

describe('decideParkReconciliation — complete-terminal', () => {
  it('merged (or abandoned) change with paused or running block reconciles complete-terminal; idle never-ran block does not', () => {
    expect(
      decideParkReconciliation({
        change_status: 'merged',
        phase: 'paused',
        paused_reason: 'user-paused',
        current_step: 'pr-review',
        baseline: null,
        observed: obs({}),
        latest_pass_acted: false,
      }).action,
    ).toBe('complete-terminal');

    expect(
      decideParkReconciliation({
        change_status: 'abandoned',
        phase: 'running',
        paused_reason: null,
        current_step: 'execute',
        baseline: null,
        observed: obs({}),
        latest_pass_acted: false,
      }).action,
    ).toBe('complete-terminal');

    // idle never-ran block on a merged change: nothing to complete.
    expect(
      decideParkReconciliation({
        change_status: 'merged',
        phase: 'idle',
        paused_reason: null,
        current_step: null,
        baseline: null,
        observed: obs({}),
        latest_pass_acted: false,
      }).action,
    ).toBe('none');

    // Deliberate narrow scope (review concern 2): an idle block WITH a live
    // current_step on a merged change is NOT reconciled here — the plan keeps
    // terminal reconciliation to phase ∈ {paused, running}.
    expect(
      decideParkReconciliation({
        change_status: 'merged',
        phase: 'idle',
        paused_reason: null,
        current_step: 'open-pr',
        baseline: null,
        observed: obs({}),
        latest_pass_acted: false,
      }).action,
    ).toBe('none');
  });
});
