// Pure state-machine logic for the per-change automation orchestrator.
//
// Extracted from automation.ts so unit tests can exercise the transition
// rules without pulling in the I/O-heavy module (which transitively imports
// node:sqlite via runs.ts → notifications.ts, and breaks vitest's module
// resolution). The function is intentionally pure: no I/O, no state, no
// side effects. The caller applies the result (dispatch / park / complete)
// and writes the state back.
//
// Every transition documented in standard-automation-loop.md § Transition
// rules should be encoded here. The tests in
// tests/unit/automation/decideNextChangeStep.test.ts cover every row.

import type { ChangeAutomationDecision, ChangeAutomationStep } from './automation.types.js';
import type { ChangeAutomationDispatchBaseline } from './changes.types.js';

// Eligibility gate for the change-automation entry points (enable + start).
// standard-automation-loop § Scope: automation runs the implementation, not
// the judgment — the plan must exist and be signed off before the loop may
// arm or dispatch.
export function checkChangeAutomationEligibility(args: {
  review_status: string | null;
  plan_path: string | null;
}): { eligible: true } | { eligible: false; reason: string } {
  const statusOk =
    args.review_status === 'approved' ||
    args.review_status === 'not-required' ||
    args.review_status === 'overridden';
  const planOk = typeof args.plan_path === 'string' && args.plan_path.trim() !== '';
  if (statusOk && planOk) return { eligible: true };
  // Next-action depends on what's missing: an ineligible review_status needs
  // the full PLAN + review cycle; an eligible (e.g. not-required) status with
  // no plan only needs PLAN.
  const nextAction = statusOk
    ? 'Run write-change (PLAN) first.'
    : 'Run write-change (PLAN) + review-change first.';
  return {
    eligible: false,
    reason: `not eligible for automation: review_status must be one of approved | not-required | overridden (got "${args.review_status ?? 'null'}") and plan_path must be set — automation runs the implementation, not the judgment (standard-automation-loop § Scope). ${nextAction}`,
  };
}

// Caller-gathered facts about the change's artifacts at verification time.
// The I/O layer (automation.ts) classifies the git read outcome:
//   - 'ref-not-found' — repo + dir resolve but the branch ref doesn't exist
//     (determinate: no commits on the change branch)
//   - 'degraded' — entity missing / dir missing / git unavailable / spawn
//     error / no branch configured (unknown — must never cause a false park)
export interface ArtifactObservation {
  head: string | null;
  head_error: 'ref-not-found' | 'degraded' | null;
  pr_url: string | null;
  pass_count: number | null;
  pr_review_path_set: boolean;
}

// Did the step's expected artifact move since the dispatch baseline?
// Pure judgment over caller-gathered observations. Returns:
//   true  — artifact moved (advance normally)
//   false — determinate no-movement (clean exit was a refusal/no-op → park)
//   'verification-unavailable' — the baseline snapshot itself was degraded,
//           so movement can't be established → park (never silently advance
//           past an unverifiable step)
//   null  — unknown (no baseline recorded, degraded read at verification
//           time, or unknown step) → gate inert, existing behavior applies
export type ArtifactMovement = boolean | 'verification-unavailable' | null;

