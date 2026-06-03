---
name: dev-close-change
description: 'Verify a PR is merged on GitHub and transition the linked change to status: merged. Writes merged_at + bumps updated. Idempotent stop when the PR is not yet merged or already closed.'
user-invocable: true
version: 1
domain: development
tags: [change, lifecycle, close, github]
inputs:
  change:
    type: string
    required: true
    description: 'Change id (the slug, e.g. `add-license`). The skill resolves the entry path via the vault manifest.'
  override:
    type: boolean
    required: false
    default: false
    description: 'Bypass the merge-state check. When true, the skill writes `status: merged` even if GitHub reports the PR is not actually merged. Recorded in the event with `override: true` for audit. Use when GitHub state is stale or the change is being closed via an alternate path (e.g. rebased-and-merged with squash that confuses the merge detection). Override ALSO skips the local branch cleanup step (since we didn''t verify the merge, deleting the local branch would risk losing un-pushed work).'
  skip_branch_cleanup:
    type: boolean
    required: false
    default: false
    description: 'Skip the local branch cleanup step (checkout default branch + ff-pull + delete merged feature branch). Use when the local repo is checked out elsewhere or the operator wants to preserve the feature branch locally for follow-up commits. Doesn''t affect the vault writes — the change still transitions to status: merged.'
outputs:
  - kind: file
    path: vault/wiki/{{domain}}/change/{{input.change}}.md
spawns: []
---

# dev-close-change

## Purpose

Close out a change that's been merged on GitHub — the terminal step in the OS-authored PR lifecycle. Transitions the change entry from `status: in-review` to `status: merged`, stamps `merged_at`, and bumps `updated`. Without this skill, the change is stuck at `in-review` forever even after the PR has shipped, leaving the lifecycle stepper incomplete and the Changes app's filter buckets wrong.

The skill is **GitHub-verified by default**:

