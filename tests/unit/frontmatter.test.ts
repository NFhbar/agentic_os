// Semantics pins for the single runtime frontmatter parser
// (scripts/frontmatter.mjs). Five divergent hand-rolled parsers were
// consolidated onto js-yaml CORE_SCHEMA — these pin the behaviors the call
// sites depend on, especially the ones the old flat parsers got wrong.

import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../scripts/frontmatter.mjs';

const doc = (fm: string, body = 'Body text.') => `---\n${fm}\n---\n${body}`;

describe('parseFrontmatter (shared)', () => {
  it('no fence → hasFrontmatter false, body passthrough, fm {}', () => {
    const r = parseFrontmatter('just a plain file');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.fm).toEqual({});
    expect(r.body).toBe('just a plain file');
    expect(r.parseError).toBeNull();
  });

  it('scalars: quotes stripped, booleans, numbers, null and ~', () => {
    const r = parseFrontmatter(
      doc(`title: 'Quoted: title'\nflag: true\nn: 42\na: null\nb: ~\nplain: hello world`),
    );
    expect(r.parseError).toBeNull();
    expect(r.fm.title).toBe('Quoted: title');
    expect(r.fm.flag).toBe(true);
    expect(r.fm.n).toBe(42);
    expect(r.fm.a).toBeNull();
    expect(r.fm.b).toBeNull(); // Task #420 class — "~" must not survive as a string
    expect(r.fm.plain).toBe('hello world');
  });

  it('timestamps stay STRINGS (CORE_SCHEMA — the 0.3.0 Date-coercion bug class)', () => {
    const r = parseFrontmatter(doc('created: 2026-06-11T01:34:54Z'));
    expect(typeof r.fm.created).toBe('string');
    expect(r.fm.created).toBe('2026-06-11T01:34:54Z');
  });

  it('single-line JSON arrays of objects parse intact (recommended_changes shape)', () => {
    const r = parseFrontmatter(
      doc('recommended_changes: [{"id":null,"summary":"x","status":"proposed"}]'),
    );
    expect(r.fm.recommended_changes).toEqual([{ id: null, summary: 'x', status: 'proposed' }]);
  });

  it('block sequences parse as real arrays (the flat parsers dropped these)', () => {
    const r = parseFrontmatter(doc('spawns:\n  - meta-dashboard\n  - meta-add-skill'));
    expect(r.fm.spawns).toEqual(['meta-dashboard', 'meta-add-skill']);
  });

  it('nested maps parse (skill inputs schemas)', () => {
    const r = parseFrontmatter(doc('inputs:\n  name:\n    type: string\n    required: true'));
    expect(r.fm.inputs).toEqual({ name: { type: 'string', required: true } });
  });

  it('single-quoted strings unescape doubled apostrophes (scheduler prompt bug)', () => {
    const r = parseFrontmatter(doc("prompt: 'status is ''running'' today'"));
    expect(r.fm.prompt).toBe("status is 'running' today");
  });

  it('inline comments after unquoted values are stripped', () => {
    const r = parseFrontmatter(doc('size: small # informational'));
    expect(r.fm.size).toBe('small');
  });

  it('duplicate keys → parseError (lifecycle-audit duplicate-tags class)', () => {
    const r = parseFrontmatter(doc('tags: [a]\ntags: [b]'));
    expect(r.hasFrontmatter).toBe(true);
    expect(r.fm).toEqual({});
    expect(r.parseError).toMatch(/duplicated mapping key/);
  });

  it('invalid YAML (unquoted alias star) → parseError, body preserved', () => {
    const r = parseFrontmatter(doc('schedule: */15 * * * *', 'still here'));
    expect(r.parseError).not.toBeNull();
    expect(r.body).toBe('still here');
  });
});
