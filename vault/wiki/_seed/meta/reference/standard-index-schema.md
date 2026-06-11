---
id: standard-index-schema
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, index]
source: manual
private: false
title: Vault index manifest schema
url: internal://standard/index-schema
kind: doc
last_verified: 2026-05-19
---

# Vault index manifest schema

## What it is

`vault/.index/manifest.json` is the derived index over `vault/wiki/`. It's rebuilt automatically by `.claude/hooks/rebuild-vault-index.sh` whenever a Write or Edit touches `vault/wiki/`.

## Schema

```json
{
  "version": 1,
  "generated": "2026-05-19T16:40:00Z",
  "entries": [
    {
      "path": "vault/wiki/<...>/<slug>.md",
      "id": "<slug>",
      "type": "<archetype>",
      "domain": "<domain>",
      "title": "<from frontmatter title or name>",
      "created": "<ISO 8601>",
      "updated": "<ISO 8601>",
      "tags": ["..."],
      "source": "<provenance>",
      "private": false,
      "project": "<owning-project-id or null>",
      "snippet": "<first ~200 chars of body, headings stripped>",
      "backlinks": ["<entry-id>", "..."]
    }
  ]
}
```

Beyond the identity fields shown, each entry carries ~35 scalar lifecycle/relationship lifts (change `status`/`pr_*`/`ci_*`, the `plan_*` + shared review-state cluster, research `report_*`, Overseer `audit_status`/`validation_result`, …). These are driven by the declarative `LIFTED_FIELDS` table in `.claude/hooks/rebuild-vault-index.mjs` — adding a manifest field is one `{name, type}` row there (`type: string | int`, with digit-string tolerance for pre-shared-parser entries), not a hand-written coercion. Absent fields lift as `null`. Server-side stage derivation over these fields lives in `domains/meta/app/server/lib/lifecycle-state.ts`.

## Consumers

- **Dashboard Overview** — counts by archetype, domain, recent updates
- **Dashboard Vault browser** — filter by archetype/domain/tag, full-text snippet search
- **`meta-brief`** — pending curation count, active project listing
- **Skills** — fast lookup of "entries about X" without grep over hundreds of files

## Search index — `vault/.index/search.db`

The same rebuild also writes a SQLite FTS5 sidecar: one `wiki_fts` virtual table over `id`, `title`, `tags`, and the full entry **body** (plus unindexed `path`/`type`/`domain` for filtering). The vault MCP's `search_wiki` queries it with BM25 ranking (column weights id 10 > title 5 > tags 3 > body 1) and FTS5 `snippet()` match context, falling back to the manifest substring scorer when the file is missing or locked mid-rebuild. Zero-hit queries are logged to events.db (`kind: mcp`, `action: vault-search-miss`) so retrieval misses are observable.

Added after the Fable review demonstrated the snippet-only scorer returning wrong-or-nothing for 3 of 4 realistic queries at ~300 entries — body-only knowledge (audit findings, review comments, decision prose) was unreachable.

## Rebuild trigger

- Automatic: PostToolUse hook (`Write|Edit` matcher) when path matches `vault/wiki/*`
- Manual: `node .claude/hooks/rebuild-vault-index.mjs`

## Gitignored

The index is derived data; the source of truth is the wiki markdown files. The index (manifest + search.db) is regenerated on first session after clone.

## Rationale

- A JSON index is fast to read in JavaScript (dashboard) and easy to grep
- Re-deriving from frontmatter avoids the "two sources of truth" problem
- Cheap to rebuild (small N) so we don't need incremental updates yet
- FTS5 was originally deferred until "~1000 entries"; in practice the substring scorer failed realistic body-content queries at ~300, so the search.db sidecar landed early (drop-and-rebuild per write — same cost profile as the manifest)

## Related

[[standard-wiki-format]], [[standard-hook-protocol]]
