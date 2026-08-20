// Drive affordance — the decision core shared by the project screen's Drive
// control and the endpoint that dispatches `dev-drive-project` for a project.
//
// Both sides have to answer the same three questions: may a drive be offered
// here at all, is there anything left to drive, and is a drive already in
// flight. Deriving them twice is how a button that looks enabled meets a
// server that refuses (or worse, the reverse). One evaluator, one wording, two
// callers — the client renders `reason` as the disabled tooltip and the server
// returns the same string as its 409 body.
//
// Pure by construction: no I/O and no `node:*` imports, so the browser bundle
// can import it the way it imports ./skill-ids.js. Anything that needs the
// filesystem or the runs table stays in the route.

import { SKILL } from './skill-ids.js';

// The skill the affordance dispatches. Named through SKILL so a rename of the
// skill directory becomes a compile error here rather than a string that
// silently stops matching any run row.
export const DRIVER_SKILL = SKILL.DEV_DRIVE_PROJECT;

// A change is done being driven at these statuses; anything else — including a
// status this OS version does not recognize — counts as live work.
//
// Mirror of TERMINAL_CHANGE_STATUSES in scripts/drive-order.mjs, the resolver
// the driver itself runs to build its queue. Mirrored rather than imported
// because that module reads node:fs at module top and this one is bundled into
// the browser client (same constraint that makes runs.types.ts mirror
// RUN_ORIGINS). tests/unit/projects/driveAffordance.test.ts pins the two lists
// equal, so a change to the resolver's vocabulary fails here loudly.
export const TERMINAL_CHANGE_STATUSES: readonly string[] = ['merged', 'abandoned'];

// Run states that mean "this run has not finished yet". Mirrors the IN clause
// in runs-db.mjs's getActiveRunForChange — the same definition of live the
// per-change concurrency gate uses.
export const LIVE_RUN_STATES: readonly string[] = ['queued', 'running'];

// Project statuses at which the project screen stops offering project-tier
// work. `completed` / `cancelled` are the skill's own precondition (it refuses
// to drive a closed project); `paused` is not — the driver would run — but the
// dashboard declines to start new project-tier work on a paused project for
// the same reason the scheduler skips its runbooks. An operator who means it
// can still invoke the skill directly.
const CLOSED_PROJECT_STATUSES: readonly string[] = ['completed', 'cancelled'];

export function isTerminalChangeStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_CHANGE_STATUSES.includes(status);
}

export function isLiveRunState(state: string | null | undefined): boolean {
  return typeof state === 'string' && LIVE_RUN_STATES.includes(state);
}

// The fields of a run row this module reads. Structural, so both the server's
// RunRow (from runs-db) and the client's RunRecord satisfy it without either
// side importing the other's shape.
export interface DriveRunLike {
  id: string;
  skill: string | null;
  project: string | null;
  state: string;
  started_at?: string | null;
}

// Newest-first by started_at, with input order as the tiebreak — rows that
// carry no timestamp sort last rather than winning by accident.
function newestFirst<T extends DriveRunLike>(runs: readonly T[]): T[] {
  return runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const at = a.run.started_at ?? '';
      const bt = b.run.started_at ?? '';
      if (at !== bt) return bt.localeCompare(at);
      return a.index - b.index;
    })
    .map((x) => x.run);
}

function driverRunsFor<T extends DriveRunLike>(runs: readonly T[], projectId: string): T[] {
  if (!projectId) return [];
  return newestFirst(runs.filter((r) => r.skill === DRIVER_SKILL && r.project === projectId));
}

/**
 * The driver run currently in flight for this project, or null.
 *
 * Matched on `skill` + `project`, not on `origin`: the driver's OWN run is
 * dispatched by whoever pressed the button (origin `human`), while the runs it
 * then makes carry origin `driver`. Filtering on origin here would find the
 * driver's children and miss the driver itself.
 */
export function findActiveDriverRun<T extends DriveRunLike>(
  runs: readonly T[],
  projectId: string,
): T | null {
  return driverRunsFor(runs, projectId).find((r) => isLiveRunState(r.state)) ?? null;
}

/** The most recent driver run for this project in any state — the "last drive". */
export function findLatestDriverRun<T extends DriveRunLike>(
  runs: readonly T[],
  projectId: string,
): T | null {
  return driverRunsFor(runs, projectId)[0] ?? null;
}

export type DriveAffordanceState =
  | 'ready' // offer the dispatch
  | 'driving' // a drive is in flight — show it instead of offering a second
  | 'project-closed' // completed / cancelled — the control does not apply
  | 'project-paused' // recoverable; say so rather than vanishing
  | 'no-changes' // nothing scaffolded yet — the driver drives change entries
  | 'nothing-drivable'; // every owned change reached a terminal status

export interface DriveAffordanceInput {
  /** The project entry's `status` field. */
  project_status: string | null;
  /** The project's owned change entries — only `status` is read. */
  changes: ReadonlyArray<{ status?: string | null }>;
  /** Id of a driver run already in flight for this project, when there is one. */
  active_run_id?: string | null;
}

