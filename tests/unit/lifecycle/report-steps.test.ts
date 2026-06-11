// Pins the research-report stepper derivation in lib/lifecycle-state.ts —
// previously derived client-side in the research Detail page (the Finding
// 4.3 dialect-drift pattern). Faithful-port semantics: `reviewed` counts ANY
// non-pending verdict as done; `approved` lights only on an approved verdict
// or report-level status: approved (overridden deliberately does NOT).
import { describe, expect, it } from 'vitest';
import { deriveReportSteps } from '../../../domains/meta/app/server/lib/lifecycle-state.js';

describe('deriveReportSteps', () => {
  it('fresh draft: drafted done, nothing else moving', () => {
    expect(deriveReportSteps({ status: 'draft', review_status: null, update_count: 0 })).toEqual({
      drafted: 'done',
      reviewed: 'pending',
      approved: 'pending',
      updated: 'pending',
    });
  });

  it('review pending: reviewed step is current', () => {
    const s = deriveReportSteps({ status: 'draft', review_status: 'pending', update_count: 0 });
    expect(s.reviewed).toBe('current');
    expect(s.approved).toBe('pending');
  });

  it('request-changes: reviewed done, approved current', () => {
    const s = deriveReportSteps({
      status: 'reviewed',
      review_status: 'request-changes',
      update_count: 0,
    });
    expect(s.reviewed).toBe('done');
    expect(s.approved).toBe('current');
  });

  it('approved verdict lights the approved step', () => {
    const s = deriveReportSteps({ status: 'reviewed', review_status: 'approved', update_count: 0 });
    expect(s.approved).toBe('done');
  });

  it('report-level status: approved also lights it', () => {
    const s = deriveReportSteps({ status: 'approved', review_status: 'pending', update_count: 0 });
    expect(s.approved).toBe('done');
  });

  it('overridden does NOT light approved (faithful-port semantics)', () => {
    const s = deriveReportSteps({
      status: 'reviewed',
      review_status: 'overridden',
      update_count: 0,
    });
    expect(s.reviewed).toBe('done');
    expect(s.approved).toBe('current');
  });

  it('update_count > 0 lights updated; null tolerated as 0', () => {
    expect(deriveReportSteps({ status: 'approved', review_status: 'approved', update_count: 2 }).updated).toBe('done');
    expect(deriveReportSteps({ status: 'approved', review_status: 'approved', update_count: null }).updated).toBe('pending');
  });
});
