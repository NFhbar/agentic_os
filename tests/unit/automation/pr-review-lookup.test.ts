// Tier 1 unit tests for lookupLinkedReview — the pr-review body parser shared
// by the changes route (PR-tab counts) and the automation orchestrator.
//
// First direct coverage for this module, added alongside the new
// `untriagedCount` field: untriaged (`status: new`) comments on the latest
// pass gate the Mark-ready affordances (comment disposition is a merge
// invariant — new → acted-on | dismissed). A parser bug here would silently
// unblock (or permanently block) the human sign-off gate.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lookupLinkedReview } from '../../../domains/meta/app/server/routes/pr-review-lookup.js';
import { REPO_ROOT } from '../../../domains/meta/app/server/repo.js';

// safePath resolves relative to REPO_ROOT, so fixtures must live inside the
// repo. A throwaway dir under tests/ keeps them out of the vault manifest.
const tmpDir = mkdtempSync(join(REPO_ROOT, 'tests', '.tmp-pr-review-lookup-'));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let fixtureN = 0;
function writeFixture(body: string): string {
  fixtureN += 1;
  const abs = join(tmpDir, `review-${fixtureN}.md`);
  writeFileSync(
    abs,
    `---\nid: review-${fixtureN}\ntype: pr-review\npublished: false\n---\n\n${body}`,
    'utf8',
  );
  return relative(REPO_ROOT, abs);
}

function comment(n: number, headerLines: string[], body = 'Comment body.'): string {
  return `#### Comment ${n}: logic · bug\n${headerLines.join('\n')}\n\n${body}\n`;
}

describe('lookupLinkedReview — untriagedCount', () => {
  it('counts status:new comments on the latest pass only', () => {
    const rel = writeFixture(
      [
        '## Pass 1',
        '',
        // Older pass: 3 new comments — must be ignored by the latest-pass scope.
        comment(1, ['- file: src/a.ts', '- line: 1', '- status: new']),
        comment(2, ['- file: src/b.ts', '- line: 2', '- status: new']),
        comment(3, ['- file: src/c.ts', '- line: 3', '- status: new']),
        '## Pass 2',
        '',
        comment(1, ['- file: src/a.ts', '- line: 10', '- status: new']),
        comment(2, ['- file: src/b.ts', '- line: 20', '- status: new']),
        comment(3, ['- file: src/c.ts', '- line: 30', '- status: accepted']),
        comment(4, ['- file: src/d.ts', '- line: 40', '- status: dismissed']),
      ].join('\n'),
    );
    const lookup = lookupLinkedReview(rel);
    expect(lookup.untriagedCount).toBe(2);
    expect(lookup.passCount).toBe(2);
    // commentsToAddress semantics pinned alongside: accepted without
    // acted_on_at counts; new and dismissed do not.
    expect(lookup.commentsToAddress).toBe(1);
  });

  it('is 0 when every comment is terminally dispositioned (merge-invariant happy path)', () => {
    const rel = writeFixture(
      [
        '## Pass 1',
        '',
        comment(1, [
          '- file: src/a.ts',
          '- line: 10',
          '- status: acted-on',
          '- acted_on_at: 2026-06-12T00:00:00Z',
        ]),
        comment(2, ['- file: src/b.ts', '- line: 20', '- status: dismissed']),
      ].join('\n'),
    );
    const lookup = lookupLinkedReview(rel);
    expect(lookup.untriagedCount).toBe(0);
    expect(lookup.commentsToAddress).toBe(0);
  });

  it('returns the empty shape (untriagedCount 0) for a missing file', () => {
    const lookup = lookupLinkedReview('tests/.does-not-exist/review.md');
    expect(lookup).toEqual({
      commentsToAddress: 0,
      reviewPublished: false,
      reviewGithubReviewId: null,
      passCount: 0,
      untriagedCount: 0,
    });
  });
});
