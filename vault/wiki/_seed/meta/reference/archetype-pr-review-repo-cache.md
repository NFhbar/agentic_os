---
id: archetype-pr-review-repo-cache
type: reference
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [archetype, memory, development, review, cache]
source: seed
private: false
title: PR review repo cache archetype
url: internal://archetype/pr-review-repo-cache
kind: doc
last_verified: 2026-05-22
---

# PR review repo cache archetype

## What it is

A **pr-review-repo-cache** entry tracks one read-only repo clone kept on disk for [[dev-pr-review]] to read code context against. Distinct from the [[archetype-entity]] (`kind: repo`) used by [[dev-write-change]] / [[dev-open-pr]] — those repos are working trees where the OS authors changes, branches, and pushes; cache entries are ephemeral, shallow, never written to.

One cache entry per `<owner>/<repo>` pair. Multiple reviews of different PRs on the same repo share the same cache entry — the entry is updated (not duplicated) when [[dev-cache-pr-review-repo]] re-fetches before a review.

## Required frontmatter (in addition to shared)

| field            | type   | notes                                                                                 |
| ---------------- | ------ | ------------------------------------------------------------------------------------- |
| `title`          | string | Short, scannable (`"Repo cache: acme/api"`)                                           |
| `owner`          | string | GitHub owner / org (`acme`, `acme`)                                                   |
| `repo`           | string | GitHub repo name (`api`, `web-client`)                                                |
| `default_branch` | string | The branch the cache mirrors. Discovered on first clone via `origin/HEAD`             |
| `local_path`     | string | Path relative to repo root — typically `.claude/state/pr-review-cache/<owner>/<repo>` |
| `status`         | enum   | `ready`, `indexing`, `error`                                                          |
| `last_pulled`    | string | ISO timestamp — when the cache was last `fetch + reset`'d                             |

## Optional frontmatter

| field         | type    | notes                                                                                              |
| ------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `clone_url`   | string  | HTTPS clone URL captured at first clone (default `https://github.com/<owner>/<repo>.git`)          |
| `files_count` | integer | Cached count of non-`.git` files in the clone — refreshed on each pull                             |
| `size_bytes`  | integer | Cached on-disk size (bytes) — refreshed on each pull                                               |
| `last_error`  | string  | Captured error message when `status: error` (else absent)                                          |
| `head_sha`    | string  | Git SHA of HEAD at last pull — lets `repo-knowledge` detect drift via `based_on_commit` comparison |

## Stage 1 indexing fields (managed by dev-cache-pr-review-repo)

Cheap heuristics computed on every cache pull (no Claude calls). Snapshotted onto the entry so downstream consumers (the dashboard's Repos tab, [[dev-pr-review]]'s prompt context) don't have to re-walk the cache dir.

| field              | type    | notes                                                                                                                   |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `build_system`     | string  | Detected from manifest file: `npm`, `pnpm`, `yarn`, `cargo`, `go-modules`, `pip`, `poetry`, `make`, or `unknown`        |
| `type_system`      | string  | `typescript` (tsconfig present), `python-typed` (mypy.ini / py.typed), `rust`, `go`, `flow`, or `none`                  |
| `test_pattern`     | string  | Detected layout: `colocated` (`*.test.*` adjacent), `parallel` (`tests/` dir), `dunder` (`__tests__/`), `none-detected` |
| `deps_count`       | integer | Number of direct dependencies in the primary manifest file                                                              |
| `has_readme`       | boolean | README.\* found at the root                                                                                             |
| `has_contributing` | boolean | CONTRIBUTING.\* found at the root or in .github/                                                                        |
| `has_changelog`    | boolean | CHANGELOG.\* found at the root                                                                                          |

### `languages` (nested, js-yaml-only)

```yaml
languages:
  - [ts, 1284]
  - [js, 213]
  - [md, 47]
```

Tuples of `[extension, file_count]`, sorted descending. The manifest's flat parser drops this field (it can't handle nested YAML), but the dashboard's `js-yaml`-backed reads pick it up fine. Per the same precedent as `pr-review`'s `config:` block.

