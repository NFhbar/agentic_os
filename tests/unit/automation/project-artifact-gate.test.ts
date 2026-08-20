// Artifact gate for the PROJECT orchestrator (executeTick in automation.ts).
//
// The project loop advances write → open-pr → review → merge on any exit-0
// run. A clean REFUSAL therefore used to "complete" the whole chain having
// produced nothing — the refusal-ghost class the per-change loop already
// closed with evaluateArtifactMovement. `verifyProjectStepArtifacts` closes it
// at the project altitude by REUSING the change loop's own artifact
// classifier (deriveCompletedStepFromArtifacts + STEP_RANK) rather than a
// parallel one.
//
// The load-bearing property is asymmetric: the gate is INERT ON UNCERTAINTY.
// Only `missing` parks; `verified` and `inert` both advance, because
// false-parking a healthy project is the rejected failure mode. Every branch
// that cannot prove absence must therefore return `inert`.

import { describe, expect, it } from 'vitest';
import {
  PROJECT_STEP_REQUIRED_COMPLETION,
  verifyProjectStepArtifacts,
} from '../../../domains/meta/app/server/routes/automation-state-machine.js';
import type {
  ArtifactObservation,
  ProjectStepArtifactContext,
} from '../../../domains/meta/app/server/routes/automation-state-machine.js';

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

function ctx(c: Partial<ProjectStepArtifactContext>): ProjectStepArtifactContext {
  return {
    change_status: null,
    observed: obs({}),
    latest_pass_acted: false,
    branch: null,
    run_summary: null,
    ...c,
  };
}

describe('PROJECT_STEP_REQUIRED_COMPLETION', () => {
  it('maps every dispatching project step to its change-lifecycle completion class', () => {
    expect(PROJECT_STEP_REQUIRED_COMPLETION).toEqual({
      write: 'execute',
      'open-pr': 'open-pr',
      review: 'pr-review',
    });
  });

  it('omits the merge step — it dispatches no skill, so it has no artifact to demand', () => {
    expect(PROJECT_STEP_REQUIRED_COMPLETION.merge).toBeUndefined();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PROJECT_STEP_REQUIRED_COMPLETION)).toBe(true);
  });
});

describe('verifyProjectStepArtifacts — refusal ghosts park', () => {
  it('write: a run that exits 0 with no branch and no status movement is missing (the ghost)', () => {
    // The regression: dev-write-change declines at its draft gate, exits 0,
    // and the project pointer used to march on to open-pr → review.
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({
        change_status: 'planning',
        observed: obs({ head: null, head_error: 'ref-not-found' }),
        branch: 'feat/ghost',
      }),
    );
    expect(v.verdict).toBe('missing');
    if (v.verdict !== 'missing') return;
    expect(v.required).toBe('execute');
    expect(v.detail).toContain('feat/ghost');
    expect(v.detail).toContain('ref not found');
  });

  it('write: commits landed but the status writeback never did is still missing', () => {
    // The wall-cap partial-completion class — the change loop's classifier
    // already refuses to call this `execute` complete; the project gate
    // inherits that judgment rather than re-deriving it.
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({
        change_status: 'planning',
        observed: obs({ head: 'abcdef1234' }),
        branch: 'feat/half',
      }),
    );
    expect(v.verdict).toBe('missing');
    if (v.verdict !== 'missing') return;
    expect(v.detail).toContain("still 'planning'");
    expect(v.detail).toContain('abcdef1');
  });

  it('open-pr: an exit-0 run that never linked a pr_url is missing', () => {
    const v = verifyProjectStepArtifacts(
      'open-pr',
      ctx({ change_status: 'in-progress', observed: obs({ head: 'abc' }) }),
    );
    expect(v.verdict).toBe('missing');
    if (v.verdict !== 'missing') return;
    expect(v.required).toBe('open-pr');
    expect(v.detail).toContain('pr_url');
  });

  it('review: an exit-0 run that produced no review pass is missing', () => {
    const v = verifyProjectStepArtifacts(
      'review',
      ctx({
        change_status: 'in-review',
        observed: obs({ head: 'abc', pr_url: 'https://github.com/o/r/pull/7' }),
      }),
    );
    expect(v.verdict).toBe('missing');
    if (v.verdict !== 'missing') return;
    expect(v.required).toBe('pr-review');
    expect(v.detail).toContain('no pr-review entry linked');
  });

  it('review: a linked review entry with zero passes is missing and names the count', () => {
    const v = verifyProjectStepArtifacts(
      'review',
      ctx({
        change_status: 'in-review',
        observed: obs({ head: 'abc', pr_url: 'pr', pr_review_path_set: true, pass_count: 0 }),
      }),
    );
    expect(v.verdict).toBe('missing');
    if (v.verdict !== 'missing') return;
    expect(v.detail).toContain('pass_count 0');
  });

  it('quotes the refusing run summary and keeps the whole detail on ONE line', () => {
    // Park reasons serialize into single-line YAML flow — a wrapped detail
    // corrupts the project entry's frontmatter.
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({
        change_status: 'planning',
        observed: obs({ head_error: 'ref-not-found' }),
        branch: 'feat/x',
        run_summary: '✗ Refused — the plan is still a draft',
      }),
    );
    expect(v.verdict).toBe('missing');
    if (v.verdict !== 'missing') return;
    expect(v.detail).toContain('run summary: "✗ Refused — the plan is still a draft"');
    expect(v.detail).not.toContain('\n');
  });
});

