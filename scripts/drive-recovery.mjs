#!/usr/bin/env node
// Drive recovery — "the drive just stopped; what kind of stop was it, and may
// the driver do anything about it?", answered from the evidence the OS already
// recorded rather than from a model's read of a stack trace.
//
// `dev-drive-project` v1 treated every stop the same way: hand back to the
// operator. That is correct for a skill that refused, and wasteful for an API
// that was overloaded for ninety seconds. v2 splits the difference by class:
// a stop caused by the infrastructure may be retried a bounded number of
// times; a stop caused by a gate, by the work, or by a human decision is
// still a hand-back, unchanged.
//
// The classifier is deliberately a script and not skill prose. Three reasons:
//   - the same evidence must produce the same class on every invocation, which
//     a model re-deriving a precedence order from a table does not guarantee;
//   - the precedence rule has a carve-out (below) that is easy to state once
//     and easy to get wrong every time it is re-read;
//   - a retry budget is only a budget if something counts it the same way
//     twice.
//
// WHAT THIS MODULE IS NOT. It never decides whether a step succeeded. The
// driver verifies the step's ARTIFACT first (dev-drive-project § Step 5) and
// only classifies when the artifact did not move. That ordering is what makes
// the "killed but the work landed" case — a session limit that lands mid-run
// after the file is written — a non-event: the artifact moved, so there is
// nothing to classify and nothing to retry.
//
// Usage:
//   node scripts/drive-recovery.mjs --park-reason '<paused_reason>' [--json]
//   node scripts/drive-recovery.mjs --run-error '<error column>' --exit-status 143
//   node scripts/drive-recovery.mjs --journal-file <path> --retries-used 1
//
// The exit code reports whether the classifier RAN (0) or was called wrong
// (2). It deliberately does not encode the verdict — a stop is a legitimate
// answer, not a tool failure, and conflating the two is how a driver ends up
// treating "the operator must decide" as "the script broke".
//
// The decision core (classifyDriveStop) is pure — no filesystem, no clock it
// does not accept as an argument — so it is unit-tested against literal
// evidence strings. See tests/unit/lifecycle/drive-recovery.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Vocabulary.
// ---------------------------------------------------------------------------

// How many times one change may be retried across a single drive. The design
// sketch names bounded retry without a number; two is the smallest budget that
// survives a transient blip and its immediate echo, and small enough that a
// misclassification costs two dispatches rather than a night of them.
export const DEFAULT_RETRY_BUDGET = 2;

// The classes. Every stop lands in exactly one.
//
//   environmental  the infrastructure got in the way — overload, a rate limit,
//                  a session window, a transport blip, a run already holding
//                  the change. The work itself was never reached or never
//                  judged. Retryable, or waitable when a clock governs it.
//   auth-wall      access is missing — credentials, credits, entitlement, a
//                  push or signing rejection. Re-running changes nothing until
//                  a human acts, and the driver never touches credentials.
//   skill-refusal  a gate said no, on purpose, and named what would satisfy
//                  it. The refusal text is the remedy.
//   skill-failure  the work ran and failed, or was terminated. Re-running it
//                  unchanged spends money to learn what is already known.
//   human-gate     a normal handoff — triage, a verdict, an explicit pause, a
//                  cap the operator set. Not an error at all.
//   unknown        the evidence does not establish which of the above this is.
//                  Stops, exactly as v1 stopped on everything.
export const DRIVE_STOP_CLASSES = Object.freeze([
  'environmental',
  'auth-wall',
  'skill-refusal',
  'skill-failure',
  'human-gate',
  'unknown',
]);

// The actions. `retry` is the only one that lets the drive continue.
//
//   retry      re-enter the same node once more, within budget.
//   wait       stop, but say when (or on what) it clears — nothing is broken
//              and no operator repair is needed; re-invoking the driver later
//              is the whole recovery.
//   stop       hand back with the remedy or the failure quoted.
//   hand-back  hand back at a gate that was always going to need a human.
export const DRIVE_ACTIONS = Object.freeze(['retry', 'wait', 'stop', 'hand-back']);

