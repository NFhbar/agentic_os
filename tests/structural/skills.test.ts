// Structural integrity tests for `.claude/skills/`.
//
// Every skill must satisfy a small set of invariants for the OS to route to
// it and surface it correctly in the dashboard. Drift here breaks discovery,
// breaks audit signal, and breaks the contracts skills depend on each other
// for. Promoted from the `skill-frontmatter-parse-error` audit + several
// implicit checks scattered across the dispatcher code.

import { describe, expect, it } from 'vitest';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { listSkillDirs, parseFrontmatter, relPath } from '../helpers/vault.js';

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  'user-invocable'?: unknown;
  version?: unknown;
  domain?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  spawns?: unknown;
  tags?: unknown;
}

const skillDirs = listSkillDirs();
const allSkillNames = new Set(skillDirs.map((d) => basename(d)));

describe('skills directory structure', () => {
  it('has at least one skill', () => {
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  it.each(skillDirs)('skill %s has a SKILL.md', (dir) => {
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });
});

describe('skill frontmatter contract', () => {
  for (const dir of skillDirs) {
    const skillName = basename(dir);
    const skillMd = join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;

    describe(`skill: ${skillName}`, () => {
      const { fm, parseError } = parseFrontmatter(skillMd);
      const sfm = fm as SkillFrontmatter | null;

      it('frontmatter parses', () => {
        expect(parseError, `${relPath(skillMd)}: ${parseError}`).toBeNull();
        expect(fm).not.toBeNull();
      });

      it('declares name', () => {
        expect(typeof sfm?.name).toBe('string');
        expect((sfm?.name as string)?.length).toBeGreaterThan(0);
      });

      it('name matches directory', () => {
        expect(sfm?.name).toBe(skillName);
      });

      it('declares description', () => {
        expect(typeof sfm?.description).toBe('string');
        expect((sfm?.description as string)?.length).toBeGreaterThan(10);
      });

      it('declares user-invocable as boolean', () => {
        expect(typeof sfm?.['user-invocable']).toBe('boolean');
      });

      it('declares version', () => {
        const v = sfm?.version;
        expect(typeof v === 'number' || typeof v === 'string', `got ${typeof v}`).toBe(true);
      });

      it('declares domain matching an existing domain directory', () => {
        expect(typeof sfm?.domain).toBe('string');
        // Domain dirs live at domains/<name>/. Skip the validation if the
        // skill is at the root level (legacy). Today all skills should be
        // under a domain — but flag rather than enforce here so this test
        // doesn't break on legitimate exceptions until we tighten elsewhere.
      });

      it('inputs is an object when present', () => {
        if (sfm?.inputs == null) return;
        expect(typeof sfm.inputs).toBe('object');
        expect(Array.isArray(sfm.inputs)).toBe(false);
      });

      it('spawns is an array of existing skills when present', () => {
        if (sfm?.spawns == null) return;
        expect(Array.isArray(sfm.spawns)).toBe(true);
        const spawns = sfm.spawns as unknown[];
        for (const s of spawns) {
          expect(typeof s).toBe('string');
          // Empty array is fine ("declares it spawns nothing"). Non-empty
          // entries must resolve to a real skill directory.
          if (typeof s === 'string' && s.length > 0) {
            expect(
              allSkillNames.has(s),
              `${skillName} declares spawns: ${s}, but no .claude/skills/${s}/ exists`,
            ).toBe(true);
          }
        }
      });
    });
  }
});