export function evaluateArtifactMovement(
  step: string | null,
  baseline: ChangeAutomationDispatchBaseline | null,
  observed: ArtifactObservation,
): ArtifactMovement {
  // No baseline → dispatched before the gate existed (or by a legacy state).
  // Gate inert so in-flight automations are never falsely parked.
  if (!baseline) return null;
  switch (step) {
    case 'execute':
    case 'address-comments': {
      if (observed.head_error === 'ref-not-found') return false;
      if (observed.head_error === 'degraded') return null;
      // A degraded baseline can't anchor the comparison: its null head_sha
      // could mean "branch absent at dispatch" OR "git read failed", so a
      // non-null observed head would read as movement even for a refusing
      // run (silent fail-open). Surface it as unverifiable instead.
      if (baseline.head_degraded) return 'verification-unavailable';
      if (observed.head === null) return null;
      return observed.head !== baseline.head_sha;
    }
    case 'open-pr':
      // dev-open-pr is idempotent: when pr_url is already set it exits 0
      // without mutating anything. The step's artifact is "a PR exists and
      // is linked", so any non-empty pr_url satisfies the postcondition —
      // even when equal to the baseline. Requiring movement here would make
      // open-pr impassable on Reset → Start for a change whose PR exists
      // (the standard's own documented skill-refused recovery).
      return typeof observed.pr_url === 'string' && observed.pr_url !== '';
    case 'pr-review':
      return observed.pr_review_path_set && (observed.pass_count ?? 0) > (baseline.pass_count ?? 0);
    default:
      // Unknown step (forward-compat) — same conservative posture as the
      // decider's default branch.
      return null;
  }
}

// Compose the human-readable no-movement fact for the park reason. Pure —
// lives here (not automation.ts) so the wording is unit-testable.
export function composeArtifactDetail(
  step: string | null,
  observed: ArtifactObservation,
  branch: string | null,
  runSummary: string | null,
  movement: false | 'verification-unavailable' = false,
): string | null {
  let detail: string | null = null;
  if (movement === 'verification-unavailable') {
    detail = `dispatch baseline for ${branch ?? '<unknown branch>'} was degraded (head read failed at dispatch) — movement cannot be established`;
  } else if (step === 'execute' || step === 'address-comments') {
    detail =
      observed.head_error === 'ref-not-found'
        ? `branch ${branch ?? '<unknown>'} has no commits (ref not found)`
        : `no new commits on ${branch ?? '<unknown branch>'} (head still ${observed.head ? observed.head.slice(0, 7) : 'unknown'})`;
  } else if (step === 'open-pr') {
    // Only reachable when pr_url is unset — a set pr_url satisfies the
    // open-pr postcondition in evaluateArtifactMovement.
    detail = 'pr_url not set on the change entry';
  } else if (step === 'pr-review') {
    detail = observed.pr_review_path_set
      ? `no new review pass (pass_count still ${observed.pass_count ?? 0})`
      : 'no pr-review entry linked';
  }
  if (runSummary) {
    detail = detail ? `${detail}; run summary: "${runSummary}"` : `run summary: "${runSummary}"`;
  }
  return detail;
}

// Lifecycle ordering of the v1 steps — the rank the park-reconciliation
// postcondition check compares against (a parked step's postcondition holds
// when the classifier returns a step of equal-or-higher rank). Kept beside
// the classifier it's read with so the two never drift.
export const STEP_RANK: Readonly<Record<ChangeAutomationStep, number>> = Object.freeze({
  execute: 1,
  'open-pr': 2,
  'pr-review': 3,
  'address-comments': 4,
});

