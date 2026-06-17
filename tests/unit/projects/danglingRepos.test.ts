// Tier 1 unit tests for the dangling-repo detector.
//
// `danglingRepos` returns the project repo ids with no ingested repo entity
// behind them. It mirrors the repo-picker's manifest filter, so the cases
// here also guard the invariant that "unselectable in the picker" and
// "flagged dangling in the detail pane" stay the same set.

import { describe, expect, it } from 'vitest';
import { danglingRepos } from '../../../domains/meta/app/src/lib/repos.js';
import type { ManifestEntry } from '../../../domains/meta/app/src/lib/vault.js';

function makeEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    path: 'vault/wiki/development/entity/x.md',
    id: 'x',
    type: 'entity',
    kind: 'repo',
    domain: 'development',
    title: null,
    created: null,
    updated: null,
    tags: [],
    source: null,
    private: false,
    snippet: '',
    backlinks: [],
    ...overrides,
  };
}

describe('danglingRepos', () => {
  it('flags repos with no kind:repo entity', () => {
    const entries = [makeEntry({ id: 'agentic-os' })];
    expect(danglingRepos(['mercury', 'agentic-os'], entries)).toEqual(['mercury']);
  });

  it('returns [] when every repo has an entity', () => {
    const entries = [makeEntry({ id: 'agentic-os' }), makeEntry({ id: 'mercury' })];
    expect(danglingRepos(['mercury', 'agentic-os'], entries)).toEqual([]);
  });

  it('ignores non-repo entities with a matching id', () => {
    const entries = [
      makeEntry({ id: 'mercury', type: 'project', kind: null }),
      makeEntry({ id: 'mercury', type: 'entity', kind: 'person' }),
    ];
    expect(danglingRepos(['mercury'], entries)).toEqual(['mercury']);
  });

  it('handles empty repos / empty manifest', () => {
    expect(danglingRepos([], [makeEntry()])).toEqual([]);
    expect(danglingRepos([], [])).toEqual([]);
    expect(danglingRepos(['mercury'], [])).toEqual(['mercury']);
  });
});
