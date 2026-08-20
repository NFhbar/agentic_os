// Model-availability policy (scripts/model-error-policy.mjs).
//
// Failure-injection suite: every source of evidence here is a synthetic dead
// run — a journal tail, a stderr sidecar, a SKILL.md — because the subject is
// exactly the runtime's honesty about deaths nobody observed. Four things are
// pinned: the classifier's regex classes and their first-match-wins order,
// the three message formats (dashboards and notifications key on them
// literally), the resolved-model-over-pin rule, and the fallback decision's
// loop guard.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyModelUnavailability,
  classifyRunFailure,
  composeModelUnavailableError,
  decideModelFallback,
  enrichModelUnavailability,
  fallbackRunTitle,
  readSkillModelPolicy,
  stderrSiblingPath,
} from '../../../scripts/model-error-policy.mjs';

const TMP_BASE = join(tmpdir(), 'model-error-policy-test');

// A fake OS root with one skill's SKILL.md — readSkillModelPolicy takes the
// root as its second arg precisely so the reader can be driven off-tree.
function writeSkill(name: string, frontmatter: string[]): void {
  const dir = join(TMP_BASE, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, ...frontmatter, '---', '', `# ${name}`, ''].join('\n'),
  );
}

// A dead run's on-disk evidence: journal + stderr sidecar.
function writeRunEvidence(
  id: string,
  { journal = '', stderr = '' }: { journal?: string; stderr?: string },
): string {
  const dir = join(TMP_BASE, 'runs');
  mkdirSync(dir, { recursive: true });
  const outputPath = join(dir, `${id}.raw.jsonl`);
  writeFileSync(outputPath, journal);
  writeFileSync(join(dir, `${id}.stderr.log`), stderr);
  return outputPath;
}