// ---------------------------------------------------------------------------
// Evidence signatures — free-text patterns, FIRST MATCH WINS.
//
// Order is load-bearing in two places, both of them collisions between real
// message texts this OS emits or forwards:
//
//   1. `session-limit` precedes `credits`, because the subscription window
//      announces itself as "Claude usage limit reached" and
//      scripts/model-error-policy.mjs classifies that phrase as `credits`.
//      A session window clears on a clock; exhausted credits do not. Getting
//      this backwards turns a fifteen-minute wait into a hand-back, or worse,
//      an exhausted account into a retry loop.
//   2. `wall-cap-kill` sits below the environmental rows so that an overload
//      message earlier in the same blob cannot claim a run the supervisor
//      terminated. In practice the layering below protects this anyway — the
//      supervisor writes `killed:` into the error column, which is read before
//      the journal — but the order makes it true within a single blob too.
//
// `wait: true` marks an environmental signature that a retry cannot help:
// something other than the driver has to move first (a clock, another run).
// ---------------------------------------------------------------------------

export const STOP_SIGNATURES = Object.freeze([
  {
    name: 'session-limit',
    class: 'environmental',
    wait: true,
    re: /usage limit reached|session[- ]limit|5-?hour limit|limit (?:will )?resets?|limit resets/i,
    say: 'the account hit its usage window',
  },
  {
    name: 'run-in-flight',
    class: 'environmental',
    wait: true,
    re: /^blocked$|blocked by run |already has a live run|another run is (?:live|in flight)/i,
    say: 'another run already owns this change',
  },
  {
    name: 'api-overload',
    class: 'environmental',
    wait: false,
    re: /overloaded_error|\boverload(?:ed)?\b|\b529\b|\b503\b|service unavailable/i,
    say: 'the API reported itself overloaded',
  },
  {
    name: 'rate-limit',
    class: 'environmental',
    wait: false,
    re: /model-unavailable\(rate-limit\)|rate.?limit|\b429\b/i,
    say: 'the request was rate-limited',
  },
  {
    name: 'transport',
    class: 'environmental',
    wait: false,
    re: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang ?up|fetch failed|network (?:error|timeout)|connection (?:refused|reset|closed)/i,
    say: 'the connection failed in transport',
  },
  {
    name: 'auth',
    class: 'auth-wall',
    re: /model-unavailable\(auth\)|not logged in|invalid (?:api key|x-api-key)|authentication_error|unauthorized|\b401\b|oauth token|token (?:expired|revoked)|please run \/login/i,
    say: 'the call was not authenticated',
  },
  {
    name: 'credits',
    class: 'auth-wall',
    re: /model-unavailable\(credits\)|credit balance|out of credits|insufficient credit|spending (?:limit|cap)|billing_error/i,
    say: 'the account is out of credit',
  },
  {
    name: 'model-pin',
    class: 'auth-wall',
    re: /model-unavailable\(model-not-found\)|model[^\n]{0,60}(?:not found|does not exist)/i,
    say: 'the pinned model is not reachable from this account',
  },
  {
    name: 'git-auth-wall',
    class: 'auth-wall',
    re: /\bGH007\b|push declined|permission denied \(publickey\)|could not read Username|remote: Permission to|gpg failed to sign|failed to sign the data|ssh_askpass|no matching key found/i,
    say: 'git refused the push or the signature',
  },
  {
    name: 'wall-cap-kill',
    class: 'skill-failure',
    re: /killed: wall-time cap exceeded/i,
    say: 'the supervisor terminated the run at its wall-time cap',
  },
  {
    name: 'dirty-tree',
    class: 'skill-refusal',
    re: /\bdirty-tree\b|uncommitted change/i,
    say: 'the working tree was dirty',
  },
  {
    name: 'head-unchanged',
    class: 'skill-refusal',
    re: /re-review debounced|head unchanged since pass/i,
    say: 'the branch head has not moved since the last review pass',
  },
  {
    name: 'not-eligible',
    class: 'skill-refusal',
    re: /not eligible for automation/i,
    say: 'the change does not satisfy the automation eligibility gate',
  },
  {
    name: 'run-vanished',
    class: 'unknown',
    re: /supervisor: PID not alive|died-after-writeback/i,
    say: 'the child process disappeared without recording why',
  },
]);

