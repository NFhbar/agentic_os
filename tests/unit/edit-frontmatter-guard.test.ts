// Tier 1 unit test for preserveFrontmatter — the guard behind POST /api/edit.
//
// A body-only save used to be written byte-for-byte, which deleted the entry's
// frontmatter and orphaned it from every typed listing (the file still exists
// on disk but no archetype listing can see it). The guard re-attaches the
// on-disk block, bumped, and must stay inert on the two shapes that were
// always safe: content that carries its own frontmatter, and files that never
// had any.

import { describe, expect, it } from 'vitest';
import { preserveFrontmatter } from '../../domains/meta/app/server/frontmatter-rewrite.js';

const NOW = '2026-08-20T12:00:00.000Z';

const BLOCK = [
  '---',
  'id: some-entry',
  'type: note',
  'domain: meta',
  'created: 2026-01-01T00:00:00Z',
  'updated: 2026-01-02T00:00:00Z',
  '---',
].join('\n');

const EXISTING = `${BLOCK}\n\n# Some entry\n\nOriginal body.\n`;

describe('preserveFrontmatter', () => {
  it('body-only save preserves the block, bumps updated, and keeps the new body', () => {
    const body = '# Some entry\n\nRewritten body.\n';
    const bumped = BLOCK.replace('updated: 2026-01-02T00:00:00Z', `updated: ${NOW}`);
    const out = preserveFrontmatter(EXISTING, body, NOW);
    expect(out).toBe(`${bumped}\n${body}`);
    expect(out).toContain('id: some-entry');
    expect(out).toContain('created: 2026-01-01T00:00:00Z');
    expect(out).not.toContain('Original body.');
  });

  it('content that carries frontmatter is written as-is', () => {
    const incoming = '---\nid: some-entry\nupdated: 2026-05-05T00:00:00Z\n---\n\nB.\n';
    expect(preserveFrontmatter(EXISTING, incoming, NOW)).toBe(incoming);
  });

  it('file without frontmatter is unaffected', () => {
    const incoming = 'plain text, no block\n';
    expect(preserveFrontmatter('older plain text\n', incoming, NOW)).toBe(incoming);
    expect(preserveFrontmatter('', incoming, NOW)).toBe(incoming);
  });

  it('block without an updated: line is preserved unbumped rather than invented', () => {
    const existing = '---\nid: x\ntype: note\n---\n\nBody.\n';
    expect(preserveFrontmatter(existing, 'New body.\n', NOW)).toBe(
      '---\nid: x\ntype: note\n---\nNew body.\n',
    );
  });

  it('bumps the block updated: line only, never one that appears in the body', () => {
    const out = preserveFrontmatter(EXISTING, 'updated: never\n\ntext\n', NOW);
    expect(out).toContain(`updated: ${NOW}`);
    expect(out).toContain('updated: never');
  });
});
