// Wire-shape types for project automation. Per standard-shared-types — the
// server (`automation.ts` + `projects.ts`) and the client (Settings card +
// header controls) consume the same shapes.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `automation.ts`.

// What stage of the change lifecycle the orchestrator is currently driving.
// Maps 1:1 to the skill the orchestrator dispatches next when it ticks
// forward. `merge` is a stub for v1 — the actual merge happens via the
// existing change-merge flow; the orchestrator just waits for the resulting
// status: merged event.
export type AutomationStep = 'write' | 'open-pr' | 'review' | 'merge';

// Phase of the project-wide automation state machine.
// - `idle`     — automation off, OR on but no eligible changes
// - `running`  — actively processing `current_change` at `current_step`
// - `paused`   — a gate was hit (review-not-approved, skill-failure, manual)
// - `failed`   — unrecoverable; orchestrator dispatch errored out
export type AutomationPhase = 'idle' | 'running' | 'paused' | 'failed';

// Configurable gates that cause the orchestrator to pause instead of
// advancing. List shape (not bools) so v2 can add new gates without breaking
// existing configs. v1 defaults to ['review-not-approved', 'skill-failure'].
export type AutomationPauseGate = 'review-not-approved' | 'skill-failure';

// Live state of the orchestrator. Persisted in the project's frontmatter
// under `automation.state` so it survives server restarts and is visible in
// the markdown source.
export interface AutomationState {
  phase: AutomationPhase;
  // The change_id currently being driven through the lifecycle. Null when
  // phase is idle. Stays set when paused (so resume knows what to continue).
  current_change: string | null;
  // The step the orchestrator is at within the current change's lifecycle.
  // Null when phase is idle.
  current_step: AutomationStep | null;
  // Human-readable reason when phase is paused or failed. Null otherwise.
  paused_reason: string | null;
  // ISO timestamp of the last state transition. Drives the "stale paused
  // state" audit hook in Phase 2.
  last_transition: string | null;
}

// Persisted config block in project frontmatter. Additive — when this block
// is absent the project is treated as automation-disabled.
export interface AutomationConfig {
  enabled: boolean;
  // Only mode in v1. Future values: `parallel`, `custom-sequence`.
  mode: 'sequential-changes';
  pause_on: AutomationPauseGate[];
  state: AutomationState;
}

// Full status response returned by every automation endpoint. Client uses
// this to refresh its view after any action.
export interface AutomationStatusResponse {
  ok: boolean;
  config: AutomationConfig;
  // The current change snapshot, when phase is running or paused. Lets the
  // UI render "Running change X (step 3 of 4)" without a second fetch. Null
  // when phase is idle.
  current_change_summary: {
    id: string;
    title: string;
    status: string;
    path: string;
  } | null;
  // Order index for the current change among the project's eligible changes.
  // 1-based; null when phase is idle. Lets the UI render "step in change Y
  // (3 of 10 eligible changes)".
  current_change_index: number | null;
  // Total eligible changes in the project (status: planning or in-progress
  // that haven't been merged/abandoned).
  total_eligible_changes: number;
}

// Body for POST /:id/automation/configure — partial updates to the config
// block. All fields optional; only the fields present are written.
export interface AutomationConfigureBody {
  enabled?: boolean;
  pause_on?: AutomationPauseGate[];
}

// Body for POST /:id/automation/tick — called when a relevant skill run
// terminates. Carries the outcome of the run so the state machine can
// decide whether to advance, pause, or fail.
export interface AutomationTickBody {
  // The skill that just terminated. Maps to a step in the lifecycle.
  skill: string;
  // The change_id the skill ran for. Must match config.state.current_change
  // or the tick is a no-op (idempotency guard against stale clients).
  change_id: string;
  // Exit status from the skill run. 0 = success → advance; non-zero =>
  // pause via skill-failure gate (if configured).
  exit_status: number;
  // Optional review outcome — only present for dev-pr-review ticks.
  // Drives the review-not-approved gate.
  review_result?: 'approve' | 'changes' | 'block' | null;
}

// ─── Phase 2 — Per-change automation ──────────────────────────────────────────
//
// Source of truth for the new model. The change entry's frontmatter carries
// the `automation:` block (see archetype-change.md § Automation). The
// orchestrator iterates over CHANGES, not projects. Project-level project
// surfaces (Phase 4) will read aggregated state from owned changes; they
// no longer write their own state machine.

// Canonical step vocabulary for the v1 change-automation loop. The data
// layer (ChangeAutomationState.current_step) stores this as a free-form
// string so new step kinds (deploy, notify, analyze, ...) can land without
// migration. This enum documents what the orchestrator knows about today.
export type ChangeAutomationStep =
  | 'execute' // dev-write-change EXECUTE phase
  | 'open-pr' // dev-open-pr
  | 'pr-review' // dev-pr-review against the open PR
  | 'address-comments'; // dev-write-change address-comments mode (iteration body)

// Result of one iteration of the state machine — drives the orchestrator's
// next gesture. 'park' transitions phase to paused with a reason; 'complete'
// transitions to complete (terminal); 'dispatch' starts a new run.
export type ChangeAutomationDecision =
  | { action: 'dispatch'; step: ChangeAutomationStep }
  | { action: 'complete' }
  | { action: 'park'; reason: string };

export interface ChangeAutomationStatusResponse {
  ok: boolean;
  // The automation block as currently persisted. Null = block never written.
  automation: import('./changes.types.js').ChangeAutomation | null;
  // Snapshot of the change so the UI can render context without a second
  // fetch. Null for missing changes (404 surfaces via reply.code(404)).
  change_summary: {
    id: string;
    title: string;
    status: string | null;
    review_status: string | null;
    pr_url: string | null;
    pr_review_status: string | null;
  } | null;
}
