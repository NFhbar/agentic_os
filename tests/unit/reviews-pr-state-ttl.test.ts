// The PR-state refresh TTL — the rule that decides whether one review's PR is
// worth a GitHub round-trip right now.
//
// It has to be pure to be trustworthy: a batch that re-checks everything on
// every press burns an API call per PR per click, and one that skips too
// eagerly leaves merged work sitting in the active list. Both failures are
// invisible without a clock you control, so `nowMs` is an argument.

import { describe, expect, it } from 'vitest';
import {
  PR_STATE_TTL_MS,
  decidePrRefresh,
  derivePrState,
  isPrStateFresh,
  parsePrUrl,
} from '../../domains/meta/app/server/lib/github-pr.js';

const NOW = Date.parse('2026-08-20T12:00:00Z');
const PR = 'https://github.com/acme/widget/pull/42';

const base = {
  prUrl: PR,
  prState: 'open' as string | null,
  checkedAt: null as string | null,
  changeStatus: null as string | null,
};

describe('PR_STATE_TTL_MS', () => {
  it('is thirty minutes', () => {
    expect(PR_STATE_TTL_MS).toBe(30 * 60 * 1000);
  });
});

describe('isPrStateFresh', () => {
  it('is fresh inside the window', () => {
    expect(isPrStateFresh('2026-08-20T11:31:00Z', NOW)).toBe(true);
  });

  it('is stale outside the window', () => {
    expect(isPrStateFresh('2026-08-20T11:29:00Z', NOW)).toBe(false);
  });

  it('treats the boundary itself as stale', () => {
    // Exactly 30 minutes old: the window has elapsed, so re-check.
    expect(isPrStateFresh('2026-08-20T11:30:00Z', NOW)).toBe(false);
  });

  it('is never fresh without a usable stamp', () => {
    // Fail open — a missing or corrupt timestamp must not freeze a PR out of
    // refreshing forever.
    expect(isPrStateFresh(null, NOW)).toBe(false);
    expect(isPrStateFresh(undefined, NOW)).toBe(false);
    expect(isPrStateFresh('not a date', NOW)).toBe(false);
  });

  it('tolerates a future stamp rather than refreshing in a loop', () => {
    expect(isPrStateFresh('2026-08-20T12:05:00Z', NOW)).toBe(true);
  });

  it('honours a caller-supplied window', () => {
    const fiveMinutes = 5 * 60 * 1000;
    expect(isPrStateFresh('2026-08-20T11:58:00Z', NOW, fiveMinutes)).toBe(true);
    expect(isPrStateFresh('2026-08-20T11:50:00Z', NOW, fiveMinutes)).toBe(false);
  });
});

describe('decidePrRefresh', () => {
  it('checks a never-checked open PR', () => {
    expect(decidePrRefresh(base, NOW)).toEqual({ check: true });
  });

  it('skips a PR checked inside the window', () => {
    expect(decidePrRefresh({ ...base, checkedAt: '2026-08-20T11:45:00Z' }, NOW)).toEqual({
      check: false,
      reason: 'fresh',
    });
  });

  it('re-checks once the window has passed', () => {
    expect(decidePrRefresh({ ...base, checkedAt: '2026-08-20T11:00:00Z' }, NOW)).toEqual({
      check: true,
    });
  });

  it('never re-checks a terminal PR state', () => {
    // merged and closed are permanent — no number of presses should spend a
    // call re-confirming them.
    for (const prState of ['merged', 'closed']) {
      expect(decidePrRefresh({ ...base, prState }, NOW)).toEqual({
        check: false,
        reason: 'already-terminal',
      });
    }
  });

  it('never re-checks a review whose change already ended', () => {
    for (const changeStatus of ['merged', 'abandoned']) {
      expect(decidePrRefresh({ ...base, changeStatus }, NOW)).toEqual({
        check: false,
        reason: 'already-terminal',
      });
    }
  });

  it('skips a review with no PR url at all', () => {
    expect(decidePrRefresh({ ...base, prUrl: null }, NOW)).toEqual({
      check: false,
      reason: 'no-pr-url',
    });
  });

  it('skips a PR url the grammar cannot parse', () => {
    expect(decidePrRefresh({ ...base, prUrl: 'https://example.com/nope' }, NOW)).toEqual({
      check: false,
      reason: 'unparseable-pr-url',
    });
  });

  it('lets force override freshness but not terminality', () => {
    const fresh = { ...base, checkedAt: '2026-08-20T11:59:00Z' };
    expect(decidePrRefresh(fresh, NOW, true)).toEqual({ check: true });
    // Forcing a merged PR still buys nothing — the answer cannot change.
    expect(decidePrRefresh({ ...fresh, prState: 'merged' }, NOW, true)).toEqual({
      check: false,
      reason: 'already-terminal',
    });
  });

  it('reports terminality ahead of freshness', () => {
    // A long-merged PR is terminal, not merely "checked recently" — the reason
    // the caller reports should say why it will never be checked again.
    const both = { ...base, prState: 'merged', checkedAt: '2026-08-20T11:59:00Z' };
    expect(decidePrRefresh(both, NOW)).toEqual({ check: false, reason: 'already-terminal' });
  });

  it('covers external-PR reviews, which have no change to read', () => {
    // The whole point of storing state on the review: with changeStatus null
    // there is no other signal, so these must still be checked.
    expect(decidePrRefresh({ ...base, changeStatus: null, prState: null }, NOW)).toEqual({
      check: true,
    });
  });

  it('honours a caller-supplied window', () => {
    const record = { ...base, checkedAt: '2026-08-20T11:50:00Z' };
    expect(decidePrRefresh(record, NOW, false, 30 * 60 * 1000)).toMatchObject({ check: false });
    expect(decidePrRefresh(record, NOW, false, 5 * 60 * 1000)).toEqual({ check: true });
  });
});

describe('derivePrState', () => {
  it('reports merged even though GitHub also calls it closed', () => {
    expect(derivePrState({ state: 'closed', merged: true })).toBe('merged');
  });

  it('distinguishes closed-without-merge from merged', () => {
    expect(derivePrState({ state: 'closed', merged: false })).toBe('closed');
  });

  it('reports an open PR as open', () => {
    expect(derivePrState({ state: 'open', merged: false })).toBe('open');
    expect(derivePrState({ state: 'open', merged: null })).toBe('open');
  });
});

describe('parsePrUrl', () => {
  it('reads owner, repo, and number from a canonical url', () => {
    expect(parsePrUrl(PR)).toEqual({ owner: 'acme', repo: 'widget', pull_number: 42 });
  });

  it('returns null for anything that is not a PR url', () => {
    expect(parsePrUrl('https://github.com/acme/widget')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
  });
});
