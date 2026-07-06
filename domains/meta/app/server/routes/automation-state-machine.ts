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
}): ChangeAutomationDecision {
  // Failure → park. Captures both unexpected exit codes and the orphan-sweep
  // case (subprocess died with non-zero before writeback).
  if (args.last_exit !== 0) {
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