// Classify the highest lifecycle step whose postcondition artifacts already
// exist — `null` means nothing is done yet. This is the artifact-aware
// boundary the tick-advance already implies, extracted so BOTH entry points
// (`/start`'s first dispatch and park reconciliation) derive the step from
// artifacts rather than from `status` alone. Pure — no I/O; the caller gathers
// the ArtifactObservation.
//
// `latest_pass_acted` = the linked review's latest pass has ≥1 acted-on
// comment AND zero still-curated (the caller computes it as
// `actedCount > 0 && commentsToAddress === 0`).
export function deriveCompletedStepFromArtifacts(args: {
  change_status: string | null;
  observed: ArtifactObservation;
  latest_pass_acted: boolean;
}): ChangeAutomationStep | null {
  const { change_status, observed, latest_pass_acted } = args;

  // A linked pr-review with ≥1 pass means pr-review ran. If every curated
  // comment on that pass is already acted-on the loop's last completed step
  // was address-comments — so the next derived step is a re-review, not a
  // needs-triage park.
  //
  // Known pre-existing edge (shared with the auto-tick path): a needs-changes
  // pass whose comments are ALL dismissed (zero curated, zero acted) derives
  // 'pr-review' completed, and the reused decideNextChangeStep table then
  // parks needs-triage with nothing left to triage. Kept as-is — identical to
  // today's tick behavior; recovery is re-triage or a forced re-review —
  // documented here so it isn't rediscovered as a bug.
  if (observed.pr_review_path_set && (observed.pass_count ?? 0) > 0) {
    return latest_pass_acted ? 'address-comments' : 'pr-review';
  }
  // A linked PR but no review pass yet → open-pr completed (dev-open-pr is
  // idempotent, so any non-empty pr_url is the satisfied postcondition).
  if (typeof observed.pr_url === 'string' && observed.pr_url !== '') return 'open-pr';
  // A branch ref exists AND status left 'planning' → execute completed.
  // EXECUTE's own writeback flips status planning → in-progress; a branch at
  // status planning means EXECUTE committed but never reached its writeback
  // (the wall-cap-commit class) — so it did NOT complete.
  if (observed.head !== null && change_status !== 'planning') return 'execute';
  // Degraded head read → trust frontmatter status alone (conservative — same
  // dispatch as today when git is unreadable).
  if (observed.head_error === 'degraded') {
    if (change_status === 'in-progress') return 'execute';
    if (change_status === 'in-review') return 'open-pr';
    return null;
  }
  // ref-not-found, no PR, no passes → nothing done yet.
  return null;
}

// ---------------------------------------------------------------------------
// Project-level artifact gate
//
// The PROJECT orchestrator (executeTick in automation.ts) advances its step
// pointer write → open-pr → review → merge on any exit-0 run. A clean REFUSAL
// (draft-gate decline, no-op) therefore "completed" a step having done
// nothing, and the ghost propagated down the whole chain — the same
// refusal-ghost class the per-change loop closed with evaluateArtifactMovement.
//
// The project loop has no dispatch baseline to compare against (its state
// block carries no snapshot), so the postcondition is EXISTENCE rather than
// movement: reuse deriveCompletedStepFromArtifacts — the change loop's own
// artifact classifier — and require the completed class to rank at or above
// the class the project step maps to. No parallel classifier.
// ---------------------------------------------------------------------------

// Project orchestrator step → the change-lifecycle completion class whose
// artifacts prove the step actually did something. Frozen. `merge` is
// deliberately ABSENT: it dispatches no skill (the human merges on GitHub),
// so there is no artifact to demand and the gate stays inert there — as it
// does for any step outside this map.
export const PROJECT_STEP_REQUIRED_COMPLETION: Readonly<Record<string, ChangeAutomationStep>> =
  Object.freeze({
    write: 'execute',
    'open-pr': 'open-pr',
    review: 'pr-review',
  });

// Caller-gathered facts for the project-level check. `observed` +
// change_status + latest_pass_acted are exactly deriveCompletedStepFromArtifacts'
// inputs (gathered by gatherArtifactObservation / lookupLinkedReview in
// automation.ts); branch + run_summary only decorate the park reason.
export interface ProjectStepArtifactContext {
  change_status: string | null;
  observed: ArtifactObservation;
  latest_pass_acted: boolean;
  branch: string | null;
  run_summary: string | null;
}

// `inert` is not a failure mode — it IS the contract: the gate is inert on
// uncertainty (unknown step, merge step, unreadable facts all ADVANCE).
// False-parking a healthy project is the rejected failure mode, so only a
// proven-missing artifact returns `missing`.
export type ProjectStepArtifactVerdict =
  | { verdict: 'verified'; completed: ChangeAutomationStep }
  | { verdict: 'inert'; why: string }
  | { verdict: 'missing'; required: ChangeAutomationStep; detail: string };

