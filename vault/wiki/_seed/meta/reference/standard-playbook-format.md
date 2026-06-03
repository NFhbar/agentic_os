---
id: standard-playbook-format
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, playbook]
source: manual
private: false
title: Playbook format standard
url: internal://standard/playbook-format
kind: doc
last_verified: 2026-05-19
---

# Playbook format standard

## What it is

Mandatory shape of every `domains/<x>/playbook.md`. Playbooks are the per-domain markdown protocols that skills read as context — the router uses them to understand how a domain operates.

## Frontmatter

```yaml
---
domain: <name>
version: <integer>
created: <ISO 8601 UTC>
updated: <ISO 8601 UTC>
---
```

## Required sections (in this order)

1. **H1 title** — display name of the domain
2. **## Purpose** — one paragraph describing what work happens here
3. **## Entities** — what kinds of "things" the domain tracks (maps to archetypes)
4. **## Skills** — list of domain skills (one-line each)
5. **## Apps** — optional apps the domain exposes
6. **## Sub-domains** — nested domain folders
7. **## Conventions** — naming, file locations, domain-specific patterns
8. **## Cross-domain links** — entities or decisions here that affect other domains

## Optional sections

Additional H2 sections may follow the required set. The `meta` playbook adds an extensive "Standards" section, for example.

## Rationale

- Consistent shape lets the router parse playbooks reliably
- The skill list doubles as a discovery surface in the dashboard
- "Conventions" gives scaffolders a place to lock domain-specific patterns
- "Cross-domain links" makes graph relationships explicit

## Related

- [[standard-skill-format]] · [[standard-file-naming]]
- [[meta-add-domain]] — scaffolds a new domain (creates the playbook from template)
- [[meta-add-app]] — adds an optional app inside a domain
