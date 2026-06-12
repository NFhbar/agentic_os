// Wire-shape types for the projects route. Imported by `projects.ts` (server)
// and `src/apps/projects/View.tsx` (client) so both sides agree on a single
// contract.
//
// Convention (see standard-shared-types): this file holds ONLY type defs.
// No node:* imports, no runtime values, no fastify imports. Anything
// stateful belongs in the sibling `projects.ts`.

import type { AutomationConfig } from './automation.types.js';
import type { ResearchReportSummary } from './research.types.js';

export interface Milestone {
  date: string | null;
  label: string;
  status: string | null;
}

export interface Reporting {
  cadence: string | null;
  target: string | null;
  target_ref: string | null;
  last_sent: string | null;
  next_due: string | null;
}

// Aggregate counts of changes owned by a project, broken down by lifecycle
// state. Computed once per list build from the prebuilt wiki manifest — no
// extra disk walks. Renders as a one-line tally in the Projects list view.
export interface ChangeAggregate {
  planning: number;
  in_progress: number;
  in_review: number;
  merged: number;
  abandoned: number;
  total: number;
  // ISO timestamp of the most recently updated owned change. Surfaces "is
  // anything happening on this project lately" without opening the detail.
  latest_change_updated: string | null;
}

// Cost/duration rollup across a project's surface. Sums every billable
// (`action = 'ai-prompt'`) event tagged to either the project directly OR
// any of its owned changes. Same shape as the per-change rollup so the
// client component renders identically.
export interface ProjectRollup {
  cost_usd: number;
  duration_ms: number;
  skill_count: number;
  by_skill: Array<{ skill: string; count: number; cost_usd: number; duration_ms: number }>;
  ai_prompt_runs: number;
  failed_runs: number;
}

export interface ProjectSummary {
  id: string | null;
  path: string;
  title: string;
  domain: string | null;
  status: string | null;
  deadline: string | null;
  updated: string | null;
  stakeholders: string[];
  // Optional workflow fields. `lifecycle_stage` is the value as written on
  // disk (frontmatter); `lifecycle_stage_derived` is the live read derived
  // from owned-change counts. Clients should prefer the derived value when
  // present — it tracks actual work; the frontmatter field is mostly stale
  // from scaffolding-time.
  lifecycle_stage: string | null;
  lifecycle_stage_derived: string | null;
  // Projects can span multiple repos. Branch tracking lives on each repo
  // entity, not on the project.
  repos: string[];
  milestones: Milestone[];
  reporting: Reporting | null;
  // Rollup of owned changes (status counts + latest activity). Sourced from
  // the vault index manifest. Null if the manifest hasn't been built yet.
  changes: ChangeAggregate | null;
  // Plan-tracking fields written by the project-orchestration skills.
  plan_path: string | null;
  // LIFECYCLE-only since the shared review-state contract: pending |
  // in-research | drafted | scaffolded | active. The review verdict lives
  // in review_status (the same 6-value enum changes and research-reports
  // use). See standard-review-state.
  plan_status: string | null;
  review_status: string | null;
  // Derived pair from research_reports + owned_changes: when a project goes
  // through the research-driven flow (`research-write` → review → approve →
  // scaffold), the frontmatter fields stay null but the lifecycle is in
  // fact progressing (mirrors lifecycle_stage_derived).
  plan_status_derived: string | null;
  review_status_derived: string | null;
  // Server-computed linear stage for steppers/timelines — the collapse of
  // the (derived-or-frontmatter) plan_status × review_status pair via
  // lifecycle-state.ts planStageId. Rendering vocabulary only.
  plan_stage: string | null;
  plan_revision: number | null;
  review_path: string | null;
  reviewed_at: string | null;
  plan_revised_at: string | null;
  plan_revised_from_review: string | null;
  plan_generated_at: string | null;
  // Paths to research-report entries owned by this project.
  research_paths: string[];
  // Project-scoped change automation (Phase 1). Null when the project has
  // no `automation:` frontmatter block — treat that as automation-disabled.
  // When present, drives the Settings → Automation card and the project
  // header status badge + control buttons.
  automation: AutomationConfig | null;
}

export interface BacklinkRef {
  id: string;
  title: string;
  type: string | null;
  domain: string | null;
  path: string;
  updated: string | null;
}

// Backlinks split by ownership: owned (frontmatter `project:` field) vs.
// referenced (only via body `[[wikilink]]`). Each side is grouped by
// archetype/type — `Record<type, BacklinkRef[]>`.
export interface BacklinkGroup {
  owned: Record<string, BacklinkRef[]>;
  referenced: Record<string, BacklinkRef[]>;
}

export interface ProjectScheduleRef {
  id: string | null;
  title: string;
  schedule: string;
  prompt: string;
  path: string;
  // ISO timestamp of the next scheduled fire (computed from the cron
  // expression). Null when the cron is unparseable or the schedule is
  // gated behind a `manual: true` flag.
  next_run: string | null;
  // Most recent firing snapshot from `vault/raw/scheduled-runs.jsonl`. Null
  // when this schedule has never fired yet.
  last_run: {
    ts: string;
    outcome: 'fired' | 'skipped' | 'spawn-error' | null;
    exit: number | null;
    skip_reason: string | null;
  } | null;
}

export interface StatusReportRef {
  path: string;
  name: string;
  mtime: string;
  // First ~400 chars of body content (no frontmatter) for the Overview tab
  // excerpt. Null when missing/unreadable.
  preview: string | null;
  // Lifted from `report_type` frontmatter or filename infix.
  kind: 'kickoff' | 'status' | 'wrap-up' | null;
  // Date-range the report's content actually covers. Lifted from frontmatter
  // `timeframe_start` / `timeframe_end`. Null for legacy reports.
  timeframe_start: string | null;
  timeframe_end: string | null;
}

// Lightweight change reference rendered inline in the Projects detail panel.
// Distinct from the full ChangeSummary (in changes.types) — projects only need
// what's necessary to render a list row + link out.
export interface OwnedChangeRef {
  id: string;
  title: string;
  status: string | null;
  repo: string | null;
  branch: string | null;
  pr_url: string | null;
  path: string;
  updated: string | null;
  derived_from_report: string | null;
  // Drives the `[N+1/M]` step indicator on the project's Changes tab.
  // Null on hand-scaffolded changes.
  recommendation_index: number | null;
  recommendations_total: number | null;
  // Phase 4 — fields the project Automation tab needs to render per-change
  // controls. review_status drives the "ready for automation" gate
  // (automation runs once `review_status: approved`); pr_review_status
  // shows the latest PR-review verdict; automation is the per-change block.
  review_status: string | null;
  pr_review_status: string | null;
  automation: import('./changes.types.js').ChangeAutomation | null;
}

export interface ProjectDetail {
  project: ProjectSummary;
  // Raw markdown body of the project entry (no frontmatter). Null on entries
  // with no body content past the frontmatter.
  body: string | null;
  // Backlinks grouped by entry type within each ownership bucket. See
  // BacklinkGroup above.
  backlinks: BacklinkGroup;
  owned_changes: OwnedChangeRef[];
  schedules: ProjectScheduleRef[];
  status_reports: StatusReportRef[];
  research_reports: ResearchReportSummary[];
  rollup: ProjectRollup;
}
