// Wire-shape types for the schedules route. Per standard-shared-types — the
// server (`schedules.ts`), the schedules app (`apps/schedules/View.tsx`),
// and the overview status card (`apps/overview/View.tsx`) all consume the
// same shapes; this is the canonical definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `schedules.ts`.

// Outcome of one scheduler-tick invocation. `fired` means the runbook ran
// to completion (exit code carries the actual result). `skipped` means a
// precondition gate (project status, minimum-matches threshold) blocked the
// fire — this is a healthy "nothing to do" state, NOT a failure. `spawn-error`
// is failure-to-start before any code ran. Undefined on legacy entries
// (pre-2026-05-29) — consumers should treat undefined as `fired` for back-compat.
export type RunOutcome = 'fired' | 'skipped' | 'spawn-error';

// One row from the scheduled-runs.jsonl log. Used by GET /api/schedules/runs
// and also as the source shape for ScheduleSummary.last_run (where it's
// projected down to a smaller subset).
export interface RunEntry {
  ts: string;
  id: string | null;
  schedule: string;
  prompt: string;
  exit: number | null;
  duration_ms: number;
  stdout_preview: string;
  stderr: string;
  // Optional fields stamped by scheduler-tick.mjs since 2026-05-29. `skipped`
  // entries omit `duration_ms` / `stdout_preview` / `stderr` and carry
  // `skip_reason` instead.
  outcome?: RunOutcome;
  skip_reason?: string;
  // Manual dashboard fires (run-now) dispatch via the canonical startRun()
  // path; run_id links this JSONL line to the runs-table row.
  manual?: boolean;
  run_id?: string;
}

// One scheduled runbook in the GET /api/schedules response. last_run is null
// if the runbook has never fired, otherwise a projection of the most-recent
// RunEntry for this id.
export interface ScheduleSummary {
  id: string | null;
  path: string;
  title: string;
  domain: string | null;
  schedule: string;
  prompt: string;
  trigger: string | null;
  next_run: string | null;
  // Optional project scoping — the tick skips this schedule unless the
  // referenced project's status is "active". See standard-project-workflow.md.
  project: string | null;
  last_run: {
    ts: string;
    exit: number | null;
    duration_ms: number;
    stdout_preview: string;
    stderr: string;
    outcome?: RunOutcome;
    skip_reason?: string;
  } | null;
}

// Top-level status summary baked into GET /api/schedules so Overview can
// render its Scheduler card with a single fetch.
export interface ScheduleStatus {
  count: number;
  next_fire: { id: string | null; ts: string } | null;
  last_24h: { runs: number; failures: number };
}

// Full GET /api/schedules response.
export interface SchedulesListResponse {
  schedules: ScheduleSummary[];
  status: ScheduleStatus;
}