// ---------------------------------------------------------------------------
// Park-reason prefixes — the orchestrator's own recorded verdict.
//
// A park reason outranks a run's error text, with ONE carve-out. Two of these
// prefixes say nothing except "the exit code was not zero":
//
//     skill-failure: execute exited 143
//     dev-write-change exited 143
//
// Both are literal restatements of `exit_status`, composed before anything
// looked at WHY. Letting them win would file every session-limit kill and
// every wall-cap kill under `skill-failure` — which is exactly the mislabel
// the recovery table exists to undo. So they defer: the run's error line, then
// the journal, then the exit shape get their turn, and `skill-failure` is
// where the chain lands if none of them say anything more specific.
//
// Every other prefix carries a real verdict and wins outright.
// ---------------------------------------------------------------------------

const PARK_PREFIXES = Object.freeze([
  { re: /^env-failure:/i, kind: 'declared-environmental' },
  { re: /^skill-refused:/i, kind: 'refusal' },
  { re: /^dirty-tree:/i, kind: 'refusal' },
  { re: /^needs-triage/i, kind: 'triage-gate' },
  { re: /^user-paused/i, kind: 'user-gate' },
  { re: /^iteration-cap-reached/i, kind: 'cap-gate' },
  { re: /^review (?:returned|not-approved)|^review-not-approved/i, kind: 'verdict-gate' },
  { re: /^verification-unavailable:/i, kind: 'unverifiable' },
  { re: /^unknown-step:/i, kind: 'vocabulary-drift' },
  { re: /^dispatch-failure:/i, kind: 'dispatch-failure' },
  { re: /^skill-failure:/i, kind: 'defer-to-error-line' },
  { re: /^\S+ exited -?\d+\s*$/i, kind: 'defer-to-error-line' },
]);

// ---------------------------------------------------------------------------
// Reset-time parsing.
//
// Scoped to a window around the word "reset" on purpose. A journal tail is
// wall-to-wall ISO timestamps; a bare "find the first timestamp" rule would
// report the moment the run started as the moment the limit clears. If the
// text does not talk about a reset, this function says so rather than
// guessing.
//
// `reset_at` is only ever a machine-readable instant (an ISO stamp or an epoch
// the text supplied). A human phrasing — "3pm (America/Los_Angeles)", "in 42
// minutes" — comes back as `reset_hint` and NOT as a fabricated timestamp:
// pinning "3pm" to a date means inventing a timezone and a day, and a wrong
// resume time is worse than a quoted string an operator can read.
// ---------------------------------------------------------------------------

const RESET_WINDOW_CHARS = 140;
const ISO_RE =
  /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const EPOCH_RE = /\b(1[0-9]{9})\b/;
const AT_HINT_RE = /\bat\s+([^\n;]{1,48})/i;
const IN_HINT_RE = /\bin\s+(\d+\s*(?:seconds?|minutes?|hours?|secs?|mins?|hrs?|[smh])\b)/i;

export function parseResetTime(text) {
  const empty = { reset_at: null, reset_hint: null };
  if (typeof text !== 'string' || text === '') return empty;
  const anchor = /reset/i.exec(text);
  if (!anchor) return empty;
  const window = text.slice(anchor.index, anchor.index + RESET_WINDOW_CHARS);

  const iso = ISO_RE.exec(window);
  if (iso) {
    const at = new Date(iso[1].replace(' ', 'T'));
    if (!Number.isNaN(at.getTime())) {
      return { reset_at: at.toISOString(), reset_hint: iso[1] };
    }
  }

  const epoch = EPOCH_RE.exec(window);
  if (epoch) {
    const at = new Date(Number(epoch[1]) * 1000);
    if (!Number.isNaN(at.getTime())) {
      return { reset_at: at.toISOString(), reset_hint: epoch[1] };
    }
  }

  const relative = IN_HINT_RE.exec(window);
  if (relative) return { reset_at: null, reset_hint: `in ${tidy(relative[1])}` };

  const clock = AT_HINT_RE.exec(window);
  if (clock) return { reset_at: null, reset_hint: tidy(clock[1]) };

  return empty;
}

