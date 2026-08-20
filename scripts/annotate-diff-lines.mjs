#!/usr/bin/env node
// annotate-diff-lines — deterministic diff line-numbering + anchor validation.
//
// Pure local: no network, no API calls. One module = one source of truth for
// hunk math, consumed by dev-pr-review (write-time anchor validation) and
// dev-pr-review-publish (publish-time re-validation against the live diff).
//
// The problem it kills: reviewers computing new-file line numbers from `@@`
// hunk-header arithmetic produce off-by-N anchors. This script prints every
// diff row with its explicit LEFT (old) and RIGHT (new) line numbers so the
// model READS anchors off the columns instead of computing them, and validates
// candidate anchors against the diff so a mis-read is caught before it ships.
//
// Validation is positional AND content-aware: an anchor may carry a `quote`
// (the exact code text the comment is about), and the validator confirms that
// text really lives at the claimed lines — or finds where it does live and
// moves the anchor there. Position alone cannot tell a right anchor from a
// wrong-but-commentable one; the quote can.
//
// Two CLI modes:
//   A (default): unified diff on stdin → annotated diff on stdout.
//       gh pr diff <url> | node scripts/annotate-diff-lines.mjs
//   B (--validate): diff on stdin + candidate anchors → per-anchor verdict JSON.
//       gh pr diff <url> | node scripts/annotate-diff-lines.mjs --validate \
//         --anchors '[{"id":"c1","file":"src/a.ts","line":42}]' [--window 3]
//       (or --anchors-file <path> instead of --anchors)
//       Anchor objects: {id, file, line, start_line?, side?, start_side?, quote?}
//
// Exported pure functions (imported by tests + skills that inline the logic):
//   parseUnifiedDiff(text)          → { files: [...] } structured form
//   annotateDiff(text)              → annotated diff text (superset of raw)
//   buildAnchorIndex(parsed)        → { <path>: { RIGHT: Map, LEFT: Map, content } }
//   normalizeQuote(text)            → the comparison form of a quote / diff line
//   findQuoteMatches(entry, side, q) → [{start_line, line}, ...] where q lives
//   validateAnchors(anchors, index, {window}) → [verdict, ...]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Column width for the L<n> / R<n> gutters in the annotated form. Wide enough
// for six-digit line numbers while staying compact.
const COL_W = 7;

// --------------------------------------------------------------------------
// Parsing — unified diff → structured files/hunks/rows with explicit numbers.

// Resolve a file path from a `--- ` / `+++ ` header value. Handles the a/ b/
// prefixes, /dev/null (add/delete), and a trailing tab-delimited timestamp.
function parseFilePath(raw) {
  let s = raw;
  const tabIdx = s.indexOf('\t');
  if (tabIdx >= 0) s = s.slice(0, tabIdx);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

export function parseUnifiedDiff(text) {
  const lines = String(text).split('\n');
  const files = [];
  let cur = null; // current file
  let hunk = null; // current hunk within cur
  let oldNum = 0;
  let newNum = 0;
  let hunkId = 0;

  const startFile = (firstLine) => {
    cur = { oldPath: null, newPath: null, path: '', headerLines: firstLine ? [firstLine] : [], hunks: [] };
    hunkId = 0;
  };
  const flushHunk = () => {
    if (hunk && cur) cur.hunks.push(hunk);
    hunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      flushFile();
      startFile(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!cur) startFile(null);
      flushHunk();
      cur.headerLines.push(line);
      cur.oldPath = parseFilePath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!cur) startFile(null);
      cur.headerLines.push(line);
      cur.newPath = parseFilePath(line.slice(4));
      cur.path = cur.newPath ?? cur.oldPath ?? '';
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) startFile(null);
      flushHunk();
      const m = line.match(/^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      const oldStart = m ? Number(m[1]) : 0;
      const oldCount = m && m[2] !== undefined ? Number(m[2]) : 1;
      const newStart = m ? Number(m[3]) : 0;
      const newCount = m && m[4] !== undefined ? Number(m[4]) : 1;
      hunk = { id: hunkId++, header: line, oldStart, oldCount, newStart, newCount, rows: [] };
      oldNum = oldStart;
      newNum = newStart;
      continue;
    }

    if (hunk) {
      const c = line[0];
      if (c === '\\') {
        // "\ No newline at end of file" — annotation-only, no line numbers.
        hunk.rows.push({ marker: '\\', oldLine: null, newLine: null, content: line.slice(1) });
        continue;
      }
      if (c === '+') {
        hunk.rows.push({ marker: '+', oldLine: null, newLine: newNum, content: line.slice(1) });
        newNum++;
        continue;
      }
      if (c === '-') {
        hunk.rows.push({ marker: '-', oldLine: oldNum, newLine: null, content: line.slice(1) });
        oldNum++;
        continue;
      }
      if (c === ' ') {
        hunk.rows.push({ marker: ' ', oldLine: oldNum, newLine: newNum, content: line.slice(1) });
        oldNum++;
        newNum++;
        continue;
      }
      // Unknown line inside a hunk (blank separator / trailing newline) ends it.
      flushHunk();
      if (line === '') continue;
      i--; // reprocess as a potential next-file header
      continue;
    }

    // Non-hunk line outside any recognized header: index/mode/rename lines that
    // belong to the current file's header block. Drop blanks + pre-diff noise.
    if (cur && line !== '') cur.headerLines.push(line);
  }
  flushFile();
  return { files };
}

