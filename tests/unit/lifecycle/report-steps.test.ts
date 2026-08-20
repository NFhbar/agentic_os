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
      order: ['drafted', 'reviewed', 'approved', 'updated'],
      cycled_step: null,
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

  // Loop ordering: research-update resets review_status to pending, which
  // pulls `reviewed` back to current with `updated` already done. Rendered in
  // the linear order that reads done·current·pending·done — a finished step
  // sitting behind an unfinished one. The reorder closes the gap.
  it('active update→re-review loop reorders chronologically and marks the cycled step', () => {
    const s = deriveReportSteps({ status: 'updated', review_status: 'pending', update_count: 1 });
    expect(s.order).toEqual(['drafted', 'updated', 'reviewed', 'approved']);
    expect(s.cycled_step).toBe('reviewed');
    // Read in `order`, the bar is done · done · current · pending — no gap.
    expect(s.order.map((id) => s[id])).toEqual(['done', 'done', 'current', 'pending']);
  });

  it('completed re-review drops back to the linear order', () => {
    const s = deriveReportSteps({ status: 'updated', review_status: 'approved', update_count: 1 });
    expect(s.order).toEqual(['drafted', 'reviewed', 'approved', 'updated']);
    expect(s.cycled_step).toBeNull();
  });

  it('an update with no review verdict at all still counts as a loop', () => {
    const s = deriveReportSteps({ status: 'updated', review_status: null, update_count: 3 });
    expect(s.order).toEqual(['drafted', 'updated', 'reviewed', 'approved']);
    expect(s.cycled_step).toBe('reviewed');
  });

  it('a pending review with no update is NOT a loop', () => {
    const s = deriveReportSteps({ status: 'draft', review_status: 'pending', update_count: 0 });
    expect(s.order).toEqual(['drafted', 'reviewed', 'approved', 'updated']);
    expect(s.cycled_step).toBeNull();
  });

  it('order arrays are per-call copies (a mutating consumer cannot poison the next call)', () => {
    const a = deriveReportSteps({ status: 'draft', review_status: null, update_count: 0 });
    a.order.push('reviewed');
    const b = deriveReportSteps({ status: 'draft', review_status: null, update_count: 0 });
    expect(b.order).toEqual(['drafted', 'reviewed', 'approved', 'updated']);
  });
});