function tidy(s) {
  return s.trim().replace(/[.,\s]+$/, '');
}

// ---------------------------------------------------------------------------
// Decision core (pure).
// ---------------------------------------------------------------------------

/**
 * Classify one drive stop and say what the driver may do about it.
 *
 * Precedence, highest first. Each layer only runs when the ones above it
 * declined to answer:
 *
 *   1. `park_reason` — the orchestrator's recorded verdict, EXCEPT the two
 *      exit-restating prefixes documented on PARK_PREFIXES.
 *   2. `run_error`   — the run row's error column, where the supervisor and
 *      the model-availability enricher write their findings.
 *   3. `journal_tail` — the child's own last words. Lower than the error
 *      column because an instant death writes here and nowhere else, while a
 *      supervised kill writes the column; when both speak, the column is the
 *      later and more considered statement.
 *   4. `exit_status` — the shape of the death, when nothing said anything.
 *
 * @param {object} input
 * @param {string|null} [input.park_reason]  `automation.state.paused_reason`, verbatim.
 * @param {string|null} [input.run_error]    the run row's `error` column, verbatim.
 * @param {number|null} [input.exit_status]  the run row's `exit_status`.
 * @param {string|null} [input.journal_tail] the tail of the run's journal / stderr.
 * @param {number} [input.retries_used]      retries already spent on THIS change in this drive.
 * @param {number} [input.retry_budget]      per-change ceiling; 0 reproduces v1 exactly.
 * @param {number} [input.iteration_count]   `automation.state.iteration_count` at park time —
 *   the cap-laundering guard below reads it. Ignored when there is no park.
 * @returns {{class: string, action: string, retry_ok: boolean, reset_at: string|null,
 *            reset_hint: string|null, signature: string, evidence: string,
 *            retry_gesture: string|null, retries_remaining: number, rationale: string}}
 */