// --------------------------------------------------------------------------
// Annotation — render the parsed diff with explicit L/R gutters. Strict
// superset of the raw diff: file + hunk headers pass through verbatim, only
// body rows gain the L<old> R<new> prefix.

export function annotateDiff(text) {
  const parsed = parseUnifiedDiff(text);
  const out = [];
  for (const file of parsed.files) {
    for (const h of file.headerLines) out.push(h);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const row of hunk.rows) {
        if (row.marker === '\\') {
          out.push('\\' + row.content);
          continue;
        }
        const oldCol = (row.oldLine == null ? '' : `L${row.oldLine}`).padEnd(COL_W);
        const newCol = (row.newLine == null ? '' : `R${row.newLine}`).padEnd(COL_W);
        out.push(`${oldCol} ${newCol} |${row.marker}${row.content}`);
      }
    }
  }
  return out.join('\n');
}

// --------------------------------------------------------------------------
// Anchor index — per file+side, the set of commentable line numbers tagged
// with the hunk they live in (needed for the same-hunk range rule). GitHub
// accepts a comment anchor only on a line present in the diff:
//   RIGHT = added ∪ context lines, numbered on the new file
//   LEFT  = removed ∪ context lines, numbered on the old file
// Context lines are commentable on both sides.
//
// `content` carries the raw text of each commentable line on each side — the
// substrate the quote layer searches. It is a sidecar on the same entry, so
// the RIGHT/LEFT maps keep their line→hunk-id shape.

export function buildAnchorIndex(parsed) {
  const index = {};
  for (const file of parsed.files) {
    const entry =
      index[file.path] ??
      (index[file.path] = {
        RIGHT: new Map(),
        LEFT: new Map(),
        content: { RIGHT: new Map(), LEFT: new Map() },
      });
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.newLine != null && (row.marker === '+' || row.marker === ' ')) {
          entry.RIGHT.set(row.newLine, hunk.id);
          entry.content.RIGHT.set(row.newLine, row.content);
        }
        if (row.oldLine != null && (row.marker === '-' || row.marker === ' ')) {
          entry.LEFT.set(row.oldLine, hunk.id);
          entry.content.LEFT.set(row.oldLine, row.content);
        }
      }
    }
  }
  return index;
}

// --------------------------------------------------------------------------
// Quote matching — the content half of validation.
//
// NORMALIZATION (applied identically to the quote and to every diff line it is
// compared against, so the two sides always meet on the same terms):
//   1. the two-character escape sequences \n, \r and \t become a space — a
//      multi-line quote survives being carried on one line of a header list;
//   2. every whitespace run (real newlines and tabs included) collapses to a
//      single space;
//   3. the result is trimmed, one wrapping pair of backticks is dropped (code
//      text is habitually written as a markdown code span), and it is trimmed
//      again.
// So indentation, line wrapping, and internal spacing never decide a match;
// the sequence of non-whitespace tokens does.
//
// MATCHING: a run of consecutive commentable lines is joined with single
// spaces into one searchable string. The quote matches wherever it appears as
// a substring of such a run — which makes a partial quote (one expression off
// a longer line) match, and lets a quote span line boundaries. Each match maps
// back to the first and last line its characters touch.

