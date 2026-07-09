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
});
