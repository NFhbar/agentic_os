// Pins every branch of the EXECUTE-bound classifier (execute-phase.ts) —
// the review-gate table it mirrors lives in dev-write-change's Step 2, so a
// drift between the two silently routes dispatches to the wrong model.

import { describe, expect, it } from 'vitest';
import { classifyChangeDispatchPhase } from '../../../domains/meta/app/server/lib/execute-phase.js';

const PROMPT = 'Run the dev-write-change skill for change "some-change".';

describe('classifyChangeDispatchPhase', () => {
  it('approved → execute-bound', () => {
    expect(
      classifyChangeDispatchPhase({ review_status: 'approved', plan_path: null, prompt: PROMPT }),
    ).toBe('execute-bound');
  });

  it('overridden → execute-bound', () => {
    expect(
      classifyChangeDispatchPhase({ review_status: 'overridden', plan_path: null, prompt: PROMPT }),
    ).toBe('execute-bound');
  });

  it('not-required with a plan → execute-bound', () => {
    expect(
      classifyChangeDispatchPhase({
        review_status: 'not-required',
        plan_path: 'vault/output/development/changes/x-plan.md',
        prompt: PROMPT,
      }),
    ).toBe('execute-bound');
  });

  it('not-required without a plan → plan-bound (skips only the review gate, never planning)', () => {
    expect(
      classifyChangeDispatchPhase({
        review_status: 'not-required',
        plan_path: null,
        prompt: PROMPT,
      }),
    ).toBe('plan-bound');
  });

  it('pending / request-changes / rejected / unset / unknown → plan-bound', () => {
    for (const review_status of ['pending', 'request-changes', 'rejected', null, 'bogus-value']) {
      expect(
        classifyChangeDispatchPhase({ review_status, plan_path: 'some-plan.md', prompt: PROMPT }),
      ).toBe('plan-bound');
    }
  });

  it('force_replan flag reclassifies an approved change as plan-bound', () => {
    for (const flag of [
      'force_replan: true',
      'force_replan=true',
      'force_replan:true',
      'FORCE_REPLAN: TRUE',
    ]) {
      expect(
        classifyChangeDispatchPhase({
          review_status: 'approved',
          plan_path: 'some-plan.md',
          prompt: `${PROMPT} with ${flag}`,
        }),
      ).toBe('plan-bound');
    }
  });

  it('force_replan: false is not a re-plan — approved stays execute-bound', () => {
    expect(
      classifyChangeDispatchPhase({
        review_status: 'approved',
        plan_path: 'some-plan.md',
        prompt: `${PROMPT} with force_replan: false`,
      }),
    ).toBe('execute-bound');
  });

  it('not-required + plan + force_replan → plan-bound (force_replan is checked first)', () => {
    // Deliberate one-cell divergence from dev-write-change's table, which
    // reads not-required as ignoring force_replan. FORCE_REPLAN_RE fires
    // ahead of the not-required row here, so a forced re-plan of a
    // not-required change classifies plan-bound. Fail-safe (EXECUTE on the
    // planning model) — pinned so the divergence can't drift silently.
    expect(
      classifyChangeDispatchPhase({
        review_status: 'not-required',
        plan_path: 'vault/output/development/changes/x-plan.md',
        prompt: `${PROMPT} with force_replan: true`,
      }),
    ).toBe('plan-bound');
  });
});
