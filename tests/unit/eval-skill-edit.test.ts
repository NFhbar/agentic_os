import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations
import { composeReplayPrompt, extractPrRef, isContinuationPrompt } from '../../scripts/eval-skill-edit.mjs';

describe('extractPrRef', () => {
  it('parses a PR URL reference', () => {
    expect(
      extractPrRef('Run the dev-pr-review skill against PR https://github.com/NFhbar/mull/pull/8 as a continuation pass.'),
    ).toEqual({ kind: 'url', owner: 'NFhbar', repo: 'mull', number: 8 });
  });

  it('parses a change-id reference', () => {
    expect(
      extractPrRef('Run the dev-pr-review skill for change "abi-decoding-via-codegen-typed-event-structs-and-per-event".'),
    ).toEqual({ kind: 'change', change_id: 'abi-decoding-via-codegen-typed-event-structs-and-per-event' });
  });

  it('returns null when neither form is present', () => {
    expect(extractPrRef('Run the morning brief.')).toBeNull();
  });
});

describe('isContinuationPrompt', () => {
  it('flags continuation passes (v1 replays initial passes only)', () => {
    expect(isContinuationPrompt('… as a continuation pass.')).toBe(true);
    expect(isContinuationPrompt('Run the dev-pr-review skill for change "x".')).toBe(false);
  });
});

describe('composeReplayPrompt', () => {
  const prompt = composeReplayPrompt({
    storedPrompt: 'Run the dev-pr-review skill for change "x".\nInputs:\n- pr: "https://github.com/o/r/pull/5"',
    patchedSkill: '---\nname: dev-pr-review\n---\nPATCHED BODY',
    localPath: '/repos/r',
    baseSha: 'aaaa1111',
    pinnedHead: 'bbbb2222',
    prUrl: 'https://github.com/o/r/pull/5',
  });

  it('inlines the patched skill between override markers', () => {
    expect(prompt).toContain('===== SKILL-OVERRIDE BEGIN =====');
    expect(prompt).toContain('PATCHED BODY');
    expect(prompt).toContain('===== SKILL-OVERRIDE END =====');
  });

  it('pins the diff to concrete shas — never a live gh fetch', () => {
    expect(prompt).toContain('git -C /repos/r diff aaaa1111 bbbb2222');
    expect(prompt).toContain('git -C /repos/r show bbbb2222:<path>');
    expect(prompt).toMatch(/Do NOT run `gh pr diff`/);
  });

  it('forbids side effects and carries the original dispatch prompt', () => {
    expect(prompt).toContain('do not create or edit ANY file in vault/');
    expect(prompt).toContain('Run the dev-pr-review skill for change "x".');
  });
});
