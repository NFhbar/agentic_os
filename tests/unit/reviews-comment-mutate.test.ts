// Tier 1 unit test for mutateCommentInContent — the surgical accept/dismiss
// rewriter behind PUT /api/reviews/:id/comments/:passN/:commentN. Accepting a
// comment is the gesture that gates publish, so it must NOT strand header
// fields: the new range fields (start_line/side/start_side) emit BEFORE
// `- status:`, and the publish/act-trail ids (github_comment_id, etc.) were
// parsed-but-not-preserved before this change. A whitelist miss on any of them
// pushes `- status:` into the message zone and resurrects a stale status on the
// next parse — destroying exactly the fields publish needs.

import { describe, expect, it } from 'vitest';
import { mutateCommentInContent } from '../../domains/meta/app/server/routes/reviews.js';

// A published, multi-line comment carrying every header field that must survive
// an accept: the range fields ahead of `- status:`, and the github ids after.
const ENTRY = [
  '---',
  'id: pr-review-test-1',
  'type: pr-review',
  'updated: 2026-01-01T00:00:00Z',
  '---',
  '',
  '# PR Review: #1 test',
  '',
  '## Summary',
  'x',
  '',
  '## Pass 1 — 2026-01-01',
  '',
  '### Comments',
  '',
  '#### Comment 1: logic · bug',
  '- file: `src/a.ts`',
  '- line: 58',
  '- start_line: 42',
  '- side: RIGHT',
  '- start_side: RIGHT',
  '- status: published',
  '- github_review_id: 777',
  '- github_comment_id: 555',
  '',
  'The body of the comment.',
  '',
  '### Stats',
  '- files: 1',
  '',
].join('\n');

describe('mutateCommentInContent', () => {
  it('accept preserves range + publish-trail header fields and flips status without stranding it', () => {
    const res = mutateCommentInContent(ENTRY, 1, 1, 'accept', 'looks good');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const out = res.newContent;

    // Exactly one status line, and it is now `accepted` (the old `published`
    // must be gone — not resurrected via a stranded copy in the body).
    const statusLines = out.match(/^- status:.*$/gm) ?? [];
    expect(statusLines).toEqual(['- status: accepted']);
    expect(out).not.toContain('- status: published');

    // Every other header field survives verbatim in the header block.
    expect(out).toContain('- start_line: 42');
    expect(out).toContain('- side: RIGHT');
    expect(out).toContain('- start_side: RIGHT');
    expect(out).toContain('- github_review_id: 777');
    expect(out).toContain('- github_comment_id: 555');
    expect(out).toContain('- line: 58');

    // The accept note landed, and the message body is intact.
    expect(out).toContain("- accept_note: 'looks good'");
    expect(out).toContain('The body of the comment.');

    // Structural: nothing from the header list leaked past the blank line into
    // the message zone. Slice the one comment block and split on its first
    // blank line — the header half must hold every `- key:` field.
    const block = out.slice(out.indexOf('#### Comment 1:'), out.indexOf('### Stats'));
    const [header] = block.split(/\n\n/, 1);
    for (const key of ['start_line', 'side', 'start_side', 'github_review_id', 'github_comment_id', 'status']) {
      expect(header).toContain(`- ${key}:`);
    }
  });
});
