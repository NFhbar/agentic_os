---
name: dev-cache-pr-review-repo
description: 'Maintain a read-only shallow clone of a GitHub repo for PR review context. Clones on first use, fetches+resets to origin/HEAD on subsequent runs, gates redundant pulls with a 5-minute staleness check. Writes a pr-review-repo-cache archetype entry tracking the cache state.'
user-invocable: true
version: 1
domain: development
tags: [cache, repo, review, git, scaffolding]
inputs:
  pr:
    type: string
    required: false
    description: 'PR URL (https://github.com/owner/repo/pull/N) — owner+repo extracted from the URL. Either pr OR (owner + repo) is required.'
  owner:
    type: string
    required: false
    description: 'GitHub owner / org. Required when pr is not provided.'
  repo:
    type: string
    required: false
    description: 'GitHub repo name. Required when pr is not provided.'
  force:
    type: boolean
    required: false
    default: false
    description: 'Skip the 5-minute staleness gate and pull anyway. Use when you know upstream changed (force-push, recent merge).'
outputs:
  - kind: folder
    path: '.claude/state/pr-review-cache/<owner>/<repo>/'
    description: 'Shallow clone of the repo at origin/HEAD. Read-only — skills must not write here.'
  - kind: file
    path: 'vault/wiki/development/pr-review-repo-cache/pr-review-repo-cache-<owner>-<repo>.md'
    description: 'Archetype entry tracking owner, repo, default_branch, local_path, last_pulled, file/size stats.'
  - kind: event
    path: '.claude/state/events.db (kind: dashboard, action: cache-pr-review-repo)'
spawns: []
---

# dev-cache-pr-review-repo

## Purpose

Maintain a read-only shallow clone of a GitHub repo at its default branch (typically `main`), so [[dev-pr-review]] can read code context beyond the diff when analyzing a PR. The cache is purpose-built for review context — never written to, never branched, never pushed.

This is the **other repo concept** in the OS. The [[archetype-entity]] (`kind: repo`) used by [[dev-write-change]] / [[dev-open-pr]] tracks repos the OS _writes to_. This skill maintains repos the OS _reads from_. They're stored separately, governed by different lifecycle rules, and shouldn't be confused.

## When to use

- Called automatically by [[dev-pr-review]] before analyzing a PR (the primary path).
- Called directly to pre-warm the cache for a repo you expect to review frequently.
- Called with `force: true` after a base-branch push to grab the new HEAD before re-reviewing.

## When NOT to use

- For repos the OS will WRITE to — use [[dev-ingest-repo]] instead.
- For full-history clones (annotate-blame, log-walking, etc.) — the cache is shallow (`--depth=1`); use a regular `git clone` outside the OS for those needs.
- To check out a non-default branch — the cache always tracks `origin/HEAD`. If you need a specific branch for review context, that's a future enhancement (currently the PR's _base_ branch is assumed to equal `origin/HEAD`).

## Prerequisites

- `git` CLI available in `$PATH` (required by every git-touching skill).
- Network access to github.com.
- For private repos: SSH key or PAT configured in the user's git config / credential helper. The skill does not manage credentials itself — it relies on the local git setup.

## Procedure

1. **Parse inputs to extract `owner` and `repo`.**
   - If `inputs.pr` is set: parse `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>` to extract owner/repo.
   - Else if `inputs.owner` and `inputs.repo` are both set: use them.
   - Else: reject with `Must provide either pr URL or owner+repo.`

   Normalize both to lowercase? **No** — preserve case for `owner` (GitHub usernames are case-preserving in URLs). The id slug below kebab-cases for safety.

2. **Compute identifiers and paths.**
   - `cache_id`: `pr-review-repo-cache-<owner>-<repo>` lowercased and kebab-cased (replace any non-`[a-z0-9-]` with `-`).
   - `entry_path`: `vault/wiki/development/pr-review-repo-cache/<cache_id>.md`
   - `cache_path`: `.claude/state/pr-review-cache/<owner>/<repo>` (relative to repo root).
   - `clone_url`: `https://github.com/<owner>/<repo>.git`

