// Wire-shape types for the runs route. Per standard-shared-types — the
// server (`runs.ts`) and the client (`src/lib/runs.ts`) consume the same
// data shape; this is the canonical definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no
// runtime values. Anything stateful belongs in the sibling `runs.ts` (or
// `scripts/runs-db.mjs` for storage).

// `died-after-writeback`: the child died without emitting a stream-json
// result event (silent OS kill, wall-cap, server restart), but the run's
// linked entity was updated after the run started — the work likely landed.
// Terminal; the automation orchestrator treats it as success-with-warning.
// Written by scripts/runs-finalize.mjs, never by the in-process close path.
export type RunState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'died-after-writeback';

// Who dispatched a run. Stamped at create time; NULL (legacy rows) reads as
// `human`. Keep in sync with RUN_ORIGINS in scripts/runs-db-init.mjs — that
// .mjs holds the runtime list; this types-only file can't import it.
export type RunOrigin = 'human' | 'automation' | 'scheduler' | 'driver';

// Attribution tags written at start-time. Used for change/project/repo
// filtering in the Processes view + cost rollups on the change/project
// detail pages. Both server (storage column names) and client (input
// shape for startRun) use the same field names.
export interface RunTags {
  skill?: string | null;
  change_id?: string | null;
  project?: string | null;
  repo?: string | null;
  domain?: string | null;
}

// One row from runs-db. The server's internal RunRow + the client's
// RunRecord are byte-equivalent — this is the unified canonical shape.
export interface RunRecord {
  id: string;
  started_at: string;
  ended_at: string | null;
  state: RunState;
  exit_status: number | null;
  pid: number | null;
  skill: string | null;
  change_id: string | null;
  project: string | null;
  repo: string | null;
  domain: string | null;
  title: string | null;
  prompt: string;
  output_path: string;
  duration_ms: number | null;
  error: string | null;
  // Cost/model observability stamped at finishRun time from the
  // stream-json `result` event the subprocess emits on exit.
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_hit: number | null;
  tokens_cache_write: number | null;
  // Two lifecycles: `model` is stamped at dispatch (resolved flags), then
  // overwritten by the observed id when a result event lands; `effort` is
  // dispatch-time only — result events carry no effort field.
  model: string | null;
  effort: string | null;
  // Who dispatched the run. Null on legacy rows (read as `human`).
  origin: RunOrigin | null;
}

// Filter passed to GET /api/runs. Client + server share the shape.
export interface RunFilter {
  state?: RunState;
  skill?: string;
  change_id?: string;
  project?: string;
  repo?: string;
  domain?: string;
  origin?: RunOrigin;
  since?: string;
  until?: string;
  limit?: number;
}

// Input to startRun() (the cross-route helper exported from runs.ts).
export interface StartRunInput {
  prompt: string;
  title?: string | null;
  tags?: RunTags;
  // Defaults to `human` when unset. The orchestrator passes `automation`,
  // the scheduler `scheduler`; an explicit value wins (the future `driver`).
  origin?: RunOrigin;
  // Bypass the server-side re-review debounce (a dev-pr-review dispatch whose
  // target branch head is unchanged since the last reviewed pass). Also
  // sniffed from the prompt (`/force\s*[:=]\s*true/i`) so CLI-composed prompts
  // that set the skill's own `force: true` input bypass the server gate too.
  force?: boolean;
}

// Result of startRun(). Server uses a discriminated union (ok: boolean +
// payload). Client currently parses this into an optional-field shape;
// that divergence is a known gap — unify on the server's discriminated
// shape in a follow-up that updates the client's parse path.
export type StartRunResult =
  | { ok: true; run_id: string }
  | { ok: false; error: 'blocked'; blocking: { run_id: string; skill: string | null } }
  // Re-review debounce refusal — the target head is unchanged since the last
  // reviewed pass. `POST /api/runs` maps this to HTTP 409 { error, refusal }.
  | { ok: false; error: string; refusal: 'head-unchanged' }
  | { ok: false; error: string };