export function classifyDriveStop(input = {}) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('classifyDriveStop expects an evidence object');
  }
  const park = str(input.park_reason);
  const runError = str(input.run_error);
  const journal = str(input.journal_tail);
  const rowExit = Number.isInteger(input.exit_status) ? input.exit_status : null;
  // The two exit-restating park reasons carry the exit code in their text. When
  // the caller had the park reason but not the row, that number is still real
  // evidence — the alternative is answering `no-evidence` about a stop whose
  // cause was written down.
  const parkExit = park ? parkExitStatus(park) : null;
  const exitStatus = rowExit ?? parkExit;
  const exitEvidence = rowExit !== null ? 'exit_status' : 'park_reason';
  const retriesUsed = Number.isFinite(input.retries_used) ? Math.max(0, input.retries_used) : 0;
  const retryBudget = Number.isFinite(input.retry_budget)
    ? Math.max(0, input.retry_budget)
    : DEFAULT_RETRY_BUDGET;

  // A park reason means the stop came from the change-automation block, so the
  // retry gesture is the pair of endpoints that re-enter it. Everything else
  // is a run the driver dispatched itself.
  const gesture = park ? 'reset-then-start' : 're-dispatch';
  const iterationCount = Number.isFinite(input.iteration_count)
    ? Math.max(0, input.iteration_count)
    : 0;
  const finish = (verdict) =>
    budgeted(verdict, {
      retriesUsed,
      retryBudget,
      gesture,
      // Reset zeroes `iteration_count` on its way to nulling `current_step`.
      // On a block that has already looped, that hands the address-comments
      // cycle a fresh cap it did not earn — the operator's cap, laundered by a
      // recovery gesture. So the retry is only available before the loop has
      // iterated; after that the environmental stop is still a hand-back.
      launders_cap: gesture === 'reset-then-start' && iterationCount > 0,
      iterationCount,
    });

  // ---- Layer 1: the park reason. ------------------------------------------
  if (park) {
    const prefix = PARK_PREFIXES.find((p) => p.re.test(park));
    const kind = prefix?.kind ?? null;
    const detail = park.replace(/^[^:]+:\s*/, '').trim();

    if (kind === 'declared-environmental') {
      // The park site already ruled this environmental; the signature table
      // only refines WHICH environmental it is. An unrecognized signature
      // still gets the class the composer asserted — it knew something the
      // pattern list does not.
      const hit = matchSignature(park);
      const reset = parseResetTime(park);
      const named = hit && hit.class === 'environmental' ? hit : null;
      return finish({
        class: 'environmental',
        signature: named?.name ?? 'env-failure',
        evidence: 'park_reason',
        action: named?.wait || reset.reset_at || reset.reset_hint ? 'wait' : 'retry',
        ...reset,
        rationale: `the park declared an environmental failure${named ? ` — ${named.say}` : ''}`,
      });
    }

    if (kind === 'refusal') {
      const hit = matchSignature(park);
      return finish({
        class: 'skill-refusal',
        signature: hit?.class === 'skill-refusal' ? hit.name : 'skill-refused',
        evidence: 'park_reason',
        action: 'stop',
        rationale:
          'the step exited cleanly and its gate named what is missing — the park reason is the remedy',
      });
    }

    if (kind === 'triage-gate') {
      return finish({
        class: 'human-gate',
        signature: 'needs-triage',
        evidence: 'park_reason',
        action: 'hand-back',
        rationale: 'the latest review pass has comments waiting on an accept/dismiss decision',
      });
    }
    if (kind === 'user-gate') {
      return finish({
        class: 'human-gate',
        signature: 'user-paused',
        evidence: 'park_reason',
        action: 'hand-back',
        rationale: 'a human paused this change explicitly',
      });
    }
    if (kind === 'cap-gate') {
      return finish({
        class: 'human-gate',
        signature: 'iteration-cap-reached',
        evidence: 'park_reason',
        action: 'hand-back',
        rationale: 'the review loop hit the iteration cap the operator set',
      });
    }
    if (kind === 'verdict-gate') {
      return finish({
        class: 'human-gate',
        signature: 'review-not-approved',
        evidence: 'park_reason',
        action: 'hand-back',
        rationale: 'a review returned a verdict that is a human judgment to act on',
      });
    }

    if (kind === 'unverifiable') {
      return finish({
        class: 'unknown',
        signature: 'verification-unavailable',
        evidence: 'park_reason',
        action: 'stop',
        rationale:
          'the artifact gate could not establish whether the step landed, so neither advancing nor re-running is safe',
      });
    }
    if (kind === 'vocabulary-drift') {
      return finish({
        class: 'unknown',
        signature: 'unknown-step',
        evidence: 'park_reason',
        action: 'stop',
        rationale: 'the orchestrator parked on a step name this OS version does not know',
      });
    }

    if (kind === 'dispatch-failure') {
      // Nothing ran, so nothing was half-done — which is what makes a retry
      // cheap here. The detail after the prefix is the startRun error, and
      // `blocked` in that slot means a live run owns the change.
      const hit = matchSignature(detail);
      if (hit) {
        const reset = parseResetTime(park);
        return finish({
          class: hit.class,
          signature: hit.name,
          evidence: 'park_reason',
          action: actionFor(hit, reset),
          ...reset,
          rationale: `the dispatch never started — ${hit.say}`,
        });
      }
      return finish({
        class: 'environmental',
        signature: 'dispatch-failure',
        evidence: 'park_reason',
        action: 'retry',
        rationale: 'the dispatch failed before the child started, so no work was left half-done',
      });
    }

    if (kind !== 'defer-to-error-line') {
      // A park reason in a vocabulary this table does not carry. Stopping is
      // the whole point of the unknown row: a park nobody modelled is exactly
      // when improvising is most expensive.
      return finish({
        class: 'unknown',
        signature: 'unrecognized-park-reason',
        evidence: 'park_reason',
        action: 'stop',
        rationale: 'the park reason is not in the vocabulary this table classifies',
      });
    }
    // kind === 'defer-to-error-line' → fall through to layer 2.
  }

  // ---- Layers 2 and 3: the recorded text. ---------------------------------
  for (const [source, text] of [
    ['run_error', runError],
    ['journal_tail', journal],
  ]) {
    if (!text) continue;
    const hit = matchSignature(text);
    if (!hit) continue;
    const reset = parseResetTime(text);
    return finish({
      class: hit.class,
      signature: hit.name,
      evidence: source,
      action: actionFor(hit, reset),
      ...reset,
      rationale:
        source === 'run_error'
          ? `the run's error line says ${hit.say}`
          : `the run's journal says ${hit.say}`,
    });
  }

  // ---- Layer 4: the shape of the death. -----------------------------------
  if (exitStatus === 0) {
    // The driver only classifies after a postcondition failed, so a clean exit
    // that got here is a step that returned success without moving its
    // artifact — the refusal shape, whether or not the skill printed one.
    return finish({
      class: 'skill-refusal',
      signature: 'clean-exit-no-artifact',
      evidence: exitEvidence,
      action: 'stop',
      rationale:
        'the step exited 0 without moving its artifact — read the run summary for the gate it declined at',
    });
  }
  if (exitStatus === 143 || exitStatus === 137) {
    return finish({
      class: 'skill-failure',
      signature: exitStatus === 143 ? 'terminated-sigterm' : 'terminated-sigkill',
      evidence: exitEvidence,
      action: 'stop',
      rationale: `the run was terminated by a signal (exit ${exitStatus}) and nothing recorded who sent it`,
    });
  }
  if (exitStatus !== null) {
    return finish({
      class: 'skill-failure',
      signature: 'nonzero-exit',
      evidence: exitEvidence,
      action: 'stop',
      rationale: `the step exited ${exitStatus} with no environmental signature in its error line or journal`,
    });
  }

  return finish({
    class: 'unknown',
    signature: 'no-evidence',
    evidence: 'none',
    action: 'stop',
    rationale: 'no park reason, no error line, no journal, no exit status — nothing to classify',
  });
}

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// The exit code an exit-restating park reason quotes — `skill-failure: execute
// exited 143` / `dev-write-change exited 143`. Null for every other shape.
function parkExitStatus(park) {
  const m = /\bexited (-?\d+)\s*$/i.exec(park.trim());
  return m ? Number.parseInt(m[1], 10) : null;
}

