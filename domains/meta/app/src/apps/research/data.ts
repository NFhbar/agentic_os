// Type re-exports from the server's wire-shape definitions. Per
// standard-shared-types (sibling .types.ts pattern), the server route file's
// .types.ts is the single source of truth — this module re-exports them so
// existing client imports keep working AND adds the client-only runtime
// constants + UI-only enums (NOTE_SEVERITIES, RecChangeStatus narrow, etc).

export type {
  FileRef,
} from '../../../server/routes/changes.types';
export type {
  MaterialRef,
  NoteConsideredEntry,
  NoteRef,
  NoteSeverity,
  RecommendedChangeRef,
  ReplayTimelineEntry,
  ResearchReportDetail,
  ResearchReportSummary,
  UpdateTrigger,
  UpdateTriggerKind,
} from '../../../server/routes/research.types';

// Client-only convenience enums + status unions. These stay here because they
// carry runtime values (NOTE_SEVERITIES is a tuple used to render select
// options) or narrow string-typed server fields for tighter UI rendering.

export type ResearchReportStatus = 'draft' | 'reviewed' | 'approved' | 'updated' | string;
export type ResearchReviewStatus =
  | 'pending'
  | 'request-changes'
  | 'approved'
  | 'overridden'
  | string;

// Strict client-side union for recommendation status (matches the four
// archetype-defined values). Server emits this field as a loose string union;
// the client narrows for badge rendering.
export type RecChangeStatus = 'proposed' | 'scaffolded' | 'merged' | 'abandoned';

export const REC_CHANGE_STATUSES: readonly RecChangeStatus[] = [
  'proposed',
  'scaffolded',
  'merged',
  'abandoned',
];

export function isKnownRecChangeStatus(s: string | null | undefined): s is RecChangeStatus {
  return s != null && (REC_CHANGE_STATUSES as readonly string[]).includes(s);
}

// LinkedChangeRef matches the inline object on RecommendedChangeRef.linked_change.
// Kept as a separate export for client-side destructuring convenience.
export interface LinkedChangeRef {
  id: string;
  title: string;
  status: string | null;
  pr_url: string | null;
  path: string;
}

import type {
  NoteSeverity,
  RecommendedChangeRef,
  ResearchReportSummary,
} from '../../../server/routes/research.types';

export const NOTE_SEVERITIES: readonly NoteSeverity[] = ['info', 'warn', 'blocker'];

// State machine for the Detail view's action banner. Derived from
// report.status + review_status + recommendations (see Detail.tsx::stateFor).
export type ResearchUiState =
  | 'awaiting-review'
  | 'pre-revise'
  | 'post-revise'
  | 'ready-to-scaffold'
  | 'approved-clean'
  | 'idle';

export function revisedAfterReview(report: ResearchReportSummary): boolean {
  if (!report.report_revised_at || !report.reviewed_at) return false;
  return report.report_revised_at > report.reviewed_at;
}

export function stateFor(
  report: ResearchReportSummary,
  recommendations: RecommendedChangeRef[],
): ResearchUiState {
  if (report.status === 'draft' && report.review_status === 'pending') {
    return 'awaiting-review';
  }
  if (report.review_status === 'request-changes') {
    return revisedAfterReview(report) ? 'post-revise' : 'pre-revise';
  }
  if (report.review_status === 'approved') {
    const unscaffolded = recommendations.some((rc) => rc.status === 'proposed');
    return unscaffolded ? 'ready-to-scaffold' : 'approved-clean';
  }
  return 'idle';
}
