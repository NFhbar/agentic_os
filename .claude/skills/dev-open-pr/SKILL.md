---
name: dev-open-pr
description: 'Push a change''s branch to its remote and open a GitHub pull request via the github MCP. Captures the PR URL onto the change entry and transitions status: in-progress → in-review. Pre-flight checks MCP availability and authentication.'
user-invocable: true
version: 1
domain: development
tags: [change, pr, github, mcp, lifecycle]
inputs:
  change:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Change id (slug). Must match an existing entry of type=change.'
  draft:
    type: boolean
    required: false
    default: false
    description: 'Open the PR in draft state. Use for early visibility / CI without requesting review.'
  base:
    type: string
    required: false
    description: 'Branch to merge into. Defaults to the repo entity''s default_branch (typically main).'
outputs:
  - kind: field
    path: 'vault/wiki/<domain>/change/<change>.md (frontmatter: pr_url, status, updated)'
  - kind: event
    path: '.claude/state/events.db (kind: dashboard, action: open-pr, change_id: <id>)'
spawns: []
---

# dev-open-pr

## Purpose

Take a change whose code work is **locally committed** (status: in-progress, branch made by `dev-write-change` EXECUTE phase, optional `review_status: approved`) and **publish it** as a GitHub pull request:

1. Push the branch to its remote
2. Open the PR via the `github` MCP's `create_pull_request` tool
3. Write `pr_url` back to the change entry's frontmatter
4. Transition `status: in-progress → in-review`

This is the lifecycle bridge between local work (status: in-progress) and external review (status: in-review → merged). The next step after `dev-open-pr` is either `dev-pr-review` (the OS reviews its own PR) or manual GitHub review followed by `dev-close-change` (planned).

## When to use

- After `dev-write-change` EXECUTE has finished committing changes locally
- When `review_status` ∈ {approved, overridden, not-required} — the plan-review gate has been satisfied
- When `pr_url` is null (no PR open yet for this change)

## When NOT to use

- Before EXECUTE has run (no commits to push). Run `/os write-change <id>` first.
- When `pr_url` is already set on the change entry. The skill detects this and reports the existing URL — re-running won't open a duplicate PR.
- When `review_status` is `request-changes` / `rejected` / `pending` — fix the gate first via `/os review-change`.

## Prerequisites

- `github` MCP configured in `.mcp.json`. Verify via:

  ```bash
  node scripts/check-mcp.mjs github
  ```

  If missing: the OS ships a custom PAT-based server at `mcps/github/` (see [[decision-github-mcp-custom-not-hosted]]) — restore `.mcp.json`'s github entry, or scaffold via `/os add-mcp`.

- `github` MCP authenticated. The deployed server is the custom stdio server (`mcps/github/server.mjs`) authenticated via `GITHUB_TOKEN` in `mcps/github/.env` — check-mcp catches a MISSING token pre-flight, but an expired/invalid PAT only surfaces as a 401 at call time (refresh the PAT; `/mcp` OAuth does not apply to it). Only a hosted-mode install (check-mcp reports `kind: hosted`) uses the `/mcp` OAuth flow.

- The repo entity for the change's `repo:` field exists at `vault/wiki/<domain>/entity/<repo>.md` with at least: `local_path`, `remote_url` (or fields parseable to owner/name), `default_branch`.

## Procedure

