// EXECUTE-bound vs PLAN-bound classification for dual-phase skill dispatches.
//
// dev-write-change runs PLAN and EXECUTE from one skill (state machine on the
// change's review_status), so a static per-skill `model:` pin cannot split
// phases. startRun consults this classifier when the dispatched skill
// declares `model_execute:` frontmatter — an execute-bound verdict swaps the
// model override; anything else keeps the skill's `model:` chain.
//
// Pure (no I/O) so vitest exercises it without the I/O-heavy route modules —
// same separation pattern as automation-state-machine.ts / lifecycle-state.ts.
// tests/unit/dispatch/execute-phase.test.ts pins every branch.

export interface ChangeDispatchGate {
  // The change entry's review_status frontmatter, verbatim (null when unset).
  review_status: string | null;
  // The change entry's plan_path frontmatter — presence gates `not-required`.
  plan_path: string | null;
  // The full dispatch prompt, sniffed for a force_replan flag.
  prompt: string;
}

export type DispatchPhase = 'execute-bound' | 'plan-bound';

// A forced RE-PLAN of an approved change is planning work. The flag arrives
// via CLI-driven interactive sessions, not dashboard dispatches, so this
// prompt-text sniff is a belt-and-braces guard; a false positive merely runs
// EXECUTE on the planning model (the pre-model_execute status quo).
const FORCE_REPLAN_RE = /force_replan\s*[:=]\s*true/i;

// Mirrors dev-write-change's Step-2 review-gate table:
//   approved | overridden          → EXECUTE
//   not-required                   → EXECUTE only once a plan exists ("skips
//                                    only the review gate, never planning")
//   pending | request-changes | rejected | unset | unknown → PLAN (or a stop
//                                    state — either way, not execution work)
// ADDRESS-COMMENTS needs no separate row: a change in that state necessarily
// passed the review gate (review_status stays `approved`), and folding review
// comments into code is execution work.
export function classifyChangeDispatchPhase(gate: ChangeDispatchGate): DispatchPhase {
  if (FORCE_REPLAN_RE.test(gate.prompt)) return 'plan-bound';
  const rs = gate.review_status;
  if (rs === 'approved' || rs === 'overridden') return 'execute-bound';
  if (rs === 'not-required') return gate.plan_path ? 'execute-bound' : 'plan-bound';
  return 'plan-bound';
}