beforeEach(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('classifyModelUnavailability', () => {
  it('classifies credits', () => {
    for (const text of [
      'Credit balance is too low',
      'You are out of credits',
      'Claude usage limit reached',
      'insufficient credit for this request',
      'spending limit exceeded',
      'monthly spending cap reached',
      '{"type":"error","error":{"type":"billing_error"}}',
    ]) {
      expect(classifyModelUnavailability(text)).toBe('credits');
    }
  });

  it('classifies auth', () => {
    for (const text of [
      'You are not logged in',
      'invalid api key',
      'invalid x-api-key',
      '{"type":"authentication_error"}',
      'Unauthorized',
      'HTTP 401 returned by the API',
      'oauth token missing',
      'token expired',
      'token revoked',
      'Please run /login to continue',
    ]) {
      expect(classifyModelUnavailability(text)).toBe('auth');
    }
  });

  it('classifies model-not-found', () => {
    for (const text of [
      'model claude-fable-5 not found',
      'the requested model does not exist',
      'model claude-fable-5 is currently unavailable',
      'model claude-fable-5 is not available on this plan',
      '{"type":"not_found_error","message":"unknown model id"}',
    ]) {
      expect(classifyModelUnavailability(text)).toBe('model-not-found');
    }
  });

  it('classifies rate-limit', () => {
    for (const text of [
      'rate limit exceeded',
      'rate-limit hit',
      'ratelimit',
      'HTTP 429 Too Many Requests',
      '{"type":"overloaded_error"}',
      'Overloaded',
    ]) {
      expect(classifyModelUnavailability(text)).toBe('rate-limit');
    }
  });

  it('returns null for ordinary failures — keep normal error handling', () => {
    expect(classifyModelUnavailability('Error: test suite failed with 3 failures')).toBeNull();
    expect(classifyModelUnavailability('killed: wall-time cap exceeded (25m)')).toBeNull();
    expect(classifyModelUnavailability('PID not alive')).toBeNull();
    expect(classifyModelUnavailability('')).toBeNull();
    expect(classifyModelUnavailability(null as unknown as string)).toBeNull();
  });

  it('is first-match-wins in class order, not longest-match', () => {
    // Both a credits phrase and a rate-limit phrase present → credits, since
    // it is declared first. The order is the contract, not an accident.
    expect(classifyModelUnavailability('rate limit hit; credit balance is too low')).toBe(
      'credits',
    );
    // auth beats model-not-found when both appear.
    expect(classifyModelUnavailability('unauthorized: model claude-x not found')).toBe('auth');
    // model-not-found beats rate-limit.
    expect(classifyModelUnavailability('429 later; model claude-x does not exist')).toBe(
      'model-not-found',
    );
  });

  it('does not read "usage limit" as a rate limit', () => {
    // The credits regex owns `usage limit`; a naive `.*limit` rate-limit rule
    // would send the operator to "wait it out" instead of "top up".
    expect(classifyModelUnavailability('usage limit reached')).toBe('credits');
  });
});

describe('readSkillModelPolicy', () => {
  it('reads a required-tier skill: policy + pin, no fallbacks', () => {
    writeSkill('fake-gate', ['model: claude-fable-5', 'model_policy: required']);
    expect(readSkillModelPolicy('fake-gate', TMP_BASE)).toEqual({
      policy: 'required',
      pinned: 'claude-fable-5',
      fallbacks: [],
    });
  });

  it('reads a fallback-allowed skill, splitting comma-separated fallbacks', () => {
    writeSkill('fake-drafter', [
      'model: claude-fable-5',
      'model_policy: fallback-allowed',
      'model_fallbacks: claude-opus-4-8, claude-sonnet-4-5',
    ]);
    expect(readSkillModelPolicy('fake-drafter', TMP_BASE)).toEqual({
      policy: 'fallback-allowed',
      pinned: 'claude-fable-5',
      fallbacks: ['claude-opus-4-8', 'claude-sonnet-4-5'],
    });
  });

  it('absent keys → inherit (the pin still reads)', () => {
    writeSkill('fake-plain', ['model: claude-fable-5']);
    expect(readSkillModelPolicy('fake-plain', TMP_BASE)).toEqual({
      policy: 'inherit',
      pinned: 'claude-fable-5',
      fallbacks: [],
    });
  });

  it('an unknown policy value is not permission to swap a model → inherit', () => {
    writeSkill('fake-typo', ['model: claude-fable-5', 'model_policy: fallback_allowed']);
    expect(readSkillModelPolicy('fake-typo', TMP_BASE).policy).toBe('inherit');
  });

  it('unreadable / missing / path-escaping skill → inherit with nothing else', () => {
    const inherit = { policy: 'inherit', pinned: null, fallbacks: [] };
    expect(readSkillModelPolicy('no-such-skill', TMP_BASE)).toEqual(inherit);
    expect(readSkillModelPolicy(null as unknown as string, TMP_BASE)).toEqual(inherit);
    expect(readSkillModelPolicy('../../etc', TMP_BASE)).toEqual(inherit);
  });

  it('malformed frontmatter → inherit rather than a half-read policy', () => {
    const dir = join(TMP_BASE, '.claude', 'skills', 'fake-broken');
    mkdirSync(dir, { recursive: true });
    // Duplicate keys throw in the shared parser (CORE_SCHEMA, dup-key check).
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', 'model: a', 'model: b', 'model_policy: fallback-allowed', '---', ''].join('\n'),
    );
    expect(readSkillModelPolicy('fake-broken', TMP_BASE).policy).toBe('inherit');
  });

  it('pins the shipped posture: 8 required gates, 5 fallback-allowed drafters', () => {
    // Reads the live tree — this is the shipped posture itself, and a skill that
    // loses its policy silently loses the park (or the fallback) with it.
    const required = [
      'dev-pr-review',
      'dev-write-change',
      'dev-review-change',
      'meta-overseer-review',
      'meta-review-project-plan',
      'research-review',
      'meta-apply-tuning-suggestion',
      'meta-eval-skill-edit',
    ];
    for (const skill of required) {
      expect(readSkillModelPolicy(skill).policy, skill).toBe('required');
    }
    const fallbackAllowed = [
      'dev-revise-plan',
      'meta-revise-project-plan',
      'research-write',
      'research-revise',
      'research-update',
    ];
    for (const skill of fallbackAllowed) {
      const read = readSkillModelPolicy(skill);
      expect(read.policy, skill).toBe('fallback-allowed');
      expect(read.fallbacks.length, skill).toBeGreaterThan(0);
    }
  });
});

