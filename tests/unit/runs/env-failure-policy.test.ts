// Environment-failure classification (scripts/model-error-policy.mjs) and the
// park reason it produces (automation-state-machine.ts).
//
// The subject is an attribution question, not a formatting one. Park reasons
// are the substrate for per-skill quality metrics, so a run the environment
// killed — the account's session window closed, the API refused traffic —
// must not be recorded as that skill having failed. These pin the split:
// which evidence is consulted and in what order, which signatures count as
// environmental, and that the two park prefixes never blur into each other.

import { describe, expect, it } from 'vitest';
import {
  composeEnvFailureReason,
  decideNextChangeStep,
} from '../../../domains/meta/app/server/routes/automation-state-machine.js';
import {
  classifyEnvironmentFailure,
  classifyEnvironmentText,
  classifyModelUnavailability,
  extractSessionResetTime,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/model-error-policy.mjs';

const SESSION_BANNER =
  "Claude usage limit reached — you've hit your session limit. Your limit will reset at 4:00pm (America/New_York).";

describe('classifyEnvironmentText — signatures', () => {
  it('recognises the session-limit banner and pulls the reset time out of it', () => {
    expect(classifyEnvironmentText(SESSION_BANNER)).toEqual({
      signature: 'session-limit',
      reset_at: '4:00pm (America/New_York)',
    });
  });

  it('classifies the session limit even when the banner carries no reset time', () => {
    expect(classifyEnvironmentText('Error: you have hit your session limit')).toEqual({
      signature: 'session-limit',
      reset_at: null,
    });
  });

  it('recognises API overload in the shapes the CLI prints', () => {
    for (const text of [
      'API Error 529 {"type":"error","error":{"type":"overloaded_error"}}',
      'Anthropic API error: Overloaded',
      'api error: 529',
    ]) {
      expect(classifyEnvironmentText(text)).toMatchObject({ signature: 'api-overloaded' });
    }
  });

  it('a bare 529 with no error context is not an overload signal', () => {
    // Digit sequences show up in shas, token counts and line numbers; only the
    // ones anchored to error/status wording may classify.
    expect(classifyEnvironmentText('wrote 529 lines to the plan')).toBeNull();
    expect(classifyEnvironmentText('commit 529abcd')).toBeNull();
  });

  it('an ordinary skill failure classifies as nothing', () => {
    expect(classifyEnvironmentText('Error: test suite failed with 3 failures')).toBeNull();
    expect(classifyEnvironmentText('')).toBeNull();
    expect(classifyEnvironmentText(null)).toBeNull();
  });
});

describe('extractSessionResetTime', () => {
  it('reads the "reset at" phrasing', () => {
    expect(extractSessionResetTime('Your limit will reset at 9pm.')).toBe('9pm');
  });

  it('keeps a balanced parenthetical but drops a sentence-closing one', () => {
    // "(UTC)" belongs to the time; the paren in "(resets at 3pm)" belongs to
    // the sentence and would otherwise leave the reason visibly unbalanced.
    expect(extractSessionResetTime('reset at 4:00pm (America/New_York).')).toBe(
      '4:00pm (America/New_York)',
    );
    expect(extractSessionResetTime('session limit (resets at 3pm)')).toBe('3pm');
  });

  it('reads the "try again at" phrasing', () => {
    expect(extractSessionResetTime('Session limit reached. Try again at 03:15 UTC.')).toBe(
      '03:15 UTC',
    );
  });

  it('reads a relative reset window', () => {
    expect(extractSessionResetTime('session limit — resets in 42 minutes')).toBe('42 minutes');
  });

  it('collapses whitespace and caps the length so the reason stays one line', () => {
    const long = `reset at ${'x'.repeat(200)}`;
    const got = extractSessionResetTime(long);
    expect(got).not.toBeNull();
    expect(got?.includes('\n')).toBe(false);
    expect((got as string).length).toBeLessThanOrEqual(61);
  });

  it('returns null when no reset time is present', () => {
    expect(extractSessionResetTime('hit your session limit')).toBeNull();
  });
});

describe('classifyEnvironmentFailure — evidence precedence', () => {
  it('the row error column is consulted first and its structured verdict is reported verbatim', () => {
    const got = classifyEnvironmentFailure({
      error: 'model-unavailable(credits): claude-opus-5 — policy: required; parked',
      // The tail says something else entirely; the error column still wins.
      tail: 'overloaded_error',
    });
    expect(got).toEqual({ signature: 'model-unavailable(credits)', reset_at: null });
  });

  it('falls back to the journal tail when the error column says nothing', () => {
    expect(classifyEnvironmentFailure({ error: null, tail: SESSION_BANNER })).toMatchObject({
      signature: 'session-limit',
    });
    expect(classifyEnvironmentFailure({ error: '', tail: 'API Error 529' })).toMatchObject({
      signature: 'api-overloaded',
    });
  });

  it('scans an unstructured error column before the tail', () => {
    expect(
      classifyEnvironmentFailure({ error: 'hit your session limit', tail: 'overloaded' }),
    ).toMatchObject({ signature: 'session-limit' });
  });

  it('an ordinary failure on both sources classifies as nothing', () => {
    expect(
      classifyEnvironmentFailure({ error: 'exit 1', tail: 'AssertionError: expected 2 to be 3' }),
    ).toBeNull();
    expect(classifyEnvironmentFailure({})).toBeNull();
  });

  it('the session-limit class stays OUT of the model-availability table', () => {
    // A session limit is an account condition — swapping models cannot cure
    // it, and the fallback hook reads that table. It must not appear there as
    // a fallback-eligible availability class.
    expect(classifyEnvironmentText(SESSION_BANNER)?.signature).toBe('session-limit');
    expect(classifyModelUnavailability('the model was fine')).toBeNull();
  });
});

describe('composeEnvFailureReason', () => {
  it('names the class, the step and the reset time on one line', () => {
    const reason = composeEnvFailureReason(
      'execute',
      { signature: 'session-limit', reset_at: '4:00pm' },
      1,
    );
    expect(reason.startsWith('env-failure:')).toBe(true);
    expect(reason).toContain('execute');
    expect(reason).toContain('session-limit');
    expect(reason).toContain('resets 4:00pm');
    expect(reason.includes('\n')).toBe(false);
  });

  it('omits the reset clause when no time was parsed', () => {
    const reason = composeEnvFailureReason('open-pr', { signature: 'api-overloaded' }, 1);
    expect(reason).not.toContain('resets');
    expect(reason).toContain('api-overloaded');
  });

  it('names an unknown step rather than emitting an empty slot', () => {
    expect(composeEnvFailureReason(null, { signature: 'session-limit' }, -1)).toContain(
      '<unknown step>',
    );
  });
});

describe('decideNextChangeStep — failure park routing', () => {
  const base = {
    current_step: 'execute',
    iteration_count: 0,
    iteration_cap: 4,
    pr_review_status: null,
  };

  it('a classified environment death parks under env-failure, not skill-failure', () => {
    const d = decideNextChangeStep({
      ...base,
      last_exit: 1,
      env_failure: { signature: 'session-limit', reset_at: '4:00pm' },
    });
    expect(d.action).toBe('park');
    expect(d.action === 'park' && d.reason.startsWith('env-failure:')).toBe(true);
    expect(d.action === 'park' && d.reason.includes('skill-failure')).toBe(false);
  });

  it('an unclassified failure keeps the skill-failure park', () => {
    for (const env of [null, undefined]) {
      const d = decideNextChangeStep({ ...base, last_exit: 1, env_failure: env });
      expect(d.action === 'park' && d.reason).toMatch(/^skill-failure: execute exited 1$/);
    }
  });

  it('omitting the field entirely preserves the pre-existing reason exactly', () => {
    const d = decideNextChangeStep({ ...base, last_exit: 137 });
    expect(d.action === 'park' && d.reason).toBe('skill-failure: execute exited 137');
  });

  it('an environment classification never diverts a CLEAN exit', () => {
    // Only the failure arm consults it — a zero exit follows the artifact
    // rules regardless of what the journal happens to contain.
    const d = decideNextChangeStep({
      ...base,
      last_exit: 0,
      artifact_moved: true,
      env_failure: { signature: 'api-overloaded' },
    });
    expect(d.action).toBe('dispatch');
  });
});
