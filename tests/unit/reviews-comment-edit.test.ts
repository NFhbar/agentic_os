// The comment-edit mutation: its policy gate and its text surgery.
//
// Two rules carry the whole feature. Empty text is a 400, because clearing a
// comment erases the finding rather than revising it. Published text is a 409,
// because the entry is the record of what other people actually read on the
// PR — rewriting it after the fact would make that record a lie. Corrections
// go out as a reply, which has its own visible history.

import { describe, expect, it } from 'vitest';
import {
  editCommentMessageInContent,
  evaluateCommentEdit,
  evaluateCommentMutation,
  extractComments,
  isCommentPublished,
  mutateCommentInContent,
} from '../../domains/meta/app/server/routes/reviews.js';

const DRAFT = { status: 'new', githubCommentId: null };
const ACCEPTED = { status: 'accepted', githubCommentId: null };
const INLINE_PUBLISHED = { status: 'published', githubCommentId: 555 };
const BODY_PUBLISHED = { status: 'published-as-body', githubCommentId: null };
const ACTED_ON = { status: 'acted-on', githubCommentId: null };

describe('isCommentPublished', () => {
  it('counts both ways a comment reaches GitHub', () => {
    expect(isCommentPublished(INLINE_PUBLISHED)).toBe(true);
    expect(isCommentPublished(BODY_PUBLISHED)).toBe(true);
  });

  it('does not count drafts or code-addressed comments', () => {
    expect(isCommentPublished(DRAFT)).toBe(false);
    expect(isCommentPublished(ACCEPTED)).toBe(false);
    // acted-on means the OS changed code because of the comment, not that
    // anyone outside read its text. Still editable.
    expect(isCommentPublished(ACTED_ON)).toBe(false);
  });
});

describe('evaluateCommentEdit', () => {
  it('rejects empty text with 400', () => {
    expect(evaluateCommentEdit('', DRAFT)).toEqual({
      allowed: false,
      status: 400,
      error: expect.stringContaining('must not be empty'),
    });
  });

  it('treats whitespace-only text as empty', () => {
    expect(evaluateCommentEdit('   \n\t ', DRAFT)).toMatchObject({ status: 400 });
  });

  it('rejects a missing or non-string body with 400', () => {
    expect(evaluateCommentEdit(undefined, DRAFT)).toMatchObject({ status: 400 });
    expect(evaluateCommentEdit(42, DRAFT)).toMatchObject({ status: 400 });
    expect(evaluateCommentEdit(null, DRAFT)).toMatchObject({ status: 400 });
  });

  it('rejects an edit to a published comment with 409', () => {
    expect(evaluateCommentEdit('revised text', INLINE_PUBLISHED)).toEqual({
      allowed: false,
      status: 409,
      error: expect.stringContaining('immutable'),
    });
    expect(evaluateCommentEdit('revised text', BODY_PUBLISHED)).toMatchObject({ status: 409 });
  });

  it('checks emptiness before publication, so a blank edit is a 400 either way', () => {
    // Order matters for the message the user sees: "you sent nothing" is more
    // actionable than "this is frozen" when both are true.
    expect(evaluateCommentEdit('', INLINE_PUBLISHED)).toMatchObject({ status: 400 });
  });

  it('allows an edit to an unpublished comment', () => {
    expect(evaluateCommentEdit('revised text', DRAFT)).toEqual({ allowed: true });
    expect(evaluateCommentEdit('revised text', ACCEPTED)).toEqual({ allowed: true });
    expect(evaluateCommentEdit('revised text', ACTED_ON)).toEqual({ allowed: true });
  });
});

describe('evaluateCommentMutation', () => {
  it('blocks accept/dismiss on a published comment with 409', () => {
    expect(evaluateCommentMutation(INLINE_PUBLISHED)).toMatchObject({ status: 409 });
    expect(evaluateCommentMutation(BODY_PUBLISHED)).toMatchObject({ status: 409 });
  });

  it('allows accept/dismiss while the comment is still a draft', () => {
    expect(evaluateCommentMutation(DRAFT)).toEqual({ allowed: true });
    expect(evaluateCommentMutation(ACCEPTED)).toEqual({ allowed: true });
  });
});