3. **Read existing archetype entry (if present)** at `entry_path`. Capture `default_branch`, `last_pulled`, `status`, `files_count`, `size_bytes` if found. This data informs the staleness check + the refresh history.

   **Capture `entry_existed_at_start = <true|false>` now and treat it as immutable for the rest of the procedure.** Every downstream branching decision (action_label, analyze trigger) reads from this snapshot, not from re-checking the filesystem. This prevents the bug where step 10 writes the entry and later steps re-read it as "already exists" → spurious no-op.

4. **Staleness gate.** Unless `inputs.force == true`:
   - If `entry_existed_at_start == true`, `status == ready`, and `last_pulled` is within the last **5 minutes** of now → set `gate_result = "fresh"`, skip steps 5–11, JUMP TO STEP 12 (record event with `action_label = "no-op-staleness"`), THEN step 13 (report `cache fresh, no-op`). **Do not** mutate the entry or the cache dir.
   - Else: set `gate_result = "proceed"` and continue with step 5.
   - Steps 5–13 read `gate_result`; do NOT re-evaluate the 5-minute condition later — by then the entry's own `last_pulled` you just wrote will trip the gate.

5. **Mark indexing.** If `entry_path` exists, Edit `status: indexing` and bump `updated:` to now. Skip if entry doesn't exist yet (it'll be created in step 10).

6. **Clone or fetch.**

   **First-time (cache_path does not exist or is missing `.git/`):**

   ```bash
   mkdir -p "$(dirname <cache_path>)"
   git clone --depth=1 <clone_url> <cache_path>
   ```

   The default branch is whatever `origin/HEAD` resolves to after clone — capture it via:

   ```bash
   git -C <cache_path> symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@'
   ```

   **Refresh (cache_path exists with `.git/`):**

   ```bash
   git -C <cache_path> fetch --depth=1 origin
   git -C <cache_path> remote set-head origin --auto       # refresh origin/HEAD in case default branch changed upstream
   git -C <cache_path> reset --hard origin/HEAD
   ```

   Re-capture `default_branch` from `symbolic-ref` (it may have changed if the repo renamed `main`/`master`).

   **Capture `head_sha`** after either clone or refresh:

   ```bash
   git -C <cache_path> rev-parse HEAD
   ```

   This lets the companion [[archetype-repo-knowledge]] entry's `based_on_commit` be compared against it to detect structural drift.

   **On failure**:
   - Auth error (`Permission denied`, `403`, `Repository not found` from github) → write entry with `status: error`, `last_error: <stderr>`, and reject with: `Cache pull failed for <owner>/<repo>: <stderr>. Check credentials (~/.ssh/config or git credential helper) and re-run.`
   - Other git errors → same shape, surface stderr.

7. **Compute stats.** From inside `cache_path`:

   ```bash
   files_count=$(find . -type f -not -path './.git/*' | wc -l | tr -d ' ')
   size_bytes=$(du -sk . | awk '{print $1 * 1024}')         # -sk for kilobytes, multiplied to bytes; portable across macOS/Linux
   ```

   Both are coarse but truthful.

