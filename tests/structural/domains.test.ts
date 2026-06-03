// Structural test: every entry's `domain:` field maps to a real domain dir.
//
// The OS organizes everything by domain — wiki entries, skills, apps,
// hooks. If an entry's `domain:` doesn't match any directory under
// `domains/`, two things break silently:
//   1. The Domains view's tree omits the entry from its owning group
//   2. Per-domain audit checks + scheduler runbooks don't see the entry
//
// Skills' `domain:` is enforced via the per-skill structural test;
// wiki entries get the same enforcement here.
//
// Pattern: read the `domains/` directory once, build the canonical set,
// fail the test with a clear list when an entry references a missing one.

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  REPO_ROOT,
  listSkillDirs,
  readManifest,
  relPath,
} from '../helpers/vault.js';

const DOMAINS_DIR = join(REPO_ROOT, 'domains');

const knownDomains = new Set(
  readdirSync(DOMAINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name),
);

describe('domain directory baseline', () => {
  it('has at least the three canonical domains', () => {
    // meta + development + research are the seed domains shipped with the
    // OS. If one of them is missing, something is very wrong.
    expect(knownDomains.has('meta')).toBe(true);
    expect(knownDomains.has('development')).toBe(true);
    expect(knownDomains.has('research')).toBe(true);
  });
});

describe('wiki entries — domain field resolves', () => {
  it('every entry with a `domain:` field references a real domain', () => {
    const manifest = readManifest();
    const orphans: Array<{ id: string; domain: string; path: string }> = [];
    for (const entry of manifest.entries) {
      if (entry.domain == null) continue;
      if (typeof entry.domain !== 'string' || entry.domain.length === 0) continue;
      if (!knownDomains.has(entry.domain)) {
        orphans.push({
          id: entry.id ?? '(no-id)',
          domain: entry.domain,
          path: entry.path ?? '(no-path)',
        });
      }
    }
    if (orphans.length === 0) return;
    const known = [...knownDomains].sort().join(', ');
    expect.fail(
      `${orphans.length} wiki entry/entries reference a domain that doesn't exist:\n` +
        orphans
          .map(
            (o) =>
              `  ${o.id} (${relPath(join(REPO_ROOT, o.path))}): domain = "${o.domain}"`,
          )
          .join('\n') +
        `\n\nKnown domains: { ${known} }\n` +
        `Fix by ONE of:\n` +
        `  (a) Correct the entry's domain to a known value.\n` +
        `  (b) Add the new domain via \`/os add-domain <name>\` so domains/${'<name>'}/ exists.`,
    );
  });
});

describe('skills — domain field resolves', () => {
  it('every skill that declares a domain references a real one', () => {
    // The skills.test.ts file checks `domain` exists as a string; this
    // test goes further and ensures the value resolves. Kept separate so
    // the failure messages stay scoped to the relevant invariant.
    const orphans: Array<{ skill: string; domain: string }> = [];
    for (const dir of listSkillDirs()) {
      const skillMd = join(dir, 'SKILL.md');
      let fm: Record<string, unknown> | null = null;
      try {
        // Inline parse to avoid pulling parseFrontmatter and its file IO
        // through twice — this test reads the same SKILL.md the skills
        // test reads, so we accept the small duplication for clarity.
        const { readFileSync } = require('node:fs');
        const content = readFileSync(skillMd, 'utf8') as string;
        const m = content.match(/^---\n([\s\S]*?)\n---/);
        if (!m) continue;
        // Cheap key:value extraction for the `domain:` line.
        const line = m[1].split('\n').find((l) => l.startsWith('domain:'));
        if (!line) continue;
        const value = line.slice('domain:'.length).trim().replace(/^['"]|['"]$/g, '');
        fm = { domain: value };
      } catch {
        continue;
      }
      const d = fm?.domain;
      if (typeof d !== 'string' || d.length === 0) continue;
      if (!knownDomains.has(d)) {
        orphans.push({ skill: basename(dir), domain: d });
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} skill(s) declare a domain that doesn't exist:\n` +
        orphans.map((o) => `  ${o.skill}: domain = "${o.domain}"`).join('\n'),
    );
  });
});
