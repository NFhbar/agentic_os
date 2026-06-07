#!/usr/bin/env node
// extract-rationale-comments — surface tagged inline-comment rationale from a
// list of files. The kind of comments developers write to capture *why* code
// is shaped weirdly: WHY:, HACK:, NOTE:, FIXME:, TODO:, etc.
//
// Designed to feed into dev-write-change PLAN as a focused "existing rationale"
// block — the model already reads the files but rationale comments are easy
// to skim past in 1000-line files. Surfacing them as structured signal makes
// the planner attend to documented constraints + hidden invariants.
//
// Companion to extract-imports.mjs (idea #1 from the graphify analysis):
//   - imports        → blast-radius awareness (who calls this?)
//   - rationale      → institutional memory (why does this look weird?)
//
// Usage:
//   node scripts/extract-rationale-comments.mjs --repo <abs-path>
//                                               --files <comma-list>
//                                               [--out <sidecar-path>]
//
// When --out is omitted, JSON goes to stdout. --files is REQUIRED — the
// script is scoped to a small set of files (typically the change's
// touched-file list). Whole-repo extraction is out of scope; if you ever
// need it, lift the per-file loop into a walk.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const repoArg = getArg('--repo');
const filesArg = getArg('--files');
if (!repoArg || !filesArg) {
  console.error('--repo <path> AND --files <comma-list> are required');
  process.exit(2);
}
const repoPath = resolve(repoArg);
if (!existsSync(repoPath)) {
  console.error(`repo path not found: ${repoPath}`);
  process.exit(2);
}
const outArg = getArg('--out');
const filesList = filesArg
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// --------------------------------------------------------------------------
// Tag vocabulary — single source of truth.
//
// The selection: developers explicitly write these when they want the reader
// to pay attention. Section-header comments like `// Phase 4 — Tuning
// suggestions` don't match — they're navigation, not rationale.
//
// To extend: add a tag here. Order doesn't matter; the regex is built from
// this set. Avoid tags that match common English words (e.g. don't add
// "BUG" alone — it'd match `// BUG report from #123` in unrelated prose).

const TAGS = [
  'WHY',
  'HACK',
  'NOTE',
  'FIXME',
  'TODO',
  'XXX',
  'CAVEAT',
  'IMPORTANT',
  'WARNING',
  'GOTCHA',
];

// Match a tagged comment line. Two prefix styles:
//   - // TAG: body          (C/C++/Go/Rust/Java/TS/JS/etc.)
//   - # TAG: body           (Python/Bash/Ruby/YAML/etc.)
// The TAG must be followed by `:` to filter out incidental uses
// (e.g. `// TODO list` is not a tagged comment, `// TODO: ...` is).
//
// We allow optional whitespace and additional `/` or `*` chars before
// the tag (`///`, `/**`, `/*`, etc.) so block-comment styles match too.
//
// Captures: (1) prefix-style (`//` or `#`), (2) tag, (3) body text.

const TAG_GROUP = TAGS.join('|');
const LINE_RE = new RegExp(
  String.raw`^\s*(?:\/\/+|\/\*+|\*+|#+)\s*(${TAG_GROUP})\s*:\s*(.*?)\s*(?:\*\/)?\s*$`,
);

// Context capture: include the comment line itself + the next N non-blank
// non-comment lines as a "what does this comment refer to" snippet. Keeps
// the prompt-rendered output self-contained without forcing the reader to
// re-fetch the file.

const CONTEXT_LINES = 3;
const CONTEXT_MAX_LEN = 100; // truncate any single context line at this width

// Detect any comment-like line (single-line `//`, `#`, or block-comment
// continuations starting with `*`). Used to walk PAST a multi-line tagged
// comment's continuation lines so context lands on the actual code subject
// the comment refers to, not on more comment prose.
const COMMENT_LIKE_RE = /^\s*(?:\/\/+|\/\*+|\*+|#+|<!--)/;

function captureContext(lines, fromIdx) {
  const ctx = [];
  let i = fromIdx + 1;
  // Phase 1: skip blank lines + comment continuation lines (including the
  // tagged comment's own multi-line continuation, e.g.
  //   // CAVEAT: long explanation that wraps
  //   //          to a second line
  //   func subject() { ... }   ← this is the actual context
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      i++;
      continue;
    }
    if (COMMENT_LIKE_RE.test(raw)) {
      // If it's a NEW tagged comment, stop — that's a separate finding's
      // subject, not ours.
      if (LINE_RE.test(raw)) break;
      i++;
      continue;
    }
    // First real code line found — start capturing.
    break;
  }
  // Phase 2: capture up to CONTEXT_LINES non-blank code lines.
  while (i < lines.length && ctx.length < CONTEXT_LINES) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      i++;
      continue;
    }
    if (COMMENT_LIKE_RE.test(raw)) break; // hit a new comment block — stop
    ctx.push(trimmed.length > CONTEXT_MAX_LEN ? `${trimmed.slice(0, CONTEXT_MAX_LEN)}…` : trimmed);
    i++;
  }
  return ctx;
}

// --------------------------------------------------------------------------
// Per-file extraction

async function extractFromFile(absPath, relPath) {
  let content;
  try {
    content = await readFile(absPath, 'utf8');
  } catch {
    return null; // missing file → skip silently
  }
  const lines = content.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const tag = m[1];
    const body = m[2].trim();
    if (!body) continue; // a bare "// TODO:" with no body is noise
    findings.push({
      line: i + 1, // 1-indexed for human readers
      tag,
      body,
      context: captureContext(lines, i),
    });
  }
  return findings;
}

async function main() {
  const out = {
    generated_at: new Date().toISOString(),
    repo_path: repoPath,
    tags: TAGS,
    files: {},
  };
  for (const fileRel of filesList) {
    const abs = resolve(repoPath, fileRel);
    // Normalize the relPath against repoPath so the output keys match what
    // callers passed in (and stay stable even if --files contained absolute
    // paths or odd forms).
    const rel = relative(repoPath, abs);
    const findings = await extractFromFile(abs, rel);
    if (findings === null) continue; // missing file
    out.files[rel] = findings;
  }
  // Summary: total tag counts across all listed files. Useful for the
  // caller's "should I bother surfacing this?" decision.
  const tagCounts = {};
  for (const findings of Object.values(out.files)) {
    for (const f of findings) tagCounts[f.tag] = (tagCounts[f.tag] ?? 0) + 1;
  }
  out.summary = {
    files_scanned: Object.keys(out.files).length,
    findings_total: Object.values(out.files).reduce((a, b) => a + b.length, 0),
    by_tag: tagCounts,
  };

  const json = JSON.stringify(out, null, 2);
  if (outArg) {
    await mkdir(dirname(resolve(outArg)), { recursive: true });
    await writeFile(outArg, json + '\n', 'utf8');
    process.stderr.write(
      `rationale-comments written: ${outArg}\n` +
        `  files: ${out.summary.files_scanned}\n` +
        `  findings: ${out.summary.findings_total} ` +
        `(${Object.entries(tagCounts)
          .map(([t, n]) => `${t}=${n}`)
          .join(', ') || 'none'})\n`,
    );
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch((e) => {
  console.error(`extract-rationale-comments failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