function matchSignature(text) {
  if (typeof text !== 'string' || text === '') return null;
  return STOP_SIGNATURES.find((s) => s.re.test(text)) ?? null;
}

// Environmental signatures retry unless something other than the driver has to
// move first — a clock the text named, or a `wait` signature (a usage window,
// another run holding the change). Every other class stops.
function actionFor(signature, reset) {
  if (signature.class !== 'environmental') return 'stop';
  if (signature.wait) return 'wait';
  if (reset?.reset_at || reset?.reset_hint) return 'wait';
  return 'retry';
}

// Apply the per-change retry budget. Only `retry` consumes it; `wait` does not,
// because waiting spends nothing and learns the same thing every time. A spent
// budget downgrades to `stop` and says so — the budget's whole purpose is that
// a transient condition which keeps recurring is information the operator
// should see, not another dispatch.
function budgeted(verdict, { retriesUsed, retryBudget, gesture, launders_cap, iterationCount }) {
  const remaining = Math.max(0, retryBudget - retriesUsed);
  const base = {
    class: verdict.class,
    action: verdict.action,
    retry_ok: false,
    retry_gesture: null,
    retries_remaining: remaining,
    signature: verdict.signature,
    evidence: verdict.evidence,
    reset_at: verdict.reset_at ?? null,
    reset_hint: verdict.reset_hint ?? null,
    rationale: verdict.rationale,
  };
  if (verdict.action !== 'retry') return base;
  if (remaining === 0) {
    return {
      ...base,
      action: 'stop',
      rationale: `${verdict.rationale}; the retry budget is spent (${retriesUsed}/${retryBudget}), and repeating the same dispatch buys no information`,
    };
  }
  if (launders_cap) {
    return {
      ...base,
      action: 'stop',
      rationale: `${verdict.rationale}; the only retry gesture for a parked block is reset-then-start, which would zero an iteration_count already at ${iterationCount} and hand the review loop a cap it did not earn`,
    };
  }
  return { ...base, retry_ok: true, retry_gesture: gesture };
}

