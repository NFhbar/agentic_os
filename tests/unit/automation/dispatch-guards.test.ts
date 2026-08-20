// Pure dispatch-guard deciders in automation-state-machine.ts:
//   - evaluatePrReviewDebounce  — refuse a re-review against an unchanged head
//   - composeDirtyTreeRefusal / TREE_WRITING_STEPS — the clean-tree gate (added
//     with the tree-gate seam)
//   - evaluateDispatchBranch / composeBranchMismatchRefusal — the clean-tree
//     gate's companion: right tree state, wrong branch is the same wasted run
// All fail OPEN on every unknown; the in-skill gates are the precise backstops.

import { describe, expect, it } from 'vitest';
import {
  TREE_WRITING_STEPS,
  composeBranchMismatchRefusal,
  composeDirtyTreeRefusal,
  evaluateDispatchBranch,
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

// Which branch a tree-writing dispatch needs depends on where the change is:
// a branch that already exists is resumed work and must be dispatched onto;
// one that doesn't exist yet is about to be cut, and must be cut from the
// repo's default branch.
describe('branch gate — evaluateDispatchBranch', () => {
  const on = (over: Record<string, unknown> = {}) =>
    evaluateDispatchBranch({
      current_branch: 'main',
      change_branch: 'feat/thing',
      change_branch_exists: false,
      default_branch: 'main',
      ...over,
    });

  it('a fresh change on the default branch passes', () => {
    expect(on().refuse).toBe(false);
  });

  it('a fresh change checked out on somebody else\'s branch is refused', () => {
    const v = on({ current_branch: 'feat/other' });
    expect(v).toEqual({ refuse: true, expected: 'main' });
  });

  it('resumed work expects the change\'s OWN branch once it exists', () => {
    expect(
      on({ current_branch: 'feat/thing', change_branch_exists: true }).refuse,
    ).toBe(false);
    expect(on({ current_branch: 'main', change_branch_exists: true })).toEqual({
      refuse: true,
      expected: 'feat/thing',
    });
  });

  it('an unreadable current branch fails open — unknown is not wrong', () => {
    // Degraded git read, detached HEAD, missing clone. Refusing here would
    // block dispatches on nothing but the gate's own blindness.
    expect(on({ current_branch: null }).refuse).toBe(false);
  });

  it('a repo entity with no default_branch fails open', () => {
    expect(on({ current_branch: 'feat/other', default_branch: null }).refuse).toBe(false);
  });

  it('a change with no branch configured falls back to the default branch', () => {
    expect(
      on({ change_branch: null, change_branch_exists: true, current_branch: 'main' }).refuse,
    ).toBe(false);
    expect(
      on({ change_branch: null, change_branch_exists: true, current_branch: 'feat/x' }),
    ).toEqual({ refuse: true, expected: 'main' });
  });
});

describe('branch gate — composeBranchMismatchRefusal', () => {
  it('is single-line, names both branches and the clone, and is prefixed for the 409 map', () => {
    const msg = composeBranchMismatchRefusal('execute', '/repo', 'feat/other', 'main');
    expect(msg.startsWith('wrong-branch:')).toBe(true);
    expect(msg).not.toContain('\n');
    expect(msg).toContain("'feat/other'");
    expect(msg).toContain("'main'");
    expect(msg).toContain('/repo');
    expect(msg).toContain('execute');
  });
});
