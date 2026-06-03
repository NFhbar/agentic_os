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

export async function fetchManifest(): Promise<Manifest> {
  return getJson<Manifest>('/api/vault/index');
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
