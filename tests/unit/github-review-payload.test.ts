// Tier 1 unit tests for mcps/github/review-payload.mjs — the payload shaping
// behind `create_pull_request_review`. Two guards are pinned here:
//
//  - pre-flight normalization, which degrades a range that can never be
//    accepted (start not strictly before end) before the call is made, and
//  - the response-driven fallback, which strips every range and retries once
//    when GitHub answers a range-carrying payload with a 422.
//
// A regression in either one turns "the review landed with a coarser anchor"
// into "the review was lost", which is the failure this module exists to
// prevent.

import { describe, expect, it } from 'vitest';
import {
  hasRangeAnchors,
  isUnprocessableEntity,
  normalizeReviewComments,
  stripRangeAnchors,
} from '../../mcps/github/review-payload.mjs';

describe('normalizeReviewComments', () => {
  it('drops comments with no path or no body', () => {
    const out = normalizeReviewComments([
      { path: 'src/a.ts', body: 'keep me', line: 4 },
      { path: 'src/b.ts', body: '' },
      { body: 'no path' },
      null,
    ]);
    expect(out).toEqual([{ path: 'src/a.ts', body: 'keep me', line: 4, side: 'RIGHT' }]);
  });

  it('defaults side to RIGHT and honours an explicit LEFT', () => {
    const out = normalizeReviewComments([
      { path: 'src/a.ts', body: 'x', line: 10 },
      { path: 'src/a.ts', body: 'y', line: 11, side: 'LEFT' },
      { path: 'src/a.ts', body: 'z', line: 12, side: 'sideways' },
    ]);
    expect(out.map((c) => c.side)).toEqual(['RIGHT', 'LEFT', 'RIGHT']);
  });

  it('leaves file-level comments without a line or side', () => {
    const [out] = normalizeReviewComments([{ path: 'README.md', body: 'file-level' }]);
    expect(out).toEqual({ path: 'README.md', body: 'file-level' });
  });

  it('forwards a well-formed range and defaults start_side to side', () => {
    const [out] = normalizeReviewComments([
      { path: 'src/a.ts', body: 'span', line: 58, start_line: 42, side: 'LEFT' },
    ]);
    expect(out).toEqual({
      path: 'src/a.ts',
      body: 'span',
      line: 58,
      side: 'LEFT',
      start_line: 42,
      start_side: 'LEFT',
    });
  });

  it('keeps an explicit cross-side start_side', () => {
    const [out] = normalizeReviewComments([
      { path: 'src/a.ts', body: 'span', line: 58, start_line: 42, side: 'RIGHT', start_side: 'LEFT' },
    ]);
    expect(out.start_side).toBe('LEFT');
  });

  it('degrades a malformed range to a single-line anchor', () => {
    const out = normalizeReviewComments([
      { path: 'src/a.ts', body: 'start == end', line: 42, start_line: 42 },
      { path: 'src/a.ts', body: 'start after end', line: 42, start_line: 58 },
    ]);
    for (const c of out) {
      expect(c.start_line).toBeUndefined();
      expect(c.start_side).toBeUndefined();
      expect(c.line).toBe(42);
    }
  });

  it('ignores a range on a file-level comment', () => {
    const [out] = normalizeReviewComments([
      { path: 'src/a.ts', body: 'no anchor', start_line: 4, start_side: 'RIGHT' },
    ]);
    expect(out).toEqual({ path: 'src/a.ts', body: 'no anchor' });
  });
});

