---
name: dev-analyze-repo-for-review
description: 'Produce structured prose knowledge about a cached repo — overview, stack, structure, conventions, notable deps, docs digest. One Claude call against a representative file sample from the local cache; writes a repo-knowledge archetype entry that dev-pr-review consumes for repo-specific judgment.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: development
tags: [analysis, repo, knowledge, review, indexing]
inputs:
  owner:
    type: string
    required: false
    description: 'GitHub owner / org. Required when cache_id is not provided.'
  repo:
    type: string
    required: false
    description: 'GitHub repo name. Required when cache_id is not provided.'
  cache_id:
    type: string
    required: false
    description: 'Cache entry id (e.g. pr-review-repo-cache-nfhbar-mull). Resolves to owner+repo. Either cache_id OR (owner+repo) is required.'
  force:
    type: boolean
    required: false
    default: false
    description: 'Re-analyze even if a fresh knowledge entry already exists. Use after major repo changes when staleness gate would otherwise skip.'
  no_fetch:
    type: boolean
    required: false
    default: false
    description: 'Skip the fetch + reset to origin step. Default false — the skill refreshes the cache to the remote default branch before analyzing so based_on_commit reflects upstream HEAD. Set true for air-gapped runs or to analyze a specific historic commit already checked out.'
outputs:
  - kind: file
    path: 'vault/wiki/development/repo-knowledge/repo-knowledge-<owner>-<repo>.md'
    description: 'The repo-knowledge archetype entry — prose sections for overview, stack, structure, conventions, deps, docs.'
  - kind: event
    path: '.claude/state/events.db (kind: dashboard, action: analyze-repo-for-review)'
spawns: []
---

# dev-analyze-repo-for-review

## Purpose

Produce the **Stage 2** prose knowledge about a cached repository that [[dev-pr-review]] consumes before judging code quality. The cheap Stage 1 heuristics (languages, build*system, test_pattern, etc.) live on the cache archetype itself and refresh on every pull — this skill produces the slower, judgment-requiring knowledge: what does this repo \_do*, how is it _organized_, what are its _conventions_.

One Claude call against a curated sample of files in the local cache. Outputs a [[archetype-repo-knowledge]] entry whose body is prose, intended to be read like documentation, not parsed as data.

## Why this is separate from the cache skill

Cache pulls are cheap (a `git fetch`); we want them to run often. Repo analysis is expensive (a Claude call); we want it to run _rarely_ but produce high-leverage knowledge that compounds across every review. Splitting them means:

- The cache refreshes every time a review runs (fresh code context, no extra cost).
- The analysis refreshes only when the cache HEAD has drifted significantly OR the user explicitly asks.

The `based_on_commit` field on the knowledge entry lets the audit / dashboard detect "this analysis is stale vs current code" without having to re-analyze every time.

## When to use

- Automatically invoked by [[dev-cache-pr-review-repo]] on **first clone** of a repo (so first-ever review benefits from knowledge).
- Manual re-run via the Repos tab's "Re-analyze" button when the user knows the repo's conventions have shifted.
- Auto re-run by the audit's `repo-knowledge-stale` info-severity nudge when `analyzed_at > 30 days` OR `cache.head_sha` has drifted far from `based_on_commit`.

## When NOT to use

- Before the cache exists — the skill rejects when `pr-review-repo-cache-<owner>-<repo>` is absent or its `status != ready`. Run [[dev-cache-pr-review-repo]] first.
- For repos the OS writes to — [[archetype-entity]] is the source of truth for those (its `## Conventions` body section is hand-authored / dev-ingest-repo authored). This skill is explicitly for _review-side_ knowledge.

## Prerequisites

- The repo must already be cached. The skill reads `pr-review-repo-cache-<owner>-<repo>` to find `local_path` + `head_sha`.
- `git` CLI on PATH (only used to confirm `head_sha`).
- Read access to the cache directory.

## Procedure

1. **Resolve `owner` + `repo`.**
   - If `inputs.cache_id` is set: read `vault/wiki/development/pr-review-repo-cache/<cache_id>.md`. Extract `owner` and `repo` from frontmatter. If the entry is missing, reject: `Cache "<cache_id>" not found — run dev-cache-pr-review-repo first.`
   - Else if `inputs.owner` and `inputs.repo` are both set: derive `cache_id = pr-review-repo-cache-<owner>-<repo>` (lowercase, kebab) and verify the cache entry exists.
   - Else: reject with `Must provide either cache_id or owner+repo.`

2. **Verify cache is ready.** From the cache entry's frontmatter:
   - `status == ready` (not `indexing` or `error`).
   - `local_path` set and pointing to an existing directory.
   - `head_sha` set (this is what `based_on_commit` records).

   If any check fails, reject with a hint pointing to `dev-cache-pr-review-repo`.