const ENTRY = [
  '---',
  'id: r1',
  'type: pr-review',
  'updated: 2026-01-01T00:00:00Z',
  '---',
  '',
  '## Pass 1 — 2026-01-01',
  '',
  '### Comments',
  '',
  '#### Comment 1: logic · bug',
  '- file: `src/a.ts`',
  '- line: 12',
  '- author: octocat',
  '- status: accepted',
  '- accept_note: \'worth fixing\'',
  '',
  'The original message.',
  '',
  '#### Comment 2: tests · nit',
  '- file: `src/b.ts`',
  '- line: 3',
  '- status: new',
  '',
  'Untouched.',
  '',
  '### Stats',
  '- files: 2',
  '',
].join('\n');

function commentsOf(content: string) {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  return extractComments(body.slice(body.indexOf('### Comments')));
}

describe('editCommentMessageInContent', () => {
  it('replaces the message and leaves every header intact', () => {
    const res = editCommentMessageInContent(ENTRY, 1, 1, 'A clearer message.');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [first] = commentsOf(res.newContent);
    expect(first.body).toBe('A clearer message.');
    expect(first.status).toBe('accepted');
    expect(first.acceptNote).toBe('worth fixing');
    expect(first.file).toBe('src/a.ts');
    expect(first.line).toBe(12);
    // Pre-existing unknown headers survive; the edit adds exactly one.
    expect(first.headers).toEqual({ author: 'octocat', body_source: 'operator' });
  });

  it('stamps the body as operator-written, which is what makes it publish verbatim', () => {
    const res = editCommentMessageInContent(ENTRY, 1, 1, 'My own words.');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(commentsOf(res.newContent)[0].headers.body_source).toBe('operator');
    // The sibling comment nobody edited stays model-authored.
    expect(commentsOf(res.newContent)[1].headers.body_source).toBeUndefined();
  });

  it('does not duplicate the stamp across repeated edits', () => {
    let content = ENTRY;
    for (const text of ['first', 'second']) {
      const res = editCommentMessageInContent(content, 1, 1, text);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      content = res.newContent;
    }
    expect(content.match(/^- body_source:.*$/gm)).toEqual(['- body_source: operator']);
  });

  it('preserves the stamp through a later accept/dismiss', () => {
    const edited = editCommentMessageInContent(ENTRY, 1, 1, 'My own words.');
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const mutated = mutateCommentInContent(edited.newContent, 1, 1, 'dismiss', 'changed my mind');
    expect(mutated.ok).toBe(true);
    if (!mutated.ok) return;
    const [first] = commentsOf(mutated.newContent);
    expect(first.headers.body_source).toBe('operator');
    expect(first.status).toBe('dismissed');
    expect(first.body).toBe('My own words.');
  });

  it('accepts multi-line replacement text', () => {
    const res = editCommentMessageInContent(ENTRY, 1, 1, 'Line one.\n\nLine two.');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(commentsOf(res.newContent)[0].body).toBe('Line one.\n\nLine two.');
  });

  it('leaves sibling comments byte-identical', () => {
    const res = editCommentMessageInContent(ENTRY, 1, 1, 'Changed.');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [, second] = commentsOf(res.newContent);
    expect(second.body).toBe('Untouched.');
    expect(second.status).toBe('new');
    expect(res.newContent).toContain('### Stats');
  });

  it('does not accumulate blank lines across repeated edits', () => {
    let content = ENTRY;
    for (const text of ['one', 'two', 'three']) {
      const res = editCommentMessageInContent(content, 1, 1, text);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      content = res.newContent;
    }
    expect(content).not.toMatch(/\n{4,}/);
    expect(commentsOf(content)[0].body).toBe('three');
  });

  it('reports a missing pass or comment rather than rewriting the wrong block', () => {
    expect(editCommentMessageInContent(ENTRY, 9, 1, 'x')).toEqual({
      ok: false,
      error: expect.stringContaining('pass 9'),
    });
    expect(editCommentMessageInContent(ENTRY, 1, 9, 'x')).toEqual({
      ok: false,
      error: expect.stringContaining('comment 9'),
    });
  });

  it('bumps the entry’s updated stamp', () => {
    const res = editCommentMessageInContent(ENTRY, 1, 1, 'Changed.');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newContent).not.toContain('updated: 2026-01-01T00:00:00Z');
    expect(res.newContent).toMatch(/^updated: \d{4}-/m);
  });
});