describe('composeModelUnavailableError', () => {
  it('required → parked, with the restore verb keyed to the class', () => {
    expect(
      composeModelUnavailableError('credits', {
        pinned: 'claude-fable-5',
        policy: 'required',
        fallbacks: [],
      }),
    ).toBe(
      'model-unavailable(credits): claude-fable-5 — policy: required; parked, no side effects; restore credits and re-dispatch',
    );
    expect(
      composeModelUnavailableError('auth', { pinned: 'claude-fable-5', policy: 'required' }),
    ).toBe(
      'model-unavailable(auth): claude-fable-5 — policy: required; parked, no side effects; restore access and re-dispatch',
    );
  });

  it('fallback-allowed with fallbacks → names the first fallback', () => {
    expect(
      composeModelUnavailableError('credits', {
        pinned: 'claude-fable-5',
        policy: 'fallback-allowed',
        fallbacks: ['claude-opus-4-8', 'claude-sonnet-4-5'],
      }),
    ).toBe(
      'model-unavailable(credits): claude-fable-5 — policy: fallback-allowed; re-dispatch on claude-opus-4-8 (drop effort pin)',
    );
  });

  it('otherwise → the bare line (inherit, or fallback-allowed with no fallbacks)', () => {
    expect(composeModelUnavailableError('rate-limit', { pinned: 'claude-fable-5' })).toBe(
      'model-unavailable(rate-limit): claude-fable-5',
    );
    expect(
      composeModelUnavailableError('rate-limit', {
        pinned: 'claude-fable-5',
        policy: 'fallback-allowed',
        fallbacks: [],
      }),
    ).toBe('model-unavailable(rate-limit): claude-fable-5');
  });
});

describe('stderrSiblingPath', () => {
  it('maps both journal shapes to the sidecar', () => {
    expect(stderrSiblingPath('/s/r_1.raw.jsonl')).toBe('/s/r_1.stderr.log');
    expect(stderrSiblingPath('/s/r_1.jsonl')).toBe('/s/r_1.stderr.log');
    expect(stderrSiblingPath('')).toBeNull();
  });
});

describe('classifyRunFailure / enrichModelUnavailability', () => {
  it('classifies from the stderr sidecar when the journal is empty (instant death)', () => {
    // The credit shape: exit 1 in under a second, nothing journaled at all.
    const output_path = writeRunEvidence('r_instant', {
      journal: '',
      stderr: 'Credit balance is too low\n',
    });
    expect(classifyRunFailure({ output_path })).toBe('credits');
  });

  it('classifies from the journal tail when the child journaled an error result', () => {
    const output_path = writeRunEvidence('r_journal', {
      journal: `${JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'API Error: 429 rate limit exceeded',
      })}\n`,
    });
    expect(classifyRunFailure({ output_path })).toBe('rate-limit');
  });

  it('reads only the tail — an availability line far above the window is not evidence', () => {
    const output_path = writeRunEvidence('r_tail', {
      journal: `Credit balance is too low\n${'x'.repeat(9 * 1024)}\n`,
    });
    expect(classifyRunFailure({ output_path })).toBeNull();
  });

  it('no journal / ordinary failure → null (the row keeps today’s handling)', () => {
    expect(classifyRunFailure({ output_path: null })).toBeNull();
    expect(classifyRunFailure(null)).toBeNull();
    const output_path = writeRunEvidence('r_ordinary', { stderr: 'TypeError: x is not a function' });
    expect(enrichModelUnavailability({ output_path, skill: 'fake-gate', model: null })).toBeNull();
  });

  it('names the RESOLVED model, not the frontmatter pin', () => {
    // The run was dispatched with an override / on a fallback leg, so the
    // pin is NOT the model that failed — naming it sends the reader to the
    // wrong model.
    writeSkill('fake-gate', ['model: claude-fable-5', 'model_policy: required']);
    const output_path = writeRunEvidence('r_resolved', { stderr: 'out of credits\n' });
    // repoRoot is the real tree here, so use a real required-tier skill to
    // exercise the policy half while the model half comes off the row.
    const line = enrichModelUnavailability({
      output_path,
      skill: 'dev-pr-review',
      model: 'claude-opus-4-8',
    });
    expect(line).toContain('model-unavailable(credits): claude-opus-4-8');
    expect(line).not.toContain('claude-fable-5');
    expect(line).toContain('policy: required');
  });

  it('falls back to the frontmatter pin only when the row has no model', () => {
    const output_path = writeRunEvidence('r_nomodel', { stderr: 'out of credits\n' });
    const line = enrichModelUnavailability({
      output_path,
      skill: 'dev-pr-review',
      model: null,
    });
    expect(line).toContain('model-unavailable(credits): claude-fable-5');
  });

  it('an unknown skill still produces the bare line — no model is worse than no message', () => {
    const output_path = writeRunEvidence('r_unknown', { stderr: 'unauthorized\n' });
    expect(enrichModelUnavailability({ output_path, skill: null, model: null })).toBe(
      'model-unavailable(auth): unknown',
    );
  });
});

