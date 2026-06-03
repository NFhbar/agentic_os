---
name: dev-ingest-repo
description: Ingest a GitHub or local repository — clone it, analyze its structure, write an entity wiki entry so future skills can navigate and modify it
user-invocable: true
version: 1
domain: development
tags: [ingestion, repo, entity, scaffolding]
inputs:
  source:
    type: string
    required: true
    description: GitHub URL (`https://github.com/owner/name`), GitHub shorthand (`owner/name`), or absolute/relative local path
  slug:
    type: string
    required: false
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Override the entity slug. Defaults to inferred from source (kebab-case repo name, owner prefix when needed for disambiguation).
  tags:
    type: string
    required: false
    description: Comma-separated free tags to apply to the entity (in addition to the automatic [repo, ...detected] tags).
  overwrite:
    type: boolean
    required: false
    default: false
    description: If true, replace an existing entity entry with the same slug. Default false aborts on collision.
outputs:
  - kind: file
    path: vault/wiki/development/entity/{{input.slug}}.md
  - kind: folder
    path: repos/{{input.slug}}/
    description: Only created when ingesting from GitHub; local repos are referenced in place.
spawns: []
---

# dev-ingest-repo

## Purpose

Ingest a repository so the OS knows it exists, where it lives, how it's structured, and how to build/test/contribute to it. The output is one `entity` archetype wiki entry that downstream skills (`dev-pr-review`, future `dev-write-feature-pr`) can read to operate on the repo without re-discovering everything.

This is "give the OS a map," not "embed all the code." Detailed code reading happens on demand later, using the map this skill produces.

## Inputs

