// Tier 1 unit tests for the change-automation eligibility gate.
//
// `checkChangeAutomationEligibility` guards the enable + start endpoints:
// automation may only arm/dispatch when the plan exists and has been signed
// off (standard-automation-loop § Scope). Added after the 2026-06-12
// live-fire incident where `start` accepted a change at status: planning /
// review_status: pending with no plan — the dispatched dev-write-change
// correctly refused, but the orchestrator advanced anyway.

import { describe, expect, it } from 'vitest';
import { checkChangeAutomationEligibility } from '../../../domains/meta/app/server/routes/automation-state-machine.js';

describe('checkChangeAutomationEligibility — rejections', () => {
  it('rejects review_status pending (2026-06-12 incident replay)', () => {
    const r = checkChangeAutomationEligibility({ review_status: 'pending', plan_path: null });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toContain('not eligible for automation');
      expect(r.reason).toContain('approved | not-required | overridden');
      expect(r.reason).toContain('(got "pending")');
      expect(r.reason).toContain(
        'automation runs the implementation, not the judgment (standard-automation-loop § Scope)',
      );
      expect(r.reason).toContain('Run write-change (PLAN) + review-change first.');
    }
  });

  it('rejects approved without plan_path', () => {
    const r = checkChangeAutomationEligibility({ review_status: 'approved', plan_path: null });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toContain('plan_path must be set');
    }
  });

  it('not-required without plan_path gets the PLAN-only next-action', () => {
    // Review-exempt changes must not be told to run review-change — the
    // next-action clause is conditional on what's actually missing.
    const r = checkChangeAutomationEligibility({ review_status: 'not-required', plan_path: null });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toContain('Run write-change (PLAN) first.');
      expect(r.reason).not.toContain('review-change');
    }
  });

  it('rejects null review_status with the got-value spelled out', () => {
    const r = checkChangeAutomationEligibility({ review_status: null, plan_path: 'some/plan.md' });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toContain('(got "null")');
    }
  });

  it('rejects request-changes even with a plan present', () => {
    const r = checkChangeAutomationEligibility({
      review_status: 'request-changes',
      plan_path: 'vault/output/development/changes/x-plan.md',
    });
    expect(r.eligible).toBe(false);
  });

  it('rejects an empty/whitespace plan_path', () => {
    const r = checkChangeAutomationEligibility({ review_status: 'approved', plan_path: '   ' });
    expect(r.eligible).toBe(false);
  });
});

describe('checkChangeAutomationEligibility — accepted states (operator-constraint happy path)', () => {
  it.each(['approved', 'not-required', 'overridden'])(
    'accepts review_status %s with plan_path set',
    (review_status) => {
      const r = checkChangeAutomationEligibility({
        review_status,
        plan_path: 'vault/output/development/changes/x-plan.md',
      });
      expect(r).toEqual({ eligible: true });
    },
  );
});
