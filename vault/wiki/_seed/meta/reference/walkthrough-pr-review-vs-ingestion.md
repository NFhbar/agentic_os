---
id: walkthrough-pr-review-vs-ingestion
type: reference
domain: meta
created: 2026-06-01T20:30:00Z
updated: 2026-06-01T20:30:00Z
tags: [walkthrough, tutorial, repo, ingestion, pr-review, explainer]
source: vault/wiki/development/change/guide-walkthroughs-section.md
private: false
title: "Walkthrough — PR-review repos vs. ingested repos"
url: internal://walkthrough/pr-review-vs-ingestion
kind: walkthrough
last_verified: 2026-06-01
---

# Walkthrough — PR-review repos vs. ingested repos

The OS has **two** mechanisms for tracking external code repositories. They look superficially similar but have very different semantics and lifecycles. Picking the wrong one wastes work; understanding the distinction up front saves confusion.

## TL;DR

| Capability        | Ingested repo (`entity`)                  | PR-review cache (`pr-review-repo-cache`)                      |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Purpose           | Long-term work target                     | Short-term review context                                     |
| Created by        | `dev-ingest-repo`                         | `dev-cache-pr-review-repo`                                    |
| Lives at          | `repos/<slug>/`                           | `.claude/state/pr-review-cache/<owner>/<repo>/`               |
| Wiki entry        | `entity` archetype                        | `pr-review-repo-cache` archetype                              |
| Owns changes?     | Yes (changes target it via `repo:` field) | No                                                            |
| Owns conventions? | Yes (entity body's Conventions section)   | No                                                            |
| Refreshed how?    | On-demand via re-ingest                   | Auto every dashboard sync; the cache is meant to be transient |
| Gitignored?       | The clone is gitignored from agentic-os   | Yes — entirely local-machine state                            |

## Mental model

**Ingested repo = "this is a project I work on."**
You expect to open many changes against it over time. You want OS-managed conventions, automation, change tracking, status reports. The entity entry is curated — you might hand-edit its body to add a `## Conventions` section explaining a non-obvious house style. The repo's clone is owned by the OS at `repos/<slug>/` and never goes stale by accident.

**PR-review cache = "I need to review someone's PR."**
A short-lived snapshot of a repo's code so the `dev-pr-review` skill has something to walk. The cache exists for the duration of the review session, gets refreshed on every dashboard sync (cheap `git fetch`), and is throwaway — the OS doesn't care about its long-term state. You don't open changes against it; you just need it locally so review can read the code being changed.

## When to use each

### Ingest as an entity if…

- You'll open changes against this repo from inside the OS
- Multiple projects will reference the same repo as their implementation target
- You want repo-specific conventions (`## Conventions` section) that override the universal `standard-code-quality` defaults
- The repo's lifecycle matters: deadlines, milestones, status reports

→ See [[walkthrough-ingest-repo]].

### Use the PR-review cache if…

- You're reviewing PRs on a repo you don't own (open-source contribution, code review for another team, agency client work)
- You won't be writing changes against it from inside the OS
- You just need `dev-pr-review` to have a recent local copy for context

→ Triggered automatically when you first open a PR review for a repo via the PR Review app's reviews list. No manual ingest needed.

## Can a repo be both?

**Yes, and it's fine.** Nothing prevents a repo from having both an `entity` entry (because you work on it) and a `pr-review-repo-cache` entry (because dev-pr-review needed a snapshot). They live in different directories with different slug conventions:

- entity: `api`
- cache: `pr-review-repo-cache-acme-api`

They don't interact — the entity is curated long-term state, the cache is transient review state. When you review a PR on `api` (which you own), the system uses the cache for the review walk, not the entity's repo clone.

## What gets created (side-by-side)

### Ingest path

```
repos/<slug>/                                              ← clone (managed)
vault/wiki/development/entity/<slug>.md                    ← entity entry (curated)
vault/wiki/development/repo-knowledge/repo-knowledge-<owner>-<repo>.md
                                                           ← optional analyze output
```

### PR-review path

```
.claude/state/pr-review-cache/<owner>/<repo>/              ← cache clone (transient)
vault/wiki/development/pr-review-repo-cache/pr-review-repo-cache-<owner>-<repo>.md
                                                           ← cache entry (frontmatter)
vault/wiki/development/repo-knowledge/repo-knowledge-<owner>-<repo>.md
                                                           ← optional analyze output (shared!)
```

**Note** — the `repo-knowledge` entry is **shared** between the two paths. `dev-analyze-repo-for-review` produces one prose-knowledge document per `<owner>/<repo>`; both the entity and the cache can reference it.

## The cache lifecycle (briefly)

For the PR-review path, the cache entry has its own state machine managed by `dev-cache-pr-review-repo`:

- `indexing` → cache is being created (first time)
- `ready` → cache is current; `head_sha` tracks remote HEAD
- `error` → fetch or analyze failed; `last_error` carries the message

The cache auto-refreshes on every dashboard sync (cheap) so `head_sha` stays current. The `dev-analyze-repo-for-review` skill (Stage 2 — Claude call) runs less often: only when the audit's `repo-knowledge-stale` finding fires, or you click the Repos tab's analyze button manually. As of `[[dev-analyze-repo-fetch-step]]`, the analyze skill itself does a fresh `git fetch && reset --hard origin/<default>` before reading the cache to ensure `based_on_commit` reflects upstream HEAD.

## Where to find each in the dashboard

- **Ingested repos** — Sidebar → Domains → development → Entities, or the Vault view filtered by `type: entity, tags: repo`.
- **PR-review caches** — Sidebar → PR Review app. The Reviews list shows PRs; clicking one drills into the review detail. The associated cache is implicit — the dashboard surfaces cache state on the review detail page (analyzed_at, head_sha, refresh button) rather than in a standalone caches list.

## Gotchas

- **Don't manually edit the cache directory.** It's read-only by convention — the `dev-cache-pr-review-repo` skill does `reset --hard origin/<default>` on every refresh, so any local edits would be lost.
- **Don't expect an ingested entity to auto-refresh.** `dev-ingest-repo` is a one-time setup. To re-pull, run it again with `overwrite: true` (or re-clone manually).
- **The PR-review cache slug differs from the entity slug.** Cache: `pr-review-repo-cache-<owner>-<repo>`. Entity: just `<repo>` (with optional owner prefix for disambiguation). When skills cross-reference, they resolve via the manifest — you rarely type these slugs by hand.

## See also

- [[walkthrough-ingest-repo]] — the ingest-as-entity flow
- [[walkthrough-write-change]] — change lifecycle (uses the ingested entity)
- [[archetype-entity]] — long-term repo entity
- [[archetype-pr-review-repo-cache]] — transient review cache
