// Generic header capture on comment blocks.
//
// The comment-block format is `- key: value` header lines, a blank line, then
// prose. Historically only a fixed list of keys was recognized; anything else
// fell through into the message body. Two things went wrong when it did:
//
//   1. The unknown header rendered as literal text at the top of the comment.
//   2. Worse, a header pushed below the blank line drags every header AFTER it
//      down too — so a `- status:` line stranded in the prose zone stops
//      counting as a status, and the next parse resurrects the default.
//
// So an unrecognized header is captured, not leaked, and a mutation carries it
// through unchanged. These tests pin both halves.

import { describe, expect, it } from 'vitest';
import {
  extractComments,
  extractPassConfig,
  mutateCommentInContent,
  parseCommentHeaderLine,
} from '../../domains/meta/app/server/routes/reviews.js';

// A pass whose first comment carries two headers nobody has taught the parser
// about (`author`, `in_reply_to`) sandwiched between ones it knows, and whose
// prose deliberately contains a colon so the body/header boundary is tested
// rather than assumed.
const PASS = [
  '',
  '### Pass config',
  '- model: some-model',
  '- agent: external',
  '',
  '### Comments',
  '',
  '#### Comment 1: logic · bug',
  '- file: `src/a.ts`',
  '- line: 12',
  '- author: octocat',
  '- in_reply_to: pass-1-comment-4',
  '- status: new',
  '',
  'Body text here: with a colon.',
  '',
  '#### Comment 2: tests · nit',
  '- file: `src/b.ts`',
  '- line: 3',
  '- status: new',
  '',
  'Second body.',
  '',
  '### Stats',
  '- files: 2',
  '',
].join('\n');

const ENTRY = ['---', 'id: r1', 'type: pr-review', 'updated: 2026-01-01T00:00:00Z', '---', '', '## Pass 1 — 2026-01-01', PASS].join('\n');

describe('parseCommentHeaderLine', () => {
  it('accepts lowercase identifier keys and trims the value', () => {
    expect(parseCommentHeaderLine('- author:  octocat  ')).toEqual({
      key: 'author',
      value: 'octocat',
    });
    expect(parseCommentHeaderLine('- in_reply_to: github:12345')).toEqual({
      key: 'in_reply_to',
      value: 'github:12345',
    });
  });

  it('rejects shapes that are prose bullets rather than headers', () => {
    // Multi-word "key" — an ordinary sentence that happens to contain a colon.
    expect(parseCommentHeaderLine('- see also the other file: it is worse')).toBeNull();
    // No colon at all.
    expect(parseCommentHeaderLine('- just a bullet')).toBeNull();
    // Not a list item.
    expect(parseCommentHeaderLine('author: octocat')).toBeNull();
  });
});

describe('extractComments — generic header capture', () => {
  const comments = extractComments(PASS);

  it('captures unrecognized headers into the headers map', () => {
    expect(comments[0].headers).toEqual({
      author: 'octocat',
      in_reply_to: 'pass-1-comment-4',
    });
  });

  it('keeps unrecognized headers out of the message body', () => {
    expect(comments[0].body).toBe('Body text here: with a colon.');
    expect(comments[0].body).not.toContain('author');
    expect(comments[0].body).not.toContain('in_reply_to');
  });

  it('still parses the typed headers that follow an unrecognized one', () => {
    // This is the failure mode the capture exists to prevent: `- status:` sits
    // BELOW the unknown headers, so leaking them would have stranded it.
    expect(comments[0].status).toBe('new');
    expect(comments[0].file).toBe('src/a.ts');
    expect(comments[0].line).toBe(12);
  });

  it('leaves the map empty for comments with only known headers', () => {
    expect(comments[1].headers).toEqual({});
  });
});

describe('extractPassConfig — agent kind', () => {
  it('reads the pass-level agent', () => {
    expect(extractPassConfig(PASS).agent).toBe('external');
  });

  it('falls back to the older source spelling', () => {
    const legacy = ['', '### Pass config', '- model: m', '- source: external', ''].join('\n');
    expect(extractPassConfig(legacy).agent).toBe('external');
  });

  it('prefers the agent line when both are present', () => {
    const both = [
      '',
      '### Pass config',
      '- agent: logic',
      '- source: external',
      '',
    ].join('\n');
    expect(extractPassConfig(both).agent).toBe('logic');
  });

  it('is null when the pass declares no agent', () => {
    const plain = ['', '### Pass config', '- model: m', '- style: concise', ''].join('\n');
    expect(extractPassConfig(plain).agent).toBeNull();
  });
});

describe('mutateCommentInContent — unknown header preservation', () => {
  it('carries unknown headers through an accept, still above the blank line', () => {
    const res = mutateCommentInContent(ENTRY, 1, 1, 'accept', null);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const block = res.newContent.slice(
      res.newContent.indexOf('#### Comment 1:'),
      res.newContent.indexOf('#### Comment 2:'),
    );
    const [header] = block.split(/\n\n/, 1);
    expect(header).toContain('- author: octocat');
    expect(header).toContain('- in_reply_to: pass-1-comment-4');
    expect(header).toContain('- status: accepted');
  });

  it('rewrites only the target comment’s status, leaving the sibling alone', () => {
    const res = mutateCommentInContent(ENTRY, 1, 1, 'dismiss', 'not our call');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Comment 1 flips; Comment 2 keeps its own. Exactly two status lines in
    // the entry, in block order — no duplicate stranded in a message zone.
    const statusLines = res.newContent.match(/^- status:.*$/gm) ?? [];
    expect(statusLines).toEqual(['- status: dismissed', '- status: new']);
  });

  it('re-parses to the same headers after a round trip', () => {
    const res = mutateCommentInContent(ENTRY, 1, 1, 'accept', 'good catch');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = res.newContent.replace(/^---\n[\s\S]*?\n---\n/, '');
    const reparsed = extractComments(body.slice(body.indexOf('### Comments')));
    expect(reparsed[0].headers).toEqual({
      author: 'octocat',
      in_reply_to: 'pass-1-comment-4',
    });
    expect(reparsed[0].status).toBe('accepted');
    expect(reparsed[0].acceptNote).toBe('good catch');
    expect(reparsed[0].body).toBe('Body text here: with a colon.');
  });
});
