// Tier 1 unit tests for the project plan-status deriver.
//
// `deriveProjectPlanStatus` maps a project's research-report state + owned
// changes to a single string that drives the Plan-lifecycle stepper and the
// Phase Timeline on the project page. Bugs surface as silently-blank
// lifecycle widgets.
//
// This test exists primarily as a Task #417 regression guard. The bug was
// `status: updated` (written by research-update) wasn't in the function's
// switch — the deriver returned null, blanking both lifecycle widgets on
// every project whose research had been refreshed.
//
// Every branch documented in the function's mapping comment is exercised.

import { describe, expect, it } from 'vitest';
import {
  deriveProjectPlanStatus,
  derivePostApprovalStage,
} from '../../../domains/meta/app/server/routes/project-plan-status.js';
import type { OwnedChangeRef } from '../../../domains/meta/app/server/routes/projects.types.js';
import type { ResearchReportSummary } from '../../../domains/meta/app/server/routes/research.types.js';

// Helpers for building minimal stubs. The function only reads specific
// fields — we narrow to those to keep tests focused.
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

describe('deriveProjectPlanStatus — empty cases', () => {
  it('returns null when no research-reports exist', () => {
    expect(deriveProjectPlanStatus([], [])).toBeNull();
  });
});

describe('deriveProjectPlanStatus — status: draft', () => {
  it('maps draft → in-research regardless of other fields', () => {
    expect(deriveProjectPlanStatus([makeReport({ status: 'draft' })], [])).toBe('in-research');
    // Edge: draft + already-approved review_status (shouldn't happen but is well-defined)
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'draft', review_status: 'approved' })],
        [],
      ),
    ).toBe('in-research');
  });
});

describe('deriveProjectPlanStatus — status: reviewed', () => {
  it('reviewed + pending review → reviewed-pending', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'reviewed', review_status: 'pending' })],
        [],
      ),
    ).toBe('reviewed-pending');
  });

  it('reviewed + request-changes → request-changes', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'reviewed', review_status: 'request-changes' })],
        [],
      ),
    ).toBe('request-changes');
  });

  it('reviewed + approved + no scaffolded → approved', () => {
    expect(
      deriveProjectPlanStatus(
        [
          makeReport({
            status: 'reviewed',
            review_status: 'approved',
            recommended_changes_scaffolded: 0,
          }),
        ],
        [],
      ),
    ).toBe('approved');
  });

  it('reviewed + approved + scaffolded, no in-flight changes → scaffolded', () => {
    expect(
      deriveProjectPlanStatus(
        [
          makeReport({
            status: 'reviewed',
            review_status: 'approved',
            recommended_changes_scaffolded: 3,
          }),
        ],
        [makeChange('planning')],
      ),
    ).toBe('scaffolded');
  });

  it('reviewed + approved + scaffolded + in-flight changes → active', () => {
    expect(
      deriveProjectPlanStatus(
        [
          makeReport({
            status: 'reviewed',
            review_status: 'approved',
            recommended_changes_scaffolded: 3,
          }),
        ],
        [makeChange('in-progress')],
      ),
    ).toBe('active');
  });
});

describe('deriveProjectPlanStatus — status: approved', () => {
  it('approved + no scaffolded → approved', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'approved', recommended_changes_scaffolded: 0 })],
        [],
      ),
    ).toBe('approved');
  });

  it('approved + scaffolded + no in-flight → scaffolded', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'approved', recommended_changes_scaffolded: 4 })],
        [makeChange('planning'), makeChange('planning')],
      ),
    ).toBe('scaffolded');
  });

  it('approved + scaffolded + one merged change → active', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'approved', recommended_changes_scaffolded: 4 })],
        [makeChange('planning'), makeChange('merged')],
      ),
    ).toBe('active');
  });

  it.each(['in-progress', 'in-review', 'merged'])(
    'approved + scaffolded + any %s change → active',
    (status) => {
      expect(
        deriveProjectPlanStatus(
          [makeReport({ status: 'approved', recommended_changes_scaffolded: 1 })],
          [makeChange(status)],
        ),
      ).toBe('active');
    },
  );
});

