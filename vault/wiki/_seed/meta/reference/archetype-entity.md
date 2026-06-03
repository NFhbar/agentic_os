---
id: archetype-entity
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [archetype, memory]
source: manual
private: false
title: Entity archetype
url: internal://archetype/entity
kind: doc
last_verified: 2026-05-19
---

# Entity archetype

## What it is

A person, project, repo, system, or other "thing" you have an ongoing relationship with. Entities are nodes in the knowledge graph that other entries reference via `[[<entity-id>]]`.

## Required frontmatter (in addition to shared)

| field   | type   | notes                                                       |
| ------- | ------ | ----------------------------------------------------------- |
| `name`  | string | display name                                                |
| `kind`  | enum   | `person`, `project`, `repo`, `system`, or `other`           |
| `links` | array  | list of `[[other-entity-id]]` references (related entities) |

## Optional frontmatter — for `kind: repo` entities

When an entity is ingested via `dev-ingest-repo` (`kind: repo`), it carries
the following repo-specific fields. The full pattern is documented in
`standard-repo-ingestion.md`.

| field              | type   | notes                                                                          |
| ------------------ | ------ | ------------------------------------------------------------------------------ |
| `remote_url`       | string | GitHub URL (`https://github.com/owner/name`), or `null` for purely local repos |
| `local_path`       | string | absolute path on disk; for GitHub clones this is `<repo-root>/repos/<slug>/`   |
| `default_branch`   | string | the repo's default branch (typically `main` or `master`)                       |
| `current_branch`   | string | the branch the agent is currently working on (defaults to `default_branch`)    |
| `language`         | string | primary language detected (`typescript`, `python`, `go`, …)                    |
| `build_command`    | string | command to build/install (`npm install`, `cargo build`, …)                     |
| `test_command`     | string | command to run tests (`npm test`, `pytest`, …)                                 |
| `ci`               | string | CI system detected (`github-actions`, `circleci`, `gitlab-ci`, `none`)         |
| `license`          | string | SPDX identifier or short license name (`MIT`, `Apache-2.0`, …)                 |
| `ingested_at`      | string | ISO 8601 timestamp of the most recent ingestion run                            |
| `ingestion_source` | enum   | `github` or `local` — how the repo was reached                                 |

These fields enable downstream skills (`dev-pr-review`, future
`dev-write-feature-pr`) to operate on the repo without re-discovering metadata.

## When to use

Use `entity` when the thing has continuing existence and other entries will refer back to it. If something is one-off (a decision made once, a note), use those archetypes instead.

## Example

```markdown
---
id: agentic-os-repo
type: entity
domain: development
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [repo, internal]
source: manual
private: false
name: Agentic OS
kind: repo
links: [[meta-domain]]
---

# Agentic OS

## Context

The repo for this OS itself. Built as a self-extending workflow OS on top of Claude Code.

## Notable details

- Local-only at v1; Tailscale-tunnel-ready
- Vite + Fastify for the dashboard app

## Links

- `[[meta-domain]]` — the OS as a domain
```

## Related

[[archetype-project]] (vs. ongoing initiatives), [[archetype-reference]] (vs. external pointers)