8. **Compute Stage 1 indexing heuristics.** Cheap, no-Claude-call detectors that snapshot the repo's surface shape onto the cache entry. Each detector is independent — if one fails, set the field to a sentinel and move on.

   **`languages`** — top 8 extensions by file count, excluding `.git/` and common ignore patterns:

   ```bash
   find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './target/*' -not -path './dist/*' \
     | sed -E 's/.*\.([a-zA-Z0-9]+)$/\1/' \
     | sort | uniq -c | sort -rn | head -8
   ```

   Convert to `[[ext, count], ...]` tuples for YAML.

   **`build_system`** — first match wins:
   - `pnpm-lock.yaml` → `pnpm`
   - `yarn.lock` → `yarn`
   - `package-lock.json` or `package.json` → `npm`
   - `Cargo.toml` → `cargo`
   - `go.mod` → `go-modules`
   - `pyproject.toml` (poetry section) → `poetry`
   - `pyproject.toml` (no poetry) or `requirements.txt` → `pip`
   - `Makefile` (no other manifest) → `make`
   - else → `unknown`

   **`type_system`**:
   - `tsconfig.json` present → `typescript`
   - `mypy.ini` or `py.typed` marker → `python-typed`
   - `Cargo.toml` present → `rust`
   - `go.mod` present → `go`
   - `.flowconfig` → `flow`
   - else → `none`

   **`test_pattern`** — first match wins. Order matters; the `*_test.go` check is intentionally above the JS-shape colocated rule so a Go-only repo doesn't fall through to `none-detected`:
   - Any `**/__tests__/` directory present → `dunder`
   - Any `**/*_test.go` file present → `colocated` (Go convention — distinct from the JS/TS `*.test.*` shape)
   - Any `**/*_test.{rs,py}` file present → `colocated` (Rust + Python `pytest -k` convention)
   - Any `**/*.test.{ts,js,tsx,jsx,py}` file present → `colocated` (JS/TS convention)
   - Any `**/*_spec.{rb,js}` file present → `colocated` (Ruby + JS spec convention)
   - `tests/` directory at root → `parallel`
   - `test/` directory at root → `parallel`
   - `spec/` directory at root → `parallel` (Ruby convention)
   - else → `none-detected`

   The pattern reflects detection only — it doesn't enforce a "correct" layout. A repo with both `tests/` AND colocated `*_test.go` gets labeled `colocated` (first match wins) but the reviewer can still see both via the cache dir.

   **`deps_count`** — read the primary manifest:
   - `package.json` → count keys in `dependencies` + `devDependencies`
   - `Cargo.toml` → count entries in `[dependencies]` + `[dev-dependencies]`
   - `go.mod` → count `require` lines (rough)
   - `pyproject.toml` → count entries in `[tool.poetry.dependencies]` (Poetry) or `[project.dependencies]` (PEP 621)
   - `requirements.txt` → count non-comment lines
   - else → `0`

   **`has_readme` / `has_contributing` / `has_changelog`** — booleans from glob:

   ```bash
   has_readme=$(ls README* 2>/dev/null | head -1 | wc -l | tr -d ' ')
   has_contributing=$(ls CONTRIBUTING* .github/CONTRIBUTING* 2>/dev/null | head -1 | wc -l | tr -d ' ')
   has_changelog=$(ls CHANGELOG* 2>/dev/null | head -1 | wc -l | tr -d ' ')
   ```

   Capture all of these as locals; they get written into the entry in step 10.

9. **Determine the action label** for the report + event. Decide STRICTLY by `entry_existed_at_start` (from step 3), NOT by the cache dir's git state:
   - `entry_existed_at_start == false` → `clone` (regardless of whether `.git/` was already present — a stale cache dir from a partial run still counts as a fresh start when no archetype entry exists)
   - `entry_existed_at_start == true` AND HEAD moved (compare `git rev-parse origin/HEAD` before vs after fetch) → `refresh`
   - `entry_existed_at_start == true` AND HEAD unchanged → `no-op-refresh`
   - `gate_result == "fresh"` (staleness gate hit in step 4) → `no-op-staleness` (the procedure already returned at step 4, but record this label for the event in step 12)