1. **Pre-flight: verify the github MCP is wired up.** Run:

   ```bash
   node scripts/check-mcp.mjs github --json
   ```

   - If exit code is non-zero: stop. Surface the script's `hint` field verbatim to the user and exit.
   - If the helper returns `kind: hosted`: print the auth_hint as a heads-up but proceed (we'll catch real auth errors at the MCP call below).

2. **Load the change entry.** Read `vault/wiki/<domain>/change/<change>.md` (find by `id == <change>` across all `vault/wiki/*/change/`). If missing → reject with: `change "<change>" not found`. Parse frontmatter.

3. **Idempotency check.** If `pr_url` is already set on the frontmatter, stop politely:

   ```
   PR already open for <change>: <pr_url>
   No action taken. Use `/os pr-review <change>` to invoke a review of the existing PR.
   ```

   Do **not** open a duplicate.

4. **Validate workflow state**:
   - `status` must be `in-progress` (typically — `in-review` is also accepted if re-running after a hiccup).
     - Reject if `planning`, `merged`, or `abandoned`.
   - `review_status` must be one of: `approved`, `overridden`, `not-required`.
     - Reject otherwise with a hint: `Plan review must complete before opening a PR — run /os review-change <change>`.
   - `branch` must be set and non-empty.

5. **Load the repo entity.** Read `vault/wiki/<domain>/entity/<repo>.md` where `<repo>` is the change entry's `repo:` field. Extract:
   - `local_path` (absolute filesystem path to the working tree)
   - `remote_url` (SSH or HTTPS URL — parse `owner/name` from this)
   - `default_branch` (used as the PR base unless `inputs.base` is provided)

   Parse `owner/name` from `remote_url`. Examples:
   - `git@github.com:foo/bar.git` → owner=`foo`, name=`bar`
   - `git@github.com-personal:acme/api.git` → owner=`acme`, name=`api` (SSH-config alias form)
   - `https://github.com/foo/bar.git` → owner=`foo`, name=`bar`

   If parsing fails → reject with: `Cannot extract owner/name from remote_url: <url>`.

6. **Verify git identity before pushing.** Per [[standard-git-hygiene]] § 4a, the commit author and the push credentials must be the same person. Run:

   ```bash
   git -C <local_path> config --get user.name
   git -C <local_path> config --get user.email
   git -C <local_path> log -1 --pretty='%an|%ae' <branch>
   ```

   Apply the following rules:
   - If `user.name` or `user.email` is empty/missing → **reject** with:

     ```
     Git identity not configured for <local_path>.
     Pushing without an identity would attribute commits to a default — set per-repo:
       git -C <local_path> config user.name "<your name>"
       git -C <local_path> config user.email "<your-email>"
     Re-run after configuring.
     ```

     Do NOT proceed.

   - Compare the HEAD commit's author email to the configured `user.email`. If they differ → **warn** (don't fail):

     ```
     ⚠ Commit author email (<head-email>) doesn't match configured user.email (<configured-email>).
       The commits were authored by a different identity than git config currently advertises.
       Proceeding with push — verify this is intentional (e.g. rebased from another machine).
     ```

   - Capture both identities into the report (step 13) so any mismatch with the eventual PR opener is visible.

   Cannot directly verify the SSH key / token resolves to the same GitHub user — that surfaces at push time (permission denied → wrong key) or at PR open time (PR.user.login mismatches commit author).

7. **Push the branch.** `cd <local_path>` and run:

   ```bash
   git push -u origin <branch>
   ```

   Idempotent: if the branch is already on origin and there are no new commits, `git push` is a no-op and exits 0. If it fails:
   - Auth error (`Permission denied`, `403`) → reject with: `Push failed — verify SSH key / token has push access to <owner>/<name>. The remote URL is <remote_url> — check ~/.ssh/config maps its host to the right key. Underlying error: <stderr>`
   - Non-fast-forward (`! [rejected]`) → reject with: `Push rejected as non-fast-forward — pull/rebase from origin/<branch> first, then re-run`
   - Other failures → surface stderr verbatim and stop

8. **Compose the PR title.** Follow [[standard-pr-description]] § 1 precedence (first wins):
   1. `pr_title:` frontmatter field on the change entry → use as-is.
   2. `change.title` matches conventional-commit pattern `^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?:\s+.+$` (case-insensitive) → use as-is.
   3. Otherwise infer:
      - `<type>` from the branch prefix (`docs/` → `docs`, `feat/` → `feat`, etc.). If the prefix is not in the allowlist → `chore`.
      - `<scope>` from `change.scope` if set, else omit.
      - `<description>` from `change.title`, lowercased, trailing period stripped.
      - Compose as `<type>(<scope>): <description>` or `<type>: <description>` when scope is empty.