export function normalizeQuote(text) {
  let s = String(text ?? '')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1).trim();
  return s;
}

// Maximal runs of consecutive line numbers on one side, each row carrying its
// normalized text. Consecutive numbering is what makes a joined run a faithful
// picture of the file: on RIGHT, an interleaved `-` row takes no new-file
// number, so the rows around it really are adjacent in the new file. A gap
// (between hunks) starts a new run — a quote can never span one.
function commentableRuns(entry, side) {
  const lineMap = side === 'LEFT' ? entry.LEFT : entry.RIGHT;
  const textMap = entry.content ? (side === 'LEFT' ? entry.content.LEFT : entry.content.RIGHT) : null;
  if (!lineMap || !textMap) return null;
  const runs = [];
  let cur = null;
  for (const line of [...lineMap.keys()].sort((a, b) => a - b)) {
    if (!cur || line !== cur[cur.length - 1].line + 1) {
      cur = [];
      runs.push(cur);
    }
    cur.push({ line, norm: normalizeQuote(textMap.get(line) ?? '') });
  }
  return runs;
}

// Every place the quote lives on this file+side, as {start_line, line} spans.
// Returns null — "no answer" rather than "no matches" — when there is nothing
// to search for (an empty quote) or nothing to search in (an index built
// without content); the caller degrades instead of guessing.
export function findQuoteMatches(entry, side, quote) {
  const q = normalizeQuote(quote);
  if (!q) return null;
  const runs = commentableRuns(entry, side);
  if (!runs) return null;

  const out = [];
  for (const run of runs) {
    // Build the run's searchable text, remembering where each line's text
    // ends in it. A line that normalizes to nothing (a blank line) contributes
    // no characters and no separator, so a quote reads straight across it.
    let doc = '';
    const ends = [];
    for (const row of run) {
      if (row.norm !== '') {
        if (doc !== '') doc += ' ';
        doc += row.norm;
      }
      ends.push({ line: row.line, to: doc.length });
    }
    // The line owning a character offset: the first line whose text reaches
    // past it. A blank line's text reaches nowhere, so it never owns one.
    const lineAt = (off) => {
      for (const e of ends) if (e.to > off) return e.line;
      return ends.length ? ends[ends.length - 1].line : null;
    };
    for (let i = doc.indexOf(q); i >= 0; i = doc.indexOf(q, i + 1)) {
      const startLine = lineAt(i);
      const endLine = lineAt(i + q.length - 1);
      if (startLine != null && endLine != null) out.push({ start_line: startLine, line: endLine });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Validation — classify each candidate anchor against the diff.
//
// Verdicts:
//   valid                → anchor (single line or range) is directly postable
//   snapped              → single line was off; moved to nearest in-diff line
//                          within ±window (tie → the higher line number), or
//                          moved to where the anchor's quote actually lives
//   degraded-to-endpoint → a range with only one valid endpoint (or endpoints
//                          in different hunks / reversed) collapses to a single
//                          valid line
//   file-level           → line beyond the snap window, the anchor's quote is
//                          nowhere in the file, or the file/line isn't in the
//                          diff at all (distinguished by `reason`)
//
// Two layers, in order. The positional layer below is the whole story for an
// anchor with no quote — byte-for-byte the verdict it has always produced. An
// anchor that carries a quote then goes through the quote layer, which can
// override the positional result, because a line number can be commentable and
// still be the wrong line.

function sideSet(index, file, side) {
  const e = index[file];
  if (!e) return null;
  return side === 'LEFT' ? e.LEFT : e.RIGHT;
}

// Nearest present line within ±window. Checks the higher candidate first so a
// distance tie resolves toward the higher line number (deterministic).
function snapToNearest(set, line, window) {
  for (let d = 1; d <= window; d++) {
    if (set.has(line + d)) return { to: line + d, distance: d };
    if (set.has(line - d)) return { to: line - d, distance: d };
  }
  return null;
}

function validatePositional(a, index, window) {
  const side = a.side === 'LEFT' ? 'LEFT' : 'RIGHT';
  const base = { id: a.id ?? null, file: a.file ?? null, side, start_side: null, start_line: null, line: null };

  if (a.file == null) return { ...base, verdict: 'file-level', reason: 'no-file' };

  const set = sideSet(index, a.file, side);
  if (!set) return { ...base, verdict: 'file-level', reason: 'file-not-in-diff', line: a.line ?? null };
  if (a.line == null) return { ...base, verdict: 'file-level', reason: 'line-null' };

  const hasRange = a.start_line != null && a.start_line !== a.line;
  if (hasRange) {
    const startSide = a.start_side === 'LEFT' ? 'LEFT' : a.start_side === 'RIGHT' ? 'RIGHT' : side;
    const startSet = sideSet(index, a.file, startSide);
    const startIn = !!(startSet && startSet.has(a.start_line));
    const endIn = set.has(a.line);
    const sameSide = startSide === side;
    const sameHunk = startIn && endIn && sameSide && startSet.get(a.start_line) === set.get(a.line);
    const ordered = a.start_line < a.line;

    if (sameSide && startIn && endIn && sameHunk && ordered) {
      return { ...base, verdict: 'valid', start_side: startSide, start_line: a.start_line, line: a.line };
    }

    // Range can't post as-is: pick the reason + degrade to a valid endpoint.
    let reason;
    if (!sameSide) reason = 'cross-side-range';
    else if (startIn && endIn && !sameHunk) reason = 'cross-hunk-range';
    else if (startIn && endIn && !ordered) reason = 'reversed-range';
    else reason = 'half-valid-range';

    const degradedFrom = { start_line: a.start_line, start_side: startSide, line: a.line };
    if (endIn) return { ...base, verdict: 'degraded-to-endpoint', line: a.line, degraded_from: degradedFrom, reason };
    if (startIn && sameSide)
      return { ...base, verdict: 'degraded-to-endpoint', line: a.start_line, degraded_from: degradedFrom, reason };
    // Neither endpoint in-diff → fall through and snap the end line.
  }

  if (set.has(a.line)) return { ...base, verdict: 'valid', line: a.line };

  const snapped = snapToNearest(set, a.line, window);
  if (snapped) {
    return {
      ...base,
      verdict: 'snapped',
      line: snapped.to,
      snap: { from: a.line, to: snapped.to, distance: snapped.distance },
    };
  }
  return { ...base, verdict: 'file-level', reason: 'beyond-snap-window', line: a.line };
}

// Positional outcomes the quote layer has nothing to say about: there is no
// file to search, or the comment declared itself file-level by carrying no
// line at all. A quote must never turn one of those into an anchor.
const QUOTE_INAPPLICABLE = new Set(['no-file', 'file-not-in-diff', 'line-null']);

// Distance from the claimed anchor line to a match span: zero inside it.
function distanceToSpan(line, span) {
  if (line >= span.start_line && line <= span.line) return 0;
  return line < span.start_line ? span.start_line - line : line - span.line;
}

// The content layer. It answers one question — is the quoted code where the
// comment says it is — and one of four things follows:
//   confirmed   the quote is at the claimed lines → the positional verdict
//               stands, now backed by content rather than position alone;
//   relocated   the quote is somewhere else, unambiguously → snapped to where
//               it actually lives, which supersedes nearest-line snapping and
//               is not bounded by the window (content is the authority);
//   ambiguous   the quote appears in several places and none of them is the
//               claimed anchor or near it → content cannot decide, so the
//               positional verdict stands with the ambiguity recorded;
//   not-found   the quote is nowhere in the file's commentable lines → the
//               anchor is wrong and no repair is available, so it degrades to
//               file-level rather than publishing onto an innocent line.
function applyQuoteLayer(a, positional, index, window) {
  const side = positional.side;
  const entry = index[a.file];
  const withQuote = (verdict, quote) => ({ ...verdict, quote });

  const matches = entry ? findQuoteMatches(entry, side, a.quote) : null;
  if (matches == null) {
    return withQuote(positional, {
      status: 'unusable',
      reason: 'quote-content-unavailable',
      matches: 0,
      at: null,
    });
  }

  // The lines the comment claims, as a span. A range start on the other side
  // is numbered against a different file and cannot bound this span.
  const rangeApplies = a.start_line != null && (a.start_side ?? side) === side;
  const claimed = {
    start_line: rangeApplies ? Math.min(a.start_line, a.line) : a.line,
    line: rangeApplies ? Math.max(a.start_line, a.line) : a.line,
  };

  const covering = matches.find((m) => m.start_line <= claimed.line && claimed.start_line <= m.line);
  if (covering) {
    return withQuote(positional, {
      status: 'confirmed',
      reason: 'quote-confirmed',
      matches: matches.length,
      at: covering,
    });
  }

  const base = {
    id: positional.id,
    file: positional.file,
    side,
    start_side: null,
    start_line: null,
    line: null,
  };

  if (matches.length === 0) {
    const quote = { status: 'not-found', reason: 'quote-not-found', matches: 0, at: null };
    return withQuote(
      { ...base, verdict: 'file-level', reason: 'quote-not-found', line: a.line ?? null },
      quote,
    );
  }

  // More than one place to go: prefer a match near the claimed line, and only
  // when exactly one is near — two candidates in the neighbourhood are as
  // undecidable as none.
  let target = matches.length === 1 ? matches[0] : null;
  let reason = 'quote-relocated';
  if (!target) {
    const near = matches.filter((m) => distanceToSpan(a.line, m) <= window);
    if (near.length !== 1) {
      return withQuote(positional, {
        status: 'ambiguous',
        reason: 'quote-ambiguous',
        matches: matches.length,
        at: null,
      });
    }
    target = near[0];
    reason = 'quote-relocated-nearest';
  }

  // A multi-line match keeps its span when the span is postable as a range
  // (same side, same hunk, ordered); otherwise the anchor lands on the line
  // the quote starts at.
  const set = sideSet(index, a.file, side);
  const asRange =
    target.line > target.start_line &&
    set.has(target.start_line) &&
    set.has(target.line) &&
    set.get(target.start_line) === set.get(target.line);
  const line = asRange ? target.line : target.start_line;

  return withQuote(
    {
      ...base,
      verdict: 'snapped',
      start_side: asRange ? side : null,
      start_line: asRange ? target.start_line : null,
      line,
      snap: { from: a.line, to: line, distance: Math.abs(line - a.line), by: 'quote' },
    },
    { status: 'relocated', reason, matches: matches.length, at: target },
  );
}

function validateOne(a, index, window) {
  const positional = validatePositional(a, index, window);
  // No quote (or nothing left of it once normalized) → positional is the
  // whole verdict, down to the absence of a `quote` block on it.
  if (normalizeQuote(a.quote) === '') return positional;
  if (QUOTE_INAPPLICABLE.has(positional.reason)) return positional;
  return applyQuoteLayer(a, positional, index, window);
}

export function validateAnchors(anchors, index, opts = {}) {
  const window = opts.window ?? 3;
  return (anchors ?? []).map((a) => validateOne(a, index, window));
}

// --------------------------------------------------------------------------
// CLI

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const windowArg = getArg('--window');
  const window = windowArg != null ? Number(windowArg) : 3;
  if (!Number.isInteger(window) || window < 0) {
    console.error('--window must be a non-negative integer');
    process.exit(2);
  }

  if (args.includes('--validate')) {
    let anchorsJson = getArg('--anchors');
    const anchorsFile = getArg('--anchors-file');
    if (!anchorsJson && anchorsFile) {
      try {
        anchorsJson = readFileSync(resolve(anchorsFile), 'utf8');
      } catch {
        console.error(`--anchors-file not readable: ${anchorsFile}`);
        process.exit(2);
      }
    }
    if (!anchorsJson) {
      console.error('--validate requires --anchors <json> or --anchors-file <path>');
      process.exit(2);
    }
    let anchors;
    try {
      anchors = JSON.parse(anchorsJson);
    } catch {
      console.error('--anchors is not valid JSON');
      process.exit(2);
    }
    if (!Array.isArray(anchors)) {
      console.error(
        '--anchors must be a JSON array of {id, file, line, start_line?, side?, start_side?, quote?}',
      );
      process.exit(2);
    }
    const parsed = parseUnifiedDiff(readStdin());
    const index = buildAnchorIndex(parsed);
    const verdicts = validateAnchors(anchors, index, { window });
    process.stdout.write(`${JSON.stringify({ window, verdicts }, null, 2)}\n`);
  } else {
    const diff = readStdin();
    if (!diff.trim()) {
      console.error('no diff on stdin — pipe `gh pr diff <url>` into this script');
      process.exit(2);
    }
    process.stdout.write(`${annotateDiff(diff)}\n`);
  }
}