3. **Refresh the cache against the remote.** Run, in `<local_path>`:

   ```bash
   git -C <local_path> fetch --quiet origin
   git -C <local_path> rev-parse --abbrev-ref HEAD     # → <current_branch>
   # Find the repo's default branch (HEAD of origin/<default>):
   default_branch=$(git -C <local_path> symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')
   git -C <local_path> reset --hard origin/$default_branch --quiet
   new_head_sha=$(git -C <local_path> rev-parse HEAD)
   ```

   **MUST: write back the resolved head_sha to the cache entry — every time, unconditionally.** Open `vault/wiki/development/pr-review-repo-cache/<cache_id>.md` and surgically Edit the frontmatter:
   - `head_sha: <new_head_sha>` (set to the just-resolved value, regardless of whether it matched what was there)
   - `updated: <now ISO>` (bumps freshness so the dashboard reflects the check)

   This writeback is non-negotiable — skipping it (or doing it conditionally) is exactly the bug that produced the `cache.head_sha drift` finding. The cache entry is the canonical record of what's on disk; if analyze-repo fetches and resolves a new HEAD but doesn't write it back, downstream consumers (`dev-pr-review`'s repo-knowledge load, the dashboard's cache status display, the audit's `repo-knowledge-stale` detector) read stale values and either redo work or fire spurious "stale" findings. The model executing this step must NOT optimize this away as "no change" when the values happen to match — write it back every run.

   Use the resolved `new_head_sha` for the rest of this procedure as `cache.head_sha`. The audit's `repo-knowledge-stale` finding only clears when `based_on_commit == cache.head_sha == remote HEAD`; without this writeback step, analyze can pin to an outdated SHA and the finding re-fires immediately.

   **Skip this step if `inputs.no_fetch == true`** — operators can opt out for air-gapped runs or when reviewing a specific historic commit. Default is to fetch.

4. **Compute identifiers and paths.**
   - `knowledge_id`: `repo-knowledge-<owner>-<repo>` (lowercase, kebab; replace non-`[a-z0-9-]` with `-`).
   - `knowledge_path`: `vault/wiki/development/repo-knowledge/<knowledge_id>.md`
   - `cache_path`: from the cache entry's `local_path`.

5. **Read existing knowledge entry (if present)** at `knowledge_path`. Capture `analyzed_at`, `based_on_commit`, `analyzer_model` if found.

   **Capture `entry_existed_at_start = <true|false>` now and treat it as immutable for the rest of the procedure.** Every downstream branching decision (action_label, gate logic, report wording) reads from this snapshot, not from re-checking the filesystem. This prevents the bug where step 11 writes the entry and later steps re-read it as "already exists" → spurious no-op.

6. **Staleness gate.** Unless `inputs.force == true`:
   - If `entry_existed_at_start == true` AND `based_on_commit == cache.head_sha` AND `analyzed_at` is within the last 30 days → set `gate_result = "fresh"`, skip steps 7–11, JUMP TO STEP 12 (record event with `action_label = "no-op-staleness"`), THEN step 13 (report `knowledge fresh, no-op`). **Do not** call the model or mutate the entry.
   - Else: set `gate_result = "proceed"` and continue with step 7.
   - Steps 7–13 read `gate_result`; do NOT re-evaluate the gate later — by then the entry's `analyzed_at` you just wrote will trip the gate.

   Two refresh triggers bypass the gate even without `force`:
   - `based_on_commit != cache.head_sha` (the code has moved; conventions might have shifted)
   - `analyzed_at` is older than 30 days (analyzer model may have improved; calendar drift)

   Determine `action_label` for the event recording in step 12. Decide STRICTLY by `entry_existed_at_start` and `gate_result`, NOT by re-reading the entry:
   - `gate_result == "fresh"` → `no-op-staleness`
   - `entry_existed_at_start == false` → `initial` (first-ever analysis)
   - `entry_existed_at_start == true` AND `gate_result == "proceed"` → `refresh`

7. **Mark analyzing.** If `entry_existed_at_start == true`, Edit `status: analyzing` and bump `updated:` to now. Skip if `entry_existed_at_start == false` (the entry will be created in step 11). Do NOT re-read the filesystem to decide this — use the snapshot from step 5.

8. **Gather the file sample.** From `cache_path`, read these (use the Read tool for each — surface errors politely, skip missing):

   **Always-read (when present):**
   - `README*` (any case + extension)
   - `CONTRIBUTING*` (root or `.github/`)
   - `CHANGELOG*` (root)
   - Primary manifest: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements.txt`, `Gemfile`, `Makefile` — first found
   - Type/lint config: `tsconfig.json`, `biome.json` / `.eslintrc*` / `.prettierrc*`, `mypy.ini`, `ruff.toml`, `rustfmt.toml` (whichever apply)
   - `ARCHITECTURE.md`, `DESIGN.md`, `docs/README.md` if present

   **Sampled source files (target ~8 representative files):**
   - Entry points: `src/index.*`, `src/main.*`, `bin/*`, `cmd/*/main.go`, `app/main.py`
   - Pick 2-3 from the most-populated source dir (use Stage 1 `languages` to identify dominant extension)
   - If a `tests/` or `__tests__/` exists, pick 1-2 test files to gauge testing style
   - If there's a `lib/` or shared module, pick 1 file from it

   **Cap the total at ~50KB of file content** — beyond that, you're not analyzing, you're flooding context. If the sample's still too large, drop test files first, then source files, keeping README + manifest.

9. **Run the analysis prompt.** Compose this prompt to yourself (the model running this skill):

   ```
   You are analyzing a code repository to produce review-time knowledge. The reader is another AI agent that will use your output to judge PRs against this repo's conventions — not generic best practices.

   REPO: <owner>/<repo>
   CACHE PATH: <cache_path>
   HEAD: <head_sha>

   STAGE 1 SIGNALS (from heuristics):
   - languages: <from cache entry>
   - build_system: <from cache entry>
   - type_system: <from cache entry>
   - test_pattern: <from cache entry>
   - deps_count: <from cache entry>

   FILES YOU'VE BEEN GIVEN:
   <list of files read + a one-line note per file>

   You may use the Read tool to consult additional files under <cache_path> if you need more evidence — but stay budgeted (don't read more than ~10 extra files).

   Output the body content for SIX sections, one after the other, exactly in this order, separated by `---SECTION---` markers (no surrounding markdown, no preamble, no closing summary):

   1. OVERVIEW — one short paragraph. What does this repo do, what's the deployment shape, what's the scale (best guess).
   2. STACK — bulleted list: Language (+ version/mode), Framework, Test runner, Build tool, Lint/format, Run commands, Type system.
   3. STRUCTURE — bulleted list of top-level dirs that matter, each with a one-line purpose. Skip generated/boilerplate dirs.
   4. CONVENTIONS — multi-subsection prose. Required subsections (use ### headers):
      - Error handling
      - Tests
      - Logging
      - Type discipline
     Add ### subsections for other notable conventions (state management, security, async, formatting) only when this repo has something distinctive worth flagging to a reviewer.
   5. NOTABLE_DEPENDENCIES — bulleted list. Skip generic deps (lodash, axios). Call out: auth lib, ORM/DB, validation lib, HTTP client wrapper, internal libraries with conventions.
   6. DOCS — bulleted list. README/CONTRIBUTING/CHANGELOG/architecture docs each as one-line summary (or "(absent)").

   Be specific. Quote file paths and code patterns when they make a convention clear. If you can't determine something with confidence, say so plainly — "no clear logging convention detected" beats inventing one.
   ```

   Do the analysis. Output the six sections separated by `---SECTION---`.

10. **Parse the model output** by splitting on `---SECTION---`. Verify you got 6 sections; if not, surface the model's raw output as `last_error`, set `status: error`, and stop.

11. **Write/update the knowledge entry** at `knowledge_path`. Choose Write vs Edit based on `entry_existed_at_start` (from step 5), NOT by re-reading the filesystem:
    - `entry_existed_at_start == false` → use the Write tool (creates the file; parent dirs auto-created)
    - `entry_existed_at_start == true` → use the Edit tool (surgical frontmatter + body section updates)

    For the Write path (entry_existed_at_start == false), scaffold from `_templates/wiki-entry/repo-knowledge.md.tmpl` with these substitutions:

    | placeholder                | value                                             |
    | -------------------------- | ------------------------------------------------- |
    | `{{slug}}`                 | `<knowledge_id>`                                  |
    | `{{domain}}`               | `development`                                     |
    | `{{datetime}}`             | now (ISO 8601 UTC)                                |
    | `{{source}}`               | `dev-analyze-repo-for-review`                     |
    | `{{owner}}`                | `<owner>`                                         |
    | `{{repo}}`                 | `<repo>`                                          |
    | `{{based_on_commit}}`      | `<cache.head_sha>`                                |
    | `{{analyzer_model}}`       | model id from your runtime context                |
    | `{{overview}}`             | section 1                                         |
    | `{{stack}}`                | section 2                                         |
    | `{{structure}}`            | section 3                                         |
    | `{{error_handling}}`       | "Error handling" subsection of section 4          |
    | `{{tests}}`                | "Tests" subsection of section 4                   |
    | `{{logging}}`              | "Logging" subsection of section 4                 |
    | `{{type_discipline}}`      | "Type discipline" subsection of section 4         |
    | `{{extra_conventions}}`    | any other ### subsections in section 4 (or empty) |
    | `{{notable_dependencies}}` | section 5                                         |
    | `{{docs}}`                 | section 6                                         |

    For the Edit path (entry_existed_at_start == true), surgically update frontmatter:
    - `updated`: now
    - `status`: `ready`
    - `analyzed_at`: now
    - `based_on_commit`: `<cache.head_sha>`
    - `analyzer_model`: current model id
    - Clear `last_error` if present.

    Then rewrite the body's section contents from the new analysis. Don't try to merge — replace cleanly. (User-added notes will be lost on re-analysis; this is documented behavior.)

12. **Record the event** via the dual-write wrapper. **ALWAYS fires, unconditionally** — every invocation produces exactly one inner event, regardless of `gate_result` or `action_label`. A no-op-staleness run that exited at step 6 still records an event from there (the no-op path should jump to this step before returning, not return immediately). This is non-negotiable for traceability; without it, you cannot tell from logs whether the skill ran at all.

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action analyze-repo-for-review \
      --skill dev-analyze-repo-for-review \
      --args '{"owner":"<owner>","repo":"<repo>","based_on_commit":"<sha_or_null>","action":"<initial|refresh|no-op-staleness>"}' \
      --files-touched '<["<knowledge_path>"] if entry was written, else []>' \
      --exit-status 0
    ```

    Use `null` for `based_on_commit` and `[]` for `files-touched` when `action_label == no-op-staleness` (no fresh write happened).

13. **Confirm to user** with a tight report:

    ```
    ✓ Repo knowledge <action> — <owner>/<repo>
      analyzed_at:     <ISO>
      based_on_commit: <short_sha> (HEAD)
      sections:        overview, stack, structure, conventions (<N>), deps, docs
      entry:           <knowledge_path>
      next:            reviews of <owner>/<repo> will now consult this knowledge
    ```

    For the staleness-gated no-op:

    ```
    ⊘ Knowledge fresh — <owner>/<repo>
      last analyzed <days_ago>d ago at <prior_ISO>, based on <short_sha> (matches HEAD)
      use force:true to re-analyze anyway
    ```

## Inputs schema notes

- `cache_id` vs `owner`+`repo`: prefer `cache_id` when chaining from a cache pull (you already have the id); use `owner`+`repo` when invoking standalone from the Repos tab UI.
- `force`: rarely needed during normal operation — the staleness gate handles drift automatically. Set true when the user knows conventions have shifted and wants immediate re-analysis.

## Outputs

- A new or updated `repo-knowledge` archetype entry at `vault/wiki/development/repo-knowledge/<knowledge_id>.md`.
- An `events.db` row with `kind: dashboard`, `action: analyze-repo-for-review`, `skill: dev-analyze-repo-for-review`.

## Errors

- `Cache "<cache_id>" not found — run dev-cache-pr-review-repo first` → cache prerequisites missing
- `Must provide either cache_id or owner+repo` → fix the input shape
- `Cache status is "<state>", not "ready" — wait for cache pull to complete or retry` → race or prior error in cache layer
- `Model output didn't produce 6 sections — saw <N>` → analysis failed mid-output; full model output saved to `last_error` for debugging
- `Knowledge fresh, no-op` → not an error; idempotent stop (use `force: true` to override)

## What this skill must NOT do

- **Edit code in the cache.** Read-only by contract. The cache dir is the cache skill's domain; this skill consults it but never writes there.
- **Trigger a cache refresh.** If the cache is stale, that's the user's call — run `dev-cache-pr-review-repo` first. This skill operates on whatever the cache currently has.
- **Merge old + new knowledge.** Refreshes replace the body cleanly. Users editing the body manually will lose those edits on re-analysis; this is documented and intentional (treating the entry as derived data, not source-of-truth).
- **Run multiple Claude analyses.** Single call, structured output. The cost discipline is the whole point of splitting Stage 1 (cheap, frequent) from Stage 2 (expensive, rare).

## See also

- [[archetype-repo-knowledge]] — the archetype this skill produces (data contract)
- [[archetype-pr-review-repo-cache]] — the cache archetype this skill reads from
- [[dev-cache-pr-review-repo]] — the upstream skill; auto-invokes this on first clone
- [[dev-pr-review]] — the primary consumer of the knowledge entry
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 11
- `_templates/wiki-entry/repo-knowledge.md.tmpl` — scaffold for first-time entries
