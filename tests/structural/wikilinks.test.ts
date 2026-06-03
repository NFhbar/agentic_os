// Structural integrity test for wikilinks across the vault.
//
// Every `[[name]]` reference in any wiki entry should resolve to either:
//   (a) another wiki entry's id (per the manifest), OR
//   (b) a skill name (under .claude/skills/), OR
//   (c) a known-exception (forward-references that resolve at runtime,
//       intentional placeholder, etc.) — recorded in WIKILINK_EXCEPTIONS.
//
// Drift here means: docs pointing at things that no longer exist (or never
// did). Today's `dangling-wikilink` audit catches this periodically; the
// test promotes it to a pre-commit gate.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  listSkillDirs,
  readManifest,
  relPath,
  walkWikiMarkdown,
} from '../helpers/vault.js';

// Known forward-references or intentional placeholders. Add (sparingly!)
// with a reason comment when a link is intentionally unresolved.
const WIKILINK_EXCEPTIONS = new Set<string>([
  // Bare archetype-shape placeholders used as examples in standard docs.
  // Most are just the field-name in `<>` brackets or named patterns —
  // they're meant to communicate "put your-id here", not resolve.
  'name',
  'id',
  'entity-id',
  'other-entity-id',
  'project-id',
  'change-id',
  'repo-entity-id',
  'other-entry-id',
  'entry-id',
  'research-report-id',
  // Generic terms used in prose about the wikilink mechanism itself.
  'wikilink',
  'wikilinks',
  'link',
  // Example project ids used in standard-project-workflow.md to illustrate
  // hierarchy / archival patterns. Deliberately illustrative, not real.
  'project-sub-a',
  'project-sub-b',
  'project-parent',
  'project-old',
  // Example entities used in archetype-project.md and standard docs.
  'user-alice',
  'use-fastify',
  'two-layer-memory',
  // Follow-up change referenced from the change-example-debounce seed to
  // show the convention. Not a real entry.
  'change-example-debounce-focus-followup',
]);

// Placeholders shown in docs to TEACH the wikilink pattern — not real
// references. We auto-detect these heuristically so docs don't have to
// register every example in WIKILINK_EXCEPTIONS.
function isDocPlaceholder(link: string): boolean {
  // `[[<change-id>]]`, `[[<repo-id>]]` — explicit angle-bracket placeholder
  if (link.startsWith('<') && link.endsWith('>')) return true;
  // `[[decision-...]]`, `[[note-...]]` — ellipsis stubs in scaffolds
  if (link.endsWith('...')) return true;
  if (link === '…') return true;
  // `[[project-a]]`, `[[project-x]]` — example names with a-z single suffix
  // following a known archetype prefix. Avoid false-positive on real id's
  // by requiring the trailing char to be a single letter.
  if (/^(project|change|note|decision|report|entry)-[a-z]$/.test(link)) return true;
  // `[[…]]` — ellipsis character
  if (link.includes('…')) return true;
  return false;
}

function extractWikilinks(body: string): string[] {
  // Match `[[name]]` or `[[name|alias]]`. The captured group is the id.
  const out: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

describe('wikilink resolution', () => {
  const manifest = readManifest();
  const entryIds = new Set(
    manifest.entries
      .map((e) => e.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const skillNames = new Set(listSkillDirs().map((d) => basename(d)));
  const files = walkWikiMarkdown();

  // Collect every dangling link first so the failure surfaces them all at
  // once rather than one-per-test-failure (which would be noisy + slow).
  const dangling: Array<{ link: string; in: string }> = [];
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    const links = extractWikilinks(body);
    for (const link of links) {
      if (entryIds.has(link)) continue;
      if (skillNames.has(link)) continue;
      if (WIKILINK_EXCEPTIONS.has(link)) continue;
      if (isDocPlaceholder(link)) continue;
      dangling.push({ link, in: relPath(file) });
    }
  }

  it('reports zero dangling wikilinks', () => {
    if (dangling.length === 0) return;
    const msg = dangling
      .map((d) => `  [[${d.link}]] in ${d.in}`)
      .join('\n');
    expect.fail(
      `${dangling.length} dangling wikilink(s) found:\n${msg}\n\n` +
        `Resolve by creating the missing entry/skill, OR (if the link is intentional) ` +
        `add it to WIKILINK_EXCEPTIONS in tests/structural/wikilinks.test.ts with a reason.`,
    );
  });
});
