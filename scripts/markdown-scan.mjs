// THE markdown-structure implementation for the OS's own scanners.
//
// Structural tests and the audit both ask the same question of markdown files:
// "does this document REALLY contain X, or is X inside an example?" Every
// scanner that answers it with a private regex gets the same class of bug —
// a `[[wikilink]]` in a fenced example counted as a real reference, a `##`
// heading inside a code block counted as a real section, a documented id
// harvested from a sample table. The rule is one implementation, here, and no
// consumer re-deriving markdown semantics on its own.
//
// Fence handling follows the CommonMark shape the OS's own docs use:
//   - backtick (```) AND tilde (~~~) fences
//   - three or more markers; the closer must use the same character and be at
//     least as long as the opener, so a ```` fence can quote ``` blocks whole
//   - an info string (```yaml) is allowed on the opener, never on the closer
//   - an unterminated fence swallows the rest of the document, which is what a
//     markdown renderer does too
//
// Indentation is deliberately unrestricted, which is where this departs from
// the letter of CommonMark's three-space rule. Skill procedures and standards
// routinely put a fenced example inside a numbered step, indented to the
// step's content column — four, five, six spaces. Those are code examples by
// every reader's understanding, and reading them as prose is precisely the bug
// class this module exists to kill. The cost is the inverse case (a genuine
// four-space indented code block whose first line is a row of backticks),
// which does not occur in these documents and would only ever cause a scanner
// to see LESS, never to invent a false positive.
//
// LINE-PRESERVING: stripped regions are blanked, not deleted. Line N of the
// output is line N of the input, so a consumer can report a line number from
// scanned text and have it point at the right place in the file.

import { parseFrontmatter } from './frontmatter.mjs';

// Opening/closing fence marker at any indentation. Group 1 is the run of
// markers, group 2 the rest of the line (info string, or trailing markers on
// an over-long closer).
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Blank every fenced code block — the fence lines themselves included.
 *
 * @param {string} text
 * @returns {string} same line count, fenced regions replaced by empty lines
 */
export function stripFencedBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const out = new Array(lines.length);
  let openChar = null;
  let openLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FENCE_RE);
    if (openChar === null) {
      if (m) {
        // A backtick opener's info string may not contain a backtick — that
        // rule is what keeps inline code like `a ``b`` c` from opening a
        // block. Tilde openers have no such restriction.
        const info = m[2];
        if (m[1][0] === '`' && info.includes('`')) {
          out[i] = line;
          continue;
        }
        openChar = m[1][0];
        openLen = m[1].length;
        out[i] = '';
        continue;
      }
      out[i] = line;
      continue;
    }
    // Inside a block: everything is blanked, and only a matching closer with
    // no info string ends it. A shorter run of the same character, or a run of
    // the other character, is just content.
    out[i] = '';
    if (m && m[1][0] === openChar && m[1].length >= openLen && m[2].trim() === '') {
      openChar = null;
      openLen = 0;
    }
  }
  return out.join('\n');
}

/**
 * Blank a leading frontmatter block, keeping the line count. Delegates the
 * detection to the shared frontmatter parser so there is still exactly one
 * answer to "where does the frontmatter end".
 */
export function stripFrontmatter(text) {
  const src = String(text ?? '');
  const { hasFrontmatter, raw } = parseFrontmatter(src);
  if (!hasFrontmatter) return src;
  // `---` + the raw YAML + `---` — blank exactly those lines.
  const consumed = raw.split('\n').length + 2;
  const lines = src.split('\n');
  for (let i = 0; i < consumed && i < lines.length; i++) lines[i] = '';
  return lines.join('\n');
}

/**
 * The prose a reader would call the document's actual content: frontmatter and
 * fenced blocks blanked, and — when asked — inline code spans too.
 *
 * `stripInlineCode` is off by default because most scanners want to see what
 * the prose says, backticks and all. Turn it on for scanners that treat
 * inline code as an example rather than a claim (the wikilink scanners do:
 * docs write `` `[[entry-id]]` `` to TEACH the syntax).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.frontmatter=true]      blank a leading frontmatter block
 * @param {boolean} [opts.stripInlineCode=false] blank single-line inline code spans
 * @returns {string} same line count as the input
 */
export function semanticMarkdown(text, { frontmatter = true, stripInlineCode = false } = {}) {
  let out = String(text ?? '');
  if (frontmatter) out = stripFrontmatter(out);
  out = stripFencedBlocks(out);
  // Single-line spans only — a run of backticks spanning a newline is far more
  // often two separate spans than one long one, and blanking across lines
  // would break the line-preserving contract.
  if (stripInlineCode) out = out.replace(/`[^`\n]+`/g, '');
  return out;
}

/**
 * The document's H2 headings, in order, skipping any that live inside a fence.
 * Line numbers are 1-based indexes into the ORIGINAL text — the blanking is
 * line-preserving, so they stay valid.
 *
 * @param {string} text
 * @returns {Array<{title: string, line: number}>}
 */
export function extractH2s(text) {
  const out = [];
  const lines = semanticMarkdown(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Exactly two hashes — `###` is a subsection, not an H2.
    const m = lines[i].match(/^ {0,3}##(?!#)\s+(.*?)\s*#*\s*$/);
    if (m && m[1].length > 0) out.push({ title: m[1], line: i + 1 });
  }
  return out;
}
