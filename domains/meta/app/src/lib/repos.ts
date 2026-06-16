import type { ManifestEntry } from './vault';

// A project repo id is "dangling" when no ingested repo entity backs it.
// Mirrors the repo-picker's manifest filter (entity + kind:repo) so the set of
// ids unselectable in the picker is exactly the set flagged here.
export function danglingRepos(repos: string[], entries: ManifestEntry[]): string[] {
  const ingested = new Set(
    entries.filter((e) => e.type === 'entity' && e.kind === 'repo').map((e) => e.id),
  );
  return repos.filter((id) => !ingested.has(id));
}
