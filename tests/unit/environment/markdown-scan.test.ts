// Unit coverage for the shared fence-aware markdown scanner
// (scripts/markdown-scan.mjs).
//
// This module exists because the same bug kept recurring in separate
// scanners: content inside a code fence counted as real. The regressions
// pinned here are the exact shapes that fooled the private regexes — a
// heading inside a fence, a wikilink inside a fence, a tilde fence (which a
// backtick-only regex passes straight through), and a longer fence quoting a
// shorter one.
//
// The line-preserving contract is pinned too: consumers report line numbers
// from scanned text, so blanking must never shift them.

import { describe, expect, it } from 'vitest';
import {
  extractH2s,
  semanticMarkdown,
  stripFencedBlocks,
  stripFrontmatter,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/markdown-scan.mjs';

const lineCount = (s: string) => s.split('\n').length;

describe('stripFencedBlocks — backtick fences', () => {
  it('blanks a fenced block and keeps the surrounding prose', () => {
    const src = ['before', '```', 'inside', '```', 'after'].join('\n');
    expect(stripFencedBlocks(src)).toBe(['before', '', '', '', 'after'].join('\n'));
  });

  it('blanks a heading that only LOOKS like a section because it is fenced', () => {
    const src = ['## Real', '', '```markdown', '## Example', '```', '', '## Also real'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).toContain('## Real');
    expect(out).toContain('## Also real');
    expect(out).not.toContain('## Example');
  });

  it('keeps an info string from re-opening the block', () => {
    const src = ['```yaml', 'id: x', '```', 'prose'].join('\n');
    expect(stripFencedBlocks(src).trim()).toBe('prose');
  });

  it('does not treat inline code as a fence opener', () => {
    const src = 'a `` b `` c ```d``` e';
    expect(stripFencedBlocks(src)).toBe(src);
  });
});

describe('stripFencedBlocks — tilde fences', () => {
  it('blanks a tilde-fenced block (a backtick-only scanner reads straight through it)', () => {
    const src = ['before', '~~~', '[[fenced-link]]', '~~~', 'after'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('[[fenced-link]]');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('does not let one fence character close the other', () => {
    const src = ['~~~', '```', 'still inside', '```', '~~~', 'after'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('still inside');
    expect(out).toContain('after');
  });
});

describe('stripFencedBlocks — length and indentation rules', () => {
  it('lets a longer fence quote a shorter one whole', () => {
    const src = ['````markdown', '```', 'nested', '```', '````', 'after'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('nested');
    expect(out).toContain('after');
  });

  it('requires the closer to be at least as long as the opener', () => {
    const src = ['````', '```', 'inside', '````', 'after'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('inside');
    expect(out).toContain('after');
  });

  it('accepts indented markers', () => {
    const src = ['   ```', '   inside', '   ```', 'after'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('inside');
    expect(out).toContain('after');
  });

  it('handles a fence nested in a numbered step, indented to the step column', () => {
    // The shape every skill procedure uses. A three-space-limited scanner
    // reads the example's contents as prose — which is how `[[id]]` inside a
    // sample report block got counted as a real reference.
    const src = [
      '1. Print the report:',
      '',
      '    ```',
      '    stakeholders: <resolved [[id]] or "(none)">',
      '    ```',
      '',
      '2. Done.',
    ].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('[[id]]');
    expect(out).toContain('2. Done.');
  });

  it('closes a fence whose closer is indented differently from its opener', () => {
    const src = ['    ```', '    inside', '```', 'after'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out).not.toContain('inside');
    expect(out).toContain('after');
  });

  it('rejects a closer that carries an info string', () => {
    const src = ['```', 'inside', '``` still-inside', 'also inside'].join('\n');
    const out = stripFencedBlocks(src);
    expect(out.trim()).toBe('');
  });

  it('swallows the rest of the document when a fence is never closed', () => {
    const src = ['prose', '```', 'inside', 'more inside'].join('\n');
    expect(stripFencedBlocks(src).trim()).toBe('prose');
  });
});

describe('line preservation', () => {
  it('keeps the line count across every stripping mode', () => {
    const src = [
      '---',
      'id: x',
      '---',
      '',
      '## Heading',
      '```',
      'fenced',
      '```',
      'tail `inline` tail',
    ].join('\n');
    expect(lineCount(stripFencedBlocks(src))).toBe(lineCount(src));
    expect(lineCount(stripFrontmatter(src))).toBe(lineCount(src));
    expect(lineCount(semanticMarkdown(src, { stripInlineCode: true }))).toBe(lineCount(src));
  });
});

describe('stripFrontmatter', () => {
  it('blanks a leading frontmatter block', () => {
    const src = ['---', 'id: x', 'tags: [a]', '---', '', 'body'].join('\n');
    expect(stripFrontmatter(src).trim()).toBe('body');
  });

  it('leaves a document with no frontmatter untouched', () => {
    const src = 'no frontmatter here\n---\nnot frontmatter either';
    expect(stripFrontmatter(src)).toBe(src);
  });
});

describe('semanticMarkdown', () => {
  it('keeps inline code by default and blanks it on request', () => {
    const src = 'prose `[[example-id]]` prose';
    expect(semanticMarkdown(src)).toContain('[[example-id]]');
    expect(semanticMarkdown(src, { stripInlineCode: true })).not.toContain('[[example-id]]');
  });

  it('removes frontmatter and fences together', () => {
    const src = ['---', 'id: x', '---', 'real', '```', 'fake', '```'].join('\n');
    const out = semanticMarkdown(src);
    expect(out).toContain('real');
    expect(out).not.toContain('fake');
    expect(out).not.toContain('id: x');
  });
});

describe('extractH2s', () => {
  it('returns real H2s with 1-based line numbers, skipping fenced ones', () => {
    const src = [
      '# Title', // 1
      '', // 2
      '## First', // 3
      '', // 4
      '```markdown', // 5
      '## Fenced', // 6
      '```', // 7
      '', // 8
      '### Not an H2', // 9
      '', // 10
      '## Second', // 11
    ].join('\n');
    expect(extractH2s(src)).toEqual([
      { title: 'First', line: 3 },
      { title: 'Second', line: 11 },
    ]);
  });

  it('ignores an H2-looking line inside frontmatter', () => {
    const src = ['---', 'title: "## not a heading"', '---', '## Real'].join('\n');
    expect(extractH2s(src).map((h: { title: string }) => h.title)).toEqual(['Real']);
  });

  it('trims a closing hash run', () => {
    expect(extractH2s('## Closed ##')).toEqual([{ title: 'Closed', line: 1 }]);
  });
});
