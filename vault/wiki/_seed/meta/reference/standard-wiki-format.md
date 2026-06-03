---
id: standard-wiki-format
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, wiki, memory]
source: manual
private: false
title: Wiki entry format standard
url: internal://standard/wiki-format
kind: doc
last_verified: 2026-05-19
---

# Wiki entry format standard

## What it is

Mandatory shape of every file under `vault/wiki/`. Combines shared frontmatter (every entry) with per-archetype required fields.

## Shared frontmatter (required on every entry)

```yaml
---
id: <kebab-slug-or-uuid> # unique within (domain, type)
type: <archetype> # one of entity, decision, runbook, reference, project, note (or registered)
domain: <domain> # required
created: <ISO 8601 UTC> # required
updated: <ISO 8601 UTC> # required
tags: [<string>, ...] # required (may be empty)
source: <provenance> # required (raw/path, conversation/id, manual, dashboard-action/ts)
private: <bool> # required; if true, entry is excluded from AI prompts
---
```

## Per-archetype additions

See the individual archetype entries:

- [[archetype-entity]]
- [[archetype-decision]]
- [[archetype-runbook]]
- [[archetype-reference]]
- [[archetype-project]]
- [[archetype-note]]

## Optional shared fields

These optional fields can appear on **any** archetype when relevant. The audit recognizes them across types.

| field     | type   | semantics                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project` | string | id of a project this entry **belongs to** (captured under that project's work). Distinct from `[[<project-id>]]` wikilinks in the body, which are mere references. The audit checks the project exists. For scheduled runbooks, the same field also gates firing — the scheduler tick skips them unless the project's `status == active`. See [[standard-project-workflow]]. |

## Body

Free markdown after the closing `---`. Typically starts with an H1 matching `title` (or `name` for entities), followed by archetype-appropriate H2 sections.

## Wikilinks

`[[other-entry-id]]` references are parsed by the index rebuilder and stored as backlinks. They're how the graph forms.

## File path

`vault/wiki/<domain>/<archetype>/<slug>.md`

`<slug>` matches frontmatter `id` (kebab-case). Seed entries live at `vault/wiki/_seed/<domain>/<archetype>/<slug>.md`.

## Privacy

`private: true` excludes the entry from any AI prompt that might be sent to an external API (e.g. the dashboard's `claude` CLI shellout). Useful for sensitive notes.

## Rationale

- Shared frontmatter is the minimum needed for indexing, attribution, and privacy controls
- Per-archetype fields capture archetype-specific semantics
- Provenance (`source`) enables audit and roll-back of AI-curated entries
- Wikilinks form the graph without requiring a database

## Related

- [[standard-file-naming]] · [[standard-index-schema]]
- [[meta-add-archetype]] — registers new archetypes (template + reference entry)
- [[meta-curate]] — promotes `vault/raw/` items into typed wiki entries with archetype frontmatter
- [[meta-rename]] · [[meta-delete]] — operations on wiki entries that maintain cross-references
