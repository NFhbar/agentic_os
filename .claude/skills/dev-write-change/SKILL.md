---
name: dev-write-change
description: 'State-machine driven: produces a structured plan, gates on peer review, then executes (creates branch, edits files, runs tests). Reads change entry to determine which phase to run.'
user-invocable: true
recommended_effort: max
version: 1
domain: development
tags: [change, code, write, plan, execute]
inputs:
  change:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Change id (slug). Must match an existing entry of type=change.'
  force_replan:
    type: boolean
    required: false
    default: false
    description: 'Force the PLAN phase even when a plan already exists. Wipes the prior plan + review_status=pending. Use when the change scope materially changed.'
outputs:
  - kind: file
    path: vault/output/{{input.domain}}/changes/{{input.change}}-plan.md
  - kind: file
    path: vault/output/{{input.domain}}/changes/{{input.change}}-execution-log.md
    description: 'Only written when EXECUTE phase hits test failures.'
spawns: []
model: claude-fable-5
effort: max
---

# dev-write-change

## Purpose

Implement the work captured in a `change` entry — **safely**, in two phases gated by peer review:

1. **PLAN phase**: walk the repo, compose a structured plan listing every file that will be touched, every test that will be added, every risk surfaced. Write to `vault/output/<domain>/changes/<slug>-plan.md`. Stop.
2. **EXECUTE phase** (only after `dev-review-change` has marked review_status as approved): create the branch, make the edits described in the plan, run tests. Update the change entry's status to in-progress.

The state machine lives in the change entry's `review_status` field. Same skill invocation, different behavior based on state — see `standard-change-workflow.md`'s "Review gate" section for the full table.

## Procedure

### Step 1: Validate

1. Read the change entry at `vault/wiki/<domain>/change/<change>.md`. Parse via js-yaml so nested fields are real values. If missing or `type != change`, reject with: `change "<change>" not found or not type=change`.
2. Verify status is compatible with re-running this skill:
   - `status == "planning"` → proceed (will run PLAN or EXECUTE per Step 2).
   - `status == "in-progress"` → proceed to EXECUTE (existing flow).
   - `status == "in-review"` AND `pr_review_path` is set → proceed; Step 2 may select ADDRESS-COMMENTS phase to re-implement against accepted/published review comments.
   - `status == "in-review"` without `pr_review_path` → reject with: `change is in-review but has no linked pr-review. Use the appropriate skill to advance state.`
   - `status` in `{merged, abandoned}` → reject with: `change is past planning phase (status=<X>). Use the appropriate skill to advance state.`
