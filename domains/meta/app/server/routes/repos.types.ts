// Wire-shape types for the repos route. Per standard-shared-types — the
// server (`repos.ts`) and the client (the PR Review app's Repos page +
// shared data.ts re-exports) consume the same shape; this is the canonical
// definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `repos.ts`.

// Server-internal summary of the repo-knowledge join, built up while walking
// the wiki dir. Not directly emitted on the wire — its fields are projected
// into `Repo` (analyzedAt / analyzerModel / knowledgeStatus / knowledgeStale).
export interface KnowledgeSummary {
  analyzedAt: string | null;
  analyzerModel: string | null;
  basedOnCommit: string | null;
  status: 'ready' | 'analyzing' | 'error';
}

// One row in GET /api/repos. The Repos tab renders these directly.
export interface Repo {
  id: string;
  name: string;
  org: string;
  branch: string;
  lang: string;
  files: number;
  size: string;
  indexed: string;
  status: 'indexed' | 'indexing' | 'stale' | 'error';
  reviews: number;
  // Optional `last_error` from the cache entry's frontmatter — surfaces when
  // status is 'error' but may also be set during recovery.
  error?: string;
  languages: Array<[string, number]>;
  // Stage 2 knowledge join (Phase 3.5) — null when no repo-knowledge entry
  // exists for this <owner>/<repo>. The Repos tab shows a "Re-analyze" button
  // on rows with a knowledge entry and a "Not analyzed" badge on rows without.
  analyzedAt: string | null;
  analyzerModel: string | null;
  knowledgeStatus: 'ready' | 'analyzing' | 'error' | 'missing';
  knowledgeStale: boolean;
  // Client-only — rendered while the repo is indexing to drive the progress
  // bar. Server never sets this.
  progress?: number;
}

// GET /api/repos response.
export interface ReposListResponse {
  repos: Repo[];
}
