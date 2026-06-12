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

import type { ChangeAutomationDecision } from './automation.types.js';

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
}): ChangeAutomationDecision {
  // Failure → park. Captures both unexpected exit codes and the orphan-sweep
  // case (subprocess died with non-zero before writeback).
  if (args.last_exit !== 0) {
    return {
      action: 'park',
      reason: `skill-failure: ${args.current_step ?? '<unknown step>'} exited ${args.last_exit}`,
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
      // else (pending = no blockers, ready-for-human) is terminal.
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