describe('deriveProjectPlanStatus — status: updated (Task #417 regression)', () => {
  // The bug: research-update writes `status: updated` and the deriver
  // didn't have a case for it. These tests pin every branch so a future
  // refactor can't silently re-introduce the gap.

  it('updated + approved → derives like approved (post-approval logic)', () => {
    // The mull-version-2 case from the bug report.
    expect(
      deriveProjectPlanStatus(
        [
          makeReport({
            status: 'updated',
            review_status: 'approved',
            recommended_changes_scaffolded: 6,
          }),
        ],
        [makeChange('merged')],
      ),
    ).toBe('active');
  });

  it('updated + approved + no scaffolded → approved', () => {
    expect(
      deriveProjectPlanStatus(
        [
          makeReport({
            status: 'updated',
            review_status: 'approved',
            recommended_changes_scaffolded: 0,
          }),
        ],
        [],
      ),
    ).toBe('approved');
  });

  it('updated + request-changes → request-changes (refresh awaiting fix)', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'updated', review_status: 'request-changes' })],
        [],
      ),
    ).toBe('request-changes');
  });

  it('updated + pending → reviewed-pending (refresh awaiting re-review)', () => {
    expect(
      deriveProjectPlanStatus(
        [makeReport({ status: 'updated', review_status: 'pending' })],
        [],
      ),
    ).toBe('reviewed-pending');
  });
});

describe('deriveProjectPlanStatus — unknown status (forward-compat)', () => {
  it('returns null for an unrecognized status (current behavior)', () => {
    // Documents the current forward-compat behavior: unknown status =>
    // null. Same behavior as before Task #417 was fixed — but now if a
    // skill starts writing a new status value, the archetype-enums
    // structural test fires FIRST (block at commit time), so reaching
    // this branch at runtime requires actively bypassing the test suite.
    expect(
      deriveProjectPlanStatus([makeReport({ status: 'superseded' })], []),
    ).toBeNull();
  });
});

describe('deriveProjectPlanStatus — picks latest report by revision', () => {
  it('higher report_revision wins over lower', () => {
    const r1 = makeReport({
      id: 'r1',
      status: 'draft',
      report_revision: 1,
      updated: '2026-06-01T00:00:00Z',
    });
    const r2 = makeReport({
      id: 'r2',
      status: 'approved',
      review_status: 'approved',
      report_revision: 2,
      updated: '2026-05-31T00:00:00Z', // earlier `updated` than r1
      recommended_changes_scaffolded: 0,
    });
    expect(deriveProjectPlanStatus([r1, r2], [])).toBe('approved');
  });

  it('ties on revision break on `updated` desc', () => {
    const r1 = makeReport({
      id: 'r1',
      status: 'draft',
      report_revision: 1,
      updated: '2026-06-01T00:00:00Z',
    });
    const r2 = makeReport({
      id: 'r2',
      status: 'approved',
      review_status: 'approved',
      report_revision: 1, // same revision
      updated: '2026-06-02T00:00:00Z', // newer
      recommended_changes_scaffolded: 0,
    });
    expect(deriveProjectPlanStatus([r1, r2], [])).toBe('approved');
  });
});

describe('derivePostApprovalStage — direct', () => {
  it('no scaffolded recs → approved', () => {
    expect(
      derivePostApprovalStage(makeReport({ recommended_changes_scaffolded: 0 }), []),
    ).toBe('approved');
  });

  it('scaffolded + only planning changes → scaffolded', () => {
    expect(
      derivePostApprovalStage(
        makeReport({ recommended_changes_scaffolded: 3 }),
        [makeChange('planning'), makeChange('planning')],
      ),
    ).toBe('scaffolded');
  });

  it('scaffolded + at least one non-planning change → active', () => {
    expect(
      derivePostApprovalStage(
        makeReport({ recommended_changes_scaffolded: 3 }),
        [makeChange('planning'), makeChange('in-progress')],
      ),
    ).toBe('active');
  });
});