3. Extract: `domain`, `repo`, `branch`, `intent` (from body's "Why" or fallback to `title`), `scope`, `review_required`, `review_status`, `plan_path`, `review_path`, **`pr_url`, `pr_review_path`, `pr_review_passes`**.
4. Read the repo entity at `vault/wiki/<domain>/entity/<repo>.md`. Extract `local_path`, `default_branch`, `current_branch`, `build_command`, `test_command`, `language`. Reject if entity is missing or `kind != repo`.

### Step 2: Decide which phase to run

**First check: is this a post-PR re-implement?** If `status == "in-review"` AND `pr_review_path` is set, scan the linked pr-review entry's latest pass for comments with `status` in `{accepted, published, published-as-body}` AND no `acted_on_at` header field. If at least one such comment exists, run the **ADDRESS-COMMENTS phase** (Step 4b) — the human has triaged review comments and wants the OS to re-implement against them. Skip the `review_status` table below.

Otherwise, fall through to the standard plan-review state machine, dispatched on `review_status`:

| `review_status`   | `inputs.force_replan` | action                                                                                                                                                                                                                       |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`         | (any)                 | **PLAN phase** (or RE-PLAN if a plan already exists and force_replan=true)                                                                                                                                                   |
| `approved`        | false                 | **EXECUTE phase**                                                                                                                                                                                                            |
| `approved`        | true                  | **RE-PLAN phase**: reset `review_status: pending`, wipe `review_path`, then PLAN                                                                                                                                             |
| `request-changes` | false                 | Show concerns + 3 options. Stop.                                                                                                                                                                                             |
| `request-changes` | true                  | **RE-PLAN phase**: reset state, then PLAN                                                                                                                                                                                    |
| `rejected`        | (any)                 | Refuse to execute. Suggest `status: abandoned`. Stop.                                                                                                                                                                        |
| `overridden`      | false                 | **EXECUTE phase** (with override log)                                                                                                                                                                                        |
| `not-required`    | (any)                 | **PLAN phase when `plan_path` is unset**, else **EXECUTE phase**. `not-required` skips only the review gate, never planning — EXECUTE hard-requires a plan (step 4.1), so routing straight to EXECUTE with no plan deadlocks |

### Step 3: PLAN phase

When you reach this phase:

1. **Gate: verify the change body is fit for planning.** Read the change entry's body. Two sub-checks:

   **1a. Template placeholders (hard reject).** If the body still contains either of these substrings (case-insensitive), the body was never written. Reject with the message below and stop:
   - `"what's broken, what's missing, or what we're improving"`
   - `"how you plan to do it. files touched, key functions, test strategy"`

   These substrings must stay byte-aligned with the placeholder prose in `_templates/wiki-entry/change.md.tmpl` (`## Why` / `## Approach`) and with the identical checks in `scripts/audit.mjs` (`change-body-template-placeholder`) and the dashboard warning in `domains/meta/app/server/routes/changes.ts`. If you reword the template, update all three consumers in the same change.

   Rejection message:

   ```
   ✗ Cannot plan — change body still has template placeholders.

   Edit vault/wiki/<domain>/change/<change>.md:
     ## Why          — what's broken / what we're improving (one paragraph)
     ## Approach     — how you plan to do it (high-level, files + strategy)
     ## Done when    — concrete completion criteria

   See [[standard-change-workflow]] § "Where the description lives across the lifecycle".
   ```

   **1b. DRAFT markers (interactive accept).** If the body contains the substring `**DRAFT**` (case-sensitive) but no template placeholders, the body was auto-drafted by `dev-add-change` and has not been human-accepted. Do **not** hard-reject — instead:
   1. Print the three drafted sections (`## Why`, `## Approach`, `## Done when`) verbatim to the terminal so the user can read what they're accepting.
   2. Ask via `AskUserQuestion`:
      - Question: `"Accept this auto-drafted body as-is and proceed to PLAN?"`
      - Options:
        - `"Accept as-is"` — strip DRAFT markers, continue to step 2.
        - `"Stop — I want to edit first"` — abort so the user can edit the file.
   3. If **Accept as-is**: use the Edit tool with `replace_all: true` to remove the literal line `> **DRAFT** — review and refine before invoking dev-write-change.` from the change entry (this nukes all three occurrences in one call). Also update the entry's `updated:` field to ISO 8601 UTC now. Then proceed to step 2.
   4. If **Stop**: print `Aborted — edit vault/wiki/<domain>/change/<change>.md (remove the > **DRAFT** lines, refine if needed) then re-run.` and stop.

   The audit's `change-body-template-placeholder` check catches both conditions independently, but this gate handles them at the moment they would cause harm — and offers a one-click accept path for auto-drafts so a satisfied human doesn't have to hand-edit the file.

2. **Read the universal standards.** Use the Read tool on:
   - `vault/wiki/_seed/development/reference/standard-code-quality.md` (code shape, deps, BC, security, tests, comments, repo conventions)
   - `vault/wiki/_seed/development/reference/standard-git-hygiene.md` (branch + commit + PR conventions)

   The plan you compose MUST respect these. Any intentional deviation belongs in the plan's `## Risk` section with rationale — never silently violated.

3. **Resolve the read source.** PLAN is a read-only pass — it composes a plan against the repo's `default_branch` snapshot, NOT whatever branch the user happens to have checked out. This decouples planning from working-tree state (you can plan a new change while a different feature branch is checked out in `local_path`).

   Strategy: prefer the OS-managed read cache (`.claude/state/pr-review-cache/<owner>/<repo>/`); fall back to `local_path` with the original branch+clean gate when the cache is unavailable.

   **3a. Compute `owner/repo`** from the entity entry's `remote_url` **when it is a GitHub URL** (`https://github.com/<owner>/<repo>`). If `remote_url` is `null` or points at a non-GitHub host, this is a **local-only repo** — a first-class ingest class (`remote_url: null` for purely local repos per the entity archetype; see [[dev-ingest-repo]]'s local flow). The OS-managed cache does not apply: skip steps 3b–3c and go straight to the 3d `local_path` flow, framed as "local-only repo — cache not applicable" (NOT the degraded-fallback warning). Do **not** guess an owner from the entity id — the id is the bare repo slug and carries no owner, so a guess would make 3c clone an unrelated repo.

   **3b. Check cache freshness.** Cache path: `.claude/state/pr-review-cache/<owner>/<repo>/`. If the directory exists AND its last refresh was within 5 minutes (see [[dev-cache-pr-review-repo]] § Staleness gate), set `read_path = <cache-path>` and skip to step 4.

   **3c. Auto-trigger the cache skill when missing or stale.** Invoke `[[dev-cache-pr-review-repo]]` with inputs `{ owner: "<owner>", repo: "<repo>" }`. The skill accepts the owner+repo pair directly (no PR URL needed) and shallow-clones / fast-forwards `default_branch` into the cache path. On success, set `read_path = <cache-path>` and continue.

   **3d. Read from `local_path`.** Reached two ways: **(i) local-only repo** routed here from 3a (cache not applicable — this is the expected read path, not a fallback), or **(ii) degraded fallback** when the cache step (3b–3c) failed for a GitHub repo (network, auth, etc.).
   - `cd` into `local_path`. Verify it's a git repo and working tree is clean (`git status --porcelain` empty) on `default_branch`. If not, abort with the specific issue (see `standard-git-hygiene` § 1).
   - Set `read_path = <local_path>`.
   - **Only for (ii)** surface a warning in the final report: `⚠ Used local_path fallback for PLAN reads — cache step failed (<reason>). Consider re-running once <reason> is resolved.` For (i) local-only repos, print no warning — reading from `local_path` is expected (there is no cache to prefer).

   The rest of this step set uses `read_path` for all reads. EXECUTE phase still uses `local_path` (writing happens in the user's clone, on a feature branch).

4. Read the change entry's body to understand intent + done-when criteria.
5. **Read the repo entity entry's `## Conventions` section** (and its `build_command` / `test_command` frontmatter). Repo-specific overrides take precedence over the universal standards from step 2 — note any divergence so the plan reflects the right rules.

   **Bonus context (when available):** if `vault/wiki/development/repo-knowledge/repo-knowledge-<owner>-<repo>.md` exists (produced by [[dev-analyze-repo-for-review]] during PR review setup), read it. It contains a curated prose summary of the repo's stack, structure, conventions, deps, and docs — saves the PLAN walk from rediscovering all that. Treat as authoritative supplement to the entity's `## Conventions` section.

6. If `scope` is set on the change, use it as a starting list of files to inspect (resolve against `read_path`). Otherwise, infer from intent.
7. Walk the relevant subtree under `read_path` (use Read/Grep/Glob — read-only). Understand:
   - Current state of files that will likely change
   - Existing patterns, utilities, hooks the change should reuse (per `standard-code-quality` § 1 "Reuse before introducing")
   - Test framework + how existing tests are structured (per `standard-code-quality` § 5)
   - Style configs that constrain code shape

   **Important:** `read_path` reflects `default_branch`, not whatever the user's local clone is currently on. References to file paths in the plan are relative to the repo root — they're equally valid in the user's local clone when EXECUTE runs.

7a. **Surface rationale comments in the candidate touched files.** Inline `// TAG:` comments (WHY, HACK, NOTE, FIXME, TODO, XXX, CAVEAT, IMPORTANT, WARNING, GOTCHA) are institutional memory — they explain _why_ code is shaped weirdly. Easy to skim past in a 1000-line file; pulled into a focused block they become constraints the plan must respect.

    Run the extractor against the set of files step 7 identified as likely-to-modify:

    ```bash
    node scripts/extract-rationale-comments.mjs \
      --repo "<read_path>" \
      --files "<comma-list of candidate files>"
    ```

    Stdout is a JSON blob shape `{ files: { <rel>: [{ line, tag, body, context }] }, summary: { findings_total, by_tag } }`. Read it as part of your planning context. For each finding:

    - **HACK / CAVEAT / WARNING / GOTCHA**: a documented constraint. The plan MUST either preserve the workaround OR explicitly call out that it's being removed (with a one-line "why this is safe to remove now" in the Risk section).
    - **WHY**: rationale for the current shape. Read it; the plan should not blindly contradict the explanation without addressing it.
    - **NOTE / IMPORTANT**: context the reader (or future-you, the executor) should know about. Cite the relevant ones inline in the plan's `## Approach` if they shape decisions.
    - **TODO / FIXME / XXX**: incomplete work flagged by a previous author. If the plan happens to address one of these, mention it. If the plan moves code containing one of these without fixing it, preserve it verbatim.

    Findings with empty bodies are dropped by the extractor. Findings on lines the plan intends to delete should still be acknowledged (the comment was load-bearing once; if you're removing it, say why).

    If the extractor finds nothing across all candidate files, skip this consideration. Don't pad the plan with "no rationale comments found" — silence is fine.

8. Compose a plan with EXACTLY the structure below — be precise. The reviewer will check each section against `standard-code-quality` + `standard-git-hygiene` + the entity's Conventions.
9. Write the plan to `vault/output/<domain>/changes/<change>-plan.md`. Create the directory if needed.
10. Update the change entry's frontmatter (via Edit tool):
    - `plan_path: vault/output/<domain>/changes/<change>-plan.md`
    - `plan_generated_at: <ISO 8601 UTC now>`
    - `updated: <ISO 8601 UTC now>`
    - If RE-PLAN: also clear `review_path: null`, `reviewed_at: null`, set `review_status: pending`
11. Record the audit event via the dual-write wrapper:
    ```bash
    node scripts/record-dashboard-action.mjs \
      --action write-change-plan \
      --skill dev-write-change \
      --args '{"change":"<id>"}' \
      --files-touched '["<plan_path>","<change_entry>"]'
    ```
12. Print:
    ```
    ✓ Plan written for <title>
      phase:   PLAN (review_status: pending)
      read:    <cache | local_path>   (cache = .claude/state/pr-review-cache/<owner>/<repo>/; local_path = local-only repo or degraded fallback)
      plan:    vault/output/<domain>/changes/<change>-plan.md
      next:    /os review-change <change>   (run dev-review-change to gate execution)
    ```
13. **Stop**. Do not proceed to execute.

### Plan template (write this exactly)

```markdown
# Plan — <title>

**Generated:** <ISO>
**Change:** [[<change-id>]]
**Repo:** [[<repo-id>]] · branch will be `<branch>`

## Intent (from change entry)

<body's Why section, verbatim>

## Approach

1. <numbered step — what you'll do first>
2. <next step>
3. <continue until the work is fully specified>

## Files I will modify

- `<path>` — <one-line summary of the change>
- ... (list every file)

## Files I will create

- `<path>` — <purpose>
- ... (or "(none)")

## Files I will NOT touch (even if related)

- `<path>` — <one-line reason — guards against scope creep>
- ... (call out anything tempting that's out of scope)

## Tests

- New test cases planned:
  - `<file>::<test name>` — <what it asserts>
- Existing tests likely to need updates:
  - `<file>::<test name>` — <why>
- Test command: `<from repo entity's test_command>`

## Risk

- **<area>**: <severity (low/med/high)> — <mitigation or explanation>
- ... (always include at least one entry, even if it's "low across the board because the change is purely additive")

## Out-of-scope concerns surfaced

While reading the repo I noticed:

- <thing not in this change but worth a follow-up>
- ... (or "(none — this change's scope was clean)")
```

### Step 4: EXECUTE phase

When you reach this phase:

1. Read `plan_path`. Reject with `plan missing — re-run write-change to regenerate` if not found.

1a. **Parent change invariant check.** If the change entry's frontmatter has a `parent_change` field set, read the parent at `vault/wiki/<domain>/change/<parent_change>.md`. Enumerate the parent's load-bearing invariants — state-mutation, rewind/migration semantics, error-propagation contracts, snapshot/checkpoint obligations. For each new persistent surface this change introduces (new tables, new on-disk format, new long-lived in-memory cache, new fanout target), verify the parent's invariants extend correctly.

The plan should already account for this, but EXECUTE is the last cheap point to catch a "frontmatter named the predecessor; neither plan nor review carried the implication forward" miss. If a gap surfaces, abort:

```
⚠ Parent-change invariant gap — <change>
  parent:    [[<parent_change>]]
  invariant: <one-line — e.g. "reorg handler must rewind all persistent state">
  surface:   <one-line — e.g. "new typed-tables introduced with no rewind hook">
  next:      either extend this change to honor the invariant, OR re-plan with
             force_replan=true and explicitly justify the carve-out in § Risk.
```

When no `parent_change` is set, skip silently.

_Rationale: added in response to the `parent_change frontmatter is load-bearing context that wasn't used` finding in audit `audit-abi-decoding-via-codegen-typed-event-structs-and-per-event` — the change's parent named the reorg handler, but execute introduced typed tables with no rewind hook (caught only at PR-review pass-3, ~$5+ in intermediate cycles). See decision `decision-dev-write-change-when-a-change-has-a-parent-change-field-execute` in your local vault (per-install — these references are intentionally NOT wikilinks because the targets live in gitignored audit/decision paths and won't resolve on other installs)._

2. If `review_status == "overridden"`: record an audit event BEFORE proceeding (makes overrides auditable):
   ```bash
   node scripts/record-dashboard-action.mjs \
     --action write-change-override \
     --skill dev-write-change \
     --args '{"change":"<id>"}'
   ```
3. **Branch creation follows [[standard-git-hygiene]] § 1–3 exactly.** Do not deviate:
   - Verify working tree clean: `git -C <local_path> status --porcelain` must be empty. If dirty, abort with the dirty-file list and ask the user to commit/stash/discard.
   - Verify on `default_branch`: if not, abort with the current branch.
   - Fetch + fast-forward latest: `git -C <local_path> fetch origin && git -C <local_path> pull --ff-only origin <default_branch>`. Never auto-merge.
   - Create the branch: `git -C <local_path> checkout -b <branch>`. If a branch with that name already exists, follow `standard-git-hygiene` § 2's resolution rules (don't auto-resolve).
4. **Follow the plan exactly AND [[standard-code-quality]].** For each "Files I will modify" + "Files I will create" entry, make the change as described. Constraints during edits (all from `standard-code-quality`):
   - Reuse existing utilities visible in the repo before introducing new ones (§ 1)
   - No new dependencies unless the plan justified them in § Risk (§ 2)
   - No breaking changes to public APIs unless the plan justified them in § Risk (§ 3)
   - Match the repo's test conventions; add tests for new behavior (§ 5)
   - Default to no comments; only WHY when non-obvious (§ 6)
   - Match neighboring code style; don't reformat unrelated code (§ 7)

   Use the actual code patterns observed during PLAN — don't re-architect on the fly.

5. After all edits, run the test command from the plan. Capture stdout + exit code.
6. **Commit** following [[standard-git-hygiene]] § 4 (conventional-commit / semantic-release format). Only commit when tests pass; on failure skip to step 8.
   - **Resolve commit type**: parse the first `/`-separated segment of the change entry's `branch:` field.
     - If it is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`, `ci`, `revert` → use it.
     - If it is `agent` (legacy default) or anything else not in the set → use `chore` as fallback AND emit a stderr warning: `warning: branch prefix "<prefix>" does not map to a semantic-release type; commit type defaulted to "chore". Future changes should use one of feat|fix|docs|style|refactor|test|chore per standard-git-hygiene.`
   - **Resolve commit scope** (optional): if the change entry's `scope:` field is set AND is short enough to be a meaningful scope (≤ 20 chars, ≤ 2 path segments), use it as `(<scope>)`. Otherwise omit.
   - **Compose subject**: `<type>[(<scope>)]: <subject>` where `<subject>` is the change's `title:` field, lowercased first character (Angular style: imperative, lowercase). Trim trailing period if any. Hard limit 72 chars — if longer, truncate the subject at a word boundary and end with `…`.
   - **Compose body**: extract the first paragraph of the change's `## Why` section (verbatim, no DRAFT markers — they were stripped earlier). Hard-wrap at 72 cols.
   - **Compose footer**: `refs: vault/wiki/<domain>/change/<slug>.md`. If the plan's § Risk identified any BREAKING CHANGE, add a line `BREAKING CHANGE: <description from plan>` BEFORE the refs line.
   - **Stage + commit**:
     ```bash
     git -C <local_path> add <every file from plan's "Files I will modify" + "Files I will create">
     git -C <local_path> commit -m "<subject>" -m "<body>" -m "<footer>"
     ```
     Use multiple `-m` flags to compose the message rather than a heredoc — keeps the commit command simple to log.
   - Capture the new commit SHA: `git -C <local_path> rev-parse HEAD`.
7. If tests pass (and step 6 commit succeeded):
   - **Auto-push when a PR exists.** If the change entry has `pr_url` set (i.e. dev-open-pr has already run), push the follow-up commit to origin so the PR reflects the new code:

     ```bash
     git -C <local_path> push origin <branch>
     ```

     - On success: capture the pushed range for the audit event (`pushed_from: <prior_sha>`, `pushed_to: <new_sha>`).
     - On failure (network blip, push-rejection): surface the stderr in the summary block, **do not** roll back the commit (it's on disk and the user can `git push` manually). Set `pushed: failed` in the summary; the manual Push button on the dashboard's PR tab covers recovery.
     - When `pr_url` is null (EXECUTE before dev-open-pr runs): skip — first push is dev-open-pr's job.

   - Update the change entry: `status: in-progress`, `updated: <ISO>` (or keep `status: in-review` if it was already in-review — ADDRESS-COMMENTS path).
   - Update the repo entity: `current_branch: <branch>`, `updated: <ISO>`.
   - Record the success event (include push outcome in args):
     ```bash
     node scripts/record-dashboard-action.mjs \
       --action write-change-execute \
       --skill dev-write-change \
       --args '{"change":"<id>","outcome":"success","commit_sha":"<sha>","commit_subject":"<subject>","pushed":"<yes|no|failed|n-a>"}' \
       --files-touched '[<every file modified, as JSON array>]'
     ```
   - Print summary:
     ```
     ✓ Executed plan for <title>
       phase:   EXECUTE (status: in-progress)
       branch:  <branch>
       commit:  <short-sha> <subject>
       tests:   passed (<command>)
       pushed:  yes (origin/<branch>) | n-a (no PR yet — open one) | failed (<short stderr>)
       next:    review the diff (`git -C <local_path> show <sha>` or `git -C <local_path> diff <default_branch>...<branch>`), then open a PR
              and update the change entry's pr_url + set review_status: in-review.
     ```

8. If tests fail:
   - **Do not** try to fix on the fly. The plan was approved; deviating mid-execute is exactly the failure mode the review gate exists to prevent.
   - Write a failure log to `vault/output/<domain>/changes/<change>-execution-log.md` capturing: the test command output (last 200 lines), the file diff, the timestamp.
   - Record the failure event with `--exit-status` set to the test command's exit code:
     ```bash
     node scripts/record-dashboard-action.mjs \
       --action write-change-execute \
       --skill dev-write-change \
       --args '{"change":"<id>","outcome":"test-failure"}' \
       --files-touched '["<execution-log path>"]' \
       --exit-status <test-cmd exit code>
     ```
   - Leave the branch in place so the user can inspect.
   - Print:
     ```
     ✗ Plan execution failed test phase for <title>
       phase:   EXECUTE FAILED
       branch:  <branch> (left in place for inspection)
       log:     vault/output/<domain>/changes/<change>-execution-log.md
       next:    inspect the diff + log. Either fix manually, abandon the branch,
              or re-plan with `force_replan: true` (this captures new context as
              a fresh plan that goes back through review).
     ```
   - Stop. Do not retry. Do not auto-fix.

### Step 4b: ADDRESS-COMMENTS phase

Triggered by the Step 2 first-check: change is `status: in-review`, has a linked `pr_review_path`, and the latest pass carries at least one `accepted` or `published` comment with no `acted_on_at` set. The intent is to **re-implement against curated review feedback** — the human has triaged the OS-side review and selected which comments deserve code changes.

1. **Verify the branch state.** Run `git -C <local_path> status --porcelain` — must be empty. Run `git -C <local_path> branch --show-current` — must equal the change entry's `branch:` field. Reject if either fails:
   - Dirty: `branch <branch> has uncommitted changes — commit/stash before re-implementing.`
   - Wrong branch: `current branch is <X>, expected <branch> — switch first.` (Don't auto-switch; the user may have intentional work elsewhere.)
   - Branch missing entirely: `branch <branch> not found — was it deleted? Address comments manually or re-create from the change entry.`

2. **Load the linked pr-review entry.** Read `pr_review_path`. Parse via js-yaml. Walk the body to find the highest-N `## Pass N` section. Reject if the file is missing or has no Pass sections:
   - Missing file: `pr_review_path "<path>" not found — the linked review was deleted. Edit the change entry's pr_review_* fields if this is intentional.`
   - No passes: `pr-review entry has no ## Pass sections — corrupted? Run dev-pr-review again first.`

3. **Extract the work list.** Walk the latest pass's `#### Comment` blocks. For each, parse the header lines (`file`, `line`, `status`, `accept_note`, `acted_on_at`, `github_comment_id`). Build a list:
   - INCLUDE comments where `status` is in `{accepted, published, published-as-body}` AND `acted_on_at` is unset.
   - SKIP all others (`new`, `dismissed`, `resolved`, `wontfix`, or anything already `acted-on`).

   Capture each kept comment's full record: `{n, file, line, status, body, accept_note, github_comment_id}`. The number `n` and pass number give us `pass-<P>-comment-<n>` — the anchor we'll use for the writeback in step 7.

   If the list is empty after filtering, surface idempotently and stop: `↻ Nothing to address — latest pass has no accepted/published comments without acted_on_at. Re-run dev-pr-review if the model should re-evaluate.`

4. **Read context.** Load the change entry's plan from `plan_path` (the originally-approved plan). Read the most recent commit on `<branch>` for context: `git -C <local_path> log -1 --format='%H %s'`. Read each file referenced by the kept comments via Read tool so subsequent edits are based on current contents.

5. **Compose the re-implement scope.** Build a brief synthesizing the work to be done. Structure:

   ```
   # Re-implement: <change.title>

   ## Comments to address (<n> items)

   ### Comment <pass-P-comment-n>: <category> · <severity>
   - file: <file>:<line>
   - status: <accepted|published>
   - accept_note: <accept_note if present, else "(none)">

   <comment body verbatim>

   ---
   <repeat for each kept comment>

   ## Original plan (for context)

   <inline plan content, abridged to the "Files I will modify" + "Approach" sections>

   ## Constraints
   - Each comment must be addressed in code OR explicitly justified as not-fixable
     (e.g. the comment is about non-code: docs the PR can't change, future work, etc.).
   - Follow [[standard-code-quality]]. No drive-by reformatting; touch only what's
     required by the comment.
   - Match the existing branch's commit style — these will be follow-up commits
     to <branch>, not new branch commits.
   ```

   This block is the contract for the edit pass.

6. **Make the edits.** For each comment in the kept list, plan and apply the smallest set of edits that resolves it:
   - Prefer one edit per comment when possible. When two comments target the same hunk, apply both in one Edit call.
   - Run the repo's `test_command` after edits. Capture exit code.
   - Do NOT proceed to step 7 (writeback) if tests fail — leave the branch in place, write a failure log per the EXECUTE step 8 template (replace action name `write-change-execute` with `write-change-address-comments`), and stop. The user can inspect and either fix manually or re-run.

6a. **Post-fix boundary check.** Before committing, examine the diff produced in step 6. If the diff introduced **new abstractions** — a new function call, a new code-path branch, a new state-mutating fanout, a new helper signature — run a focused self-review on the boundaries of those additions. Skip this check entirely for **mechanical fixes** (reorder, defensive-copy, comment/docs-only edits) — those don't have the failure mode this check targets.

For each new abstraction in the diff, verify:

- **(a) Every new function call resolves to a definition in the diff or pre-existing code.** If the fix added `decodeBytesNTopic(...)`, confirm the helper exists. Orphan calls become compile failures or missing-symbol bugs the next PR-review pass catches.
- **(b) Every new state mutation reasons about partial-failure / atomicity.** If the fix added fanout (`for _, sink := range sinks { sink.RewindTo(n) }`), reason explicitly about what happens if one fanout target fails mid-loop. Pick a semantics — best-effort, atomic, transactional — and document the choice inline OR accept the half-state risk explicitly in the commit body.
- **(c) Every new test path exercises actual production code, not a parallel implementation.** If a test reimplements the production logic to verify the result, the test passes regardless of whether production is correct — it tests the test. Sanity-check that the test calls the same code path the production caller would.

When the check surfaces an issue, fix it in this same address-comments cycle (loop back to step 6 for the additional edit, then re-check). The point is to catch boundary defects pre-commit, not punt them to the next PR-review pass.

_Rationale: this check was added in response to the `fix-introduces-defect-at-boundary` pattern observed across 3 consecutive address-comments cycles in audit `audit-abi-decoding-via-codegen-typed-event-structs-and-per-event`. Each cycle's fix introduced a new abstraction whose boundary obligations were not satisfied — caught only by the next PR-review pass at $5/occurrence. See decision `decision-dev-write-change-after-applying-a-fix-in-the-address-comments-phase` in your local vault (per-install — these references are intentionally NOT wikilinks because the targets live in gitignored audit/decision paths)._

6b. **New-test execution & defect-fold obligation.** When the edits in step 6 introduced a NEW test (not just a modification to an existing test) that targets a load-bearing path identified by a pr-review comment, verify the new test was actually exercised by the test run in step 6 — not merely compiled. Concretely:

- Confirm the new test name appears in the test_command's stdout (or the framework's structured report). A test that compiles but isn't selected by the runner (wrong package, build-tag gated out, file outside the suite) would silently ship the gap the pr-review comment flagged.
- If the new test fails or surfaces a defect, fold the necessary source fix into THIS address-comments cycle — either as additional edits in the same commit, or as a sibling commit in the same cycle before the writeback in step 8. Do NOT defer the defect to a separate change. The test was added to close the gap; shipping it as a known failure (or skipping it) reintroduces the gap.

_Rationale: this obligation was added in response to the medium-confidence tuning suggestion in audit `audit-multi-contract-multi-chain-sources-list-in-config-per-source` — `TestRunIndex_MultiSourceErrgroupCoordinatesShutdownAndIsolatesCheckpoints` was added to address pass-1 finding #6 and surfaced a latent SQLITE_BUSY defect, fixed via `_pragma=busy_timeout(5000)` in the same cycle. The positive case shows that running an added test in-cycle reveals real defects; the negative case (test compiles but isn't actually run) would silently ship the gap. See decision `decision-dev-write-change-when-address-comments-adds-a-new-test-for-a` in your local vault (per-install — these references are intentionally NOT wikilinks because the targets live in gitignored audit/decision paths)._

7. **Commit the follow-up** following [[standard-git-hygiene]] § 4. Subject convention:
   - `<type>(<scope>): address review comments — <short summary>` where `<short summary>` is a one-clause description (e.g. "fix copyright year, drop unused import").
   - Body: enumerate addressed comments in `Refs: pass-P-comment-n` lines (one per).
   - Footer: `Refs: vault/wiki/<domain>/pr-review/<pr_review_id>.md`.

   Capture the new commit SHA.

7a. **Auto-push the follow-up commit.** ADDRESS-COMMENTS runs on an existing PR (`pr_url` is set, `status: in-review`), so the commit MUST land on origin for CI to fire and for the next Re-review pass to see it. Push without prompting:
`bash
    git -C <local_path> push origin <branch>
    ` - On success: capture the pushed range (`pushed_from`, `pushed_to`) for the audit event. - On failure: surface the stderr in the final summary block as `pushed: failed (<short stderr>)`, **do not** roll back the local commit, **do continue** to step 8 (the writeback). The user can recover via the manual Push button on the change's PR tab or by running `git push` themselves. - The branch is expected to exist on origin (dev-open-pr created it). If `git push` returns a non-fast-forward error, surface the stderr and stop — that means someone else pushed; the user must rebase/resolve manually.

8. **Write back to the pr-review entry.** For each comment in the kept list, surgically Edit its header block in the body via the Edit tool — same surgical pattern as Phase 2's accept/dismiss:
   - Replace `- status: accepted` (or `- status: published`) → `- status: acted-on`
   - Insert `- acted_on_at: <ISO now>` immediately after the new status line.
   - Preserve all other header lines (`file`, `line`, `prior`, `accept_note`, `github_comment_id`, `github_review_id`) and the comment body verbatim.

   Then update the pr-review entry's frontmatter `updated: <ISO now>` (don't touch other frontmatter — `result`, `pass_count`, etc. are owned by dev-pr-review).

   Do NOT rewrite the whole file. Surgical Edit per comment header + the one frontmatter field.

9. **Bump the change entry.** Set `updated: <ISO now>`. The `status` stays `in-review` (the PR still awaits human merge; addressing comments doesn't change that).

10. **Record the event:**

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action write-change-address-comments \
      --skill dev-write-change \
      --args '{"change":"<id>","pr_review":"<pr_review_id>","pass":<latest_pass_n>,"addressed_count":<n>,"commit_sha":"<sha>","pushed":"<yes|failed>"}' \
      --files-touched '<[every file modified + the pr-review path + the change path, as JSON array]>' \
      --exit-status 0
    ```

11. **Confirm to the user** with a tight report:

    ```
    ✓ Addressed review comments — <change>
      pass:       <latest_pass_n>
      addressed:  <n> comment(s)
      branch:     <branch>
      commit:     <short-sha> <subject>
      pushed:     yes (origin/<branch>) | failed (<short stderr>)
      next:       run /os review-pr (continuation pass) to verify the new commit
                  clears the comments,
                  OR Mark ready for human + merge the PR on GitHub.
    ```

### Step 5: Request-changes path

When `review_status == "request-changes"` and `force_replan == false`:

1. Read `review_path`. Surface the verdict + concerns (just the "Concerns" section is enough).
2. Print:
   ```
   ⚠ Reviewer requested changes for <title>
     review:  vault/output/<domain>/changes/<change>-review.md
     verdict: request-changes
     concerns: <N>
     options:
       (a) re-plan addressing the concerns:
           /os write-change <change> --force_replan=true
       (b) override the reviewer's verdict and execute the original plan:
           edit change entry, set review_status: overridden, then re-run write-change
       (c) abandon: edit change entry, set status: abandoned
   ```
3. Stop.

## Outputs

- Plan written to `vault/output/<domain>/changes/<change>-plan.md` (PLAN phase)
- Branch created + files edited in `repos/<repo>/` (EXECUTE phase)
- Follow-up commits on the existing branch + per-comment `status: acted-on` + `acted_on_at` writebacks on the linked pr-review entry (ADDRESS-COMMENTS phase)
- Execution log at `vault/output/<domain>/changes/<change>-execution-log.md` (only on test failure)
- Change entry frontmatter updates: `plan_path`, `plan_generated_at`, `status`, `updated`
- Audit log lines for each phase

## Errors

- Change not found → reject with id
- Status invalid for current phase → reject with the status + which phase was expected
- Repo entity missing or `kind != repo` → reject
- Repo working tree dirty → reject; user must clean before proceeding
- Plan missing in EXECUTE phase → reject; suggest re-running write-change
- Tests fail in EXECUTE or ADDRESS-COMMENTS phase → write log, leave branch, stop (don't retry)
- Reviewer requested changes and `force_replan: false` → surface concerns; user picks next action
- ADDRESS-COMMENTS phase invoked but `pr_review_path` missing → reject; suggest running dev-pr-review first
- ADDRESS-COMMENTS phase invoked but no qualifying comments → idempotent stop with `↻ Nothing to address`

## See also

- [[standard-change-workflow]] — full state machine + plan/review templates + override path
- [[dev-review-change]] — the peer reviewer
- [[archetype-change]] — change archetype contract + review-gate fields
- [[dev-add-change]] — scaffolds the entries this skill operates on
- [[dev-ingest-repo]] — produces the repo entity this skill needs
- [[archetype-pr-review]] — comment header contract (`status`, `acted_on_at`) read by Step 4b
- [[dev-pr-review]] — produces the pr-review entry this skill's ADDRESS-COMMENTS phase consumes
- [[dev-pr-review-publish]] — Phase 4 skill that flips comments to `published`; Step 4b filters by `{accepted, published, published-as-body}`