10. **Write/update the archetype entry** at `entry_path`. Use Write for first-time, Edit for refresh (preserve any user-added notes in the body).

    For first-time, scaffold from `_templates/wiki-entry/pr-review-repo-cache.md.tmpl` with these substitutions:

    | placeholder            | value                                                                                                                                                                                         |
    | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `{{slug}}`             | `<cache_id>`                                                                                                                                                                                  |
    | `{{domain}}`           | `development`                                                                                                                                                                                 |
    | `{{datetime}}`         | now (ISO 8601 UTC)                                                                                                                                                                            |
    | `{{source}}`           | `dev-cache-pr-review-repo`                                                                                                                                                                    |
    | `{{owner}}`            | `<owner>`                                                                                                                                                                                     |
    | `{{repo}}`             | `<repo>`                                                                                                                                                                                      |
    | `{{default_branch}}`   | from step 6                                                                                                                                                                                   |
    | `{{local_path}}`       | `<cache_path>`                                                                                                                                                                                |
    | `{{clone_url}}`        | `<clone_url>`                                                                                                                                                                                 |
    | `{{head_sha}}`         | from step 6                                                                                                                                                                                   |
    | `{{files_count}}`      | from step 7                                                                                                                                                                                   |
    | `{{size_bytes}}`       | from step 7                                                                                                                                                                                   |
    | `{{build_system}}`     | from step 8                                                                                                                                                                                   |
    | `{{type_system}}`      | from step 8                                                                                                                                                                                   |
    | `{{test_pattern}}`     | from step 8                                                                                                                                                                                   |
    | `{{deps_count}}`       | from step 8                                                                                                                                                                                   |
    | `{{has_readme}}`       | from step 8 (`true` or `false`)                                                                                                                                                               |
    | `{{has_contributing}}` | from step 8 (`true` or `false`)                                                                                                                                                               |
    | `{{has_changelog}}`    | from step 8 (`true` or `false`)                                                                                                                                                               |
    | `{{languages_yaml}}`   | from step 8 — YAML block (see below)                                                                                                                                                          |
    | `{{knowledge_id}}`     | `repo-knowledge-<owner_lower>-<repo_lower>` — lowercased + kebab-cased; must match the slug `dev-analyze-repo-for-review` will write so the wikilink resolves once analyze produces the entry |

    For `{{languages_yaml}}`, render each tuple as one indented YAML list item:

    ```yaml
      - [ts, 1284]
      - [js, 213]
      - [md, 47]
    ```

    Two leading spaces per line (the `languages:` key is at column 0; values are nested). If the heuristic produced no extensions, render as `  []` (empty inline list).

    For refresh, surgically update the frontmatter fields:
    - `updated`: now
    - `status`: `ready`
    - `last_pulled`: now
    - `default_branch`: from step 6 (may have changed)
    - `head_sha`: from step 6
    - `files_count`: from step 7
    - `size_bytes`: from step 7
    - `build_system`, `type_system`, `test_pattern`, `deps_count`, `has_readme`, `has_contributing`, `has_changelog`: from step 8
    - `languages`: from step 8 (replace the nested block entirely)
    - Clear `last_error` if present.

    Then append one bullet to the body's `## Refresh history` section:
    - `- <ISO>: <action_label> → <delta or "up-to-date with origin/<branch>">`

    Cap the history at 10 most recent bullets — drop the oldest when adding the 11th.

