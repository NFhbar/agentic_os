---
id: standard-repo-ingestion
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [standard, ingestion, repo, development]
source: seed
private: false
title: Repository ingestion standard
url: internal://standard/repo-ingestion
kind: doc
last_verified: 2026-05-20
---

# Repository ingestion standard

## What this covers

How the OS knows about external code repositories — whether on GitHub or on the local filesystem. Ingestion produces a wiki `entity` entry (with `kind: repo`) plus, for GitHub sources, a clone at `repos/<slug>/`. Downstream skills (`dev-pr-review`, future `dev-write-feature-pr`) consume the entity's frontmatter as a navigational map.

## The shape

A repo entity is a wiki entry with these distinguishing characteristics:

```yaml
---
id: <slug>
type: entity
domain: development          # always
kind: repo                   # the entity discriminator
remote_url: <github URL or null>
local_path: <absolute path>
default_branch: main
current_branch: main         # updated by feature-work skills
language: typescript         # primary detected
build_command: npm install
test_command: npm test
ci: github-actions           # or none/circleci/gitlab-ci
license: MIT
ingested_at: <ISO>
ingestion_source: github     # or local
---
```

Field-by-field documentation: `archetype-entity.md` (optional frontmatter section).

## Storage layout

| asset        | location                                                            | committed?          |
| ------------ | ------------------------------------------------------------------- | ------------------- |
| entity entry | `vault/wiki/development/entity/<slug>.md`                           | yes                 |
| GitHub clone | `repos/<slug>/` (repo root)                                         | **no** (gitignored) |
| Local repos  | wherever they already live (referenced by `local_path`, not copied) | n/a                 |

`repos/` is added to the OS root `.gitignore` — the OS doesn't track external code, only its index of it.

## Ingestion vs work location

**v1 model: same location.** `repos/<slug>/` serves as both the read-only ingestion clone AND the read-write working directory for downstream feature work. Specific rules:

- After ingestion the clone is on `default_branch` with a clean working tree.
- Feature-work skills (when we add them) create branches like `agent/<feature-slug>` directly in this clone and update the `current_branch` field on the entity entry.
- **Re-ingestion** requires a clean working tree on `default_branch`. If the agent (or user) has work in progress, ingestion aborts with a clear message so nothing gets clobbered.
- **Concurrent features per repo** are not supported in v1 — only one active branch at a time.

**v2 upgrade path:** when parallelism becomes useful, downstream skills can use Claude Code's built-in `EnterWorktree` / `ExitWorktree` tools to isolate per-feature work without duplicating the `.git/`. The base clone in `repos/<slug>/` stays as the ingestion reference; worktrees branch off it. The entity entry would then track `working_branches: [...]` instead of a single `current_branch`.

## GitHub vs local — discriminator order

The skill discriminates `source` in this strict order (first match wins):

1. Starts with `https://github.com/` or `http://github.com/` → GitHub URL
2. Starts with `git@github.com:` → GitHub SSH URL
3. Starts with `/` → absolute local path
4. Starts with `./` or `../` → relative local path (resolved against the OS repo root)
5. Matches `^[\w.-]+/[\w.-]+$` AND no local directory of that name exists → GitHub shorthand (rewrites to `https://github.com/<source>`)
6. Otherwise reject

This ordering means a local directory called `owner/repo` takes precedence over the GitHub shorthand interpretation — local paths win when ambiguous.

## What gets analyzed

Medium-depth analysis only. The skill reads:

- `README.md` (+ CONTRIBUTING, CHANGELOG, LICENSE, CODEOWNERS, PULL_REQUEST_TEMPLATE) for purpose, conventions, contribution model
- One of `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `Gemfile` (whichever is dominant) for stack + commands
- Style configs (`biome.json`, `.prettierrc`, `.editorconfig`, `[tool.ruff]`)
- CI configs (`.github/workflows/*.yml`, `.circleci/config.yml`, `.gitlab-ci.yml`)
- Top-2-level directory layout (skipping vendored/derived dirs)
- Language-aware entry point inference (`src/index.ts`, `src/main.py`, `cmd/<name>/main.go`, …)

The skill does **not** in v1:

- Read every source file
- Generate per-module documentation
- Build a dependency graph
- Run the test suite to discover behavior
- Compute embeddings or any kind of vector index

If the agent later needs file-level detail, it uses Read/Grep/Glob on the cloned tree on demand. The entity entry is the map; the code is the territory.

## Re-ingestion

Re-running `dev-ingest-repo` against the same source with `overwrite: true`:

- For a GitHub source: pulls latest on the default branch (clone must be clean), refreshes metadata, rewrites the entity entry with new `ingested_at`
- For a local source: re-reads files, rewrites the entry
- **Preserves** `current_branch` and any free-form tags the user added — these are agent state, not derived from the repo

Without `overwrite: true`, ingestion of an existing slug aborts. The skill prints the existing entry's path so the user can decide whether to refresh or rename.

## Cleanup / retirement

To remove an ingested repo:

1. Use `/os delete entity <slug>` (existing `meta-delete` skill handles wiki entries with cross-reference cleanup).
2. Manually delete the clone: `rm -rf repos/<slug>/` (the OS doesn't manage the clone's lifecycle — it's gitignored and disposable).

Future: a `dev-deingest-repo` skill could do both in one step. Not v1.

## Authentication notes

- GitHub clones use `gh repo clone` first (which uses the user's `gh` auth), falling back to plain `git clone` if `gh` is missing or unauthenticated.
- Private repos require either `gh auth login` or SSH keys configured for `git@github.com`.
- The skill does not attempt to manage credentials — that's the user's responsibility outside the OS.

## Failure modes

| symptom                                | meaning                                           | resolution                                                                           |
| -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| "could not interpret `<source>`"       | Source matched none of the discriminator patterns | Use a full GitHub URL or absolute path                                               |
| "entity `<slug>` already exists"       | Slug collision                                    | Pass `overwrite: true` OR use a different `slug`                                     |
| "repos/<slug> has uncommitted changes" | Existing clone has dirty working tree             | Commit/stash/discard in that clone, then re-run                                      |
| "repos/<slug> is on branch `<X>`"      | Existing clone is on a feature branch             | Finish/abandon that work, return to default branch, re-run                           |
| `gh repo clone` fails with auth error  | `gh` not authenticated for that repo              | `gh auth login` or use SSH URL                                                       |
| Local path doesn't exist               | Path typo or wrong cwd                            | Verify the path; relative paths resolve against the OS repo root, not the user's cwd |

## Related

- [[archetype-entity]] — entity contract + the repo-specific optional fields documented here
- [[dev-pr-review]] — skill that consumes ingested-repo entity entries to operate on a PR (wikilink resolves to the Skills view)
- [[standard-feature-anatomy]] — repo ingestion built against this anatomy (data model: extend entity; runtime: none, on-demand; scaffolder: dev-ingest-repo; docs: this entry)
- [[standard-file-naming]] — `repos/<slug>/` convention for clone storage
