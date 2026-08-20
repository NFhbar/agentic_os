// Tier 1 unit tests for scripts/annotate-diff-lines.mjs — the deterministic
// diff line-numbering + anchor validator that dev-pr-review (write-time) and
// dev-pr-review-publish (publish-time) both consume. These pin the numbering
// math and the validate/snap semantics; a regression here reintroduces exactly
// the off-by-N anchor class this module exists to kill.
//
// Imports the exported pure functions directly (per the frontmatter.test.ts /
// tuning-targets.test.ts precedent — the CLI guard keeps import side-effect-free)
// and shells out for the CLI smoke tests the skills actually invoke.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  annotateDiff,
  buildAnchorIndex,
  findQuoteMatches,
  normalizeQuote,
  parseUnifiedDiff,
  validateAnchors,
} from '../../scripts/annotate-diff-lines.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/annotate-diff-lines.mjs');

// A two-hunk, single-file diff. Hunk 1 has a delete + two adds (so the RIGHT
// numbering diverges from LEFT); hunk 2 lands later in the file with its own
// header offset (the +41 start already encodes the cumulative shift).
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,5 +10,6 @@ function foo() {',
  ' const x = 1;',
  ' const y = 2;',
  '-const z = 3;',
  '+const z = 30;',
  '+const w = 40;',
  ' return x + y;',
  ' }',
  '@@ -40,3 +41,4 @@ function bar() {',
  ' const p = 1;',
  '+const q = 2;',
  ' return p;',
  ' }',
  '',
].join('\n');

// Two-file diff: a pure new file (--- /dev/null) with a no-newline marker, and
// a deleted file (+++ /dev/null). Exercises path keying + that the `\` marker
// does not advance line numbers.
const MULTI_FILE_DIFF = [
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  'index 0000000..abcdef0',
  '--- /dev/null',
  '+++ b/new.ts',
  '@@ -0,0 +1,3 @@',
  '+line one',
  '+line two',
  '+line three',
  '\\ No newline at end of file',
  'diff --git a/old.ts b/old.ts',
  'deleted file mode 100644',
  'index abcdef0..0000000',
  '--- a/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone one',
  '-gone two',
  '',
].join('\n');

// Two isolated single-line adds with a gap between them (RIGHT = {20, 24}),
// so an anchor at 22 is equidistant from both — pins the snap tie rule.
const GAP_DIFF = [
  'diff --git a/g.ts b/g.ts',
  '--- a/g.ts',
  '+++ b/g.ts',
  '@@ -20,0 +20,1 @@',
  '+line twenty',
  '@@ -23,0 +24,1 @@',
  '+line twentyfour',
  '',
].join('\n');

// Fixture for the quote layer. RIGHT lines 10–15 and 33–36 are commentable;
// `const beta = 2;` deliberately appears twice, far apart and at different
// indentation (R11 and R34), so multi-match and whitespace-normalization
// behavior are both exercised on one file.
const QUOTE_DIFF = [
  'diff --git a/src/q.ts b/src/q.ts',
  '--- a/src/q.ts',
  '+++ b/src/q.ts',
  '@@ -10,3 +10,6 @@ function alpha() {',
  ' const alpha = 1;', //   L10 / R10
  '+  const beta = 2;', //       R11
  '+const gamma = 3;', //        R12
  '+const omega = 4;', //        R13
  ' return alpha;', //      L11 / R14
  ' }', //                  L12 / R15
  '@@ -30,3 +33,4 @@ function omega() {',
  ' const delta = 4;', //   L30 / R33
  '+const beta = 2;', //         R34
  ' return delta;', //      L31 / R35
  ' }', //                  L32 / R36
  '',
].join('\n');

