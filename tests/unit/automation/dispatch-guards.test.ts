// Pure dispatch-guard deciders in automation-state-machine.ts:
//   - evaluatePrReviewDebounce  — refuse a re-review against an unchanged head
//   - composeDirtyTreeRefusal / TREE_WRITING_STEPS — the clean-tree gate (added
//     with the tree-gate seam)
// Both fail OPEN on every unknown; the in-skill gates are the precise backstops.

import { describe, expect, it } from 'vitest';
import {
  TREE_WRITING_STEPS,
  composeDirtyTreeRefusal,
  evaluatePrReviewDebounce,
} from '../../../domains/meta/app/server/routes/automation-state-machine.js';

describe('evaluatePrReviewDebounce', () => {
  it('refuses only when both heads are non-null, equal, and not forced', () => {
    const r = evaluatePrReviewDebounce({
      last_head_sha: 'deadbeefcafe',
      live_head: 'deadbeefcafe',
      pass_count: 2,
      force: false,
    });
    expect(r.refuse).toBe(true);
    if (r.refuse) {
      expect(r.message.startsWith('⊘')).toBe(true);
      expect(r.message).toContain('pass 2');
      expect(r.message).toContain('deadbee'); // sha-7
    }
  });

  it('force bypasses even on equal heads', () => {
    expect(
      evaluatePrReviewDebounce({ last_head_sha: 'abc', live_head: 'abc', pass_count: 1, force: true })
        .refuse,
    ).toBe(false);
  });

  it('different heads dispatch (new commits landed)', () => {
    expect(
      evaluatePrReviewDebounce({ last_head_sha: 'abc', live_head: 'def', pass_count: 1, force: false })
        .refuse,
    ).toBe(false);
  });

  it('any unknown head fails open to dispatch', () => {
    expect(
      evaluatePrReviewDebounce({ last_head_sha: null, live_head: 'abc', pass_count: 1, force: false })
        .refuse,
    ).toBe(false);
    expect(
      evaluatePrReviewDebounce({ last_head_sha: 'abc', live_head: null, pass_count: 1, force: false })
        .refuse,
    ).toBe(false);
    expect(
      evaluatePrReviewDebounce({
        last_head_sha: null,
        live_head: null,
        pass_count: null,
        force: false,
      }).refuse,
    ).toBe(false);
  });

  it('message carries both sha-7s and pass N', () => {
    const r = evaluatePrReviewDebounce({
      last_head_sha: '1234567abcdef',
      live_head: '1234567abcdef',
      pass_count: 3,
      force: false,
    });
    if (!r.refuse) throw new Error('expected refusal');
    expect(r.message).toMatch(/last reviewed 1234567/);
    expect(r.message).toMatch(/branch head 1234567/);
    expect(r.message).toContain('pass 3');
  });
});

describe('clean-tree gate', () => {
  it('only execute and address-comments are tree-writing', () => {
    expect(TREE_WRITING_STEPS.has('execute')).toBe(true);
    expect(TREE_WRITING_STEPS.has('address-comments')).toBe(true);
    expect(TREE_WRITING_STEPS.has('open-pr')).toBe(false);
    expect(TREE_WRITING_STEPS.has('pr-review')).toBe(false);
  });

  it('dirty-tree refusal is single-line, caps the file list, starts with dirty-tree:', () => {
    const many = Array.from({ length: 13 }, (_, i) => `?? f${i}.ts`);
    const msg = composeDirtyTreeRefusal('execute', '/repo', many);
    expect(msg.startsWith('dirty-tree:')).toBe(true);
    expect(msg).not.toContain('\n'); // single-line — park reasons serialize to one-line YAML flow
    expect(msg).toContain('13 uncommitted change(s)');
    expect(msg).toContain('+3 more'); // 13 total, cap 10
    expect(msg).toContain('/repo');
  });

  it('a short dirty list is shown in full with no "+N more"', () => {
    const msg = composeDirtyTreeRefusal('address-comments', '/r', ['M a.ts', '?? b.md']);
    expect(msg).toContain('M a.ts · ?? b.md');
    expect(msg).not.toContain('more');
    expect(msg).toContain('2 uncommitted change(s)');
  });
});