describe('decideModelFallback', () => {
  const base = {
    state: 'failed',
    resolvedModel: 'claude-fable-5',
    cls: 'credits',
    policy: 'fallback-allowed',
    fallbacks: ['claude-opus-4-8'],
    title: null,
  };

  it('fires for a classified failure on a fallback-allowed skill', () => {
    expect(decideModelFallback(base)).toEqual({
      redispatch: true,
      model: 'claude-opus-4-8',
      reason: 'ok',
    });
  });

  it('LOOP GUARD: a run already resolved to the fallback model stays failed', () => {
    expect(decideModelFallback({ ...base, resolvedModel: 'claude-opus-4-8' })).toEqual({
      redispatch: false,
      model: null,
      reason: 'loop-guard',
    });
  });

  it('LOOP GUARD: a fallback leg (by title) never spawns a third leg', () => {
    // Belt-and-braces for the case where the leg reports a dated variant of
    // the fallback id, which the resolved-model arm would not catch.
    expect(
      decideModelFallback({
        ...base,
        resolvedModel: 'claude-opus-4-8-20260101',
        title: 'fallback(claude-opus-4-8): research-write',
      }),
    ).toEqual({ redispatch: false, model: null, reason: 'fallback-leg' });
  });

  it('required never auto-downgrades — that is the whole safety property', () => {
    expect(decideModelFallback({ ...base, policy: 'required' }).reason).toBe(
      'policy-not-fallback-allowed',
    );
    expect(decideModelFallback({ ...base, policy: 'inherit' }).redispatch).toBe(false);
  });

  it('no fallbacks declared → nothing to fall back to', () => {
    expect(decideModelFallback({ ...base, fallbacks: [] }).reason).toBe('no-fallbacks');
  });

  it('an unclassified failure is an ordinary failure — no second leg', () => {
    expect(decideModelFallback({ ...base, cls: null }).reason).toBe('not-classified');
  });

  it('only failed runs qualify — done / cancelled / died-after-writeback never re-dispatch', () => {
    for (const state of ['done', 'cancelled', 'died-after-writeback', 'running']) {
      expect(decideModelFallback({ ...base, state }).reason).toBe('not-failed');
    }
  });
});

describe('fallbackRunTitle', () => {
  it('names the model the second leg runs on', () => {
    expect(fallbackRunTitle('claude-opus-4-8', 'research-write')).toBe(
      'fallback(claude-opus-4-8): research-write',
    );
    expect(fallbackRunTitle('claude-opus-4-8', null)).toBe('fallback(claude-opus-4-8): run');
  });
});
