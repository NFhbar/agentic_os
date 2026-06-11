// Wire-shape types for the research route. Imported by `research.ts` (server)
// and `src/apps/research/data.ts` (client) so both sides type-check against
// the same definition.
//
// Convention (see standard-shared-types): this file holds ONLY type
// definitions. No node:* imports, no runtime values, no fastify imports.
// Anything stateful belongs in the sibling `research.ts`.

import type { FileRef } from './changes.types.js';

export interface RecommendedChangeRef {
  index: number;
  id: string | null;
  summary: string;
  domain: string | null;
  size: string | null;
  status: 'proposed' | 'scaffolded' | 'merged' | 'abandoned' | string;
  linked_change: {
    id: string;
    title: string;
    status: string | null;
    pr_url: string | null;
    path: string;
  } | null;
}

// Canonical enum literals for the research-report lifecycle. These are the
// same sets enforced at runtime by `tests/structural/archetype-enums.test.ts`
// (kept in sync — adding a value here means adding it there and to the
// `deriveProjectPlanStatus` switch). String-literal unions force TS to
// surface missed cases at compile time; the runtime test catches values that
// land in actual entries but aren't here yet.
export type ResearchReportStatus = 'draft' | 'reviewed' | 'approved' | 'updated';
// The shared review-state enum (see standard-review-state) — identical for
// research-reports, change plans, and project plans. This union previously
// omitted 'overridden' / 'not-required' even though meta-mark-research-
// approved writes the former and the archetype documents both.
export type ResearchReviewStatus =
  | 'pending'
  | 'approved'
  | 'request-changes'
  | 'rejected'
  | 'overridden'
  | 'not-required';

// Server-computed stepper statuses (derived in lib/lifecycle-state.ts —
// clients render, never re-derive; Finding 4.3).
export type ReportStepStatus = 'done' | 'current' | 'pending';

export interface ReportStepStatuses {
  drafted: ReportStepStatus;
  reviewed: ReportStepStatus;
  approved: ReportStepStatus;
  updated: ReportStepStatus;
}

export interface ResearchReportSummary {
  id: string;
  path: string;
  title: string;
  project: string | null;
  status: ResearchReportStatus | null;
  review_status: ResearchReviewStatus | null;
  step_statuses: ReportStepStatuses;
  review_required: boolean;
  review_path: string | null;
  reviewed_at: string | null;
  report_generated_at: string | null;
  report_revision: number | null;
  report_revised_at: string | null;
  report_revised_from_review: string | null;
  materials_path: string | null;
  last_data_ingest: string | null;
  update_count: number;
  recommended_changes_count: number;
  recommended_changes_proposed: number;
  recommended_changes_scaffolded: number;
  recommended_changes_merged: number;
  recommended_changes_abandoned: number;
  dismissed_triggers: string[];
  has_updates_pending: boolean;
  created: string | null;
  updated: string | null;
}

export interface MaterialRef {
  name: string;
  path: string;
  size: number;
  mtime: string;
  ingested: boolean;
}

export type UpdateTriggerKind =
  | 'new-materials-ingested'
  | 'staleness-threshold-passed'
  | 'recommended-change-merged';

export interface UpdateTrigger {
  id: string;
  kind: UpdateTriggerKind;
  fired_at: string;
  reason: string;
}

export interface ReplayTimelineEntry {
  ts: string;
  kind: 'event';
  event: {
    id: number;
    action: string | null;
    skill: string | null;
    duration_ms: number | null;
    exit_status: string | null;
    cost_usd: number | null;
  };
}

export type NoteSeverity = 'info' | 'warn' | 'blocker';

export interface NoteConsideredEntry {
  skill: string;
  ts: string;
  run_id?: string | null;
}

export interface NoteRef {
  index: number;
  ts: string;
  severity: NoteSeverity;
  body: string;
  considered_by: NoteConsideredEntry[];
}

export interface ResearchReportDetail {
  report: ResearchReportSummary;
  body: string | null;
  recommended_changes: RecommendedChangeRef[];
  materials: MaterialRef[];
  review: FileRef | null;
  triggers: UpdateTrigger[];
  timeline: ReplayTimelineEntry[];
  notes: NoteRef[];
}
