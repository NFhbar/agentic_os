// Tier 1 unit tests for the project plan-state deriver.
//
// Since the shared review-state contract (Fable review, Finding 4.2) the
// deriver returns a PAIR — { plan_status (lifecycle), review_status (shared
// verdict enum) } — plus planStageId(), which collapses the pair into one
// linear id for stepper RENDERING only. The old single-string vocabulary
// ('reviewed-pending' et al.) is gone; this file and the migration note in
// archetype-project are the only places that should still spell it.
//
// Task #417 regression guard retained: `status: updated` (research-update)
// must keep deriving a post-approval stage instead of blanking widgets.

import { describe, expect, it } from 'vitest';
import {
  deriveProjectPlanState,
  derivePostApprovalStage,
  planStageId,
} from '../../../domains/meta/app/server/lib/lifecycle-state.js';
import type { OwnedChangeRef } from '../../../domains/meta/app/server/routes/projects.types.js';
import type { ResearchReportSummary } from '../../../domains/meta/app/server/routes/research.types.js';

function makeReport(overrides: Partial<ResearchReportSummary> = {}): ResearchReportSummary {
  return {
    id: 'r1',
    path: 'vault/wiki/research/research-report/r1.md',
    title: 'r1',
    project: 'p1',
    status: 'draft',
    review_status: 'pending',
    review_required: true,
    review_path: null,
    report_revision: 1,
    updated: '2026-06-01T00:00:00Z',
    recommended_changes_scaffolded: 0,
    ...overrides,
  } as ResearchReportSummary;
}

function makeChange(status: string): OwnedChangeRef {
  return {
    id: 'c1',
    title: 'c1',
    status,
    repo: null,
    branch: null,
    pr_url: null,
    path: 'vault/wiki/development/change/c1.md',
    updated: null,
    derived_from_report: null,
    recommendation_index: null,
    recommendations_total: null,
    review_status: null,
    pr_review_status: null,
    automation: null,
  };
}

describe('deriveProjectPlanState', () => {
  it('no reports → null pair, null stage', () => {
    const s = deriveProjectPlanState([], []);
    expect(s).toEqual({ plan_status: null, review_status: null });
    expect(planStageId(s)).toBeNull();
  });

  it('draft report → in-research / pending', () => {
    const s = deriveProjectPlanState([makeReport({ status: 'draft' })], []);
    expect(s).toEqual({ plan_status: 'in-research', review_status: 'pending' });
    expect(planStageId(s)).toBe('in-research');
  });

  it('reviewed + pending verdict → drafted / pending (awaiting-review stage)', () => {
    const s = deriveProjectPlanState([makeReport({ status: 'reviewed' })], []);
    expect(s).toEqual({ plan_status: 'drafted', review_status: 'pending' });
    expect(planStageId(s)).toBe('awaiting-review');
  });

  it('reviewed + request-changes → drafted / request-changes', () => {
    const s = deriveProjectPlanState(
      [makeReport({ status: 'reviewed', review_status: 'request-changes' })],
      [],
    );
    expect(s).toEqual({ plan_status: 'drafted', review_status: 'request-changes' });
    expect(planStageId(s)).toBe('request-changes');
  });

  it('approved, nothing scaffolded → drafted / approved (approved stage)', () => {
    const s = deriveProjectPlanState(
      [makeReport({ status: 'reviewed', review_status: 'approved' })],
      [],
    );
    expect(s).toEqual({ plan_status: 'drafted', review_status: 'approved' });
    expect(planStageId(s)).toBe('approved');
  });

  it('approved + scaffolded, no in-flight changes → scaffolded / approved', () => {
    const s = deriveProjectPlanState(
      [
        makeReport({
          status: 'approved',
          review_status: 'approved',
          recommended_changes_scaffolded: 6,
        }),
      ],
      [makeChange('planning')],
    );
    expect(s).toEqual({ plan_status: 'scaffolded', review_status: 'approved' });
    expect(planStageId(s)).toBe('scaffolded');
  });

  it('approved + scaffolded + in-flight change → active / approved', () => {
    const s = deriveProjectPlanState(
      [
        makeReport({
          status: 'approved',
          review_status: 'approved',
          recommended_changes_scaffolded: 6,
        }),
      ],
      [makeChange('in-progress')],
    );
    expect(s).toEqual({ plan_status: 'active', review_status: 'approved' });
    expect(planStageId(s)).toBe('active');
  });

  it('Task #417 guard: status updated + approved stays post-approval', () => {
    const s = deriveProjectPlanState(
      [
        makeReport({
          status: 'updated',
          review_status: 'approved',
          recommended_changes_scaffolded: 3,
        }),
      ],
      [makeChange('merged')],
    );
    expect(s).toEqual({ plan_status: 'active', review_status: 'approved' });
  });

  it('status updated + pending verdict → drafted / pending', () => {
    const s = deriveProjectPlanState([makeReport({ status: 'updated' })], []);
    expect(s).toEqual({ plan_status: 'drafted', review_status: 'pending' });
  });

  it('overridden verdict behaves like approved and survives into the pair', () => {
    const s = deriveProjectPlanState(
      [makeReport({ status: 'reviewed', review_status: 'overridden' })],
      [],
    );
    expect(s).toEqual({ plan_status: 'drafted', review_status: 'overridden' });
    expect(planStageId(s)).toBe('approved');
  });

  it('latest report wins by report_revision, then updated', () => {
    const s = deriveProjectPlanState(
      [
        makeReport({ id: 'old', status: 'draft', report_revision: 1 }),
        makeReport({
          id: 'new',
          status: 'reviewed',
          review_status: 'approved',
          report_revision: 2,
        }),
      ],
      [],
    );
    expect(s.review_status).toBe('approved');
  });
});

describe('derivePostApprovalStage', () => {
  it('zero scaffolded recommendations → drafted', () => {
    expect(derivePostApprovalStage(makeReport(), [])).toBe('drafted');
  });
});

describe('planStageId', () => {
  it('lifecycle pending → planning stage', () => {
    expect(planStageId({ plan_status: 'pending', review_status: null })).toBe('planning');
  });
});
