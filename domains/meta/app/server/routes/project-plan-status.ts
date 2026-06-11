// Pure deriver for a project's plan state. Pulled out of projects.ts so unit
// tests can exercise it without the I/O-heavy module (which transitively
// imports vault walkers, sqlite, etc.). Same separation pattern as
// automation-state-machine.ts.
//
// Since the shared review-state contract (Fable review, Finding 4.2) the
// deriver returns a PAIR instead of one mixed string:
//   plan_status   — lifecycle only: pending | in-research | drafted |
//                   scaffolded | active
//   review_status — the shared 6-value verdict enum used by change plans and
//                   research-reports: pending | approved | request-changes |
//                   rejected | overridden | not-required
// The old single-string vocabulary ('reviewed-pending' et al.) mixed the two
// axes and gave projects a third review dialect. planStageId() collapses the
// pair back into one linear id for stepper/timeline RENDERING only — display
// granularity is not contract vocabulary.
//
// Bugs here surface as silently-blank lifecycle widgets — Task #417 is the
// canonical case (research-update added a `status: updated` value the
// deriver didn't cover). tests/unit/projects/deriveProjectPlanStatus.test.ts
// pins every branch.

import type { OwnedChangeRef } from './projects.types.js';
import type { ResearchReportSummary } from './research.types.js';

export type PlanLifecycleStatus = 'pending' | 'in-research' | 'drafted' | 'scaffolded' | 'active';
export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'request-changes'
  | 'rejected'
  | 'overridden'
  | 'not-required';

export interface DerivedPlanState {
  plan_status: PlanLifecycleStatus | null;
  review_status: ReviewStatus | null;
}

export function deriveProjectPlanState(
  researchReports: ResearchReportSummary[],
  ownedChanges: OwnedChangeRef[],
): DerivedPlanState {
  if (researchReports.length === 0) return { plan_status: null, review_status: null };
  // Pick the latest report by report_revision desc, falling back to `updated`.
  const latest = [...researchReports].sort((a, b) => {
    const aR = a.report_revision ?? 0;
    const bR = b.report_revision ?? 0;
    if (bR !== aR) return bR - aR;
    return (b.updated ?? '').localeCompare(a.updated ?? '');
  })[0];
  const rs = latest.status;
  const rv = latest.review_status;
  if (rs === 'draft') return { plan_status: 'in-research', review_status: 'pending' };
  if (rs === 'reviewed' || rs === 'updated') {
    if (rv === 'request-changes')
      return { plan_status: 'drafted', review_status: 'request-changes' };
    if (rv === 'approved' || rv === 'overridden') {
      // The scaffolder consumed the report even though status may still be
      // 'reviewed' (the reviewed → approved flip is a separate human step,
      // but the scaffolder doesn't require it). Treat as post-approval.
      return {
        plan_status: derivePostApprovalStage(latest, ownedChanges),
        review_status: rv,
      };
    }
    return { plan_status: 'drafted', review_status: 'pending' };
  }
  if (rs === 'approved') {
    return {
      plan_status: derivePostApprovalStage(latest, ownedChanges),
      review_status: rv === 'overridden' ? 'overridden' : 'approved',
    };
  }
  return { plan_status: null, review_status: null };
}

export function derivePostApprovalStage(
  latest: ResearchReportSummary,
  ownedChanges: OwnedChangeRef[],
): PlanLifecycleStatus {
  const scaffoldedRecs = latest.recommended_changes_scaffolded ?? 0;
  if (scaffoldedRecs === 0) return 'drafted';
  // Any owned change past planning → automation/lifecycle is active.
  const anyInFlight = ownedChanges.some(
    (c) => c.status === 'in-progress' || c.status === 'in-review' || c.status === 'merged',
  );
  return anyInFlight ? 'active' : 'scaffolded';
}

// Collapse the pair into one linear stage id for the Plan-lifecycle stepper
// + Phase Timeline. Rendering vocabulary only — never persisted.
export type PlanStageId =
  | 'planning'
  | 'in-research'
  | 'awaiting-review'
  | 'request-changes'
  | 'approved'
  | 'scaffolded'
  | 'active';

export function planStageId(state: DerivedPlanState): PlanStageId | null {
  const { plan_status, review_status } = state;
  if (plan_status === null) return null;
  if (plan_status === 'pending') return 'planning';
  if (plan_status === 'in-research') return 'in-research';
  if (plan_status === 'drafted') {
    if (review_status === 'request-changes') return 'request-changes';
    if (review_status === 'approved' || review_status === 'overridden') return 'approved';
    return 'awaiting-review';
  }
  return plan_status; // 'scaffolded' | 'active'
}