This is enough for the Repos tab's language chip + the review prompt's "this is a TS-heavy repo" hint. We don't try to compute LOC or weight by file size — that's polish for later.

## Lifecycle

| stage      | what it means                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------- |
| `indexing` | First clone in progress, or refresh-pull in progress. Skill mutex prevents concurrent writes. |
| `ready`    | Cache exists at `local_path`, last_pulled is fresh, files can be read.                        |
| `error`    | Last operation failed. `last_error` describes what went wrong. Re-run skill to retry.         |

There are no terminal states — entries persist until manually deleted, refreshed by the skill, or pruned by a future eviction policy.

## When to use

- A PR submitted for review needs code context beyond the diff alone
- A user wants to pre-warm the cache for a repo they expect to review against frequently
- The Repos tab in the PR Review app wants to list "what's cached and how big"

## When NOT to use

- For repos the OS will WRITE to (open PRs against, author changes for). Use [[archetype-entity]] with `kind: repo` for those — the working tree there is mutable and tracks branches.
- To replace `git clone` for general purposes. The cache is purpose-built for read-only PR review context; if you need a full history clone you want `git clone --no-shallow` outside the OS.

## Body sections

```markdown
# <title>

## Purpose
One-paragraph reminder that this is a read-only cache for PR review context.

## Refresh history
- <ISO>: clone (initial)
- <ISO>: fetch + reset → no diff vs prior pull
- <ISO>: fetch + reset → <delta>
```

The body's "Refresh history" is updated by [[dev-cache-pr-review-repo]] on each pull, capped at the most recent N entries (currently 10) so the file doesn't grow unbounded.

## Composition

```
pr-review-repo-cache(acme/api)         ← cached at .claude/state/pr-review-cache/acme/api
  ├─ pr-review(pr-review-acme-api-1)   ← reviews of api's PR #1
  ├─ pr-review(pr-review-acme-api-2)   ← reviews of api's PR #2
  └─ ...
```

The cache is a many-to-one shared resource. Deleting the cache entry doesn't invalidate existing pr-review entries — those snapshots are immutable historical records of what the model saw at review time.

## Outputs / artifacts produced

| artifact          | location                                           | when                                                   |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------ |
| Cache entry       | `vault/wiki/<domain>/pr-review-repo-cache/<id>.md` | Created on first clone, updated on each refresh        |
| Cached repo clone | `.claude/state/pr-review-cache/<owner>/<repo>/`    | Created on first clone, mutated by `git fetch + reset` |

## Example

```markdown
---
id: pr-review-repo-cache-acme-api
type: pr-review-repo-cache
domain: development
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T14:30:00Z
tags: [cache, review]
source: dev-cache-pr-review-repo
private: false
title: 'Repo cache: acme/api'
owner: acme
repo: api
default_branch: main
local_path: .claude/state/pr-review-cache/acme/api
clone_url: https://github.com/acme/api.git
status: ready
last_pulled: 2026-05-22T14:30:00Z
head_sha: a3f9b2e1c0d8f7e6b5a4938271605f4e3d2c1b0a
files_count: 87
size_bytes: 412543
build_system: npm
type_system: typescript
test_pattern: colocated
deps_count: 14
has_readme: true
has_contributing: false
has_changelog: false
languages:
  - [ts, 64]
  - [md, 12]
  - [json, 8]
  - [yml, 3]
---

# Repo cache: acme/api

## Purpose
Read-only shallow clone of `main` for dev-pr-review to consult when reviewing PRs against this repo. Never written to; refreshed via `git fetch + reset --hard` on demand.

## Refresh history
- 2026-05-22T14:30:00Z: fetch + reset → up-to-date with origin/main
- 2026-05-22T14:00:00Z: clone (initial)
```

## Related

- [[archetype-pr-review]] — the review entries that consume this cache for code context
- [[dev-cache-pr-review-repo]] — the skill that creates and refreshes cache entries
- [[dev-pr-review]] — the consumer that invokes the cache skill at review time
- [[archetype-entity]] — the _other_ repo concept (`kind: repo`), used for repos the OS writes to