9. **Compose the PR body.** Follow [[standard-pr-description]] § 2–3 precedence:
   1. **Repo template detection.** Look in `<local_path>` for the first of these (case-insensitive filename match):
      - `.github/pull_request_template.md`
      - `.github/PULL_REQUEST_TEMPLATE.md`
      - `.github/PULL_REQUEST_TEMPLATE/default.md`
      - `docs/pull_request_template.md`
      - `pull_request_template.md` (repo root)

      If found, read its content as the body skeleton. Preserve HTML comments verbatim — they're reviewer hints.

   2. **OS default** (when no repo template found): use this exact structure:

      ```markdown
      # what

      <one-paragraph summary derived from the change's `## Why` — what this PR changes>

      # why

      <full `## Why` from the change body — 2-4 sentences on motivation>

      # tests

      <bulleted list — tests added/updated from the plan's tests section, OR `## Done when` checklist if no plan file>
      ```

   Fill recognizable section headers from the change's data per [[standard-pr-description]] § 3:
   - `# what` / `## What` / `## Summary` / `## Description` → one-paragraph summary from `## Why`
   - `# why` / `## Why` / `## Motivation` → full `## Why` from change body
   - `## Approach` / `## Changes` → `## Approach` from change body
   - `# tests` / `## Test plan` / `## Testing` → from plan's tests or `## Done when`
   - Leave unchecked checklist items (`- [ ]`) alone — the author decides
   - Leave free-form sections (Screenshots, Notes) blank for human edit post-open

   **Always append** the OS provenance footer:

   ```markdown
   ---

   ### Generated by the Agentic OS
   - Change record: `vault/wiki/<domain>/change/<change>.md`
   - Plan: `<plan_path or "(none)">`
   - Review verdict: `<review_status>` (`<review_path or "(no review file)">`)
   - Branch: `<branch>` → `<base>`
   ```

10. **Call the `github` MCP's `create_pull_request` tool.** Pass:

    ```json
    {
      "owner": "<owner>",
      "repo": "<name>",
      "title": "<composed title from step 7>",
      "body": "<composed body from step 8>",
      "head": "<branch>",
      "base": "<inputs.base or repo.default_branch>",
      "draft": <inputs.draft>
    }
    ```

    The tool returns the GitHub PR object — capture: `number`, `url` (a.k.a. `html_url`), `state`, `draft`, and **`user.login`** (the authenticated GitHub user who opened the PR). The `user.login` is the third identity from [[standard-git-hygiene]] § 4a — surfacing it here lets the report flag mismatches with the commit author.

    **On error:**
    - If the response indicates auth (`401`, `unauthorized`, `token`) → branch on the check-mcp `kind` captured in step 1: `custom` → reject with `GitHub MCP auth failed — GITHUB_TOKEN in mcps/github/.env is missing, expired, or lacks pull-requests:write scope; refresh the PAT and re-run.`; `hosted` → reject with `GitHub MCP auth failed. Run \`/mcp\` in Claude Code to complete OAuth, then re-run.`
    - If `A pull request already exists for <branch>` → query the MCP for the existing PR via `mcp__github__list_pull_requests` (or equivalent) filtered to the head branch, capture its URL **and `user.login`**, treat as success. Don't fail.
    - Other errors → surface the tool's error message and stop.

11. **CI snapshot (single read, no polling).** Per [[standard-pr-description]] § 4, take ONE snapshot of the PR's checks via the `github` MCP — typically `mcp__github__list_pull_request_checks` or the equivalent the configured server exposes. Categorize:
    - All checks have `conclusion: success` → `ci_state: pass`
    - Any check has `conclusion: failure` / `cancelled` / `timed_out` → `ci_state: fail`
    - Any check has `status: in_progress` / `queued` → `ci_state: running (<N> checks)`
    - No checks reported (repo has no CI configured) → `ci_state: none`

    **Do not poll.** If checks are still running after the first read, the report tells the user to re-query later (a `/os pr-status <change>` skill is planned for this). Blocking the headless skill on CI completion would defeat the purpose of running it from the dashboard.

    Capture `ci_state` for the next steps; don't fail the skill on `fail` (the PR is opened; CI failure is for the human to triage).

12. **Update the change entry's frontmatter** via Edit tool:
    - `pr_url`: the returned URL
    - `status`: `in-review`
    - `pr_title`: the title used (so re-runs can be idempotent and audit-trail-clear)
    - `updated`: now (ISO 8601 UTC)

13. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action open-pr \
      --skill dev-open-pr \
      --args '{"change":"<change>","pr_number":<number>,"draft":<draft>,"ci_state":"<ci_state>","commit_author":"<configured-email>","pr_opener":"<user.login>"}' \
      --files-touched '["vault/wiki/<domain>/change/<change>.md"]' \
      --exit-status 0
    ```

    The shared event-attribution helper picks up `change_id` from `args.change`, so the row lands tagged in `.claude/state/events.db`. `ci_state`, `commit_author`, and `pr_opener` are included so a future audit / analytics layer can correlate PR opens with CI outcomes and surface identity drift over time.

14. **Confirm to user** with a tight report:

    ```
    ✓ PR opened for <change>
      pr:        <pr_url>
      title:     <composed title>
      branch:    <branch> → <base>
      status:    in-progress → in-review
      commit:    <configured-name> <<configured-email>>     # git config user.* on the repo
      opened by: <user.login>     # GitHub user the MCP authenticated as
      ci:        <ci_state>     # pass | fail | running (N) | none
      template:  <repo-template-path or "OS default (# what / # why / # tests)">
      next:      <next-hint>
    ```

    **Identity check at report time**: if the local part of `<configured-email>` clearly doesn't relate to `<user.login>` (e.g. configured-email is `alice@work.com` but the PR was opened by `bob-personal`), prepend a one-line warning to the report:

    ```
    ⚠ Commit author (<configured-email>) and PR opener (<user.login>) look like different identities.
       Verify this is intentional — see standard-git-hygiene § 4a for the multi-account setup.
    ```

    This is a heuristic warning, not a block — the user may have legitimately different email + GitHub login (e.g. noreply addresses, or work email mapped to a personal GitHub via SSO). The skill flags the divergence; the human decides.

    The `<next-hint>` depends on `ci_state`:
    - `pass` → `/os pr-review <change>` (run dev-pr-review on the open PR) or wait for human review + merge
    - `fail` → CI failed — inspect <pr_url> and address before requesting review
    - `running (N)` → CI in progress — re-check via /os pr-status <change> (planned) or open <pr_url> in browser
    - `none` → no CI configured for this repo; proceed to review or merge

## Inputs schema notes

- `change`: kebab-case id. The skill resolves the file path itself — don't pass a path.
- `draft`: boolean. Default false. Set true when the change is mid-flight and you want CI to start without requesting review.
- `base`: optional override for the PR base branch. Almost always you want the repo's `default_branch` (the default).

## Outputs

- Updated frontmatter on the change entry: `pr_url`, `status: in-review`, `updated`.
- An events.db row with `kind: dashboard`, `action: open-pr`, `skill: dev-open-pr`, `change_id: <change>`.
- The PR itself, on GitHub, viewable at `pr_url`.

## Errors

- `change "<id>" not found` → verify the slug matches an existing wiki entry of type=change
- `MCP github not configured` → run `/os add-mcp` to register the github MCP
- `GitHub MCP auth failed` → custom server (the default): refresh `GITHUB_TOKEN` in `mcps/github/.env`; hosted mode only: run `/mcp` to complete OAuth
- `Plan review must complete before opening a PR` → review_status is not approved/overridden/not-required; run `/os review-change <id>` first
- `Push failed — verify SSH key / token` → fix local git auth, then re-run
- `Non-fast-forward push` → pull/rebase the branch and re-run
- `PR already open for <change>: <url>` → not an error; idempotent stop

## What this skill must NOT do

- **Edit code.** All code changes belong to `dev-write-change` EXECUTE. This skill only pushes what's already committed and opens the PR.
- **Override the review gate.** If `review_status` isn't satisfied, the skill stops — it does NOT bypass.
- **Open a PR when one already exists.** Idempotency prevents duplicates.
- **Delete or rewrite branch history.** Only `git push -u origin <branch>` — no force-push, no rebase, no branch creation.

## See also

- [[archetype-change]] — the change archetype
- [[standard-change-workflow]] — full lifecycle + skill chain
- [[standard-pr-description]] — PR title precedence + body templating rules (the contract this skill implements)
- [[standard-git-hygiene]] — branch + commit conventions; § 5 (Pushing + PR opening) defers to standard-pr-description for the PR artifact
- [[standard-mcp-usage]] — calling MCP tools from a skill (pre-flight + naming + auth + errors)
- [[concept-mcp]] — what MCPs are
- [[dev-write-change]] — what produced the local commits
- [[dev-review-change]] — what gated the plan
- `mcps/github/` (when scaffolded) or `.mcp.json` row for the hosted github MCP
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