- `source` — one of:
  - GitHub URL: `https://github.com/owner/name` or `https://github.com/owner/name.git`
  - SSH URL: `git@github.com:owner/name.git`
  - GitHub shorthand: `owner/name` (when both `owner` and `name` exist and there's no local path of the same name)
  - Absolute path: `/Users/foo/code/myrepo`
  - Relative path: `./myrepo` or `../myrepo` (resolved against the OS repo root)
- `slug` — optional override (lowercase kebab-case)
- `tags` — optional, comma-separated, free-form
- `overwrite` — default false; setting true replaces any existing entity entry for this slug

## Procedure

### 1. Discriminate the source

Decide whether `source` points at GitHub or a local path. Match in this order — first match wins:

- Begins with `https://github.com/` or `http://github.com/` → **GitHub URL**
- Begins with `git@github.com:` → **GitHub SSH URL**
- Begins with `/` → **absolute local path**
- Begins with `./` or `../` → **relative local path** (resolve against repo root)
- Matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` AND no local path of that name exists → **GitHub shorthand** (rewrite to `https://github.com/<source>`)
- Otherwise → reject with: "could not interpret `<source>` as either a GitHub URL or a local path"

### 2. Compute the slug

If `inputs.slug` is provided, use it (validate against `^[a-z0-9][a-z0-9-]*$`).

Otherwise infer:

- GitHub: take the last URL segment, strip `.git`, lowercase. If a local repo with the same name exists already, prefix with `<owner>-` to disambiguate.
- Local: use the basename of the path, lowercased and kebab-cased.

If a wiki entry at `vault/wiki/development/entity/<slug>.md` already exists AND `overwrite=false`, abort with: "entity `<slug>` already exists — pass `overwrite: true` to re-ingest, or use a different `slug`."

### 3. Clone or reference

**GitHub flow:**

- Ensure `repos/` exists at the OS repo root (create if missing).
- If `repos/<slug>/` already exists and is a clean git working tree on default branch, reuse it. Otherwise:
  - If it exists with uncommitted changes, **abort** with: "repos/<slug> has uncommitted changes — clean before re-ingesting."
  - If it exists on a non-default branch, **abort** with: "repos/<slug> is on branch `<X>` — check out default branch or pass a different `slug`."
  - If it does not exist, run: `gh repo clone <url> repos/<slug> -- --depth 50` (shallow clone with enough history for context). Fall back to `git clone --depth 50 <url> repos/<slug>` if `gh` is not authenticated.
- `local_path` = absolute path to `repos/<slug>/`.

**Local flow:**

- Verify the path exists and is readable.
- Verify it contains a `.git/` directory (or is at least a directory tree — non-git directories are OK but warn).
- Verify working tree is clean (`git status --porcelain` empty) — if not, warn but proceed.
- `local_path` = the absolute path as provided.

### 4. Determine repo metadata

From inside `local_path`:

- `default_branch`: `git symbolic-ref refs/remotes/origin/HEAD` (strip prefix) — if no remote, use `git rev-parse --abbrev-ref HEAD`.
- `current_branch`: same as `default_branch` immediately after ingest.
- `remote_url`: `git remote get-url origin` — null if no `origin`.
- `ingestion_source`: `github` if remote_url points at github, else `local`.

### 5. Read core metadata files

Read each of these if present. Skip silently if absent:

| file                                                                       | what to extract                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `README.md` (or `.rst`, `.txt`)                                            | purpose, 1-2 paragraph summary                                      |
| `CONTRIBUTING.md`                                                          | contribution model, PR conventions                                  |
| `CHANGELOG.md`                                                             | last 1-2 versions, recent direction                                 |
| `LICENSE`                                                                  | infer SPDX identifier                                               |
| `package.json`                                                             | `name`, `description`, `scripts.build`/`scripts.test`, primary deps |
| `pyproject.toml` / `setup.py`                                              | Python project; build/test commands                                 |
| `Cargo.toml`                                                               | Rust project; build/test commands                                   |
| `go.mod`                                                                   | Go project; module name                                             |
| `Gemfile`                                                                  | Ruby project                                                        |
| `Dockerfile`                                                               | containerized build hint                                            |
| `.editorconfig`, `biome.json`, `.prettierrc`, `pyproject.toml [tool.ruff]` | code style                                                          |
| `.github/workflows/*.yml`                                                  | CI = `github-actions`; extract main workflow command                |
| `.circleci/config.yml`                                                     | CI = `circleci`                                                     |
| `.gitlab-ci.yml`                                                           | CI = `gitlab-ci`                                                    |
| `CODEOWNERS`                                                               | code ownership hints                                                |
| `.github/PULL_REQUEST_TEMPLATE.md`                                         | PR template (capture for future PR-writing skills)                  |

Use the highest-priority match for each field. For `language`, infer from which package manifest is dominant; for `build_command` and `test_command`, prefer explicit script entries over guesses.

### 6. Walk the structure

`ls -la` the top level, then `ls` into each directory at depth 1 (skip `node_modules`, `dist`, `build`, `target`, `vendor`, `__pycache__`, `.next`, `.git`, `.venv`).

Note conventional directories:

- `src/`, `lib/` — source code root
- `tests/`, `test/`, `__tests__/`, `spec/` — test suites
- `docs/` — documentation
- `scripts/`, `bin/` — tooling
- `examples/`, `samples/` — usage examples

Identify likely **entry points** (best-effort, language-aware):

- TS/JS: `src/index.{ts,js}`, `src/main.{ts,js}`, files referenced by `package.json#main` or `#bin`
- Python: `src/<package>/__init__.py`, `main.py`, `__main__.py`, files in `[project.scripts]`
- Go: `cmd/<name>/main.go`, `main.go`
- Rust: `src/main.rs`, `src/lib.rs`, `[[bin]]` entries in Cargo.toml

### 7. Compose the entity entry

Use `_templates/wiki-entry/entity.md.tmpl` as the base. Substitute placeholders and fill the body sections below. Final file path: `vault/wiki/development/entity/<slug>.md`.

````markdown
---
id: <slug>
type: entity
domain: development
created: <ISO datetime>
updated: <ISO datetime>
tags: [repo, <language>, <ci>, <user-supplied tags...>]
source: ingestion
private: false
name: <repo display name from package metadata or basename>
kind: repo
links: []
remote_url: <github URL or null>
local_path: <absolute path>
default_branch: <branch>
current_branch: <branch>
language: <detected>
build_command: <detected or null>
test_command: <detected or null>
ci: <detected or "none">
license: <SPDX or "unknown">
ingested_at: <ISO datetime>
ingestion_source: github | local
---

# <Repo display name>

## Purpose

<1-2 paragraphs synthesized from README — what does this project do, who is it for>

## Stack

- **Language:** <primary language + version constraint if specified>
- **Framework / key deps:** <top 3-5>
- **Build:** `<build_command>`
- **Test:** `<test_command>`
- **CI:** <github-actions | circleci | gitlab-ci | none>
- **License:** <SPDX>

## Structure

Top-level layout (depth 2, ignoring vendored/derived dirs):

\```
<directory tree>
\```

## Entry points

- `<path>` — <one-line description>
- ...

## Conventions

- **Code style:** <biome / prettier / ruff / gofmt — whichever is configured>
- **Tests:** <framework + test directory>
- **Commits / PRs:** <observations from CONTRIBUTING.md or recent commit format>

## Development workflow

How to get from a clean clone to a working dev setup:

1. <install / setup>
2. <build>
3. <test>
4. <run>

Adapt based on what package manifest exists.

## Notable recent work

If `CHANGELOG.md` exists, summarize the last 1-2 entries. Otherwise note "no changelog — run `git log --oneline -20` for recent direction" without actually doing so unless asked.

## Links

- <github issues / dashboards / docs links extracted from README, as `[[reference-id]]` if those exist as wiki entries, else plain URLs>
````

### 8. Audit log

Record the ingest event via the dual-write wrapper — appends one line to `vault/raw/dashboard-actions.jsonl` AND inserts the matching row in `.claude/state/events.db`:

```bash
node scripts/record-dashboard-action.mjs \
  --action ingest-repo \
  --skill dev-ingest-repo \
  --args '{"source":"<source>","slug":"<slug>"}' \
  --files-touched '["vault/wiki/development/entity/<slug>.md"]'
```

For GitHub flow also include `repos/<slug>/` in `--files-touched` (e.g. `'["vault/wiki/development/entity/<slug>.md","repos/<slug>/"]'`).

### 9. Confirm to the user

Print a 5-line summary:

```
✓ Ingested <name>
  slug:     <slug>
  source:   <github | local>
  language: <X>
  clone:    <repos/<slug>/ | local — referenced in place>
  entity:   vault/wiki/development/entity/<slug>.md
```

## Outputs

- New `entity` wiki entry at `vault/wiki/development/entity/<slug>.md`
- (GitHub only) Cloned working tree at `repos/<slug>/`
- One line appended to `vault/raw/dashboard-actions.jsonl` + one row in `.claude/state/events.db` (via the dual-write wrapper)

## Errors

- Source ambiguous → reject with rule that failed (e.g. "looks like a path but does not exist")
- GitHub clone fails → surface stderr (auth issue? not found? rate limited?)
- Slug collision without `overwrite: true` → reject with the slug name and how to override
- Existing clone has uncommitted changes → abort with the path; user must clean first
- Existing clone on non-default branch → abort; user must finish/abandon that branch first

## See also

- [[standard-repo-ingestion]] — the full standard this skill implements
- [[archetype-entity]] — entity contract + repo-specific optional fields
- [[dev-pr-review]] — operates on an ingested repo (skill — wikilink resolves to the Skills view)
- Future: `dev-write-feature-pr` — generates a PR using this entity entry as its map (not implemented yet)