export function verifyProjectStepArtifacts(
  step: string | null,
  ctx: ProjectStepArtifactContext,
): ProjectStepArtifactVerdict {
  const required = step === null ? undefined : PROJECT_STEP_REQUIRED_COMPLETION[step];
  if (!required) {
    return {
      verdict: 'inert',
      why: `step '${step ?? '<null>'}' has no artifact postcondition`,
    };
  }
  try {
    const completed = deriveCompletedStepFromArtifacts({
      change_status: ctx.change_status,
      observed: ctx.observed,
      latest_pass_acted: ctx.latest_pass_acted,
    });
    // Equal-or-higher rank satisfies the postcondition — the same bar the park
    // reconciliation uses. A project mid-flight whose change already reached a
    // later class is grandfathered by construction.
    if (completed !== null && STEP_RANK[completed] >= STEP_RANK[required]) {
      return { verdict: 'verified', completed };
    }
    // The commit-bearing class turns on a git read; a degraded one (repo
    // entity missing, dir gone, no branch configured, git unavailable) means
    // UNKNOWN, not absent — same posture evaluateArtifactMovement takes above.
    // pr_url and the review pass are frontmatter facts, so a degraded git read
    // says nothing about them and must not soften those verdicts.
    if (required === 'execute' && ctx.observed.head_error === 'degraded') {
      return { verdict: 'inert', why: `git read degraded for '${step}' — artifacts unverifiable` };
    }
    return { verdict: 'missing', required, detail: composeProjectStepDetail(required, ctx) };
  } catch (e) {
    // The classifier itself failing is uncertainty, not evidence of a refusal.
    // Advance (the caller only parks on `missing`).
    return {
      verdict: 'inert',
      why: `artifact classifier threw for '${step}': ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// One-line missing-artifact fact for the park reason (park reasons serialize
// into single-line YAML flow via rewriteFrontmatter, so this must never wrap).
// Mirrors composeArtifactDetail's wording, phrased for existence rather than
// movement.
function composeProjectStepDetail(
  required: ChangeAutomationStep,
  ctx: ProjectStepArtifactContext,
): string {
  const { observed, branch, change_status, run_summary } = ctx;
  let detail: string;
  if (required === 'execute') {
    detail =
      observed.head === null
        ? `no commits on ${branch ?? '<unknown branch>'}${observed.head_error === 'ref-not-found' ? ' (ref not found)' : ''}`
        : `change status still '${change_status ?? 'unknown'}' at head ${observed.head.slice(0, 7)} — the EXECUTE writeback never landed`;
  } else if (required === 'open-pr') {
    detail = 'pr_url not set on the change entry';
  } else if (required === 'pr-review') {
    detail = observed.pr_review_path_set
      ? `no review pass on the linked pr-review entry (pass_count ${observed.pass_count ?? 0})`
      : 'no pr-review entry linked';
  } else {
    detail = `${required} artifacts not found`;
  }
  return run_summary ? `${detail}; run summary: "${run_summary}"` : detail;
}

// An infrastructure death, as classified by scripts/model-error-policy.mjs's
// classifyEnvironmentFailure. Structurally duplicated here rather than
// imported: this module is the pure half and takes no dependencies, and the
// .mjs classifier carries no type declarations. `signature` is the class name
// (e.g. `session-limit`, `model-unavailable(credits)`); `reset_at` is the
// moment the condition lifts, when the evidence carried one.
export interface EnvironmentFailure {
  signature: string;
  reset_at?: string | null;
}

// Park reason for a run the environment killed. Distinct prefix from
// `skill-failure` on purpose: park reasons are the substrate for per-skill
// quality metrics, and a run that died because the session window closed or
// the API refused traffic carries no information about the skill that was
// running. Counting those against the skill is the pollution this prefix
// exists to prevent. One line — park reasons serialize into single-line YAML.
export function composeEnvFailureReason(
  step: string | null,
  env: EnvironmentFailure,
  exit: number,
): string {
  const reset = env.reset_at ? ` (resets ${env.reset_at})` : '';
  return `env-failure: ${step ?? '<unknown step>'} died on ${env.signature}${reset} — the environment, not the skill; exit ${exit}. Re-dispatch once it lifts`;
}

// Decide the next gesture given the change's current state + the outcome of
// the most recent run. Pure function — no side effects, no I/O.
export function decideNextChangeStep(args: {
  current_step: string | null;
  iteration_count: number;
  iteration_cap: number;
  last_exit: number; // exit status of the run that just terminated
  pr_review_status: string | null; // change.pr_review_status after the latest pr-review pass
  // Comments on the latest pr-review pass curated for re-implementation
  // (status in {accepted, published, published-as-body} AND no acted_on_at).
  // Computed by the caller via lookupLinkedReview from pr-review-lookup.ts.
  //
  // Used to short-circuit the address-comments no-op loop (Task #427): when
  // the verdict is needs-changes but zero comments are curated, dispatching
  // address-comments would no-op (the skill refuses on status:new) AND the
  // following pr-review would re-review unchanged code (Task #428). Park
  // instead so the user can triage. Null = unknown / pr_review_path not set;
  // treat as "no guard" and fall through to existing behavior.
  comments_to_address?: number | null;
  // Artifact-verified advance (2026-06-12 incident). Result of
  // evaluateArtifactMovement, computed by the caller: false = the run exited
  // 0 but the step's expected artifact didn't move (skill refused / no-op) →
  // park instead of advancing. 'verification-unavailable' = the dispatch
  // baseline was degraded so movement can't be established → park (never
  // silently advance an unverifiable step). true / null / omitted fall
  // through to existing behavior — same back-compat pattern as
  // comments_to_address.
  artifact_moved?: ArtifactMovement;
  // Human-readable fact about the unmoved artifact (+ the refusing run's
  // summary line when available). Composed by the caller; lands verbatim in
  // the park reason.
  artifact_detail?: string | null;
  // Environment classification for the run that just failed, computed by the
  // caller from the run row's error column + journal tail. Non-null routes the
  // failure park to `env-failure` instead of `skill-failure`. Null / omitted
  // (including every non-failure path) keeps existing behavior.
  env_failure?: EnvironmentFailure | null;
}): ChangeAutomationDecision {
  // Failure → park. Captures both unexpected exit codes and the orphan-sweep
  // case (subprocess died with non-zero before writeback).
  if (args.last_exit !== 0) {
    // Infrastructure deaths park under their own prefix — see
    // composeEnvFailureReason for why the two must not be conflated.
    if (args.env_failure?.signature) {
      return {
        action: 'park',
        reason: composeEnvFailureReason(args.current_step, args.env_failure, args.last_exit),
      };
    }
    return {
      action: 'park',
      reason: `skill-failure: ${args.current_step ?? '<unknown step>'} exited ${args.last_exit}`,
    };
  }
  // Clean exit without artifact movement → the skill refused or no-opped.
  // Advancing here is exactly the 2026-06-12 misfire (execute REFUSED →
  // ghost open-pr → ghost pr-review). Failure keeps precedence above.
  if (args.last_exit === 0 && args.artifact_moved === false) {
    const detail = args.artifact_detail ?? null;
    return {
      action: 'park',
      reason: `skill-refused: ${args.current_step ?? '<unknown step>'} exited 0 without artifact movement${detail ? ` — ${detail}` : ''}`,
    };
  }
  // Degraded dispatch baseline → the artifact check is unanswerable. Park
  // with a reason distinct from skill-refused (the gate, not the skill, is
  // what stopped the loop) — silently advancing here would reopen the
  // fail-open the gate exists to close. Recovery: Reset → Start re-snapshots
  // a fresh baseline.
  if (args.last_exit === 0 && args.artifact_moved === 'verification-unavailable') {
    const detail = args.artifact_detail ?? null;
    return {
      action: 'park',
      reason: `verification-unavailable: cannot verify ${args.current_step ?? '<unknown step>'} artifact movement${detail ? ` — ${detail}` : ''}`,
    };
  }
  // Step-by-step transitions for the v1 loop.
  switch (args.current_step) {
    case null:
      // First dispatch for this change. Begin EXECUTE.
      return { action: 'dispatch', step: 'execute' };
    case 'execute':
      return { action: 'dispatch', step: 'open-pr' };
    case 'open-pr':
      return { action: 'dispatch', step: 'pr-review' };
    case 'pr-review': {
      // Decide based on the review verdict — see archetype-change § PR review
      // fields. `needs-changes` triggers the address-comments loop. Anything
      // else (pending = no blockers, approved = clean pass awaiting human
      // triage, ready-for-human) is terminal.
      if (args.pr_review_status === 'needs-changes') {
        // Task #427 — no-op-loop guard. If zero comments on the latest pass
        // are curated for re-implementation, dispatching address-comments
        // would no-op (the skill refuses to act on status:new comments per
        // its SKILL.md gate). Park with a clear reason so the user can triage
        // — flip status:new → accepted/dismissed on the dashboard — then
        // resume. Without this guard, the orchestrator would dispatch
        // address-comments → no-op → re-dispatch pr-review on unchanged head
        // (Task #428) → loop until the model accidentally bypasses its own
        // gate. Null = caller didn't compute; fall through to existing flow.
        if (args.comments_to_address === 0) {
          return {
            action: 'park',
            reason:
              'needs-triage: latest pr-review pass has comments to triage (accept/dismiss) before address-comments can run',
          };
        }
        if (args.iteration_count >= args.iteration_cap) {
          return {
            action: 'park',
            reason: `iteration-cap-reached: ${args.iteration_count} loops`,
          };
        }
        return { action: 'dispatch', step: 'address-comments' };
      }
      return { action: 'complete' };
    }
    case 'address-comments':
      return { action: 'dispatch', step: 'pr-review' };
    default:
      // Unknown step (forward-compat for new step kinds). Stop conservatively.
      return {
        action: 'park',
        reason: `unknown-step: '${args.current_step}' — orchestrator vocabulary out of sync`,
      };
  }
}

// Result of the park-reconciliation decision (read-time, state-only — never
// dispatches). `complete-terminal` cleans up a stale block on a merged/
// abandoned change (restores the on-complete audit trigger that a stuck
// `paused` block suppressed); `unpark` clears a park whose step completed
// out-of-band so the next Start advances; `none` = leave the block alone.
export type ParkReconciliation =
  | { action: 'complete-terminal'; detail: string }
  | { action: 'unpark'; detail: string }
  | { action: 'none' };

// Pause-reason prefixes whose parks auto-reconcile — but ONLY when BOTH the
// movement bar AND the postcondition bar hold (see decideParkReconciliation).
// Deliberately EXCLUDES:
//   - user-paused                 explicit human stop — never overridden
//   - needs-triage                waits on comment triage; its step artifact
//                                 already moved at park time, so movement
//                                 alone would flip-flop every poll
//   - iteration-cap-reached       documented Reset/Resume recovery
//   - verification-unavailable    documented Reset recovery (degraded baseline)
//   - dispatch-failure            current_step is the completed PREVIOUS step,
//                                 so both bars hold by construction at park
//                                 time — auto-unpark would erase the new
//                                 debounce/dirty-tree refusal that IS the
//                                 operator's cue, within one poll
// See standard-automation-loop § Park reconciliation.
//
// `env-failure` sits alongside `skill-failure` because it is the same park
// split by cause, not a new class of park: the run produced nothing either
// way, and if the step later completes out-of-band both bars below still have
// to hold before anything unparks. Leaving it out would silently strip
// reconciliation from the exact runs that most often get re-driven by hand.
//
// Exported so the I/O layer's cheap pre-filter (which decides whether a change
// is worth a git spawn) reads the same list rather than a hand-kept copy.
export const AUTO_UNPARK_PREFIXES = ['skill-failure', 'skill-refused', 'env-failure'] as const;

function stepRank(step: string | null): number {
  return (STEP_RANK as Record<string, number | undefined>)[step ?? ''] ?? 0;
}

// Decide whether a change's automation block should reconcile against
// out-of-band artifact state. Pure — the caller gathers observations and
// applies the result (state-only write, no dispatch).
export function decideParkReconciliation(args: {
  change_status: string | null;
  phase: string;
  paused_reason: string | null;
  current_step: string | null;
  baseline: ChangeAutomationDispatchBaseline | null;
  observed: ArtifactObservation;
  latest_pass_acted: boolean;
}): ParkReconciliation {
  const {
    change_status,
    phase,
    paused_reason,
    current_step,
    baseline,
    observed,
    latest_pass_acted,
  } = args;

  // Terminal: a merged/abandoned change with a live (paused|running) block +
  // a current_step never fired the on-complete audit trigger (phase-aware #0's
  // Exit case). Deliberately NARROW to phase ∈ {paused, running}: an `idle`
  // block with a live current_step on a terminal change pre-exists this
  // mechanism (nothing reconciles it today either, and the absorbed audit
  // case was `paused`). Widening to "any block with current_step != null"
  // would be strictly safe — a merged/abandoned status makes the lifecycle
  // terminally done regardless of phase — but is kept out of scope so this
  // change lands exactly the plan the review approved.
  if (
    (change_status === 'merged' || change_status === 'abandoned') &&
    (phase === 'paused' || phase === 'running') &&
    current_step !== null
  ) {
    return {
      action: 'complete-terminal',
      detail: `change ${change_status} with a live ${phase} block at ${current_step} — completing terminal cleanup`,
    };
  }

  // Unpark: only skill-failure/skill-refused parks, and only when BOTH bars
  // hold — movement since this park's own dispatch (evaluateArtifactMovement
  // === true) AND the parked step's postcondition (classifier rank ≥ parked
  // step's rank). Movement alone proves commits landed, not that
  // execute/address-comments finished — the wall-cap partial-completion class
  // (commits landed, status still planning → classifier null) must stay
  // parked. The postcondition alone is satisfiable by a PRIOR pass for a
  // re-review park (pass_count > 0 already holds → would unpark on stale
  // evidence, then the next Start re-parks). The conjunction never loosens:
  // for open-pr and a first-pass pr-review the two bars coincide. Absent/
  // degraded baseline → movement is not `true` → no unpark (legacy parks
  // recover via Resume/Reset as today).
  if (
    phase === 'paused' &&
    AUTO_UNPARK_PREFIXES.some((p) => (paused_reason ?? '').startsWith(p)) &&
    baseline !== null &&
    evaluateArtifactMovement(current_step, baseline, observed) === true
  ) {
    const completed = deriveCompletedStepFromArtifacts({
      change_status,
      observed,
      latest_pass_acted,
    });
    if (completed !== null && stepRank(completed) >= stepRank(current_step)) {
      return {
        action: 'unpark',
        detail: `${current_step} postcondition satisfied out-of-band (completed step: ${completed}) — clearing ${(paused_reason ?? 'park').split(':')[0]}`,
      };
    }
  }

  return { action: 'none' };
}

// Server-side re-review debounce decision. Refuses a dev-pr-review dispatch
// ONLY when the last-reviewed head and the live branch head are both known,
// equal, and force isn't set — every unknown fails OPEN to dispatch. Pure —
// the caller gathers last_head_sha (from the linked review) + live_head (git).
//
// Deliberately compares the LOCAL branch head, not the GitHub PR head (no
// PAT-dependent network call in the dispatch path). The stranded-unpushed
// -commit case (local head moved, GitHub head didn't) intentionally PASSES
// this gate and is caught by dev-pr-review's own in-skill head_sha gate with
// its richer "unpushed commit" diagnosis — the audits' own division of labor.
export type PrReviewDebounce = { refuse: false } | { refuse: true; message: string };

export function evaluatePrReviewDebounce(args: {
  last_head_sha: string | null;
  live_head: string | null;
  pass_count: number | null;
  force: boolean;
}): PrReviewDebounce {
  const { last_head_sha, live_head, pass_count, force } = args;
  // force, or any unknown head → dispatch (fail-open).
  if (force || !last_head_sha || !live_head) return { refuse: false };
  if (last_head_sha !== live_head) return { refuse: false };
  const n = pass_count ?? 0;
  const s7 = (s: string) => s.slice(0, 7);
  return {
    refuse: true,
    message: `⊘ Re-review debounced — head unchanged since pass ${n} (last reviewed ${s7(last_head_sha)}, branch head ${s7(live_head)}); push new commits or re-dispatch with force: true for a fresh pass against the same head`,
  };
}

// Steps that write the working tree (create a branch, commit) — the dispatches
// the clean-tree gate probes before spawning. address-comments is included
// deliberately: it is EXECUTE-bound per classifyChangeDispatchPhase and hits
// the same dirty-tree wall inside dev-write-change's Step 4b. open-pr and
// pr-review don't touch the tree, so a dirty clone is irrelevant to them.
export const TREE_WRITING_STEPS: ReadonlySet<string> = new Set(['execute', 'address-comments']);

// Single-line dirty-tree refusal for a tree-writing dispatch. Park reasons
// serialize into one-line YAML flow via rewriteFrontmatter, so the whole
// message — including the file list — must stay on one line. Caps the list at
// 10 porcelain lines with a `+N more` tail.
export function composeDirtyTreeRefusal(
  step: string,
  localPath: string,
  dirtyFiles: string[],
): string {
  const CAP = 10;
  const shown = dirtyFiles.slice(0, CAP).join(' · ');
  const extra = dirtyFiles.length > CAP ? ` · +${dirtyFiles.length - CAP} more` : '';
  return `dirty-tree: cannot dispatch ${step} — working tree at ${localPath} has ${dirtyFiles.length} uncommitted change(s): ${shown}${extra} — commit/stash/discard first (mirrors dev-write-change's own pre-branch abort)`;
}

// Companion to the clean-tree gate: is the clone on the branch this dispatch
// needs? A tree-writing step run from the wrong branch is the same waste the
// dirty-tree gate exists to prevent — dev-write-change verifies the checkout
// and aborts, after a full run has already been paid for.
//
// Which branch is right depends on where the change is:
//   - the change's own branch already exists → resumed work belongs on it
//     (address-comments commits onto the open PR's branch; a second EXECUTE
//     continues where the first stopped)
//   - it doesn't exist yet → the branch is about to be cut, and it must be cut
//     from the repo's default branch
//
// Fail-open on every unknown — a degraded git read, an entity with no
// default_branch, a change with no branch configured. The gate may only refuse
// on two known, unequal branch names.
export function evaluateDispatchBranch(args: {
  current_branch: string | null;
  change_branch: string | null;
  change_branch_exists: boolean;
  default_branch: string | null;
}): { refuse: false } | { refuse: true; expected: string } {
  const { current_branch, change_branch, change_branch_exists, default_branch } = args;
  if (!current_branch) return { refuse: false };
  const expected = change_branch_exists && change_branch ? change_branch : default_branch;
  if (!expected) return { refuse: false };
  if (current_branch === expected) return { refuse: false };
  return { refuse: true, expected };
}

// Single-line wrong-branch refusal. Same one-line constraint and same voice as
// composeDirtyTreeRefusal — these two land in the same field and are read side
// by side.
export function composeBranchMismatchRefusal(
  step: string,
  localPath: string,
  currentBranch: string,
  expected: string,
): string {
  return `wrong-branch: cannot dispatch ${step} — clone at ${localPath} is on '${currentBranch}', expected '${expected}' — check out the expected branch first (mirrors dev-write-change's own pre-branch abort)`;
}
