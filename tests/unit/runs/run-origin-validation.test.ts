// Behavior + vocabulary-drift pins for the run-origin validator that guards
// every HTTP dispatch path (domains/meta/app/server/lib/run-origin.ts). It is
// the single runtime membership check; these pin its contract AND that the
// four-value vocabulary stays in sync across its three homes — the runtime list
// (scripts/run-origins.mjs), the re-export that keeps scripts/audit.mjs
// resolving (scripts/runs-db-init.mjs), and the compile-time RunOrigin union
// (runs.types.ts, a types-only file that can't import the runtime value).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRunOrigin } from '../../../domains/meta/app/server/lib/run-origin.js';
import { RUN_ORIGINS } from '../../../scripts/run-origins.mjs';
import { REPO_ROOT } from '../../helpers/vault.js';

const EXPECTED = ['human', 'automation', 'scheduler', 'driver'];

describe('parseRunOrigin', () => {
  it('accepts every vocabulary value', () => {
    for (const origin of EXPECTED) {
      expect(parseRunOrigin(origin)).toEqual({ ok: true, origin });
    }
  });

  it('passes through an absent origin (default stays startRun\'s)', () => {
    expect(parseRunOrigin(undefined)).toEqual({ ok: true, origin: undefined });
    expect(parseRunOrigin(null)).toEqual({ ok: true, origin: undefined });
  });

  it('rejects an unknown string with an expected-one-of message', () => {
    const result = parseRunOrigin('gremlin');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('gremlin');
    for (const origin of EXPECTED) {
      expect(result.error).toContain(origin);
    }
  });

  it('rejects non-strings', () => {
    for (const bad of [42, {}, ['human'], true]) {
      expect(parseRunOrigin(bad).ok).toBe(false);
    }
  });
});

describe('run-origin vocabulary drift pins', () => {
  it('RUN_ORIGINS is exactly the four reserved values', () => {
    expect(RUN_ORIGINS).toEqual(EXPECTED);
  });

  it('runs-db-init.mjs re-exports RUN_ORIGINS from run-origins.mjs', () => {
    // Source-read: runs-db-init.mjs imports node:sqlite at module top, so it
    // can't be imported under vitest — the re-export keeps scripts/audit.mjs's
    // `import { RUN_ORIGINS } from './runs-db-init.mjs'` resolving unchanged.
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'runs-db-init.mjs'), 'utf8');
    expect(src).toMatch(/export\s*\{\s*RUN_ORIGINS\s*\}\s*from\s*'\.\/run-origins\.mjs'/);
  });

  it('every RUN_ORIGINS value appears in the RunOrigin union', () => {
    // Source-read: runs.types.ts is types-only and can't import the runtime
    // list, so the union mirrors it by hand — pin the mirror against drift.
    const src = readFileSync(
      join(REPO_ROOT, 'domains', 'meta', 'app', 'server', 'routes', 'runs.types.ts'),
      'utf8',
    );
    const union = src.match(/export type RunOrigin =([^;]*);/)?.[1] ?? '';
    expect(union).not.toBe('');
    for (const origin of RUN_ORIGINS) {
      expect(union).toContain(`'${origin}'`);
    }
  });
});
