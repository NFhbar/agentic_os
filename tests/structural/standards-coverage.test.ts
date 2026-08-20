// Structural integrity test for the audit subsystem.
//
// The OS audit (scripts/audit.mjs) implements N structural checks. Each
// check has an `id` (e.g., `change-body-template-placeholder`). The
// canonical list of checks lives in vault/wiki/_seed/meta/reference/
// standard-os-audit.md. The two should be in lockstep — every implemented
// check is documented, every documented check is implemented.
//
// Today's audit catches drift via `audit-check-id-documented` and
// `audit-check-id-implemented` findings. This test promotes both to a
// pre-commit gate because they're load-bearing: a documented-but-unimpl
// check creates false expectations; an implemented-but-undocumented check
// fires findings nobody knows how to interpret.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractH2s,
  semanticMarkdown,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../scripts/markdown-scan.mjs';
import { REPO_ROOT } from '../helpers/vault.js';

const AUDIT_PATH = join(REPO_ROOT, 'scripts', 'audit.mjs');
const STANDARD_PATH = join(
  REPO_ROOT,
  'vault',
  'wiki',
  '_seed',
  'meta',
  'reference',
  'standard-os-audit.md',
);

// Extract check ids from audit.mjs by grepping for `id: '<kebab-case>'`
// inside findings.push() calls. Heuristic but stable — every finding does
// `findings.push({ id: '...', severity: '...', ... })`.
function readImplementedIds(): Set<string> {
  const src = readFileSync(AUDIT_PATH, 'utf8');
  const out = new Set<string>();
  const re = /findings\.push\(\s*\{[^}]*?id:\s*['"]([a-z][a-z0-9-]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.add(m[1]);
  }
  return out;
}

// The H2 that owns the registry tables. Rows anywhere else in the document
// (usage examples, the severity legend, a future appendix) are prose about
// the audit, not declarations of what it checks.
const REGISTRY_HEADING = 'Check registry';

// Extract check ids from standard-os-audit.md by finding all `\`<id>\``
// occurrences that are the leading cell of a markdown table row.
//
// Scoped two ways, both via the shared markdown scanner: fenced blocks are
// blanked (a sample registry row inside a ```markdown example must not count
// as documentation), and only lines under the registry H2 are considered.
function readDocumentedIds(): Set<string> {
  const src = readFileSync(STANDARD_PATH, 'utf8');
  const h2s = extractH2s(src) as Array<{ title: string; line: number }>;
  const startIdx = h2s.findIndex((h) => h.title === REGISTRY_HEADING);
  if (startIdx < 0) {
    throw new Error(
      `standard-os-audit.md has no "## ${REGISTRY_HEADING}" section — the id scanner has nothing to read. ` +
        'Restore the heading, or update REGISTRY_HEADING in this test to match the new structure.',
    );
  }
  // Line numbers are 1-based and the scanner is line-preserving, so they index
  // straight into the scanned text.
  const lines = (semanticMarkdown(src) as string).split('\n');
  const from = h2s[startIdx].line;
  const to = h2s[startIdx + 1]?.line ?? lines.length + 1;

  const out = new Set<string>();
  for (const line of lines.slice(from, to - 1)) {
    // Rows shaped like `| \`change-body-template-placeholder\` | warn | ... |`
    // The "contains a hyphen" guard excludes severity-column matches and
    // other short single-word entries — every real audit check id is
    // kebab-case with at least one hyphen.
    const m = line.match(/^\|\s*`([a-z][a-z0-9-]*-[a-z0-9-]+)`\s*\|/);
    if (m) out.add(m[1]);
  }
  return out;
}

describe('audit check coverage', () => {
  const implemented = readImplementedIds();
  const documented = readDocumentedIds();

  it('has at least one implemented + documented check', () => {
    expect(implemented.size).toBeGreaterThan(5);
    expect(documented.size).toBeGreaterThan(5);
  });

  it('every implemented check is documented in standard-os-audit.md', () => {
    const undocumented = [...implemented].filter((id) => !documented.has(id)).sort();
    if (undocumented.length === 0) return;
    expect.fail(
      `${undocumented.length} audit check(s) are implemented in scripts/audit.mjs but not documented in standard-os-audit.md:\n` +
        undocumented.map((id) => `  ${id}`).join('\n') +
        '\n\nAdd a row to standard-os-audit.md describing the check.',
    );
  });

  it('every documented check is implemented in scripts/audit.mjs', () => {
    const unimplemented = [...documented].filter((id) => !implemented.has(id)).sort();
    if (unimplemented.length === 0) return;
    expect.fail(
      `${unimplemented.length} audit check(s) are documented in standard-os-audit.md but not implemented in scripts/audit.mjs:\n` +
        unimplemented.map((id) => `  ${id}`).join('\n') +
        '\n\nEither implement the check OR remove the row from standard-os-audit.md.',
    );
  });
});
