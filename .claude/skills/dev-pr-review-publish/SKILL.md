---
name: dev-pr-review-publish
description: 'Publish a pr-review entry pass back to GitHub. Posts accepted comments as a single GitHub review with verdict derived from the entry, then writes the resulting GitHub ids back to the pr-review entry.'
user-invocable: true
version: 2
domain: development
tags: [pr-review, publish, github]
inputs:
  review:
    type: string
    required: true
    description: 'pr-review entry id (e.g. `pr-review-acme-backend-1284`). The skill resolves the file via the vault manifest.'
  pass:
    type: integer
    required: false
    description: 'Pass number to publish. Defaults to the latest pass in the entry. Pass an explicit number to publish an older pass (e.g. you re-reviewed but want to ship the verdict from pass 2, not pass 3).'
  dry_run:
    type: boolean
    required: false
    default: false
    description: 'When true, performs all parsing + verdict mapping but skips the GitHub call and the writeback. Reports what WOULD be published. Use to sanity-check before submitting to a real PR.'
outputs:
  - kind: file
    path: vault/wiki/development/pr-review/{{input.review}}.md
spawns: []
---

# dev-pr-review-publish

## Purpose

Submit a pr-review entry's pass back to GitHub as a real PR review. This is the bridge between **OS-internal review** (the vault entry with per-comment accept/dismiss state) and **GitHub-side review** (what the PR author and other reviewers see).

The skill is **scoped narrow**:

- **Only accepted comments are published.** Comments with `status: new` (not actioned) or `status: dismissed` (the user explicitly rejected) are skipped. The user's accept gesture in the dashboard is the publish-gate.
- **One GitHub review per call, batched.** All eligible comments go into a single `create_pull_request_review` call, producing one review event on the PR. No per-comment submission — that pollutes the PR with N review entries instead of one.
- **Verdict comes from the entry, not the user.** The pr-review's `result` field (set by `dev-pr-review`) maps deterministically to GitHub's review event (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`). The user already made the call when accepting comments; no second decision point at publish time.
- **Idempotent.** Comments with `status: published` (or a `github_comment_id`) are skipped on re-runs. Re-publishing a pass after adding more accepts only posts the new ones — never duplicates existing comments.

Used in the **external PR flow**: a human pasted a PR URL into the dashboard, the OS ran `dev-pr-review`, the human triaged accept/dismiss per-comment, and now the human clicks Publish to hand the curated review back to GitHub.

For OS-authored PRs, publish is usually skipped — the human merges based on the dashboard's view directly. But nothing prevents publishing an OS-authored review back to its own PR; the skill doesn't care about `change_id` linkage.

## Pre-conditions

- github MCP configured and authenticated. Pre-flight via:

  ```bash
  node scripts/check-mcp.mjs github
  ```

- `gh` CLI installed and authenticated (`gh auth status`) — used by step 7b to fetch the live diff for publish-time anchor re-validation. Already a prerequisite of [[dev-pr-review]] in the same flow.
- The pr-review entry exists and parses cleanly (its body has at least one `## Pass N` section).
- The target pass has at least one comment with `status: accepted` AND `github_comment_id` unset. If both conditions fail, the skill exits idempotently with a "nothing to publish" message.

## Procedure

1. **Pre-flight: verify the github MCP.** Run `node scripts/check-mcp.mjs github --json`. If exit code is non-zero, surface the script's `hint` field verbatim and stop.

2. **Resolve the entry path.** Read `vault/.index/manifest.json`. Find the entry whose `id === inputs.review` AND `type === 'pr-review'`. If none, reject:

   ```
   pr-review `<review>` not found in the vault manifest.
   ```

3. **Parse the entry.** Load the file; split frontmatter from body. Capture from frontmatter:
   - `pr_url` — required; reject if missing
   - `result` — required; reject with hint to run `dev-pr-review` first if missing
   - `pass_count`
   - `status` — must be `completed`; reject otherwise (`Entry status is <status> — wait for the pass to finish.`)

   Parse the body's `## Pass <N>` sections per [[archetype-pr-review]] § Body sections. Capture for each pass: the pass-header timestamp (local-TZ readable form, not ISO) and the comment list with header fields (`file`, `line`, `start_line`, `side`, `start_side`, `status`, `accept_note`, `github_comment_id`, `github_review_id`, `severity`, `category`). The `start_line` / `side` / `start_side` fields are optional (present only on multi-line or old-side comments) — absent means a single-line RIGHT anchor. Note: passes carry NO per-pass summary paragraph — the entry-level `## Summary` (rewritten each pass) is the only summary; step 9 sources from there.

4. **Pick the target pass.**
   - If `inputs.pass` is set: use that. If no `## Pass <inputs.pass>` section exists, reject with `Pass <n> not found in entry — entry has passes 1..<pass_count>.`
   - Else: use the highest-numbered pass (`pass_count`).

   Capture `<target_pass>` = the chosen pass number.

5. **Parse the PR url.** Extract `owner`, `repo`, `n` (integer) from `pr_url`. Compute the canonical form `https://github.com/<owner>/<repo>/pull/<n>` for the report.

6. **Build the publish set.** From the target pass's comments, select only those where:
   - `status === 'accepted'` AND
   - `github_comment_id` is null/unset AND
   - `status !== 'published-as-body'` (these are terminal — already surfaced in a prior review body; re-publishing would duplicate them)

   Comments already carrying a `github_comment_id` were published as inline GitHub comments in a prior run — skip them (idempotent). Comments with `status: dismissed`, `new`, `resolved`, `wontfix`, `published`, `published-as-body`, or `acted-on` are filtered out by policy or prior-run state.

   If the publish set is empty AND no comments were previously published, surface:

   ```
   ↻ Nothing to publish — pass <n> has no accepted comments (and no prior publish).
     Accept at least one comment in the dashboard first.
   ```

   …and stop without an event (or record `noop: true`).

   If the publish set is empty BUT some comments already carry `github_comment_id` OR `status: published-as-body`, surface:

   ```
   ↻ Already up to date — pass <n> has <m> previously-published comment(s); no new accepts to publish.
   ```

   …and stop.

7. **Get PR head SHA.** Inline review comments must anchor to a specific commit. Fetch via the github MCP's `get_pull_request` tool:

   ```json
   { "owner": "<owner>", "repo": "<repo>", "pull_number": <n> }
   ```

   Capture the flat `head_sha` field as `<commit_id>` (the custom github MCP returns a flat shape — there is no nested `head.sha`). Reject if PR is `closed` or `merged` with a clear message — can't review a closed PR.

7b. **Re-validate anchors against the LIVE diff (layer 2 — publish time).** The pass's stored anchors were validated at write time against the diff as it was THEN; the head may have moved since (new commits, a rebase). GitHub only accepts an inline comment on a line present in the diff of `<commit_id>` — so re-validate against the **current** diff, not the pass's stored annotation. `<commit_id>` from step 7 is BOTH the review anchor and the diff basis, so anchors and commit agree by construction.

    ```bash
    TMPDIFF=$(mktemp)
    gh pr diff <canonical_pr_url> > "$TMPDIFF"
    node scripts/annotate-diff-lines.mjs --validate --anchors '<publish-set anchors as JSON>' < "$TMPDIFF"
    ```

    Build the anchors array from the publish set (step 6): one object per comment `{id: "<target_pass>-<n>", file, line, start_line?, side?, start_side?}`. **Parse legacy range strings first** — a `line: "42-58"` header becomes `{start_line: 42, line: 58}` before validation, so legacy multi-line comments publish as real ranges when the range still validates (this supersedes the old collapse-to-end-line rule). Capture the returned verdict per comment (`valid` / `snapped` / `degraded-to-endpoint` / `file-level`) for step 10.

    **If the live-diff fetch itself fails** (gh outage, network): warn loudly in the report and fall through to today's unvalidated behavior — step 10 treats every anchor as `valid` as-authored. Publish availability beats validation; do not abort.

8. **Map verdict.** Translate the entry's `result` field to a GitHub review event:

   | `result`          | GitHub `event`    | Notes                                                    |
   | ----------------- | ----------------- | -------------------------------------------------------- |
   | `approved`        | `APPROVE`         | Confirms a clean review; LGTM-equivalent                 |
   | `request-changes` | `REQUEST_CHANGES` | Blocks merge until addressed; mirrors the OS's verdict   |
   | `comment`         | `COMMENT`         | Default for `comment`/`none` — observations, no blocking |
   | `none` or unknown | `COMMENT`         | Safe fallback — never auto-block or auto-approve         |

   Capture `<event>`.

9. **Compose the review body** — the top-level message that introduces the inline comments. Use this template:

   ```
   🤖 OS review (pass <target_pass>) — <commit_id short>

   <pass_summary line>

   <comment counts: e.g. "Publishing 3 accepted comments (2 logic, 1 docs)">

   _Generated from `vault/wiki/development/pr-review/<review>.md` via dev-pr-review-publish._
   ```

   The summary line comes from the entry-level `## Summary` section (dev-pr-review rewrites it each pass; pass sections themselves open with config bullets, not prose). When publishing an OLDER pass via `inputs.pass` (the entry Summary then describes a later pass), or when `## Summary` is absent, fall back to the neutral line `Publishing <N> accepted comments from pass <n>.` The OS attribution line keeps the audit trail intact on the GitHub side.

10. **Compose inline comments — verdict-driven.** For each comment in the publish set, its step-7b verdict decides placement. (When step 7b fell through on a gh outage, treat every anchor as `valid` as-authored.) `side` defaults to `RIGHT`.
    - **`valid` / `snapped` single-line** → inline comment at the (possibly snapped) `line`:

      ```json
      { "path": "<file>", "line": <resolved_line>, "side": "<side>", "body": "<body>" }
      ```

    - **`valid` range** → inline **multi-line** comment; pass `start_line` (+ `start_side` only when it differs from `side`) so GitHub anchors the whole span as one comment:

      ```json
      { "path": "<file>", "line": <end>, "side": "<side>", "start_line": <start>, "start_side": "<start_side>", "body": "<body>" }
      ```

    - **`degraded-to-endpoint`** → inline single-line at the returned valid endpoint (`line`); do **not** send `start_line`. Prepend the intended range to the body so the author sees the full span (`_(re: lines <N>–<M>)_`, en-dash `–` U+2013).

    - **`file-level`** (file absent from the live diff, or the line is beyond the snap window) → do **not** inline. Append the comment as a quoted block to the review body from step 9 — the `<body_surfaced_set>`, parallel to the inline `publish_set` — naming the intended anchor so nothing is lost:

      ```
      > **<file>:<line-or-range> — <category> · <severity>** (accepted; note: _"<accept_note>"_)
      >
      > <comment body verbatim, indented with `> ` per markdown blockquote>
      ```

      These write back `status: published-as-body` (not `published`) in step 12 — terminal for publish, no inline anchor to link.

    **Body convention (inline comments):**
    - When the anchor was **snapped** or **degraded**, prepend the one-line drift marker so it's visible on GitHub — `_(snapped from line <N> — the diff moved since review)_` for a snap, or the `_(re: lines <N>–<M>)_` range note for a degrade.
    - Then the comment's markdown body (everything after the header lines), verbatim.
    - If `accept_note` is set, append a horizontal rule + footer:

      ```
      ---
      🤖 **OS reviewer note:** <accept_note>
      ```

      The note signals to the PR author that a human curated this comment before publishing, with their rationale.

    Track each comment's **final published anchor** (`<file>:<line>` / `<file>:<start>–<end>`, plus any snap/degrade applied) — step 14 reports the full list so the operator can verify placement on GitHub at a glance.

11. **Submit the review via the github MCP.** Single call:

    ```json
    {
      "owner": "<owner>",
      "repo": "<repo>",
      "pull_number": <n>,
      "commit_id": "<commit_id>",
      "event": "<event>",
      "body": "<review body from step 9>",
      "comments": [<inline payloads from step 10>]
    }
    ```

    Tool name: `mcp__github__create_pull_request_review`.

    Capture the response. Expect:
    - `id` → `<github_review_id>`
    - `comments` array (in submission order) → each carries a numeric `id` → `<github_comment_ids>` (parallel to the publish set)

    Error handling:
    - Auth failure → surface `mcps/github/.env not configured — see decision-github-mcp-custom-not-hosted.md` and stop. No writeback.
    - 422 (per-comment validation; usually bad anchor) → log which comment failed; if any succeeded, proceed with the writeback for the successful ones. Report partial publish at the end.
    - **422 "Can not approve your own pull request"** (whole-review rejection — fires when `event: APPROVE` and the PAT identity matches the PR author) → automatically downgrade `event: APPROVE` → `event: COMMENT` and re-submit the same payload once. This is NOT a verdict change — the entry's `result: approved` stays as-is; the audit trail records the intended verdict via a banner at the TOP of the review body:

      ```
      Verdict: **approved** (submitted as COMMENT because GitHub blocks self-approval via API; the OS-side entry records `result: approved`).
      ```

      The banner is prepended to the existing body composed in step 9. Continue with normal writeback on success. This branch keeps publish deterministic in the single-identity dogfood setup; the long-term fix is bot-account separation (Task #430). Other 422 verdict-related errors (e.g. `event: REQUEST_CHANGES` on closed PRs) do NOT auto-downgrade — surface them and stop.

    - Network/timeout → surface error, no writeback. Re-running the skill is safe (the publish set is the same; idempotency check at step 6 won't double-post since nothing was written).

12. **Write back to the entry (skip when `dry_run`).** Two cases per comment, depending on whether it was inlined on GitHub or surfaced in the review body:

    **Case A — inlined (the `publish_set` from step 10's main path):** surgically update the comment's header block via the Edit tool:
    - Replace `- status: accepted` → `- status: published`
    - **Insert** (after the `status` line) `- github_review_id: <github_review_id>`
    - **Insert** (after `github_review_id`) `- github_comment_id: <github_comment_id>`

    **Case B — surfaced in body (the `body_surfaced_set` from step 10's `line: null`/out-of-diff branch):** surgically update the comment's header block via the Edit tool:
    - Replace `- status: accepted` → `- status: published-as-body`
    - **Insert** (after the `status` line) `- github_review_id: <github_review_id>`
    - Do **not** insert `github_comment_id` — there is no inline comment to link to. The user can deep-link to the parent review via `<pr_url>#pullrequestreview-<github_review_id>`.

    In both cases, preserve all other header lines (`file`, `line`, `start_line`, `side`, `start_side`, `prior`, `accept_note`) and the comment body verbatim.

    Then update frontmatter:
    - `published: true` (set whenever EITHER case fired — the entry has at least one comment that reached GitHub in some form)
    - `updated: <now>` (ISO 8601 UTC)

    Do NOT rewrite the whole file — surgical Edit per comment + per frontmatter field. Preserve YAML comments, field order, and unrelated fields.

13. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action pr-review-publish \
      --skill dev-pr-review-publish \
      --args '{"review":"<review>","pr":"<canonical_url>","pass":<target_pass>,"event":"<event>","published_count":<n>,"skipped_count":<m>,"github_review_id":<id>,"dry_run":<bool>}' \
      --files-touched '<["vault/wiki/development/pr-review/<review>.md"] when step 12 wrote, else []>' \
      --exit-status 0
    ```

    `published_count` is the number of comments that landed on GitHub. `skipped_count` is the number filtered out by step 6 (already published, dismissed, new). The shared event-attribution helper picks up `change_id` from the entry's frontmatter, so OS-authored PR publishes land on the change's timeline; external publishes land standalone.

14. **Confirm to the user** with a tight report:

    ```
    ✓ Published to GitHub — <review> · pass <target_pass>
      pr:        <canonical_url>
      event:     <event>            (mapped from result: <result>)
      published: <n> comment(s)
      skipped:   <m> already-published + <k> not accepted
      anchors:   <one line per published comment — "<file>:<line>" or "<file>:<start>–<end>";
                 append " (snapped: was N → M, d=<distance>)", " (range degraded to line M)",
                 or " (body-surfaced — file not in live diff)" where applicable>
      review:    https://github.com/<owner>/<repo>/pull/<n>#pullrequestreview-<github_review_id>
      entry:     vault/wiki/development/pr-review/<review>.md
    ```

    Dry-run variant (no GitHub call, no writeback):

    ```
    ⚙ Dry run — would publish to <canonical_url>
      event:     <event>
      comments:  <n> would be published, <m> would be skipped
      no changes made; re-run without dry_run to submit.
    ```

## Inputs schema notes

- `review`: required. Use the id, not a path.
- `pass`: optional. Defaults to the latest pass in the entry. Useful when you re-reviewed but want to ship the older verdict.
- `dry_run`: optional. Defaults to false. When true, exercises steps 1–11 (minus the actual MCP submit) and step 14, but skips steps 11 (call) + 12 (writeback) + 13 (event with `dry_run: true`). The intent is to verify the verdict mapping and the publish set before committing.

## Outputs

- A GitHub PR review event posted to the target PR (one per call), with inline comments attached.
- The pr-review entry's body mutated in-place: each published comment's header gains `status: published`, `github_review_id`, `github_comment_id`.
- The entry's frontmatter `published: true` flipped on first successful publish; `updated:` bumped.
- An `events.db` row tagged with the PR url + pass number.

## What this skill must NOT do

- **Mutate the PR code.** Read-only with respect to the source tree. Only the GitHub review timeline is written.
- **Publish dismissed comments.** Dismiss is the user's "no, this isn't worth the PR author's time" signal; never override it.
- **Mark un-accepted comments published.** If the user wants `new` comments shipped, they accept them first in the dashboard. The skill enforces this gate.
- **Submit verdicts the user didn't choose.** Verdict is read from the entry; this skill never asks the user to pick at publish time. If the user wants a different verdict, they edit `result` on the entry (or re-run `dev-pr-review`).
- **Submit twice.** Already-published comments are skipped by header inspection; the skill can be re-run safely after partial failures or after new accepts land.

## Errors

- `pr-review \`<review>\` not found in the vault manifest.` — verify the id.
- `Entry has no result field — run dev-pr-review first.` — the review hasn't produced a verdict yet.
- `Entry status is <status> — wait for the pass to finish.` — running review can't be published mid-flight.
- `Pass <n> not found in entry — entry has passes 1..<pass_count>.` — pick a valid pass.
- `Nothing to publish — pass <n> has no accepted comments.` — accept some first.
- `MCP github not configured` → run `/os add-mcp` and add the github MCP.
- `GitHub MCP auth failed` → configure `mcps/github/.env`.
- `PR is closed/merged — cannot publish a review.` — chronological gate.
- `Inline anchor failed for comment <n>` — the file/line moved since the review was generated. Re-run `dev-pr-review` (continuation) to refresh anchors against the new HEAD.
- `Range failed to parse for comment <n> (line: '<value>')` — the comment's `line:` header looked like a range but didn't match `<int>-<int>`. Surfaced when step 7b's legacy-range parse falls through. Edit the entry to clean up the `line:` value, or accept the body-surfaced fallback.
- `Live diff fetch failed — publishing with unvalidated anchors` — gh outage at publish time (step 7b); the skill fell through to today's behavior. Re-run once gh is authenticated/reachable to get validated anchors.
- `Comment <n> range degraded to a single line` — the live diff no longer supports the full range (endpoints drifted apart / cross-hunk); published at the valid endpoint with the intended range quoted in the body. Not fatal.
- `Comment <n> surfaced in body — file/line absent from the live diff` — the anchor couldn't be placed inline against `<commit_id>`; surfaced as a quoted block in the review body (`status: published-as-body`). Not fatal.

## See also

- [[archetype-pr-review]] § Comments — the data contract for `status: published`, `github_review_id`, `github_comment_id`, and the optional `start_line` / `side` / `start_side` range fields
- [[dev-pr-review]] — produces the entry this skill consumes; sets the `result` that maps to the GitHub event, validates anchors at write time (layer 1)
- [[decision-github-mcp-custom-not-hosted]] — why the github MCP uses PAT, not OAuth
- [[standard-mcp-usage]] — calling MCP tools from a skill
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
- `scripts/annotate-diff-lines.mjs` — live-diff anchor validate/snap used in step 7b
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 13