// The one-line form the drive report and the event args both carry, so the
// prose an operator reads and the record an audit scores never drift.
export function formatRecoveryLine(result) {
  const bits = [`class: ${result.class}`, `signature: ${result.signature}`];
  bits.push(`evidence: ${result.evidence}`);
  bits.push(`action: ${result.action}`);
  if (result.action === 'retry') bits.push(`retries left: ${result.retries_remaining}`);
  if (result.reset_at) bits.push(`resets: ${result.reset_at}`);
  else if (result.reset_hint) bits.push(`resets: ${result.reset_hint}`);
  return `${bits.join(' · ')} — ${result.rationale}`;
}

// ---------------------------------------------------------------------------
// CLI half.
// ---------------------------------------------------------------------------

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'usage: node scripts/drive-recovery.mjs [evidence...] [--json]',
        '',
        '  --park-reason  <text>   automation.state.paused_reason, verbatim',
        '  --run-error    <text>   the run row error column, verbatim',
        '  --journal-tail <text>   tail of the run journal / stderr',
        '  --journal-file <path>   read the journal tail from a file instead',
        '  --exit-status  <n>      the run row exit_status',
        '  --retries-used <n>      retries already spent on this change (default 0)',
        `  --retry-budget <n>      per-change ceiling (default ${DEFAULT_RETRY_BUDGET}; 0 = never retry)`,
        '  --iteration-count <n>   automation.state.iteration_count at park time (default 0)',
        '',
        'Exit 0 when the classification ran, 2 on a usage error. The verdict is',
        'in the payload, not in the exit code.',
      ].join('\n'),
    );
    process.exit(0);
  }

  let journalTail = readFlag(argv, '--journal-tail');
  const journalFile = readFlag(argv, '--journal-file');
  if (journalFile) {
    try {
      const whole = readFileSync(journalFile, 'utf8');
      journalTail = whole.slice(-8 * 1024);
    } catch (e) {
      console.error(`cannot read --journal-file ${journalFile}: ${e.message}`);
      process.exit(2);
    }
  }

  const exitRaw = readFlag(argv, '--exit-status');
  const exitStatus = exitRaw == null ? null : Number.parseInt(exitRaw, 10);
  if (exitRaw != null && !Number.isInteger(exitStatus)) {
    console.error(`--exit-status expects an integer, got "${exitRaw}"`);
    process.exit(2);
  }

  const numeric = (flag, fallback) => {
    const raw = readFlag(argv, flag);
    if (raw == null) return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`${flag} expects a non-negative integer, got "${raw}"`);
      process.exit(2);
    }
    return n;
  };

  const result = classifyDriveStop({
    park_reason: readFlag(argv, '--park-reason'),
    run_error: readFlag(argv, '--run-error'),
    journal_tail: journalTail,
    exit_status: exitStatus,
    retries_used: numeric('--retries-used', 0),
    retry_budget: numeric('--retry-budget', DEFAULT_RETRY_BUDGET),
    iteration_count: numeric('--iteration-count', 0),
  });

  if (argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(formatRecoveryLine(result));
  process.exit(0);
}

// Only run when invoked directly (allow importing the core for tests).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
