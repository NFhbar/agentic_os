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

## Consumers

- **Dashboard Overview** — counts by archetype, domain, recent updates
- **Dashboard Vault browser** — filter by archetype/domain/tag, full-text snippet search
- **`meta-brief`** — pending curation count, active project listing
- **Skills** — fast lookup of "entries about X" without grep over hundreds of files

## Rebuild trigger

- Automatic: PostToolUse hook (`Write|Edit` matcher) when path matches `vault/wiki/*`
- Manual: `node .claude/hooks/rebuild-vault-index.mjs`

## Gitignored

The index is derived data; the source of truth is the wiki markdown files. The index is regenerated on first session after clone.

## Rationale

- A JSON index is fast to read in JavaScript (dashboard) and easy to grep
- Re-deriving from frontmatter avoids the "two sources of truth" problem
- Cheap to rebuild (small N) so we don't need incremental updates yet
- When wiki grows past ~1000 entries we add SQLite FTS5 on top of this manifest

## Related

[[standard-wiki-format]], [[standard-hook-protocol]]