- Calls `mcp__github__get_pull_request` to read the live PR state
- Only writes `status: merged` when GitHub confirms `merged: true`
- Captures the merge timestamp from GitHub (the PR's `merged_at` field) when available, falling back to "now" if not

This is the symmetric counterpart of [[dev-mark-pr-ready]]:

- `dev-mark-pr-ready` signals **the OS has signed off** on a PR (`pr_review_status: ready-for-human`)
- `dev-close-change` signals **the human has merged** the PR (`status: merged`)

Both are vault-mutation skills with a single state-transition writeback. dev-close-change adds one MCP read on top.

## Pre-conditions

- github MCP configured and authenticated. Pre-flight via:

  ```bash
  node scripts/check-mcp.mjs github
  ```

- The change entry exists, has `pr_url` set, and is currently in `status: in-review`. Other statuses are rejected by step 3.

## Procedure

1. **Pre-flight: verify the github MCP.** Run `node scripts/check-mcp.mjs github --json`. If exit code is non-zero, surface the script's `hint` field verbatim and stop. (Skip this step if `inputs.override === true` — override mode is for the case where GitHub is unreachable or its state is stale.)

2. **Resolve the change entry path.**

   Read `vault/.index/manifest.json`. Find the entry whose `id === inputs.change` AND `type === 'change'`. If multiple match (shouldn't happen), prefer the one under `vault/wiki/development/change/`. If none match, reject:

   ```
   Change `<change>` not found in the vault manifest. Did you mean `/os add-change`?
   ```

3. **Parse the entry's frontmatter** and validate the gate:

   | check                                                                           | failure mode                                                                                                                                           |
   | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `pr_url` is set                                                                 | reject: `Change \`<change>\` has no pr_url — open a PR first via dev-open-pr.`                                                                         |
   | `status === 'in-review'`                                                        | **Idempotent stop** when `status === 'merged'`: `↻ Change \`<change>\` is already merged (since <merged_at>). Nothing to do.` (no event, no writeback) |
   |                                                                                 | Reject for any other status: `Change \`<change>\` is in status: <X> — close-change only operates on in-review changes.`                                |
   | `pr_url` parses as a GitHub PR URL `https://github.com/<owner>/<repo>/pull/<n>` | reject: `pr_url has unexpected shape: <pr_url>. Expected https://github.com/<owner>/<repo>/pull/<N>.`                                                  |

4. **Fetch live PR state via the github MCP.** Skip this step if `inputs.override === true`.

   ```json
   { "owner": "<owner>", "repo": "<repo>", "pull_number": <n> }
   ```

   Tool name: `mcp__github__get_pull_request`. Capture from the response:
   - `state` (`open` / `closed`)
   - `merged` (boolean)
   - `merged_at` (ISO timestamp, when `merged === true`; null otherwise — GitHub returns this field)
   - `html_url` (canonical PR URL)

5. **Validate the merge state.** Skip if `inputs.override === true`.
   - `merged === true` → proceed to step 6 with the GitHub-captured `merged_at`
   - `state === 'closed'` AND `merged === false` → reject: `PR is closed without being merged. Use \`/os abandon-change <change>\` to mark the change abandoned instead.`(The`abandon-change` skill is future work; the message is informative until then.)
   - `merged === false` AND `state === 'open'` → **idempotent stop** (not an error):

     ```
     ↻ PR is not yet merged on GitHub — current state: open.
       Merge the PR on GitHub first, then re-run /os close-change.
       (Or pass override: true to force-close anyway — recorded in the audit log.)
     ```

     Skip steps 6–7; record an event with `noop: true` and `reason: 'pr-not-merged'`.

6. **Compute the writes:**
   - `status: merged`
   - `merged_at: <github_merged_at>` (from step 4) OR `<now>` if `override === true` and GitHub data unavailable
   - `updated: <now>` (ISO 8601 UTC — same `now` used for the event timestamp so they're aligned)

7. **Apply the writes surgically via the Edit tool** — preserve comments, field order, and unrelated fields. Three cases per field:
   - **Field already present** with a different value → replace its value on the existing line.
   - **Field already present** with the target value → leave it (no-op; shouldn't happen since step 3 ruled out `status: merged` already).
   - **Field missing** → insert it. Place `merged_at` near other terminal-state timestamps (`ci_completed_at` is a natural neighbor when it exists; otherwise insert right after `status:`). Place `updated:` on its existing line.

   Do NOT rewrite the whole frontmatter block — surgical Edit only.

7b. **Check off all "Done when" items** in the body. The premise: once the PR is merged, every success criterion is by definition satisfied — otherwise the human wouldn't have merged. Locate the `## Done when` section (case-sensitive header). For every line matching `^- \[ \] ` immediately under the section header (until the next `## ` header or EOF), replace `- [ ]` with `- [x]`. Skip lines that are already checked. If the section doesn't exist, skip this step entirely (some changes don't carry a Done-when list — that's fine).

    Surgical Edit via the Edit tool, NOT a body rewrite. Prepend the section with a `<!-- All criteria auto-checked by dev-close-change on <ISO> when the PR was confirmed merged on GitHub. -->` comment so the audit trail is visible if a future reader wonders why a checkbox wasn't manually toggled. Insert the comment only when at least one box was actually flipped — don't pollute the entry on idempotent re-runs.

    **Override path:** when `inputs.override === true`, the PR isn't verified merged — the criteria aren't guaranteed satisfied. Skip this step on override unless the user passed a separate `mark_done_when: true` input (future extension); for now, leave the checkboxes alone on overrides and surface a note in the report.

7c. **Local branch cleanup.** Returns the local repo to the default branch + deletes the merged feature branch. Without this, the local repo stays on the merged feature branch, and the next change's `dev-write-change` EXECUTE pre-flight refuses because the working tree isn't on main (see the friction tracked at the orchestrator level).

    **Skip this step entirely when:**
    - `inputs.override === true` (override means we didn't verify the merge — don't touch the local repo)
    - `inputs.skip_branch_cleanup === true` (operator opted out)
    - The change's frontmatter has no `branch:` field (defensive — nothing to clean up)
    - The change's `repo:` doesn't resolve to a local clone (skill steps below will detect + skip gracefully)

    **Procedure:**

    a. **Resolve the repo's local path.** Read `vault/.index/manifest.json`, find the entity entry where `id === <change.repo>` AND `type === 'entity'`. From that entry's frontmatter, extract `local_path`. If the entity entry is missing OR has no `local_path`, skip this step entirely (the repo isn't ingested as a managed clone — there's nothing to clean up locally) and proceed to step 8.

    b. **Verify the repo state.** Run, capturing output:

       ```bash
       git -C <local_path> rev-parse --is-inside-work-tree
       git -C <local_path> status --porcelain
       ```

       If `rev-parse` fails (not a git repo) OR `status --porcelain` returns ANY uncommitted-change lines (working tree not clean), skip cleanup with a note in the report: "branch cleanup skipped: working tree is dirty (uncommitted changes present)". Don't lose user work.

    c. **Resolve the default branch.** Three-tier fallback so clones made
       without `origin/HEAD` (older clones, `git clone --branch X`, shallow
       clones) still get cleaned up (Task #433):

       **Tier 1 — read existing config:**

       ```bash
       git -C <local_path> symbolic-ref --short refs/remotes/origin/HEAD
       ```

       Strip the `origin/` prefix — what's left is the default branch (typically `main` or `master`). On success, proceed to step d.

       **Tier 2 — auto-set on first use:** If Tier 1 fails (no `origin/HEAD` configured), run:

       ```bash
       git -C <local_path> remote set-head origin --auto
       ```

       This queries GitHub for the repo's default branch and stamps `refs/remotes/origin/HEAD` locally. Idempotent + safe (read-only with respect to the source tree). Then retry Tier 1.

       **Tier 3 — fall back to the repo entity entry:** If Tier 2 also fails (network down, remote unreachable), read the repo's `default_branch` field from the entity wiki entry — find the entry by matching `repo:` on the change against the entity's `id`/`name`, look for `default_branch:` in frontmatter. If present, use that value. If absent (older repo entries), skip cleanup with: "branch cleanup skipped: could not resolve default branch (origin/HEAD unset, set-head failed, repo entity has no default_branch field)".

       In all success cases, capture the resolved branch name as `<default_branch>` for step d.

    d. **Fast-forward main + delete the feature branch.** In order:

       ```bash
       git -C <local_path> checkout <default_branch>
       git -C <local_path> fetch --quiet origin
       git -C <local_path> pull --ff-only origin <default_branch>
       git -C <local_path> branch -d <change.branch>
       ```

       The `branch -d` (lowercase) only deletes if fully merged — it'll refuse on local commits not in main, which surfaces the case where someone made follow-up commits we shouldn't lose. On refusal, surface the error verbatim in the report.

       If `<change.branch>` doesn't exist locally (already deleted, or operator works on a different branch name), the `branch -d` returns a `branch not found` error — log it as informational, not a failure.

    e. **Report what happened** in the success message (see step 9). Track which of the four steps succeeded: `default_branch`, `fetched`, `pulled`, `branch_deleted`. The report renders a one-line summary either "branch cleanup: ✓ on <default>, deleted <branch>" or "branch cleanup: skipped: <reason>".

8. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action close-change \
     --skill dev-close-change \
     --args '{"change":"<change>","pr":"<pr_url>","override":<true|false>,"merged_at":"<merged_at_or_null>","github_state":"<state>","github_merged":<bool>,"noop":<true|false>}' \
     --files-touched '<["vault/wiki/<domain>/change/<change>.md"] when step 7 wrote, else []>' \
     --exit-status 0
   ```

   Notes:
   - `noop: true` only when step 5 hit the "PR not yet merged" branch. In that case `files_touched` is `[]`.
   - `github_state` + `github_merged` capture what GitHub reported at close time — useful for tracing inconsistencies (e.g. override fires while GitHub still says open).
   - The shared event-attribution helper picks up `change_id` from `args.change`, so this event lands on the change's lifecycle timeline automatically.

9. **Confirm to the user** with a tight one-screen report:

   Success:

   ```
   ✓ Closed — <change>
     pr:           <pr_url>
     state:        merged on GitHub (verified via mcp__github__get_pull_request)
     merged_at:    <ISO timestamp>
     done-when:    <n> criteria auto-checked   (or "no Done-when section" / "all already checked")
     branch:       ✓ on <default_branch>, deleted <change.branch>
                   (or "skipped: <reason>")
     entry:        vault/wiki/<domain>/change/<change>.md
     next:         change is terminal; lifecycle "merged" stage is now done.
   ```

   Idempotent stop (PR not merged):

   ```
   ↻ Cannot close yet — PR is open on GitHub.
     pr:        <pr_url>
     state:     <state>
     Merge the PR first, then re-run /os close-change.
   ```

   Idempotent stop (already merged):

   ```
   ↻ Already closed — <change> (merged on <merged_at>)
     No write performed.
   ```

   Override path:

   ```
   ✓ Closed via override — <change>
     pr:        <pr_url>
     override:  true   (GitHub merge-state check was skipped — recorded in event)
     merged_at: <ISO timestamp>
     entry:     vault/wiki/<domain>/change/<change>.md
   ```

## Inputs schema notes

- `change`: required. The slug only, NOT a path. The skill resolves the file via the manifest so callers don't need to know the owning domain.
- `override`: optional. Defaults to false. Skips the MCP pre-flight + the merge-state validation, allowing the change to be force-closed. Recorded in the event row for the audit trail.

## Outputs

- The change entry's frontmatter mutated in-place: `status: merged`, `merged_at: <ISO>`, `updated: <ISO>`. All other fields preserved verbatim.
- The change entry's body's `## Done when` checkboxes flipped from `- [ ]` to `- [x]` (step 7b), with an HTML comment marker noting the auto-check. Skipped on overrides + when no Done-when section exists.
- An `events.db` row with `kind: dashboard`, `action: close-change`, `skill: dev-close-change`, `change_id: <change>`, `files_touched: [<change-path>]`.
- A short report to stdout.

## What this skill must NOT do

- **Mutate the PR on GitHub.** Read-only — only `get_pull_request` is called. No close/reopen/comment/label changes.
- **Touch the linked pr-review entry.** Comment state on the review (accepted / dismissed / published / acted-on) is owned by the review-side skills; this skill is exclusively about the change's lifecycle terminal state.
- **Auto-trigger on merge detection.** This skill runs only when explicitly invoked (by the user clicking the Changes detail "Close change" banner, or via `/os close-change <id>`). It does NOT poll. The CI-monitor runbook is the polling counterpart; the two coexist — whichever fires first marks the change merged.
- **Touch sibling changes or projects.** Single-change scope. If a project owns multiple changes, close each one separately.

## Errors

- `Change \`<change>\` not found in the vault manifest.` — verify the slug.
- `Change \`<change>\` has no pr_url — open a PR first via dev-open-pr.` — chronological precondition.
- `Change \`<change>\` is in status: <X> — close-change only operates on in-review changes.` — caller error; close-change can't recover other statuses.
- `pr_url has unexpected shape: <url>.` — malformed PR URL on the entry.
- `PR is closed without being merged. Use /os abandon-change <change> to mark the change abandoned instead.` — chronological gate; the change should transition to `abandoned`, not `merged`.
- `MCP github not configured` → run `/os add-mcp` and add the github MCP.
- `GitHub MCP auth failed` → configure `mcps/github/.env`.
- `branch cleanup skipped: working tree is dirty (uncommitted changes present)` → manual `git stash` or commit, then re-run with `skip_branch_cleanup: false` to finish the cleanup. Vault state is unaffected; this is purely a local repo housekeeping skip.
- `git branch -d <branch> refused: branch not fully merged` → the feature branch has commits that aren't in the default branch. Investigate via `git -C <local_path> log <default>..<branch>` — usually means the operator pushed follow-up commits that weren't merged. Resolve manually then run `git branch -D <branch>` (capital D forces delete) if appropriate.

## See also

- [[archetype-change]] § Lifecycle — the data contract for `status: merged` + `merged_at`
- [[dev-mark-pr-ready]] — the prior-step skill (signals OS-side sign-off before human merge)
- [[dev-open-pr]] — created the PR this skill closes
- [[runbook-pr-ci-monitor]] — the polling counterpart that auto-detects merges every ~15 min
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 8
