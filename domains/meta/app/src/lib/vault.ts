// Vault types + reader wrappers around /api/vault.

import { getJson } from './api';

export type Archetype = 'entity' | 'decision' | 'runbook' | 'reference' | 'project' | 'note';

export interface ManifestEntry {
  path: string;
  id: string | null;
  type: Archetype | string | null;
  // For `type: entity` entries, `kind` classifies further (repo, person,
  // service, etc.). Null for non-entity archetypes.
  kind: string | null;
  domain: string | null;
  title: string | null;
  created: string | null;
  updated: string | null;
  tags: string[];
  source: string | null;
  private: boolean;
  snippet: string;
  backlinks: string[];
}

export interface Manifest {
  version: number;
  generated: string | null;
  entries: ManifestEntry[];
}

// Module-level cache for the manifest. Set on first fetch; clients call
// fetchManifest(true) to force a refresh (post-edit, post-rename, etc.).
let _manifestCache: Promise<Manifest> | null = null;

export function fetchManifest(force = false): Promise<Manifest> {
  if (force || !_manifestCache) {
    _manifestCache = getJson<Manifest>('/api/vault/index');
  }
  return _manifestCache;
}

// Returns id → type map. Used by EditableMarkdown's wikilink resolver so
// wikilinks can route polymorphically to the type-appropriate app (changes,
// pr-review) rather than always landing in the Vault generic entry view.
// Closes #449. Shares the same manifest cache as the Vault app.
export async function fetchEntryTypes(): Promise<Map<string, string>> {
  const m = await fetchManifest();
  const out = new Map<string, string>();
  for (const e of m.entries) {
    if (e.id && e.type) out.set(e.id, e.type);
  }
  return out;
}

export interface EntryResponse {
  path: string;
  content: string;
  mtime?: string | null;
}

export async function fetchEntry(path: string): Promise<EntryResponse> {
  return getJson(`/api/vault/entry?path=${encodeURIComponent(path)}`);
}

// Returns null if the file does not exist (HTTP 404), otherwise the entry.
// Useful for optional surfaces like the Overview's Latest brief card.
export async function fetchEntryOptional(path: string): Promise<EntryResponse | null> {
  const r = await fetch(`/api/vault/entry?path=${encodeURIComponent(path)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`/api/vault/entry?path=${path} → ${r.status}`);
  return r.json();
}