describe('hasRangeAnchors', () => {
  it('is true when any comment carries a range', () => {
    expect(
      hasRangeAnchors([
        { path: 'a', body: 'b', line: 3, side: 'RIGHT' },
        { path: 'a', body: 'b', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT' },
      ]),
    ).toBe(true);
  });

  it('is false for a single-line-only payload', () => {
    expect(hasRangeAnchors([{ path: 'a', body: 'b', line: 3, side: 'RIGHT' }])).toBe(false);
  });

  it('is false for an empty payload', () => {
    expect(hasRangeAnchors([])).toBe(false);
    expect(hasRangeAnchors()).toBe(false);
  });
});

describe('stripRangeAnchors', () => {
  it('collapses every range onto its end line and counts what it touched', () => {
    const { comments, stripped } = stripRangeAnchors([
      { path: 'a.ts', body: 'one', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT' },
      { path: 'b.ts', body: 'two', line: 3, side: 'RIGHT' },
      { path: 'c.ts', body: 'three', line: 20, side: 'LEFT', start_line: 11, start_side: 'LEFT' },
    ]);
    expect(stripped).toBe(2);
    expect(comments).toEqual([
      { path: 'a.ts', body: 'one', line: 9, side: 'RIGHT' },
      { path: 'b.ts', body: 'two', line: 3, side: 'RIGHT' },
      { path: 'c.ts', body: 'three', line: 20, side: 'LEFT' },
    ]);
  });

  it('preserves body and path bytes exactly', () => {
    const body = 'line one\n\n```ts\nconst x = 1;\n```\n';
    const { comments } = stripRangeAnchors([
      { path: 'src/deep/path.ts', body, line: 9, side: 'RIGHT', start_line: 7 },
    ]);
    expect(comments[0].body).toBe(body);
    expect(comments[0].path).toBe('src/deep/path.ts');
  });

  it('is a no-op on a payload with no ranges', () => {
    const input = [{ path: 'a.ts', body: 'x', line: 3, side: 'RIGHT' }];
    const { comments, stripped } = stripRangeAnchors(input);
    expect(stripped).toBe(0);
    expect(comments).toEqual(input);
  });
});

describe('isUnprocessableEntity', () => {
  it('recognizes a 422 status', () => {
    expect(isUnprocessableEntity(Object.assign(new Error('boom'), { status: 422 }))).toBe(true);
  });

  it('rejects other statuses even when the message mentions 422', () => {
    expect(
      isUnprocessableEntity(Object.assign(new Error('not 422 at all'), { status: 404 })),
    ).toBe(false);
  });

  it('falls back to the message when no status is attached', () => {
    expect(isUnprocessableEntity(new Error('HttpError: 422 Unprocessable Entity'))).toBe(true);
    expect(isUnprocessableEntity(new Error('HttpError: 500 Server Error'))).toBe(false);
    expect(isUnprocessableEntity('422 from a string throw')).toBe(true);
  });

  it('is false for no error at all', () => {
    expect(isUnprocessableEntity(null)).toBe(false);
    expect(isUnprocessableEntity(undefined)).toBe(false);
  });
});

describe('422 fallback sequence', () => {
  // Replays the submit → 422 → strip → resubmit path the review handler runs,
  // against a fake submitter. The contract: exactly one retry, ranges gone on
  // that retry, and no retry at all when there was nothing to strip.
  function submitWithFallback(
    comments: Record<string, unknown>[],
    submit: (payload: Record<string, unknown>[]) => { ok: true } | never,
  ) {
    const normalized = normalizeReviewComments(comments);
    const seen: Record<string, unknown>[][] = [];
    const call = (payload: Record<string, unknown>[]) => {
      seen.push(payload);
      return submit(payload);
    };
    try {
      call(normalized);
      return { seen, rangeFallback: false };
    } catch (err) {
      if (!isUnprocessableEntity(err) || !hasRangeAnchors(normalized)) throw err;
      call(stripRangeAnchors(normalized).comments);
      return { seen, rangeFallback: true };
    }
  }

  const RANGE = [{ path: 'a.ts', body: 'span', line: 58, start_line: 42 }];

  it('retries once with ranges stripped when GitHub answers 422', () => {
    let attempts = 0;
    const { seen, rangeFallback } = submitWithFallback(RANGE, () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('rejected'), { status: 422 });
      return { ok: true };
    });
    expect(attempts).toBe(2);
    expect(rangeFallback).toBe(true);
    expect(seen[0][0].start_line).toBe(42);
    expect(seen[1][0].start_line).toBeUndefined();
    expect(seen[1][0].line).toBe(58);
  });

  it('does not retry when the payload carried no range to strip', () => {
    let attempts = 0;
    expect(() =>
      submitWithFallback([{ path: 'a.ts', body: 'single', line: 58 }], () => {
        attempts += 1;
        throw Object.assign(new Error('rejected'), { status: 422 });
      }),
    ).toThrow('rejected');
    expect(attempts).toBe(1);
  });

  it('does not retry on a non-422 rejection', () => {
    let attempts = 0;
    expect(() =>
      submitWithFallback(RANGE, () => {
        attempts += 1;
        throw Object.assign(new Error('auth'), { status: 401 });
      }),
    ).toThrow('auth');
    expect(attempts).toBe(1);
  });

  it('surfaces the failure when the stripped retry is rejected too', () => {
    let attempts = 0;
    expect(() =>
      submitWithFallback(RANGE, () => {
        attempts += 1;
        throw Object.assign(new Error(`rejected #${attempts}`), { status: 422 });
      }),
    ).toThrow('rejected #2');
    expect(attempts).toBe(2);
  });
});