describe('verifyProjectStepArtifacts — inert on uncertainty', () => {
  it('an unknown step advances (forward-compat: new step kinds are not judged)', () => {
    const v = verifyProjectStepArtifacts('deploy', ctx({ change_status: 'planning' }));
    expect(v.verdict).toBe('inert');
  });

  it('the merge step advances — no skill dispatched, no artifact to demand', () => {
    // The merge watcher synthesizes a tick with current_step 'merge'; parking
    // there would strand every project at the human-merge boundary.
    const v = verifyProjectStepArtifacts('merge', ctx({ change_status: 'in-review' }));
    expect(v.verdict).toBe('inert');
  });

  it('a null step advances', () => {
    expect(verifyProjectStepArtifacts(null, ctx({})).verdict).toBe('inert');
  });

  it('write with a degraded git read advances — unknown is not absent', () => {
    // repo entity missing / dir gone / no branch configured / git unavailable.
    // Same posture evaluateArtifactMovement takes for the change loop.
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({ change_status: 'planning', observed: obs({ head_error: 'degraded' }) }),
    );
    expect(v.verdict).toBe('inert');
  });

  it('open-pr with a degraded git read still parks — pr_url is a frontmatter fact', () => {
    // The degraded read must NOT soften verdicts it says nothing about,
    // otherwise one unreadable clone disables the gate wholesale.
    const v = verifyProjectStepArtifacts(
      'open-pr',
      ctx({ change_status: 'in-progress', observed: obs({ head_error: 'degraded' }) }),
    );
    expect(v.verdict).toBe('missing');
  });

  it('a throwing classifier advances instead of parking', () => {
    const exploding = new Proxy(obs({}), {
      get() {
        throw new Error('boom');
      },
    }) as ArtifactObservation;
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({ change_status: 'planning', observed: exploding }),
    );
    expect(v.verdict).toBe('inert');
    if (v.verdict !== 'inert') return;
    expect(v.why).toContain('boom');
  });
});

describe('verifyProjectStepArtifacts — happy path advances', () => {
  it('write: branch head plus status movement verifies as execute', () => {
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({
        change_status: 'in-progress',
        observed: obs({ head: 'abcdef1' }),
        branch: 'feat/real',
      }),
    );
    expect(v).toEqual({ verdict: 'verified', completed: 'execute' });
  });

  it('open-pr: a linked pr_url verifies', () => {
    const v = verifyProjectStepArtifacts(
      'open-pr',
      ctx({
        change_status: 'in-review',
        observed: obs({ head: 'abc', pr_url: 'https://github.com/o/r/pull/9' }),
      }),
    );
    expect(v).toEqual({ verdict: 'verified', completed: 'open-pr' });
  });

  it('review: a review entry with a pass verifies', () => {
    const v = verifyProjectStepArtifacts(
      'review',
      ctx({
        change_status: 'in-review',
        observed: obs({ head: 'abc', pr_url: 'pr', pr_review_path_set: true, pass_count: 1 }),
      }),
    );
    expect(v).toEqual({ verdict: 'verified', completed: 'pr-review' });
  });

  it('review: an already-acted pass verifies at the higher address-comments rank', () => {
    // Rank, not equality — the classifier returns 'address-comments' (rank 4)
    // once the latest pass is fully acted on, which still satisfies pr-review.
    const v = verifyProjectStepArtifacts(
      'review',
      ctx({
        change_status: 'in-review',
        latest_pass_acted: true,
        observed: obs({ head: 'abc', pr_url: 'pr', pr_review_path_set: true, pass_count: 2 }),
      }),
    );
    expect(v).toEqual({ verdict: 'verified', completed: 'address-comments' });
  });

  it('grandfathers a mid-flight project: write verifies off artifacts already past it', () => {
    // Judge only the step that just completed — a change that already carries
    // a PR satisfies the write postcondition at a higher rank and advances.
    const v = verifyProjectStepArtifacts(
      'write',
      ctx({
        change_status: 'in-review',
        observed: obs({ head: 'abc', pr_url: 'https://github.com/o/r/pull/4' }),
      }),
    );
    expect(v.verdict).toBe('verified');
  });
});
