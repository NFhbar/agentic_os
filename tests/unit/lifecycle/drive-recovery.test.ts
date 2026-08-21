// Unit tests for classifyDriveStop — the judgment `dev-drive-project` v2 makes
// when a node stops.
//
// Two properties carry the whole safety story, and both need to be executable
// rather than aspirational:
//
//   1. Only `environmental` ever produces `retry_ok: true`, and only within a
//      budget. Every gate, every refusal, every failure still hands back — the
//      v1 behavior, unchanged, for everything the table cannot place.
//   2. Precedence is fixed. A park reason outranks an error line outranks the
//      journal outranks the exit shape — except the two park reasons that only
//      restate the exit code, which defer. That carve-out is the reason a
//      session-limit kill stops reading as a skill failure, so it is tested
//      from both directions.
//
// Evidence strings below are the real shapes this OS emits: park reasons from
// automation-state-machine.ts, `model-unavailable(...)` lines from
// scripts/model-error-policy.mjs, and the supervisor's wall-cap marker from
// scripts/runs-supervisor.mjs.

import { describe, expect, it } from 'vitest';
import {
  classifyDriveStop,
  formatRecoveryLine,
  parseResetTime,
  DEFAULT_RETRY_BUDGET,
  DRIVE_ACTIONS,
  DRIVE_STOP_CLASSES,
  STOP_SIGNATURES,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/drive-recovery.mjs';

interface Recovery {
  class: string;
  action: string;
  retry_ok: boolean;
  reset_at: string | null;
  reset_hint: string | null;
  signature: string;
  evidence: string;
  retry_gesture: string | null;
  retries_remaining: number;
  rationale: string;
}

function classify(input: Record<string, unknown>): Recovery {
  return classifyDriveStop(input) as Recovery;
}

describe('vocabulary', () => {
  it('every signature declares a class the table knows', () => {
    for (const sig of STOP_SIGNATURES as Array<{ name: string; class: string }>) {
      expect(DRIVE_STOP_CLASSES).toContain(sig.class);
    }
  });

  it('defaults to a budget of two retries per change', () => {
    expect(DEFAULT_RETRY_BUDGET).toBe(2);
  });

  it('never returns a class or action outside the vocabulary', () => {
    const evidence = [
      { park_reason: 'env-failure: api-overload' },
      { park_reason: 'skill-refused: execute exited 0 without artifact movement' },
      { park_reason: 'needs-triage: latest pr-review pass has comments to triage' },
      { park_reason: 'verification-unavailable: cannot verify execute artifact movement' },
      { park_reason: 'something nobody wrote a row for' },
      { run_error: 'model-unavailable(auth): claude-opus-5' },
      { exit_status: 1 },
      {},
    ];
    for (const e of evidence) {
      const r = classify(e);
      expect(DRIVE_STOP_CLASSES).toContain(r.class);
      expect(DRIVE_ACTIONS).toContain(r.action);
    }
  });
});

describe('environmental', () => {
  it('retries an API overload park', () => {
    const r = classify({ park_reason: 'env-failure: api-overload — upstream returned 529' });
    expect(r.class).toBe('environmental');
    expect(r.action).toBe('retry');
    expect(r.retry_ok).toBe(true);
    expect(r.retries_remaining).toBe(2);
  });

  it('retries a rate limit recorded on the run error line', () => {
    const r = classify({
      run_error:
        'model-unavailable(rate-limit): claude-opus-5 — policy: required; parked, no side effects; restore access and re-dispatch',
      exit_status: 1,
    });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('rate-limit');
    expect(r.evidence).toBe('run_error');
    expect(r.action).toBe('retry');
  });

  it('retries a transport failure found only in the journal tail', () => {
    const r = classify({
      journal_tail: 'FetchError: request to https://api.anthropic.com failed, ECONNRESET',
      exit_status: 1,
    });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('transport');
    expect(r.evidence).toBe('journal_tail');
    expect(r.retry_ok).toBe(true);
  });

  it('names the automation endpoints as the retry gesture for a park', () => {
    const r = classify({ park_reason: 'env-failure: api-overload' });
    expect(r.retry_gesture).toBe('reset-then-start');
  });

  it('names a re-dispatch as the retry gesture when there is no park', () => {
    const r = classify({ run_error: 'Error: socket hang up', exit_status: 1 });
    expect(r.retry_gesture).toBe('re-dispatch');
  });

  it('retries a dispatch that never started, because nothing was left half-done', () => {
    const r = classify({ park_reason: 'dispatch-failure: spawn ENOENT' });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('dispatch-failure');
    expect(r.action).toBe('retry');
  });
});

describe('environmental — honest waiting', () => {
  it('waits rather than retrying when a session limit names an ISO reset', () => {
    const r = classify({
      park_reason: 'env-failure: session-limit — usage limit reached, resets 2026-08-20T22:00:00Z',
    });
    expect(r.class).toBe('environmental');
    expect(r.action).toBe('wait');
    expect(r.retry_ok).toBe(false);
    expect(r.reset_at).toBe('2026-08-20T22:00:00.000Z');
  });

  it('waits on a standing session limit even when no reset time was recorded', () => {
    const r = classify({ journal_tail: 'Claude usage limit reached', exit_status: 1 });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('session-limit');
    expect(r.action).toBe('wait');
    expect(r.reset_at).toBeNull();
  });

  it('quotes a human reset phrasing instead of inventing a timestamp', () => {
    const r = classify({
      journal_tail: 'Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles).',
      exit_status: 1,
    });
    expect(r.action).toBe('wait');
    expect(r.reset_at).toBeNull();
    expect(r.reset_hint).toBe('3pm (America/Los_Angeles)');
  });

  it('waits, not retries, when a live run already owns the change', () => {
    const r = classify({ park_reason: 'dispatch-failure: blocked' });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('run-in-flight');
    expect(r.action).toBe('wait');
    expect(r.retry_ok).toBe(false);
  });

  it('honors a reset time on an otherwise-retryable signature', () => {
    const r = classify({
      run_error: 'rate limit exceeded — resets at 2026-08-20T09:15:00Z',
      exit_status: 1,
    });
    expect(r.signature).toBe('rate-limit');
    expect(r.action).toBe('wait');
    expect(r.reset_at).toBe('2026-08-20T09:15:00.000Z');
  });

  it('waiting does not consume the retry budget', () => {
    const r = classify({
      park_reason: 'env-failure: session-limit — resets 2026-08-20T22:00:00Z',
      retries_used: 0,
    });
    expect(r.retries_remaining).toBe(2);
  });
});

describe('auth-wall', () => {
  it('stops on an authentication failure without retrying', () => {
    const r = classify({
      run_error:
        'model-unavailable(auth): claude-opus-5 — policy: required; parked, no side effects; restore access and re-dispatch',
      exit_status: 1,
    });
    expect(r.class).toBe('auth-wall');
    expect(r.signature).toBe('auth');
    expect(r.action).toBe('stop');
    expect(r.retry_ok).toBe(false);
  });

  it('reads an exhausted balance as a wall, not as a session window', () => {
    const r = classify({
      run_error: 'model-unavailable(credits): claude-opus-5 — restore credits and re-dispatch',
      exit_status: 1,
    });
    expect(r.class).toBe('auth-wall');
    expect(r.signature).toBe('credits');
  });

  it('reads "usage limit reached" as the session window, not as exhausted credits', () => {
    // scripts/model-error-policy.mjs files this phrase under `credits`; the
    // recovery table has to disagree, because a window clears on a clock.
    const r = classify({ journal_tail: 'Claude usage limit reached', exit_status: 1 });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('session-limit');
  });

  it('stops on a push rejected by branch protection', () => {
    const r = classify({
      run_error: 'remote: error: GH007: Your push would publish a private email address',
      exit_status: 1,
    });
    expect(r.class).toBe('auth-wall');
    expect(r.signature).toBe('git-auth-wall');
    expect(r.action).toBe('stop');
  });

  it('stops on a signing failure', () => {
    const r = classify({ run_error: 'error: gpg failed to sign the data', exit_status: 128 });
    expect(r.class).toBe('auth-wall');
    expect(r.retry_ok).toBe(false);
  });

  it('stops on a model the account cannot reach', () => {
    const r = classify({
      run_error: 'model-unavailable(model-not-found): claude-fable-9',
      exit_status: 1,
    });
    expect(r.class).toBe('auth-wall');
    expect(r.signature).toBe('model-pin');
  });
});

describe('skill-refusal', () => {
  it('stops on a skill-refused park and keeps the reason as the remedy', () => {
    const r = classify({
      park_reason:
        'skill-refused: execute exited 0 without artifact movement — no branch created for change x',
    });
    expect(r.class).toBe('skill-refusal');
    expect(r.action).toBe('stop');
    expect(r.retry_ok).toBe(false);
  });

  it('stops on a dirty working tree', () => {
    const r = classify({
      park_reason:
        'dispatch-failure: dirty-tree: cannot dispatch execute — working tree has 3 uncommitted change(s)',
    });
    expect(r.class).toBe('skill-refusal');
    expect(r.signature).toBe('dirty-tree');
    expect(r.action).toBe('stop');
  });

  it('stops on the re-review debounce rather than forcing past it', () => {
    const r = classify({
      run_error: '⊘ Re-review debounced — head unchanged since pass 2 (last reviewed abc1234)',
    });
    expect(r.class).toBe('skill-refusal');
    expect(r.signature).toBe('head-unchanged');
  });

  it('stops on the automation eligibility gate', () => {
    const r = classify({
      run_error: 'not eligible for automation: review_status must be one of approved | not-required',
    });
    expect(r.class).toBe('skill-refusal');
    expect(r.signature).toBe('not-eligible');
  });

  it('reads a clean exit with no artifact movement as a refusal', () => {
    const r = classify({ exit_status: 0 });
    expect(r.class).toBe('skill-refusal');
    expect(r.signature).toBe('clean-exit-no-artifact');
    expect(r.action).toBe('stop');
  });

  it('keeps the refusal class even when the refusal text quotes a network word', () => {
    // The park site splices a run summary into the reason; a stray
    // "connection reset" in that summary must not turn a gate into a retry.
    const r = classify({
      park_reason:
        'skill-refused: execute exited 0 without artifact movement — summary mentioned a connection reset',
    });
    expect(r.class).toBe('skill-refusal');
    expect(r.retry_ok).toBe(false);
  });
});

describe('skill-failure', () => {
  it('stops on a plain non-zero exit and never retries it', () => {
    const r = classify({ park_reason: 'skill-failure: execute exited 2', exit_status: 2 });
    expect(r.class).toBe('skill-failure');
    expect(r.signature).toBe('nonzero-exit');
    expect(r.action).toBe('stop');
    expect(r.retry_ok).toBe(false);
  });

  it('stops on a wall-cap kill — a plain re-dispatch would hit the same wall', () => {
    const r = classify({
      park_reason: 'skill-failure: execute exited 143',
      run_error: 'killed: wall-time cap exceeded (240m)',
      exit_status: 143,
    });
    expect(r.class).toBe('skill-failure');
    expect(r.signature).toBe('wall-cap-kill');
    expect(r.evidence).toBe('run_error');
    expect(r.retry_ok).toBe(false);
  });

  it('stops on a signal termination nobody claimed', () => {
    const r = classify({ exit_status: 143 });
    expect(r.class).toBe('skill-failure');
    expect(r.signature).toBe('terminated-sigterm');
  });

  it('distinguishes a SIGKILL from a SIGTERM in the record', () => {
    expect(classify({ exit_status: 137 }).signature).toBe('terminated-sigkill');
  });

  it('never retries, whatever the budget', () => {
    const r = classify({ exit_status: 2, retries_used: 0, retry_budget: 99 });
    expect(r.retry_ok).toBe(false);
    expect(r.action).toBe('stop');
  });
});

describe('human-gate', () => {
  it.each([
    ['needs-triage: latest pr-review pass has comments to triage', 'needs-triage'],
    ['user-paused', 'user-paused'],
    ['iteration-cap-reached: 4 loops', 'iteration-cap-reached'],
    ['review returned request-changes', 'review-not-approved'],
  ])('hands back on %s', (park, signature) => {
    const r = classify({ park_reason: park });
    expect(r.class).toBe('human-gate');
    expect(r.signature).toBe(signature);
    expect(r.action).toBe('hand-back');
    expect(r.retry_ok).toBe(false);
  });
});

describe('unknown — the table is inert on uncertainty', () => {
  it('stops when the artifact gate could not establish movement', () => {
    const r = classify({
      park_reason: 'verification-unavailable: cannot verify execute artifact movement',
    });
    expect(r.class).toBe('unknown');
    expect(r.action).toBe('stop');
  });

  it('stops when the orchestrator parked on a step name it does not know', () => {
    const r = classify({ park_reason: "unknown-step: 'polish' — vocabulary out of sync" });
    expect(r.class).toBe('unknown');
    expect(r.signature).toBe('unknown-step');
  });

  it('stops on a park reason outside the classified vocabulary', () => {
    const r = classify({ park_reason: 'gremlins in the pipeline' });
    expect(r.class).toBe('unknown');
    expect(r.signature).toBe('unrecognized-park-reason');
    expect(r.action).toBe('stop');
  });

  it('stops when the child vanished without recording why', () => {
    const r = classify({ run_error: 'supervisor: PID not alive', exit_status: 1 });
    expect(r.class).toBe('unknown');
    expect(r.signature).toBe('run-vanished');
  });

  it('stops when there is no evidence at all', () => {
    const r = classify({});
    expect(r.class).toBe('unknown');
    expect(r.signature).toBe('no-evidence');
    expect(r.action).toBe('stop');
  });

  it('throws on a non-object input — that is a caller bug, not a stop condition', () => {
    expect(() => classifyDriveStop(null)).toThrow(TypeError);
  });
});

describe('precedence', () => {
  it('lets a class-bearing park reason beat the run error line', () => {
    const r = classify({
      park_reason: 'needs-triage: comments waiting',
      run_error: 'overloaded_error: the API is overloaded',
      exit_status: 1,
    });
    expect(r.class).toBe('human-gate');
    expect(r.evidence).toBe('park_reason');
  });

  it('lets a skill-refused park beat an environmental error line', () => {
    const r = classify({
      park_reason: 'skill-refused: execute exited 0 without artifact movement',
      run_error: 'model-unavailable(rate-limit): claude-opus-5',
    });
    expect(r.class).toBe('skill-refusal');
  });

  it('lets the error line beat the journal tail', () => {
    const r = classify({
      run_error: 'killed: wall-time cap exceeded (240m)',
      journal_tail: 'earlier in the run: overloaded_error, retrying',
      exit_status: 143,
    });
    expect(r.signature).toBe('wall-cap-kill');
    expect(r.evidence).toBe('run_error');
  });

  it('lets the journal tail beat the exit shape', () => {
    const r = classify({ journal_tail: 'overloaded_error', exit_status: 1 });
    expect(r.class).toBe('environmental');
    expect(r.evidence).toBe('journal_tail');
  });

  it('falls to the exit shape only when nothing else spoke', () => {
    const r = classify({ run_error: 'something the table has no pattern for', exit_status: 1 });
    expect(r.class).toBe('skill-failure');
    expect(r.evidence).toBe('exit_status');
  });
});

describe('precedence — the exit-restating carve-out', () => {
  it('reclassifies a session-limit kill the park reason filed as skill-failure', () => {
    // The exact mislabel the recovery table exists to undo: the park site sees
    // a non-zero exit and writes `skill-failure`, while the journal says the
    // account hit its usage window.
    const r = classify({
      park_reason: 'skill-failure: execute exited 1',
      journal_tail: 'Claude usage limit reached. Your limit will reset at 2026-08-20T22:00:00Z.',
      exit_status: 1,
    });
    expect(r.class).toBe('environmental');
    expect(r.signature).toBe('session-limit');
    expect(r.action).toBe('wait');
    expect(r.reset_at).toBe('2026-08-20T22:00:00.000Z');
  });

  it('defers the project-tier "<skill> exited <n>" park the same way', () => {
    const r = classify({
      park_reason: 'dev-write-change exited 1',
      run_error: 'model-unavailable(rate-limit): claude-opus-5',
      exit_status: 1,
    });
    expect(r.class).toBe('environmental');
    expect(r.evidence).toBe('run_error');
  });

  it('lands on skill-failure when the deferred park finds nothing more specific', () => {
    const r = classify({ park_reason: 'skill-failure: execute exited 2' });
    expect(r.class).toBe('skill-failure');
    expect(r.signature).toBe('nonzero-exit');
    // The row's exit_status was never supplied — the number came out of the
    // park text, and the record says so.
    expect(r.evidence).toBe('park_reason');
    expect(r.rationale).toContain('exited 2');
  });

  it('prefers the row exit status over the number quoted in the park reason', () => {
    const r = classify({ park_reason: 'skill-failure: execute exited 1', exit_status: 143 });
    expect(r.signature).toBe('terminated-sigterm');
    expect(r.evidence).toBe('exit_status');
  });
});

describe('retry budget', () => {
  const overload = { park_reason: 'env-failure: api-overload' };

  it('allows the first retry', () => {
    const r = classify({ ...overload, retries_used: 0 });
    expect(r.retry_ok).toBe(true);
    expect(r.retries_remaining).toBe(2);
  });

  it('allows the second retry', () => {
    const r = classify({ ...overload, retries_used: 1 });
    expect(r.retry_ok).toBe(true);
    expect(r.retries_remaining).toBe(1);
  });

  it('stops once the budget is spent, and says the budget is why', () => {
    const r = classify({ ...overload, retries_used: 2 });
    expect(r.retry_ok).toBe(false);
    expect(r.action).toBe('stop');
    expect(r.retries_remaining).toBe(0);
    expect(r.rationale).toContain('the retry budget is spent (2/2)');
  });

  it('keeps the class honest after the budget is spent — it stops, it is not reclassified', () => {
    const r = classify({ ...overload, retries_used: 5 });
    expect(r.class).toBe('environmental');
    expect(r.action).toBe('stop');
  });

  it('reproduces v1 exactly at retry_budget: 0', () => {
    for (const evidence of [
      { park_reason: 'env-failure: api-overload' },
      { run_error: 'ECONNREFUSED', exit_status: 1 },
      { park_reason: 'dispatch-failure: spawn ENOENT' },
    ]) {
      const r = classify({ ...evidence, retry_budget: 0 });
      expect(r.retry_ok).toBe(false);
      expect(r.action).toBe('stop');
    }
  });

  it('honors a raised budget', () => {
    const r = classify({ ...overload, retries_used: 2, retry_budget: 4 });
    expect(r.retry_ok).toBe(true);
    expect(r.retries_remaining).toBe(2);
  });

  it('treats a nonsense retries_used as zero rather than blocking the drive', () => {
    const r = classify({ ...overload, retries_used: Number.NaN });
    expect(r.retries_remaining).toBe(2);
  });
});

describe('retry budget — the cap-laundering guard', () => {
  const overload = { park_reason: 'env-failure: api-overload' };

  it('retries a parked block that has not looped yet', () => {
    const r = classify({ ...overload, iteration_count: 0 });
    expect(r.retry_ok).toBe(true);
    expect(r.retry_gesture).toBe('reset-then-start');
  });

  it('refuses to reset a block whose review loop has already iterated', () => {
    // reset nulls current_step AND zeroes iteration_count; on a looped block
    // that would hand address-comments a cap the operator never granted.
    const r = classify({ ...overload, iteration_count: 2 });
    expect(r.class).toBe('environmental');
    expect(r.action).toBe('stop');
    expect(r.retry_ok).toBe(false);
    expect(r.rationale).toContain('iteration_count already at 2');
  });

  it('does not apply the guard to a re-dispatch, which touches no counter', () => {
    const r = classify({ run_error: 'ECONNRESET', exit_status: 1, iteration_count: 3 });
    expect(r.retry_ok).toBe(true);
    expect(r.retry_gesture).toBe('re-dispatch');
  });

  it('reports the spent budget before the cap guard when both apply', () => {
    const r = classify({ ...overload, retries_used: 2, iteration_count: 2 });
    expect(r.rationale).toContain('the retry budget is spent');
  });
});

describe('parseResetTime', () => {
  it('reads an ISO instant near the word reset', () => {
    expect(parseResetTime('limit resets 2026-08-20T22:00:00Z').reset_at).toBe(
      '2026-08-20T22:00:00.000Z',
    );
  });

  it('reads an epoch-second reset', () => {
    const { reset_at } = parseResetTime('reset at 1755727200');
    expect(reset_at).toBe(new Date(1755727200 * 1000).toISOString());
  });

  it('reads a relative reset as a hint, not as an instant', () => {
    const r = parseResetTime('rate limited; resets in 42 minutes');
    expect(r.reset_at).toBeNull();
    expect(r.reset_hint).toBe('in 42 minutes');
  });

  it('ignores timestamps that are not near a reset', () => {
    // A journal tail is wall-to-wall timestamps; only a reset is a reset.
    const r = parseResetTime('2026-08-20T08:00:00Z starting execute for change x');
    expect(r.reset_at).toBeNull();
    expect(r.reset_hint).toBeNull();
  });

  it('answers empty for text with no reset at all', () => {
    expect(parseResetTime('overloaded_error')).toEqual({ reset_at: null, reset_hint: null });
    expect(parseResetTime('')).toEqual({ reset_at: null, reset_hint: null });
    expect(parseResetTime(null)).toEqual({ reset_at: null, reset_hint: null });
  });
});

describe('formatRecoveryLine', () => {
  it('carries class, signature, evidence, action and rationale on one line', () => {
    const line = formatRecoveryLine(
      classify({ park_reason: 'env-failure: api-overload' }),
    ) as string;
    expect(line).toContain('class: environmental');
    expect(line).toContain('signature: api-overload');
    expect(line).toContain('evidence: park_reason');
    expect(line).toContain('action: retry');
    expect(line).toContain('retries left: 2');
  });

  it('carries the reset time when there is one', () => {
    const line = formatRecoveryLine(
      classify({ park_reason: 'env-failure: session-limit — resets 2026-08-20T22:00:00Z' }),
    ) as string;
    expect(line).toContain('resets: 2026-08-20T22:00:00.000Z');
  });
});
