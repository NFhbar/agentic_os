// Wire-shape types for the changes route. Imported by `changes.ts` (server)
// and by `src/apps/changes/View.tsx` (client) so both sides type-check
// against the same definition.
//
// Convention (see standard-shared-types): this file holds ONLY type
// definitions. No node:* imports, no runtime values, no fastify imports.
// Anything stateful belongs in the sibling `changes.ts`.

export interface ChangeSummary {
  id: string | null;
  path: string;
  title: string;
  domain: string | null;
  status: string | null;
  repo: string | null;
  branch: string | null;
  scope: string | null;
  pr_url: string | null;
  size: string | null;
  project: string | null;
  parent_change: string | null;
  updated: string | null;
  // Review-gate fields (managed by dev-write-change / dev-review-change)
  review_required: boolean | null;
  review_status: string | null;
  plan_path: string | null;
  review_path: string | null;
  plan_generated_at: string | null;
  reviewed_at: string | null;
  // Plan-revision tracking (managed by dev-revise-plan).
  plan_revision: number | null;
  plan_revised_at: string | null;
  plan_revised_from_review: string | null;
  // PR review summary (managed by dev-pr-review when invoked with a change input)
  pr_review_status: string | null;
  pr_review_path: string | null;
  pr_review_passes: number | null;
  pr_reviewed_at: string | null;
  pr_ready_at: string | null;
  merged_at: string | null;
  abandoned_at: string | null;
  abandoned_reason: string | null;
  // CI rollup state managed by pr-ci-poll runbook (pass / fail / running / none).
  // Surfaces on the Change Overview so the user can see PR check health without
  // opening GitHub.
  ci_state: string | null;
  ci_completed_at: string | null;
  // Research-attribution fields written by `research-scaffold-recommendations`.
  derived_from_report: string | null;
  recommendation_index: number | null;
  recommendations_total: number | null;
  // Per-change automation config. Null when the change's frontmatter has no
  // `automation:` block — the canonical signal that automation has never been
  // touched for this change. The orchestrator only operates on changes where
  // automation !== null AND automation.enabled === true.
  automation: ChangeAutomation | null;
}

// ── Per-change automation (Phase 1 — data model) ─────────────────────────────
//
// The change entry's frontmatter is the source of truth for automation. This
// supports two cases the project-level model couldn't:
//   - orphan changes (no project) can still be automated
//   - per-change opt-in within a project — mix automated + manual freely
//
// Top-level fields = user config (set via UI/hand-edit). State fields = owned
// by the orchestrator; user mutates them only via defined gestures (Pause /
// Resume / Reset) that translate to canonical transitions.
//
// Extensibility rules:
//   - `phase` is a CLOSED enum (each value has explicit semantics in the
//     orchestrator's state machine; adding a phase is a deliberate change).
//   - `current_step` is FREE-FORM string — the orchestrator documents its
//     canonical step vocabulary in standard-automation-loop.md. Future loops
//     can introduce new step kinds (deploy, notify, analyze, etc.) without
//     touching this type or migrating data.
//   - `paused_reason` is FREE-FORM string — orchestrator-defined vocabulary;
//     new reasons added without data migration.
export interface ChangeAutomation {
  // User-set config (rarely changes once set).
  enabled: boolean;
  iteration_cap: number; // max EXECUTE → PR-REVIEW loops before park
  // Runtime state — orchestrator owns; UI displays + offers controlled gestures.
  state: ChangeAutomationState;
}

export type ChangeAutomationPhase =
  | 'idle' // automation may dispatch when conditions are met
  | 'running' // orchestrator currently driving a step
  | 'paused' // halted (skill-failure, iteration-cap-reached, user-paused, ...)
  | 'complete'; // reached terminal state (PR open, awaiting human)

export interface ChangeAutomationState {
  phase: ChangeAutomationPhase;
  // Canonical step vocabulary for the v1 loop (orchestrator owns; this type
  // doesn't enforce the set so new steps can land without data migration):
  //   execute | pr-review | address-comments | open-pr
  current_step: string | null;
  // Increments each completed EXECUTE → PR-REVIEW cycle. Cap-check fires
  // before dispatching the next iteration.
  iteration_count: number;
  // Human-readable when paused. Canonical values for v1:
  //   skill-failure | iteration-cap-reached | user-paused
  paused_reason: string | null;
  paused_at: string | null; // ISO 8601 UTC
  last_transition: string | null; // ISO 8601 UTC of last state mutation
  last_run_id: string | null; // most recent orchestrator-dispatched run id
  // Artifact snapshot taken immediately before the most recent dispatch.
  // Drives the artifact-verified advance gate: a step only advances when its
  // expected artifact moved relative to this baseline. Absent/null on states
  // written before the gate existed — the gate stays inert for those.
  dispatch_baseline?: ChangeAutomationDispatchBaseline | null;
}

// What the world looked like just before the orchestrator dispatched the
// current step. Snapshotted BEFORE startRun so the dispatched skill's own
// work can't leak into its baseline.
export interface ChangeAutomationDispatchBaseline {
  head_sha: string | null; // change-branch head; null when the ref doesn't exist yet
  pr_url: string | null; // change frontmatter pr_url at dispatch time
  pass_count: number | null; // latest pass N on the linked pr-review entry
}

// File reference returned in change detail — null when the file doesn't exist.
export interface FileRef {
  path: string;
  mtime: string;
  preview: string;
}

export type StageStatus = 'done' | 'current' | 'pending' | 'skipped';

export interface LifecycleStage {
  id: string;
  label: string;
  status: StageStatus;
  at: string | null; // ISO timestamp when this stage was reached
  via: string | null; // skill name that drove the transition
  artifact: string | null; // optional path to related output file
  hint: string | null; // short human-readable description
}

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  action: string | null;
  skill: string | null;
  duration_ms: number | null;
  exit_status: string | null;
  cost_usd: number | null;
}

export interface RelatedEntities {
  project: string | null;
  repo: string | null;
  parent_change: string | null;
  skills_used: string[];
  // Heuristic from event skills — when dev-open-pr ran, github MCP was called.
  mcps_used: string[];
  artifacts: Array<{ kind: string; path: string }>;
}

export interface ChangeRollup {
  cost_usd: number;
  duration_ms: number;
  skill_count: number;
  by_skill: Array<{ skill: string; count: number; cost_usd: number; duration_ms: number }>;
  ai_prompt_runs: number;
}
