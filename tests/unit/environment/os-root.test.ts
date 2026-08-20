// Unit coverage for the fail-closed OS-root resolver (scripts/os-root.mjs).
//
// The contract these pin is a refusal contract: the resolver may return a
// directory it has verified, or throw — never a plausible-looking guess. The
// incident class is silent, so the tests assert the negative cases hardest:
// a declared-but-wrong root throws instead of quietly walking somewhere else,
// an unrelated directory throws instead of resolving to cwd, and half a
// sentinel (OS.md without .claude/skills, or the reverse) is not a root.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  OS_ROOT_ENV_VAR,
  findOsRootUpward,
  isOsRoot,
  osRootEnv,
  resolveOsRoot,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/os-root.mjs';

const tmpRoot = mkdtempSync(join(tmpdir(), 'os-root-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// A directory carrying both sentinels — the shape the resolver accepts.
function makeOsTree(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(dir, 'OS.md'), '# OS\n', 'utf8');
  return dir;
}

// A directory carrying only some of the sentinels.
function makePartialTree(name: string, { osMd = false, skills = false }): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  if (skills) mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
  if (osMd) writeFileSync(join(dir, 'OS.md'), '# OS\n', 'utf8');
  return dir;
}

describe('isOsRoot — the sentinel is BOTH markers', () => {
  it('accepts a directory holding OS.md and .claude/skills', () => {
    expect(isOsRoot(makeOsTree('complete'))).toBe(true);
  });

  it('rejects OS.md alone — docs mirrors and archives carry one too', () => {
    expect(isOsRoot(makePartialTree('doc-only', { osMd: true }))).toBe(false);
  });

  it('rejects .claude/skills alone — any Claude Code project has one', () => {
    expect(isOsRoot(makePartialTree('skills-only', { skills: true }))).toBe(false);
  });

  it('rejects a non-existent path and a non-string', () => {
    expect(isOsRoot(join(tmpRoot, 'nope'))).toBe(false);
    expect(isOsRoot('')).toBe(false);
  });
});

describe('findOsRootUpward', () => {
  it('finds the nearest enclosing root from a nested start dir', () => {
    const root = makeOsTree('walk');
    const nested = join(root, 'domains', 'meta', 'app');
    mkdirSync(nested, { recursive: true });
    expect(findOsRootUpward(nested)).toBe(root);
  });

  it('returns null rather than a guess when nothing above is a root', () => {
    const stray = join(tmpRoot, 'stray', 'deep');
    mkdirSync(stray, { recursive: true });
    expect(findOsRootUpward(stray)).toBeNull();
  });
});

describe('resolveOsRoot — precedence', () => {
  it('prefers a validated declaration over the walk', () => {
    const declared = makeOsTree('declared');
    const walked = makeOsTree('walked');
    const nested = join(walked, 'scripts');
    mkdirSync(nested, { recursive: true });
    expect(
      resolveOsRoot({ env: { [OS_ROOT_ENV_VAR]: declared }, startDir: nested }),
    ).toBe(declared);
  });

  it('falls through to the walk when the declaration is unset or blank', () => {
    const walked = makeOsTree('walk-fallthrough');
    const nested = join(walked, 'scripts');
    mkdirSync(nested, { recursive: true });
    expect(resolveOsRoot({ env: {}, startDir: nested })).toBe(walked);
    expect(resolveOsRoot({ env: { [OS_ROOT_ENV_VAR]: '   ' }, startDir: nested })).toBe(walked);
  });

  it('THROWS on a declaration that is not a root — never silently picks another tree', () => {
    const walked = makeOsTree('shadowed');
    const nested = join(walked, 'scripts');
    mkdirSync(nested, { recursive: true });
    const bogus = makePartialTree('bogus-declared', { osMd: true });
    expect(() => resolveOsRoot({ env: { [OS_ROOT_ENV_VAR]: bogus }, startDir: nested })).toThrow(
      /is not an OS root/,
    );
  });

  it('treats hint vars as hints — a wrong one is skipped, a right one wins', () => {
    const hinted = makeOsTree('hinted');
    const stray = join(tmpRoot, 'hint-stray');
    mkdirSync(stray, { recursive: true });
    expect(
      resolveOsRoot({
        env: { CLAUDE_PROJECT_DIR: hinted },
        startDir: stray,
        hintEnvVars: ['CLAUDE_PROJECT_DIR'],
      }),
    ).toBe(hinted);

    const walked = makeOsTree('hint-skipped');
    const nested = join(walked, 'mcps', 'vault');
    mkdirSync(nested, { recursive: true });
    expect(
      resolveOsRoot({
        env: { CLAUDE_PROJECT_DIR: stray },
        startDir: nested,
        hintEnvVars: ['CLAUDE_PROJECT_DIR'],
      }),
    ).toBe(walked);
  });

  it('THROWS rather than falling back to cwd when nothing resolves', () => {
    const stray = join(tmpRoot, 'unresolvable', 'deep');
    mkdirSync(stray, { recursive: true });
    let message = '';
    try {
      resolveOsRoot({ env: {}, startDir: stray });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/refusing to guess a tree/);
    // The message must be actionable: it names the sentinel and the escape hatch.
    expect(message).toContain('OS.md');
    expect(message).toContain('.claude/skills');
    expect(message).toContain(OS_ROOT_ENV_VAR);
  });
});

describe('osRootEnv — what dispatched children inherit', () => {
  it('produces the single env pair spawn sites merge in', () => {
    expect(osRootEnv('/somewhere/agentic_os')).toEqual({
      [OS_ROOT_ENV_VAR]: '/somewhere/agentic_os',
    });
  });
});
