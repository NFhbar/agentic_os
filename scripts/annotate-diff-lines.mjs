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
// Two CLI modes:
//   A (default): unified diff on stdin → annotated diff on stdout.
//       gh pr diff <url> | node scripts/annotate-diff-lines.mjs
//   B (--validate): diff on stdin + candidate anchors → per-anchor verdict JSON.
//       gh pr diff <url> | node scripts/annotate-diff-lines.mjs --validate \
//         --anchors '[{"id":"c1","file":"src/a.ts","line":42}]' [--window 3]
//       (or --anchors-file <path> instead of --anchors)
//
// Exported pure functions (imported by tests + skills that inline the logic):
//   parseUnifiedDiff(text)          → { files: [...] } structured form
//   annotateDiff(text)              → annotated diff text (superset of raw)
//   buildAnchorIndex(parsed)        → { <path>: { RIGHT: Map, LEFT: Map } }
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

export function buildAnchorIndex(parsed) {
  const index = {};
  for (const file of parsed.files) {
    const entry = index[file.path] ?? (index[file.path] = { RIGHT: new Map(), LEFT: new Map() });
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.newLine != null && (row.marker === '+' || row.marker === ' ')) {
          entry.RIGHT.set(row.newLine, hunk.id);
        }
        if (row.oldLine != null && (row.marker === '-' || row.marker === ' ')) {
          entry.LEFT.set(row.oldLine, hunk.id);
        }
      }
    }
  }
  return index;
}

// --------------------------------------------------------------------------
// Validation — classify each candidate anchor against the diff.
//
// Verdicts:
//   valid                → anchor (single line or range) is directly postable
//   snapped              → single line was off; moved to nearest in-diff line
//                          within ±window (tie → the higher line number)
//   degraded-to-endpoint → a range with only one valid endpoint (or endpoints
//                          in different hunks / reversed) collapses to a single
//                          valid line
//   file-level           → line beyond the snap window, or the file/line isn't
//                          in the diff at all (distinguished by `reason`)

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

function validateOne(a, index, window) {
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
      console.error('--anchors must be a JSON array of {id, file, line, start_line?, side?, start_side?}');
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
