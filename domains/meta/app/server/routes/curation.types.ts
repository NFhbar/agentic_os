// Wire-shape types for the curation route. Per standard-shared-types — the
// server (`curation.ts`) and the client (`apps/curation/View.tsx`) consume
// the same shape; this is the canonical definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `curation.ts`.

// One row in the curation queue. `discovered: true` means the file was
// found on disk (in `vault/raw/`) but was not present in the pending-curation
// queue — i.e. an external drop that bypassed the PostToolUse hook.
export interface CurationItem {
  path: string;
  preview: string;
  mtime: string | null;
  discovered: boolean;
}

// GET /api/curation response.
export interface CurationListResponse {
  items: CurationItem[];
}
