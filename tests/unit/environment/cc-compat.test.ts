// Unit coverage for the Claude Code version-compatibility contract
// (scripts/check-cc-compat.mjs). The impure half — reading `claude --version`
// and mapping the class onto the `cc-version-compat` finding id — lives in
// scripts/audit.mjs, which can't be imported here because it pulls node:sqlite
// at module top.
//
// The bug these exist to prevent is a string compare: lexicographically
// '2.1.9' > '2.1.196', which would wave through a CLI months older than the
// minimum. Every ordering assertion below is chosen so a string compare fails
// it.

import { describe, expect, it } from 'vitest';
import {
  GATED_FEATURES,
  HIGHEST_TESTED,
  MIN_SUPPORTED,
  compareVersions,
  evaluateCompat,
  parseVersion,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/check-cc-compat.mjs';

describe('the declared range', () => {
  it('pins the minimum and the tested ceiling', () => {
    expect(MIN_SUPPORTED).toBe('2.1.196');
    expect(HIGHEST_TESTED).toBe('2.1.220');
  });

  it('keeps the minimum at or below the ceiling', () => {
    expect(compareVersions(MIN_SUPPORTED, HIGHEST_TESTED)).toBeLessThanOrEqual(0);
  });
});

describe('parseVersion', () => {
  it('accepts bare, v-prefixed, and suffixed forms', () => {
    expect(parseVersion('2.1.220')).toEqual([2, 1, 220]);
    expect(parseVersion('v2.1.220')).toEqual([2, 1, 220]);
    expect(parseVersion('2.1.220 (Claude Code)')).toEqual([2, 1, 220]);
    expect(parseVersion('  2.1.220-beta.1  ')).toEqual([2, 1, 220]);
  });

  it('returns null for anything without a dotted number', () => {
    expect(parseVersion('unknown')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('compareVersions — per-segment NUMERIC', () => {
  it('orders multi-digit segments by value, not by character', () => {
    // The whole point: a string compare says '2.1.9' > '2.1.196'.
    expect(compareVersions('2.1.9', '2.1.196')).toBe(-1);
    expect(compareVersions('2.1.196', '2.1.9')).toBe(1);
    expect(compareVersions('2.1.1000', '2.1.999')).toBe(1);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.1', '2.1.1')).toBe(-1);
  });

  it('compares earlier segments first', () => {
    expect(compareVersions('3.0.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.2.0', '2.10.0')).toBe(-1);
  });

  it('throws rather than inventing an order for garbage', () => {
    expect(() => compareVersions('nope', '2.1.0')).toThrow();
  });
});

describe('evaluateCompat — the three classes', () => {
  it('fails below the minimum and names what degrades', () => {
    const r = evaluateCompat('2.1.9');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('2.1.9');
    expect(r.message).toContain(MIN_SUPPORTED);
    // Naming the gated behavior is the point — "too old" alone tells the
    // operator nothing about what to look for.
    expect(r.message).toContain('headless gate');
    expect(GATED_FEATURES.length).toBeGreaterThan(0);
    expect(r.hint).toBeTruthy();
  });

  it('is ok at both range boundaries and in between', () => {
    expect(evaluateCompat(MIN_SUPPORTED).status).toBe('ok');
    expect(evaluateCompat(HIGHEST_TESTED).status).toBe('ok');
    expect(evaluateCompat('2.1.200').status).toBe('ok');
  });

  it('informs above the tested ceiling and asks for the suite, not an upgrade', () => {
    const r = evaluateCompat('2.1.228');
    expect(r.status).toBe('info');
    expect(r.message).toContain(HIGHEST_TESTED);
    expect(r.hint).toMatch(/suite/i);
    expect(r.hint).toMatch(/HIGHEST_TESTED/);
  });

  it('reports unknown rather than guessing when the version is unreadable', () => {
    const r = evaluateCompat('not-a-version');
    expect(r.status).toBe('unknown');
    expect(r.hint).toBeTruthy();
  });

  it('honors an injected range so the classes stay testable as the pins move', () => {
    const range = { min: '1.0.0', tested: '1.5.0' };
    expect(evaluateCompat('0.9.0', range).status).toBe('fail');
    expect(evaluateCompat('1.2.0', range).status).toBe('ok');
    expect(evaluateCompat('1.6.0', range).status).toBe('info');
  });
});
