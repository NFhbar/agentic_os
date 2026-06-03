---
id: walkthrough-ingest-repo
type: reference
domain: meta
created: 2026-06-01T20:30:00Z
updated: 2026-06-01T20:30:00Z
tags: [walkthrough, tutorial, repo, ingestion, getting-started]
source: vault/wiki/development/change/guide-walkthroughs-section.md
private: false
title: "Walkthrough — ingest a repo"
url: internal://walkthrough/ingest-repo
kind: walkthrough
last_verified: 2026-06-01
---

# Walkthrough — ingest a repo

Bring an external code repository into the OS as a first-class entity. Once ingested, the repo can own changes, anchor PR-review flows, and serve as the implementation target for projects.

## Goal

After this walkthrough you have:

- A local clone at `repos/<slug>/` (auto-managed)
- A wiki entity entry at `vault/wiki/development/entity/<slug>.md` carrying detected language(s), build system, conventions, and any custom tags you set
- A repo registered with the OS — every `dev-add-change` / `dev-pr-review` / repo-knowledge analysis can target it by slug

## Prerequisites

- The OS is installed (`./install.sh` ran cleanly)
- The dashboard server is running (or you'll use `/os` CLI)
- GitHub repo URL OR local path to a repo on disk

## Steps (UI)

1. **Open the Overview page** (default landing view). Find the Quick Actions row.
2. Click **`+ Repo`**.
3. The `ScaffoldForm` opens. Fill in:
   - **`source`** _(required)_ — GitHub URL (`https://github.com/owner/name`), shorthand (`owner/name`), or absolute path to a local repo. Examples: `https://github.com/acme/api`, `acme/api`, `/Users/me/Code/myproject`.
   - **`slug`** _(optional)_ — Override the entity slug. Defaults to a kebab-case derivation. Use this if the natural slug collides with an existing entity.
   - **`tags`** _(optional)_ — Comma-separated free tags (in addition to auto-detected `[repo, ...detected]`).
   - **`overwrite`** _(optional)_ — Default `false`. Set `true` to replace an existing entity with the same slug. Use only when re-ingesting.
4. Click **Submit**. The `dev-ingest-repo` skill runs as a subprocess (you'll see it in the Runs view).
5. Wait for the run to land. On success the entity entry exists and is queryable.

## Steps (CLI)

```bash
/os ingest repo acme/api
# or with explicit slug + tags
/os ingest repo https://github.com/acme/api --slug api --tags evm,indexer
```

## What gets created

```
repos/<slug>/                                   ← managed clone (gitignored from agentic-os)
vault/wiki/development/entity/<slug>.md         ← wiki entity entry
.claude/state/events.db                         ← row recording the ingestion
```

The entity entry's frontmatter carries:

- `repo_url`, `default_branch`, `head_sha`
- Detected `languages: []`, `build_system`, `test_pattern`, `type_system`
- `tags: [repo, ...auto-detected, ...user-supplied]`

The body has prose sections (Conventions, Stack, Structure) written by the skill — these are surface-level. For deeper repo-knowledge used by PR review, see `dev-analyze-repo-for-review` (different skill, different output).

## What to do next

- **Browse the entity** — Vault view, find your repo under `development/entity/`. Read the auto-written body.
- **Add a project that targets this repo** — see [[walkthrough-add-project]]. The project's `repos:` array references the slug.
- **Open a change against it** — see [[walkthrough-write-change]]. `dev-add-change` lifts the entity's conventions into the change's plan.
- **Add custom conventions** — edit the entity body's `## Conventions` section. Future `dev-write-change` runs read these. Repo-specific conventions override the universal `standard-code-quality` standards where they conflict.

## Gotchas

- **Existing slug refuses by default.** If a previous ingest created the same slug, you need `overwrite: true` (and the OS will warn). This protects you from accidentally clobbering hand-edited entity entries.
- **Local repos are referenced in place.** When `source` is a local path, the OS does NOT clone — it links the entity entry to your working tree. Edits in that tree are visible to OS skills immediately. The opposite is true for GitHub sources: the OS owns the clone at `repos/<slug>/`, and your home-directory clone (if any) is unrelated.
- **First ingest auto-analyzes the repo** (skill detects build system, runs heuristics). For the deeper Claude-call analysis used by PR review, run `dev-analyze-repo-for-review` separately.

## See also

- [[walkthrough-pr-review-vs-ingestion]] — when to ingest vs. use the PR-review cache
- [[archetype-entity]] — full entity archetype reference
- [[standard-repo-ingestion]] — the ingestion model standard