export interface DriveAffordance {
  state: DriveAffordanceState;
  /** Render the control at all? */
  visible: boolean;
  /** Accept a click / a dispatch? Only ever true for `ready`. */
  enabled: boolean;
  /** Why not, in one sentence. Null when enabled. Rendered as the tooltip AND returned as the server's refusal. */
  reason: string | null;
  /** How many owned changes are still non-terminal. */
  drivable_count: number;
  active_run_id: string | null;
}

/**
 * Decide what the Drive control shows for a project.
 *
 * Precedence, and why:
 *   1. a live driver run wins over everything — a drive in flight is always
 *      surfaced, including on a project someone closed while it ran;
 *   2. closed → hidden (the screen already offers Reopen; a dead button next
 *      to it is noise);
 *   3. paused → visible but refused, because the state is one flip from
 *      drivable and the operator deserves to be told which flip;
 *   4. no changes → hidden (nothing to drive, and nothing the operator can do
 *      here except scaffold a change, which the Changes tab already offers);
 *   5. all changes terminal → visible but refused, because that is the
 *      project's success state and saying so is worth a line.
 */
export function evaluateDriveAffordance(input: DriveAffordanceInput): DriveAffordance {
  const activeRunId = input.active_run_id ?? null;
  const status = input.project_status;
  const total = input.changes.length;
  const drivable = input.changes.filter((c) => !isTerminalChangeStatus(c.status)).length;

  const base = { drivable_count: drivable, active_run_id: activeRunId };

  if (activeRunId) {
    return {
      ...base,
      state: 'driving',
      visible: true,
      enabled: false,
      reason: `a drive is already running for this project (run ${activeRunId}) — watch that run instead of starting a second one`,
    };
  }
  if (typeof status === 'string' && CLOSED_PROJECT_STATUSES.includes(status)) {
    return {
      ...base,
      state: 'project-closed',
      visible: false,
      enabled: false,
      reason: `project is ${status} — reopen it before driving`,
    };
  }
  if (status === 'paused') {
    return {
      ...base,
      state: 'project-paused',
      visible: true,
      enabled: false,
      reason: 'project is paused — set it back to active before driving',
    };
  }
  if (total === 0) {
    return {
      ...base,
      state: 'no-changes',
      visible: false,
      enabled: false,
      reason: 'no changes are scaffolded under this project yet — the driver drives change entries',
    };
  }
  if (drivable === 0) {
    return {
      ...base,
      state: 'nothing-drivable',
      visible: true,
      enabled: false,
      reason: 'every change in this project is merged or abandoned — nothing left to drive',
    };
  }
  return { ...base, state: 'ready', visible: true, enabled: true, reason: null };
}

export interface DriveProjectInputs {
  project: string;
  /** Stop after driving this many changes in one invocation. */
  max_changes?: number | null;
  /** Refuse the dispatch that would cross this cumulative spend. */
  spend_cap_usd?: number | null;
  /** Derive the queue and print the plan, dispatching nothing. */
  dry_run?: boolean;
  /** Port the OS API answers on — the driver dispatches over HTTP, not through the Skill tool. */
  api_port?: number | null;
}

/**
 * Compose the driver's dispatch prompt.
 *
 * Two properties are load-bearing and both are pinned by unit tests:
 *
 *  - **No `change:` input line, ever.** `startRun` lifts `change_id` out of
 *    prompt text (`extractFromPrompt`), and a run attributed to a change is
 *    blocked from dispatching for that change. A driver run wearing a change
 *    id would be refused by the concurrency gate on every dispatch it tried to
 *    make for that change — the one attribution mistake that breaks the driver
 *    silently. `max_changes` is safe: the field name the extractor matches is
 *    the literal `change:`.
 *  - **The headless contract.** The child is a `claude -p` with nobody at the
 *    keyboard; the skill's human gates are clean stops, not questions.
 */
export function buildDriveProjectPrompt(inputs: DriveProjectInputs): string {
  const lines = [
    `Run the ${DRIVER_SKILL} skill for project "${inputs.project}".`,
    `Read .claude/skills/${DRIVER_SKILL}/SKILL.md and follow its Procedure exactly.`,
    '',
    'Inputs:',
    `- project: ${JSON.stringify(inputs.project)}`,
  ];
  if (typeof inputs.max_changes === 'number') lines.push(`- max_changes: ${inputs.max_changes}`);
  if (typeof inputs.spend_cap_usd === 'number') {
    lines.push(`- spend_cap_usd: ${inputs.spend_cap_usd}`);
  }
  if (inputs.dry_run === true) lines.push('- dry_run: true');
  if (typeof inputs.api_port === 'number') lines.push(`- api_port: ${inputs.api_port}`);
  lines.push(
    '',
    'IMPORTANT — headless dashboard-dispatched call:',
    '- Do NOT use AskUserQuestion or any interactive prompt.',
    '- Every human gate in the skill is a clean stop: leave the artifact where it is, name the one gesture the operator owes, and finish.',
    '- Do not bypass a gate a refusal names, and do not improvise recovery — an ambiguous state is a stop.',
    '- End with the drive report the skill specifies: the queue in dependency order, what was dispatched, where it stopped and why.',
  );
  return lines.join('\n');
}