describe('annotateDiff', () => {
  it('context lines carry both LEFT and RIGHT numbers; added RIGHT-only; removed LEFT-only', () => {
    const lines = annotateDiff(DIFF).split('\n');
    const ctx = lines.find((l) => l.endsWith('| const x = 1;'));
    expect(ctx).toBeDefined();
    expect(ctx).toContain('L10');
    expect(ctx).toContain('R10');

    const added = lines.find((l) => l.endsWith('|+const z = 30;'));
    expect(added).toBeDefined();
    expect(added).toContain('R12');
    expect(added).not.toMatch(/L\d/); // no old-file number on a pure addition

    const removed = lines.find((l) => l.endsWith('|-const z = 3;'));
    expect(removed).toBeDefined();
    expect(removed).toContain('L12');
    expect(removed).not.toMatch(/R\d/); // no new-file number on a pure deletion

    // File + hunk headers pass through verbatim (strict superset of raw diff).
    expect(lines).toContain('--- a/src/a.ts');
    expect(lines).toContain('+++ b/src/a.ts');
    expect(lines).toContain('@@ -10,5 +10,6 @@ function foo() {');
  });

  it('multi-hunk offsets stay correct after earlier insertions/deletions', () => {
    // `return p;` is the second line of hunk 2 (newStart 41) and sits AFTER the
    // added `const q = 2;`, so it must render R43 — not R42. This is the
    // off-by-N bug class the module exists to prevent.
    const lines = annotateDiff(DIFF).split('\n');
    const returnP = lines.find((l) => l.endsWith('| return p;'));
    expect(returnP).toBeDefined();
    expect(returnP).toContain('L41');
    expect(returnP).toContain('R43');
  });

  it('multi-file diffs keyed by +++ path; new-file and deleted-file hunks; no-newline marker does not shift numbering', () => {
    const parsed = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(parsed.files.map((f) => f.path)).toEqual(['new.ts', 'old.ts']);

    const index = buildAnchorIndex(parsed);
    // New file: three added RIGHT lines, no LEFT lines; the `\ No newline`
    // marker must NOT have advanced the counter to 4.
    expect([...index['new.ts'].RIGHT.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(index['new.ts'].RIGHT.has(4)).toBe(false);
    expect(index['new.ts'].LEFT.size).toBe(0);
    // Deleted file: two removed LEFT lines, no RIGHT lines.
    expect([...index['old.ts'].LEFT.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(index['old.ts'].RIGHT.size).toBe(0);
  });
});

describe('validateAnchors', () => {
  const index = buildAnchorIndex(parseUnifiedDiff(DIFF));
  const one = (a: Record<string, unknown>, opts?: { window?: number }) =>
    validateAnchors([a], index, opts ?? {})[0];

  it('exact in-diff anchor → valid (added and context lines both commentable)', () => {
    expect(one({ id: 'add', file: 'src/a.ts', line: 12 }).verdict).toBe('valid'); // added line
    expect(one({ id: 'ctx', file: 'src/a.ts', line: 14 }).verdict).toBe('valid'); // context line
  });

  it('seeded off-by-2 anchor → snapped within ±3, deterministic tie toward the higher line', () => {
    const gapIndex = buildAnchorIndex(parseUnifiedDiff(GAP_DIFF));
    const v = validateAnchors([{ id: 'c', file: 'g.ts', line: 22 }], gapIndex, {})[0];
    expect(v.verdict).toBe('snapped');
    expect(v.line).toBe(24); // 20 and 24 both at distance 2 → higher wins
    expect(v.snap).toEqual({ from: 22, to: 24, distance: 2 });
  });

  it('anchor beyond ±3 → file-level verdict with reason', () => {
    const v = one({ id: 'far', file: 'src/a.ts', line: 25 });
    expect(v.verdict).toBe('file-level');
    expect(v.reason).toBe('beyond-snap-window');
  });

  it('LEFT-side anchor validates against old-file numbering only', () => {
    // Old line 40 is a context line on the LEFT; on the RIGHT the file starts
    // at 41, so a RIGHT anchor at 40 is NOT valid (it snaps).
    expect(one({ id: 'l', file: 'src/a.ts', line: 40, side: 'LEFT' }).verdict).toBe('valid');
    expect(one({ id: 'r', file: 'src/a.ts', line: 40, side: 'RIGHT' }).verdict).toBe('snapped');
  });

  it('range with both endpoints in one hunk → valid range; start ≥ end rejected', () => {
    const ok = one({ id: 'range', file: 'src/a.ts', line: 14, start_line: 12, side: 'RIGHT' });
    expect(ok.verdict).toBe('valid');
    expect(ok.start_line).toBe(12);
    expect(ok.line).toBe(14);

    const reversed = one({ id: 'rev', file: 'src/a.ts', line: 12, start_line: 14, side: 'RIGHT' });
    expect(reversed.verdict).not.toBe('valid');
  });

  it('half-valid range → degraded-to-endpoint (the valid line)', () => {
    const v = one({ id: 'half', file: 'src/a.ts', line: 14, start_line: 99, side: 'RIGHT' });
    expect(v.verdict).toBe('degraded-to-endpoint');
    expect(v.line).toBe(14);
    expect(v.reason).toBe('half-valid-range');
  });

  it('cross-hunk range → degraded to end line', () => {
    // start 12 lives in hunk 0, end 42 in hunk 1 — both in-diff, different hunks.
    const v = one({ id: 'xhunk', file: 'src/a.ts', line: 42, start_line: 12, side: 'RIGHT' });
    expect(v.verdict).toBe('degraded-to-endpoint');
    expect(v.line).toBe(42);
    expect(v.reason).toBe('cross-hunk-range');
  });

  it('file absent from diff → file-level with file-not-in-diff reason', () => {
    const v = one({ id: 'gone', file: 'not/in/diff.ts', line: 5 });
    expect(v.verdict).toBe('file-level');
    expect(v.reason).toBe('file-not-in-diff');
  });
});

describe('normalizeQuote', () => {
  it('collapses whitespace runs, trims, and folds \\n / \\t escapes into spaces', () => {
    expect(normalizeQuote('  const   beta  =  2;  ')).toBe('const beta = 2;');
    expect(normalizeQuote('const beta = 2;\n  const gamma = 3;')).toBe('const beta = 2; const gamma = 3;');
    expect(normalizeQuote('const beta = 2;\\nconst gamma = 3;')).toBe('const beta = 2; const gamma = 3;');
    expect(normalizeQuote('\tif (x) {\r\n  y();\n}')).toBe('if (x) { y(); }');
  });

  it('drops one wrapping pair of backticks (code text is written as a code span)', () => {
    expect(normalizeQuote('`const beta = 2;`')).toBe('const beta = 2;');
    // Only a WRAPPING pair — an inner span is part of the text.
    expect(normalizeQuote('call(`x`) + 1')).toBe('call(`x`) + 1');
  });

  it('an absent / blank quote normalizes to the empty string', () => {
    expect(normalizeQuote(undefined)).toBe('');
    expect(normalizeQuote(null)).toBe('');
    expect(normalizeQuote('   \n  ')).toBe('');
  });
});

describe('findQuoteMatches', () => {
  const entry = buildAnchorIndex(parseUnifiedDiff(QUOTE_DIFF))['src/q.ts'];

  it('reports every place the quote lives, matching across indentation differences', () => {
    expect(findQuoteMatches(entry, 'RIGHT', 'const beta = 2;')).toEqual([
      { start_line: 11, line: 11 },
      { start_line: 34, line: 34 },
    ]);
  });

  it('a multi-line quote matches across the line boundary and reports the whole span', () => {
    expect(findQuoteMatches(entry, 'RIGHT', 'const beta = 2;\nconst gamma = 3;')).toEqual([
      { start_line: 11, line: 12 },
    ]);
  });

  it('a partial quote matches the line it is part of; sides are searched independently', () => {
    expect(findQuoteMatches(entry, 'RIGHT', 'gamma')).toEqual([{ start_line: 12, line: 12 }]);
    // `const omega = 4;` is an added line — it exists on RIGHT only.
    expect(findQuoteMatches(entry, 'RIGHT', 'const omega = 4;')).toEqual([{ start_line: 13, line: 13 }]);
    expect(findQuoteMatches(entry, 'LEFT', 'const omega = 4;')).toEqual([]);
    // Context lines are on both sides, numbered per side.
    expect(findQuoteMatches(entry, 'LEFT', 'return alpha;')).toEqual([{ start_line: 11, line: 11 }]);
    expect(findQuoteMatches(entry, 'RIGHT', 'return alpha;')).toEqual([{ start_line: 14, line: 14 }]);
  });

  it('a blank line inside the span neither breaks a match nor shifts the line mapping', () => {
    const withBlank = buildAnchorIndex(
      parseUnifiedDiff(
        [
          'diff --git a/b.ts b/b.ts',
          '--- a/b.ts',
          '+++ b/b.ts',
          '@@ -1,0 +1,4 @@',
          '+const first = 1;',
          '+',
          '+const second = 2;',
          '+const third = 3;',
          '',
        ].join('\n'),
      ),
    )['b.ts'];
    expect(findQuoteMatches(withBlank, 'RIGHT', 'const first = 1; const second = 2;')).toEqual([
      { start_line: 1, line: 3 },
    ]);
    expect(findQuoteMatches(withBlank, 'RIGHT', 'const third = 3;')).toEqual([{ start_line: 4, line: 4 }]);
  });

  it('a quote cannot span the gap between hunks', () => {
    // R15 (`}`) and R33 (`const delta = 4;`) are adjacent rows in the diff but
    // 18 lines apart in the file — joining them would invent a span.
    expect(findQuoteMatches(entry, 'RIGHT', '} const delta = 4;')).toEqual([]);
  });
});

describe('validateAnchors — quote layer', () => {
  const index = buildAnchorIndex(parseUnifiedDiff(QUOTE_DIFF));
  const one = (a: Record<string, unknown>, opts?: { window?: number }) =>
    validateAnchors([a], index, opts ?? {})[0];

  it('quote found at the claimed line → valid, confirmed by content', () => {
    const v = one({ id: 'c', file: 'src/q.ts', line: 12, quote: 'const gamma = 3;' });
    expect(v.verdict).toBe('valid');
    expect(v.line).toBe(12);
    expect(v.quote).toEqual({
      status: 'confirmed',
      reason: 'quote-confirmed',
      matches: 1,
      at: { start_line: 12, line: 12 },
    });
  });

  it('confirmation is whitespace-insensitive and tolerates a code-span wrapper', () => {
    for (const quote of ['const beta = 2;', '  const   beta = 2;  ', '`const beta = 2;`']) {
      const v = one({ id: 'w', file: 'src/q.ts', line: 11, quote });
      expect(v.verdict).toBe('valid');
      expect(v.quote.status).toBe('confirmed');
      expect(v.quote.at).toEqual({ start_line: 11, line: 11 });
    }
  });

  it('the claimed line wins over a competing match elsewhere', () => {
    // `const beta = 2;` lives at R11 and R34; anchoring at either confirms
    // that one rather than calling the pair ambiguous.
    expect(one({ id: 'a', file: 'src/q.ts', line: 11, quote: 'const beta = 2;' }).quote.status).toBe('confirmed');
    expect(one({ id: 'b', file: 'src/q.ts', line: 34, quote: 'const beta = 2;' }).quote.status).toBe('confirmed');
  });

  it('quote found elsewhere → snapped to the quote, not to the nearest commentable line', () => {
    // Positional-only: line 17 is off-diff and snaps to R15 (distance 2).
    expect(one({ id: 'p', file: 'src/q.ts', line: 17 })).toMatchObject({
      verdict: 'snapped',
      line: 15,
      snap: { from: 17, to: 15, distance: 2 },
    });
    // With a quote, the anchor goes where the code actually is — 20 lines
    // away, well outside the snap window, because content is the authority.
    const v = one({ id: 'q', file: 'src/q.ts', line: 17, quote: 'return delta;' });
    expect(v.verdict).toBe('snapped');
    expect(v.line).toBe(35);
    expect(v.snap).toEqual({ from: 17, to: 35, distance: 18, by: 'quote' });
    expect(v.quote).toEqual({
      status: 'relocated',
      reason: 'quote-relocated',
      matches: 1,
      at: { start_line: 35, line: 35 },
    });
  });

  it('a wrong-but-commentable anchor is caught — positional valid becomes snapped', () => {
    // This is the whole point of the layer: line 15 IS commentable, so the
    // positional check passes it, but the quoted code lives at 35.
    expect(one({ id: 'v', file: 'src/q.ts', line: 15 }).verdict).toBe('valid');
    const v = one({ id: 'v', file: 'src/q.ts', line: 15, quote: 'return delta;' });
    expect(v.verdict).toBe('snapped');
    expect(v.line).toBe(35);
    expect(v.quote.status).toBe('relocated');
  });

  it('several matches, one near the claimed line → snapped to the near one', () => {
    const v = one({ id: 'n', file: 'src/q.ts', line: 13, quote: 'const beta = 2;' });
    expect(v.verdict).toBe('snapped');
    expect(v.line).toBe(11); // R11 is within ±3 of 13; the R34 twin is not
    expect(v.snap).toEqual({ from: 13, to: 11, distance: 2, by: 'quote' });
    expect(v.quote).toMatchObject({ status: 'relocated', reason: 'quote-relocated-nearest', matches: 2 });
  });

  it('several matches, none near → ambiguous, falls through to the positional verdict', () => {
    const v = one({ id: 'amb', file: 'src/q.ts', line: 15, quote: 'const beta = 2;' });
    expect(v.verdict).toBe('valid'); // exactly what the positional layer said
    expect(v.line).toBe(15);
    expect(v.snap).toBeUndefined();
    expect(v.quote).toEqual({ status: 'ambiguous', reason: 'quote-ambiguous', matches: 2, at: null });
  });

  it('ambiguity does not rescue a bad position — the positional verdict still stands', () => {
    const v = one({ id: 'amb2', file: 'src/q.ts', line: 24, quote: 'const beta = 2;' });
    expect(v.verdict).toBe('file-level');
    expect(v.reason).toBe('beyond-snap-window');
    expect(v.quote.status).toBe('ambiguous');
  });

  it('two matches both inside the window are as undecidable as none', () => {
    // Widening the window pulls BOTH twins into range of line 22.
    const v = one({ id: 'amb3', file: 'src/q.ts', line: 22, quote: 'const beta = 2;' }, { window: 12 });
    expect(v.quote).toMatchObject({ status: 'ambiguous', matches: 2 });
  });

  it('quote nowhere in the file → file-level, never a guessed anchor', () => {
    const v = one({ id: 'nf', file: 'src/q.ts', line: 12, quote: 'const nowhere = 9;' });
    expect(v.verdict).toBe('file-level');
    expect(v.reason).toBe('quote-not-found');
    expect(v.line).toBe(12); // the claimed line is preserved for the report
    expect(v.start_line).toBeNull();
    expect(v.quote).toEqual({ status: 'not-found', reason: 'quote-not-found', matches: 0, at: null });
  });

  it('a quote on the wrong side degrades rather than jumping sides', () => {
    // `const omega = 4;` is an added line: it exists on RIGHT, not on LEFT.
    const v = one({ id: 'side', file: 'src/q.ts', line: 11, side: 'LEFT', quote: 'const omega = 4;' });
    expect(v.verdict).toBe('file-level');
    expect(v.reason).toBe('quote-not-found');
  });

  it('range anchor confirmed by a multi-line quote → valid range', () => {
    const v = one({
      id: 'r',
      file: 'src/q.ts',
      line: 12,
      start_line: 11,
      quote: 'const beta = 2;\nconst gamma = 3;',
    });
    expect(v.verdict).toBe('valid');
    expect(v.start_line).toBe(11);
    expect(v.line).toBe(12);
    expect(v.quote).toMatchObject({ status: 'confirmed', at: { start_line: 11, line: 12 } });
  });

  it('range anchor relocated by its quote keeps the span the quote occupies', () => {
    // Neither endpoint is in the diff — positionally this is file-level.
    expect(one({ id: 'r0', file: 'src/q.ts', line: 21, start_line: 20 })).toMatchObject({
      verdict: 'file-level',
      reason: 'beyond-snap-window',
    });
    const v = one({
      id: 'r1',
      file: 'src/q.ts',
      line: 21,
      start_line: 20,
      quote: 'const beta = 2; const gamma = 3;',
    });
    expect(v.verdict).toBe('snapped');
    expect(v.start_line).toBe(11);
    expect(v.start_side).toBe('RIGHT');
    expect(v.line).toBe(12);
    expect(v.snap).toEqual({ from: 21, to: 12, distance: 9, by: 'quote' });
  });

  it('a single-line quote collapses a relocated range to one line', () => {
    const v = one({ id: 'r2', file: 'src/q.ts', line: 21, start_line: 20, quote: 'const omega = 4;' });
    expect(v.verdict).toBe('snapped');
    expect(v.start_line).toBeNull();
    expect(v.line).toBe(13);
  });

  it('a quote never invents an anchor for a file-level comment or an off-diff file', () => {
    const noLine = one({ id: 'nl', file: 'src/q.ts', line: null, quote: 'const gamma = 3;' });
    expect(noLine.verdict).toBe('file-level');
    expect(noLine.reason).toBe('line-null');
    expect(noLine.quote).toBeUndefined();

    const noFile = one({ id: 'nfl', file: 'other/z.ts', line: 3, quote: 'const gamma = 3;' });
    expect(noFile.verdict).toBe('file-level');
    expect(noFile.reason).toBe('file-not-in-diff');
    expect(noFile.quote).toBeUndefined();
  });
});

describe('validateAnchors — positional behavior is untouched without a quote', () => {
  const index = buildAnchorIndex(parseUnifiedDiff(DIFF));

  // The full positional verdict vocabulary, frozen. Any drift here is a
  // back-compat break for every comment authored without a quote.
  const ANCHORS = [
    { id: 'exact', file: 'src/a.ts', line: 12 },
    { id: 'snap', file: 'src/a.ts', line: 17 },
    { id: 'far', file: 'src/a.ts', line: 25 },
    { id: 'left', file: 'src/a.ts', line: 40, side: 'LEFT' },
    { id: 'range', file: 'src/a.ts', line: 14, start_line: 12 },
    { id: 'half', file: 'src/a.ts', line: 14, start_line: 99 },
    { id: 'xhunk', file: 'src/a.ts', line: 42, start_line: 12 },
    { id: 'gone', file: 'not/in/diff.ts', line: 5 },
    { id: 'nofile', file: null, line: 5 },
    { id: 'noline', file: 'src/a.ts', line: null },
  ];

  const EXPECTED = [
    { id: 'exact', file: 'src/a.ts', side: 'RIGHT', start_side: null, start_line: null, line: 12, verdict: 'valid' },
    {
      id: 'snap',
      file: 'src/a.ts',
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: 15,
      verdict: 'snapped',
      snap: { from: 17, to: 15, distance: 2 },
    },
    {
      id: 'far',
      file: 'src/a.ts',
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: 25,
      verdict: 'file-level',
      reason: 'beyond-snap-window',
    },
    { id: 'left', file: 'src/a.ts', side: 'LEFT', start_side: null, start_line: null, line: 40, verdict: 'valid' },
    { id: 'range', file: 'src/a.ts', side: 'RIGHT', start_side: 'RIGHT', start_line: 12, line: 14, verdict: 'valid' },
    {
      id: 'half',
      file: 'src/a.ts',
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: 14,
      verdict: 'degraded-to-endpoint',
      degraded_from: { start_line: 99, start_side: 'RIGHT', line: 14 },
      reason: 'half-valid-range',
    },
    {
      id: 'xhunk',
      file: 'src/a.ts',
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: 42,
      verdict: 'degraded-to-endpoint',
      degraded_from: { start_line: 12, start_side: 'RIGHT', line: 42 },
      reason: 'cross-hunk-range',
    },
    {
      id: 'gone',
      file: 'not/in/diff.ts',
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: 5,
      verdict: 'file-level',
      reason: 'file-not-in-diff',
    },
    {
      id: 'nofile',
      file: null,
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: null,
      verdict: 'file-level',
      reason: 'no-file',
    },
    {
      id: 'noline',
      file: 'src/a.ts',
      side: 'RIGHT',
      start_side: null,
      start_line: null,
      line: null,
      verdict: 'file-level',
      reason: 'line-null',
    },
  ];

  it('every verdict shape is byte-identical to the pre-quote validator', () => {
    expect(JSON.stringify(validateAnchors(ANCHORS, index, {}))).toBe(JSON.stringify(EXPECTED));
  });

  it('no quote-layer field is attached when no quote was supplied', () => {
    for (const v of validateAnchors(ANCHORS, index, {})) {
      expect(Object.prototype.hasOwnProperty.call(v, 'quote')).toBe(false);
    }
  });

  it('a null / blank quote is treated as no quote at all, at every window width', () => {
    const nulled = ANCHORS.map((a) => ({ ...a, quote: null }));
    const blank = ANCHORS.map((a) => ({ ...a, quote: '  \n ' }));
    for (const window of [0, 1, 3, 10]) {
      const baseline = JSON.stringify(validateAnchors(ANCHORS, index, { window }));
      expect(JSON.stringify(validateAnchors(nulled, index, { window }))).toBe(baseline);
      expect(JSON.stringify(validateAnchors(blank, index, { window }))).toBe(baseline);
    }
  });
});

describe('CLI', () => {
  it('annotate mode: stdin diff → annotated stdout', () => {
    const out = execFileSync('node', [SCRIPT], { input: DIFF, encoding: 'utf8' });
    expect(out).toContain('R43'); // the multi-hunk offset survives the round-trip
    expect(out).toContain('|+const z = 30;');
  });

  it('validate mode: --anchors JSON round-trip → verdict JSON', () => {
    const out = execFileSync(
      'node',
      [SCRIPT, '--validate', '--anchors', '[{"id":"c1","file":"src/a.ts","line":25}]'],
      { input: DIFF, encoding: 'utf8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.window).toBe(3);
    expect(parsed.verdicts).toHaveLength(1);
    expect(parsed.verdicts[0].verdict).toBe('file-level');
    expect(parsed.verdicts[0].reason).toBe('beyond-snap-window');
  });

  it('validate mode: the optional quote field travels through the CLI', () => {
    const anchors = JSON.stringify([
      { id: 'confirmed', file: 'src/q.ts', line: 12, quote: 'const gamma = 3;' },
      { id: 'moved', file: 'src/q.ts', line: 15, quote: 'return delta;' },
      { id: 'missing', file: 'src/q.ts', line: 12, quote: 'const nowhere = 9;' },
    ]);
    const out = execFileSync('node', [SCRIPT, '--validate', '--anchors', anchors], {
      input: QUOTE_DIFF,
      encoding: 'utf8',
    });
    const { verdicts } = JSON.parse(out);
    expect(verdicts.map((v: { verdict: string }) => v.verdict)).toEqual(['valid', 'snapped', 'file-level']);
    expect(verdicts[0].quote.status).toBe('confirmed');
    expect(verdicts[1].line).toBe(35);
    expect(verdicts[2].reason).toBe('quote-not-found');
  });
});
