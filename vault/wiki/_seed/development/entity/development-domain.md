---
id: development-domain
type: entity
domain: development
created: 2026-06-02T18:00:00Z
updated: 2026-06-02T18:00:00Z
tags: [system, ownership]
source: seed
private: false
name: Development domain
kind: system
links: []
---

# Development domain

## Context

The OS's outward-facing engineering surface — handles writing code, opening PRs, reviewing them, addressing comments, and closing changes against external repos. Owner of `dev-*` skills and the PR-review sub-domain. Sibling to `[[meta-domain]]` (which governs the OS itself).

Referenced as the `owner:` on development-scoped runbooks + scheduled reports (e.g. daily status reports for code projects).

## Notable details

- Implemented as `domains/development/` with the playbook + sub-domain rules at `domains/development/playbook.md`
- Owns all `dev-*` skills under `.claude/skills/` (write-change, review-change, open-pr, pr-review, address-comments, close-change, etc.)
- The PR-review sub-domain lives at `domains/development/pr-review/` with its own playbook
- Integrates with external repos via the github MCP at `mcps/github/`
- Runbooks/schedules that operate on code work declare `owner: development-domain`

## Links

- [[concept-domain]] — what a domain is
- [[meta-domain]] — sibling system entity (OS itself)
- [[standard-feature-anatomy]] — how a domain accepts new capabilities
