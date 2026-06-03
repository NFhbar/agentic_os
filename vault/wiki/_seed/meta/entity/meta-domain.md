---
id: meta-domain
type: entity
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [system, ownership]
source: seed
private: false
name: Meta domain
kind: system
links: []
---

# Meta domain

## Context

The OS as an entity. Owns OS-evolution skills, scaffolding templates, standards, the dashboard, and the heartbeat. Referenced as the owner of meta-domain runbooks, scheduled jobs, and any work that touches OS structure itself.

## Notable details

- Implemented as `domains/meta/` with the dashboard app at `domains/meta/app/`
- Owns all `meta-*` skills under `.claude/skills/`
- Standards live at `vault/wiki/_seed/meta/reference/`
- Scheduled jobs that operate on the OS itself (morning brief, curation health check) declare `owner: meta-domain`

## Links

- [[concept-domain]] — what a domain is
- [[concept-primitives]] — every primitive the meta-domain governs
- [[standard-feature-anatomy]] — how the meta-domain accepts new capabilities
