// Pure deriver for a project's plan-lifecycle stage. Pulled out of
// projects.ts so unit tests can exercise it without the I/O-heavy module
// (which transitively imports vault walkers, sqlite, etc.). Same separation
// pattern as automation-state-machine.ts.
//
// The function maps the project's research-report state + owned changes to
// a single string that drives the Plan-lifecycle stepper + the Phase
// Timeline on the project page. Bugs here surface as silently-blank lifecycle
// widgets — Task #417 is the canonical case (research-update added a new
// `status: updated` value that the deriver didn't cover).
//
// The companion test in tests/unit/projects/deriveProjectPlanStatus.test.ts
// pins every documented branch.

import type { OwnedChangeRef } from './projects.types.js';
import type { ResearchReportSummary } from './research.types.js';

export function deriveProjectPlanStatus(
  researchReports: ResearchReportSummary[],
  ownedChanges: OwnedChangeRef[],
): string | null {
  if (researchReports.length === 0) return null;
  // Pick the latest report by report_revision desc, falling back to `updated`.
  const latest = [...researchReports].sort((a, b) => {
    const aR = a.report_revision ?? 0;
    const bR = b.report_revision ?? 0;
    if (bR !== aR) return bR - aR;
    return (b.updated ?? '').localeCompare(a.updated ?? '');
  })[0];
  const rs = latest.status;
  const rv = latest.review_status;
  if (rs === 'draft') return 'in-research';
  if (rs === 'reviewed') {
    if (rv === 'request-changes') return 'request-changes';
    if (rv === 'approved') {
      // The scaffolder consumed the report even though status is still
      // 'reviewed' (the reviewed → approved flip is a separate human step,
      // but the scaffolder doesn't require it). Treat reviewed+approved as
      // post-approval for stepper purposes.
      return derivePostApprovalStage(latest, ownedChanges);
    }
    return 'reviewed-pending';
  }
  if (rs === 'approved') {
    return derivePostApprovalStage(latest, ownedChanges);
  }
  // `status: updated` is what research-update writes back after a refresh —
  // an approved report stays approved, but the status field changes to
  // signal "the report has been re-walked since its original write." For
  // stepper purposes, dispatch on review_status: an approved+updated report
  // is post-approval (same as 'approved'); a non-approved+updated report is
  // a pending refresh awaiting re-review.
  if (rs === 'updated') {
    if (rv === 'approved') return derivePostApprovalStage(latest, ownedChanges);
    if (rv === 'request-changes') return 'request-changes';
    return 'reviewed-pending';
  }
  return null;
}

export function derivePostApprovalStage(
  latest: ResearchReportSummary,
  ownedChanges: OwnedChangeRef[],
): string {
  const scaffoldedRecs = latest.recommended_changes_scaffolded ?? 0;
  if (scaffoldedRecs === 0) return 'approved';
  // Any owned change past planning → automation/lifecycle is active.
  const anyInFlight = ownedChanges.some(
    (c) => c.status === 'in-progress' || c.status === 'in-review' || c.status === 'merged',
  );
  return anyInFlight ? 'active' : 'scaffolded';
}