11. **Trigger Stage 2 analysis when there was no prior archetype entry.** Trigger condition is STRICTLY `entry_existed_at_start == false` (from step 3). If true, invoke [[dev-analyze-repo-for-review]] as a sub-step with `owner` + `repo` from the inputs. This produces the [[archetype-repo-knowledge]] entry that [[dev-pr-review]] reads for repo-specific convention judgments.

    **Do not** key this trigger off the cache dir's git state, off `action_label` directly, off the entry's current state on disk (you just wrote it in step 10 — it'll always "exist" now), or off any re-read of `entry_path`. ONLY `entry_existed_at_start` controls this.

    Skip the trigger when `entry_existed_at_start == true` — those land in the staleness gate inside the analyze skill anyway, and refreshes should stay cheap. The audit's `repo-knowledge-stale` nudge surfaces drift; the dashboard's Re-analyze button lets the user trigger manually.

    On failure (analyze skill errors, e.g. model timeout), log the failure into the cache entry's refresh history but **do not** mark the cache entry itself as errored — the cache pull succeeded; analysis is a separate concern. The user can manually re-run `/os analyze repo <owner>/<repo>` later.

12. **Record the event** via the dual-write wrapper. **ALWAYS fires, unconditionally** — every invocation produces exactly one inner event, regardless of `gate_result` or `action_label`. A no-op-staleness run that exited at step 4 still records an event from there (the no-op path should jump to this step before returning, not return immediately). This is non-negotiable for traceability; without it, you cannot tell from logs whether a skill ran at all.

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action cache-pr-review-repo \
      --skill dev-cache-pr-review-repo \
      --args '{"owner":"<owner>","repo":"<repo>","action":"<clone|refresh|no-op-refresh|no-op-staleness>","files_count":<n_or_null>,"size_bytes":<n_or_null>}' \
      --files-touched '<["<entry_path>"] if entry was written, else []>' \
      --exit-status 0
    ```

    Use `null` for `files_count` / `size_bytes` when the gate skipped the work (you don't have fresh values). Use `[]` for `files-touched` when no file was written (gate-skip case).

    Note: the cache dir itself is NOT in `files_touched` because it's outside the vault — `files_touched` is a vault-write log, not a git-write log.

13. **Confirm to user** with a tight report:

    ```
    ✓ Cache <action_label> — <owner>/<repo>
      path:     <cache_path>
      branch:   <default_branch>
      pulled:   <ISO> (was <prior_ISO_or_"never">)
      files:    <files_count>
      size:     <human_size>
      entry:    <entry_path>
    ```

    For the staleness-gated no-op (step 4):

    ```
    ⊘ Cache fresh — <owner>/<repo>
      last pulled <minutes_ago>m ago at <prior_ISO> (< 5m threshold; use force:true to override)
      path: <cache_path>
    ```

## Inputs schema notes

- `pr` vs `owner`+`repo`: use `pr` when called from review flows (the URL is already known); use the explicit `owner`+`repo` when pre-warming from the Repos tab.
- `force`: rarely needed. Only set when you know upstream changed but `last_pulled` is recent.

## Outputs

- A `.claude/state/pr-review-cache/<owner>/<repo>/` directory containing a shallow clone of the default branch.
- A new or updated `pr-review-repo-cache` archetype entry at `vault/wiki/development/pr-review-repo-cache/<cache_id>.md`.
- An `events.db` row with `kind: dashboard`, `action: cache-pr-review-repo`, `skill: dev-cache-pr-review-repo`.

## Errors

- `Must provide either pr URL or owner+repo` → fix the input shape
- `Cache pull failed for <owner>/<repo>: <stderr>` → likely auth or network; investigate per the stderr message
- `Invalid pr URL format` → match `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`

## What this skill must NOT do

- **Write to the cached repo.** Read-only by contract. The cache dir is for the model to _consult_, not to mutate. If a future review skill needs a working tree, it must clone separately.
- **Switch branches.** The cache tracks `origin/HEAD` only. Multiple-branch caching is a future enhancement, not a v1 feature.
- **Manage credentials.** The skill relies on the user's git credential setup (SSH key, PAT in keychain, etc.). It does not read tokens from `mcps/github/.env` or anywhere else — `git clone` over HTTPS uses the standard git credential flow.
- **Delete the cache.** Eviction is a separate concern (Phase 3+); this skill only creates and refreshes.

## See also

- [[archetype-pr-review-repo-cache]] — the archetype this skill produces (data contract)
- [[dev-pr-review]] — the primary consumer; calls this skill as a sub-step
- [[archetype-entity]] — the _other_ repo concept (`kind: repo`); used for repos the OS writes to
- [[dev-ingest-repo]] — the _other_ ingestion skill; produces entity entries for writable repos
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 12
- `_templates/wiki-entry/pr-review-repo-cache.md.tmpl` — scaffold for first-time entries
