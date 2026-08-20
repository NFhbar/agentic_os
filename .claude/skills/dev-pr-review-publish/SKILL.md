---
name: dev-pr-review-publish
description: 'Publish a pr-review entry pass back to GitHub. Sends comments that answer an existing thread as threaded replies and fresh findings as a single GitHub review with verdict derived from the entry, then writes the resulting GitHub ids back to the pr-review entry. A replies-only publish posts no verdict.'
user-invocable: true
version: 3
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
- **Two outbound paths, one publish.** Comments that answer an existing GitHub thread go out as threaded replies, one call each, landing where the conversation already is. Fresh findings go out together as a single `create_pull_request_review` call, producing one review event on the PR. Never the reverse: an answer posted as a new top-level comment loses the thread, and N fresh findings posted one-by-one pollute the PR with N review entries.
- **A replies-only publish posts no verdict.** When every comment being published is a reply, no review event is created at all. Answering the author's question must never re-request changes on their PR — the OS's verdict was already stated when the findings went out, and answering a follow-up is not a new judgment.
- **Verdict comes from the entry, not the user.** For the review path, the pr-review's `result` field (set by `dev-pr-review`) maps deterministically to GitHub's review event (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`). The user already made the call when accepting comments; no second decision point at publish time.
- **Operator text is published byte-for-byte.** When a person wrote the body, it goes out exactly as they wrote it — no markers, footers, counts, or framing wrapped around it. Model-generated bodies keep the marker treatment described in step 10.
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
   - `result` — required for the review path; reject with a hint to run `dev-pr-review` first if missing. Defer the rejection until after step 6b: a replies-only publish maps no verdict and needs no `result`, so failing on it before the partition would block an answer on a field the answer never reads.
   - `pass_count`
   - `status` — must be `completed`; reject otherwise (`Entry status is <status> — wait for the pass to finish.`)

   Parse the body's `## Pass <N>` sections per [[archetype-pr-review]] § Body sections. Capture for each pass: the pass-header timestamp (local-TZ readable form, not ISO) and the comment list with header fields (`file`, `line`, `start_line`, `side`, `start_side`, `status`, `accept_note`, `github_comment_id`, `github_review_id`, `severity`, `category`, `in_reply_to`, `body_source`). The `start_line` / `side` / `start_side` fields are optional (present only on multi-line or old-side comments) — absent means a single-line RIGHT anchor. `in_reply_to` is present only on a comment that answers another comment; `body_source: operator` marks a body a person wrote. Parse **every** pass, not just the target one: step 6b resolves `pass-<N>-comment-<M>` parent refs against comments anywhere in the entry. Note: passes carry NO per-pass summary paragraph — the entry-level `## Summary` (rewritten each pass) is the only summary; step 9 sources from there.

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

6b. **Partition the publish set — replies vs fresh findings.** Every eligible comment lands in exactly one of two sets, decided by its `- in_reply_to:` header:

    - **`reply_set`** — the comment carries `in_reply_to`. Resolve the parent ref to a GitHub comment id, which takes exactly two forms:
      - `github:<id>` → `<id>`, used verbatim. The parent lives only on GitHub.
      - `pass-<N>-comment-<M>` → read that comment's `github_comment_id` from the entry (step 3 parsed every pass). That id is what the parent was published or ingested as, and it is the thread to answer into.
      - A `pass-<N>-comment-<M>` ref whose target carries **no** `github_comment_id` has no thread on GitHub to reply into — the parent never reached it. Move that comment to `review_set` so the text still ships, and name it in the report: `comment <n>: parent has no GitHub thread — published as a fresh comment`.
    - **`review_set`** — everything else. A finding with no parent goes out through the review-creation path.

    Capture `<replies_only> = reply_set is non-empty AND review_set is empty`. When it holds, this publish posts **no review event and no verdict**: skip steps 7b, 8, 9, 10, and 11 entirely, and record `event: null` in step 13. Answering an author is not a judgment on their PR — re-submitting `REQUEST_CHANGES` alongside an answer would re-block a PR the author may have already fixed.

7. **Get PR head SHA.** Inline review comments must anchor to a specific commit. Fetch via the github MCP's `get_pull_request` tool:

   ```json
   { "owner": "<owner>", "repo": "<repo>", "pull_number": <n> }
   ```

   Capture the flat `head_sha` field as `<commit_id>` (the custom github MCP returns a flat shape — there is no nested `head.sha`). Reject if PR is `closed` or `merged` with a clear message — can't review a closed PR. `<commit_id>` is consumed only by the review path; a reply inherits its parent thread's anchor and needs no commit. Keep the call even when `<replies_only>` — it is also the open-PR gate.

7b. **Re-validate anchors against the LIVE diff (layer 2 — publish time).** Runs over the **`review_set` only** — a reply has no anchor of its own to validate; skip this step entirely when `<replies_only>`. The pass's stored anchors were validated at write time against the diff as it was THEN; the head may have moved since (new commits, a rebase). GitHub only accepts an inline comment on a line present in the diff of `<commit_id>` — so re-validate against the **current** diff, not the pass's stored annotation. `<commit_id>` from step 7 is BOTH the review anchor and the diff basis, so anchors and commit agree by construction.

    ```bash
    TMPDIFF=$(mktemp)
    gh pr diff <canonical_pr_url> > "$TMPDIFF"
    node scripts/annotate-diff-lines.mjs --validate --anchors '<review-set anchors as JSON>' < "$TMPDIFF"
    ```

    Build the anchors array from the `review_set` (step 6b): one object per comment `{id: "<target_pass>-<n>", file, line, start_line?, side?, start_side?}`. **Parse legacy range strings first** — a `line: "42-58"` header becomes `{start_line: 42, line: 58}` before validation, so legacy multi-line comments publish as real ranges when the range still validates (this supersedes the old collapse-to-end-line rule). Capture the returned verdict per comment (`valid` / `snapped` / `degraded-to-endpoint` / `file-level`) for step 10.

    **If the live-diff fetch itself fails** (gh outage, network): warn loudly in the report and fall through to today's unvalidated behavior — step 10 treats every anchor as `valid` as-authored. Publish availability beats validation; do not abort.

8. **Map verdict.** Skip entirely when `<replies_only>` — there is no review event to carry a verdict. Otherwise translate the entry's `result` field to a GitHub review event:

   | `result`          | GitHub `event`    | Notes                                                    |
   | ----------------- | ----------------- | -------------------------------------------------------- |
   | `approved`        | `APPROVE`         | Confirms a clean review; LGTM-equivalent                 |
   | `request-changes` | `REQUEST_CHANGES` | Blocks merge until addressed; mirrors the OS's verdict   |
   | `comment`         | `COMMENT`         | Default for `comment`/`none` — observations, no blocking |
   | `none` or unknown | `COMMENT`         | Safe fallback — never auto-block or auto-approve         |

   Capture `<event>`.

9. **Compose the review body** — the top-level message that introduces the inline comments. Skip entirely when `<replies_only>`. Use this template:

   ```
   🤖 OS review (pass <target_pass>) — <commit_id short>

   <pass_summary line>

   <comment counts: e.g. "Publishing 3 accepted comments (2 logic, 1 docs)">

   _Generated from `vault/wiki/development/pr-review/<review>.md` via dev-pr-review-publish._
   ```

   The summary line comes from the entry-level `## Summary` section (dev-pr-review rewrites it each pass; pass sections themselves open with config bullets, not prose). When publishing an OLDER pass via `inputs.pass` (the entry Summary then describes a later pass), or when `## Summary` is absent, fall back to the neutral line `Publishing <N> accepted comments from pass <n>.` The OS attribution line keeps the audit trail intact on the GitHub side.

10. **Compose inline comments — verdict-driven.** Skip entirely when `<replies_only>`. For each comment in the `review_set`, its step-7b verdict decides placement. (When step 7b fell through on a gh outage, treat every anchor as `valid` as-authored.) `side` defaults to `RIGHT`.
    - **`valid` / `snapped` single-line** → inline comment at the (possibly snapped) `line`:

      ```json
      { "path": "<file>", "line": <resolved_line>, "side": "<side>", "body": "<body>" }
      ```

    - **`valid` range** → inline **multi-line** comment; pass `start_line` (+ `start_side` only when it differs from `side`) so GitHub anchors the whole span as one comment:

      ```json
      { "path": "<file>", "line": <end>, "side": "<side>", "start_line": <start>, "start_side": "<start_side>", "body": "<body>" }
      ```

    - **`degraded-to-endpoint`** → inline single-line at the returned valid endpoint (`line`); do **not** send `start_line`. Prepend the intended range to the body so the author sees the full span (`_(re: lines <N>–<M>)_`, en-dash `–` U+2013).

    - **`file-level`** (file absent from the live diff, or the line is beyond the snap window) → do **not** inline. Append the comment as a quoted block to the review body from step 9 — the `<body_surfaced_set>`, parallel to the inlined part of the `review_set` — naming the intended anchor so nothing is lost:

      ```
      > **<file>:<line-or-range> — <category> · <severity>** (accepted; note: _"<accept_note>"_)
      >
      > <comment body verbatim, indented with `> ` per markdown blockquote>
      ```

      These write back `status: published-as-body` (not `published`) in step 12 — terminal for publish, no inline anchor to link.

      **Exception — operator-supplied bodies are never body-surfaced.** Quoting a comment into the review body wraps it in an anchor label and blockquote markers, which is exactly what the verbatim rule forbids for text a person wrote. So when a `- body_source: operator` comment lands on this branch, publish nothing for it: leave its `status: accepted` untouched and report it (`comment <n>: no inline anchor — left unpublished; re-anchor it or send it as a reply`). The operator decides what happens to their own words; re-running publish after a fix picks it up unchanged.

    **Body convention (inline comments) — model-generated bodies:**
    - When the anchor was **snapped** or **degraded**, prepend the one-line drift marker so it's visible on GitHub — `_(snapped from line <N> — the diff moved since review)_` for a snap, or the `_(re: lines <N>–<M>)_` range note for a degrade.
    - Then the comment's markdown body (everything after the header lines), verbatim.
    - If `accept_note` is set, append a horizontal rule + footer:

      ```
      ---
      🤖 **OS reviewer note:** <accept_note>
      ```

      The note signals to the PR author that a human curated this comment before publishing, with their rationale.

    **Body convention — operator-supplied bodies (`- body_source: operator`):** the body is text a person wrote, and it ships **byte-for-byte**. No drift marker, no accept-note footer, no attribution line, no counts, no framing of any kind — not one character the operator didn't type. This holds everywhere a body is published, inline comments and replies alike. The rule exists because operator text is already the message: anything the OS wraps around it changes what the PR author reads as the human's words. When an anchor snapped or degraded on an operator-supplied comment, report the drift in step 14's anchor list instead of writing it into the body. A comment with no `body_source` header (or any value other than `operator`) is model-generated and keeps the marker treatment above.

    Track each comment's **final published anchor** (`<file>:<line>` / `<file>:<start>–<end>`, plus any snap/degrade applied) — step 14 reports the full list so the operator can verify placement on GitHub at a glance.

10b. **Send the replies (`reply_set`).** Skip when `reply_set` is empty. One call per reply — threads have no batch endpoint, and each reply names its own parent:

     ```json
     {
       "owner": "<owner>",
       "repo": "<repo>",
       "pull_number": <n>,
       "comment_id": <parent GitHub comment id resolved in step 6b>,
       "body": "<reply body>"
     }
     ```

     Tool name: `mcp__github__reply_to_pull_request_comment`.

     **Reply body:** the comment's markdown body (everything after the header lines). Operator-supplied bodies (`- body_source: operator`) go byte-for-byte per step 10's verbatim rule — nothing prepended, nothing appended. Model-drafted replies may carry the `accept_note` footer, and nothing else: a reply has no review body to introduce it, so there is no `🤖 OS review (pass N)` header, no counts line, and no attribution footer on a reply. Send them in entry order so a thread the OS answers twice reads in the order it was written.

     Capture per reply: the returned `id` as `<reply_comment_id>` and `html_url` for the report.

     **Error handling — per-reply, not per-batch.** A reply that fails does not abort the others; collect the failures and report them at the end.
     - `404` on `comment_id` → the parent comment no longer exists on GitHub (deleted, or the thread was resolved away). Leave the comment `accepted` (no writeback) and report `comment <n>: parent thread <id> is gone on GitHub`. Re-running is safe.
     - `422` → GitHub rejected the reply body or the thread state. Report verbatim; leave the comment `accepted`.
     - Auth failure → stop the whole publish (the review path can't succeed either) with the same message as step 11.

     Comments whose reply succeeded are the `replied_set` for step 12's writeback; the rest stay `accepted` and are picked up by the next run.

11. **Submit the review via the github MCP.** Skip entirely when `<replies_only>` — no review event, no verdict, nothing posted beyond the replies of step 10b. Otherwise a single call:

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
    - `comments` array (in submission order) → each carries a numeric `id` → `<github_comment_ids>` (parallel to the `review_set`)
    - `range_fallback` → when `true`, GitHub refused the multi-line ranges and the MCP re-submitted the review once with every range collapsed to its end line. The review landed; the spans did not. Note it in step 14's anchor list (`(range dropped — GitHub refused the span)`) so the operator can see the comment sits on one line rather than the range they authored.

    Error handling:
    - Auth failure → surface `mcps/github/.env not configured — see decision-github-mcp-custom-not-hosted.md` and stop. No writeback.
    - 422 (per-comment validation; usually bad anchor) → log which comment failed; if any succeeded, proceed with the writeback for the successful ones. Report partial publish at the end.
    - **422 "Can not approve your own pull request"** (whole-review rejection — fires when `event: APPROVE` and the PAT identity matches the PR author) → automatically downgrade `event: APPROVE` → `event: COMMENT` and re-submit the same payload once. This is NOT a verdict change — the entry's `result: approved` stays as-is; the audit trail records the intended verdict via a banner at the TOP of the review body:

      ```
      Verdict: **approved** (submitted as COMMENT because GitHub blocks self-approval via API; the OS-side entry records `result: approved`).
      ```

      The banner is prepended to the existing body composed in step 9. Continue with normal writeback on success. This branch keeps publish deterministic in the single-identity dogfood setup; the long-term fix is bot-account separation (Task #430). Other 422 verdict-related errors (e.g. `event: REQUEST_CHANGES` on closed PRs) do NOT auto-downgrade — surface them and stop.

    - Network/timeout → surface error, no writeback. Re-running the skill is safe (the publish set is the same; idempotency check at step 6 won't double-post since nothing was written).

12. **Write back to the entry (skip when `dry_run`).** Three cases per comment, depending on how it reached GitHub:

    **Case A — inlined (the `review_set` comments on step 10's main path):** surgically update the comment's header block via the Edit tool:
    - Replace `- status: accepted` → `- status: published`
    - **Insert** (after the `status` line) `- github_review_id: <github_review_id>`
    - **Insert** (after `github_review_id`) `- github_comment_id: <github_comment_id>`

    **Case B — surfaced in body (the `body_surfaced_set` from step 10's `line: null`/out-of-diff branch):** surgically update the comment's header block via the Edit tool:
    - Replace `- status: accepted` → `- status: published-as-body`
    - **Insert** (after the `status` line) `- github_review_id: <github_review_id>`
    - Do **not** insert `github_comment_id` — there is no inline comment to link to. The user can deep-link to the parent review via `<pr_url>#pullrequestreview-<github_review_id>`.

    **Case C — replied (the `replied_set` from step 10b):** surgically update the comment's header block via the Edit tool:
    - Replace `- status: accepted` → `- status: published`
    - **Insert** (after the `status` line) `- github_comment_id: <reply_comment_id>` — the id GitHub assigned to the REPLY itself, recorded exactly like any other published comment id. This is what closes the loop: when the author answers the reply, the next [[dev-pull-pr-comments]] run finds that id and threads their answer to this comment as `pass-<N>-comment-<M>` instead of a bare GitHub id.
    - Do **not** insert `github_review_id` — a reply is not part of a review event, and inventing one would deep-link to a review that doesn't exist.

    In all three cases, preserve all other header lines (`file`, `line`, `start_line`, `side`, `start_side`, `prior`, `accept_note`, `in_reply_to`, `body_source`) and the comment body verbatim.

    Then update frontmatter:
    - `published: true` (set whenever ANY of the three cases fired — the entry has at least one comment that reached GitHub in some form)
    - `updated: <now>` (ISO 8601 UTC)

    Do NOT rewrite the whole file — surgical Edit per comment + per frontmatter field. Preserve YAML comments, field order, and unrelated fields.

13. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action pr-review-publish \
      --skill dev-pr-review-publish \
      --args '{"review":"<review>","pr":"<canonical_url>","pass":<target_pass>,"event":<"<event>" or null when replies-only>,"published_count":<n>,"replied_count":<r>,"skipped_count":<m>,"github_review_id":<id or null when replies-only>,"dry_run":<bool>}' \
      --files-touched '<["vault/wiki/development/pr-review/<review>.md"] when step 12 wrote, else []>' \
      --exit-status 0
    ```

    `published_count` is the number of comments that landed through the review path; `replied_count` is the number that landed as threaded replies. `event` and `github_review_id` are `null` on a replies-only publish — the timeline should show that this publish answered questions without re-stating a verdict. `skipped_count` is the number filtered out by step 6 (already published, dismissed, new). The shared event-attribution helper picks up `change_id` from the entry's frontmatter, so OS-authored PR publishes land on the change's timeline; external publishes land standalone.

14. **Confirm to the user** with a tight report:

    ```
    ✓ Published to GitHub — <review> · pass <target_pass>
      pr:        <canonical_url>
      event:     <event>            (mapped from result: <result>)
      published: <n> comment(s)
      replied:   <r> threaded reply/replies
      skipped:   <m> already-published + <k> not accepted
      anchors:   <one line per published comment — "<file>:<line>" or "<file>:<start>–<end>";
                 append " (snapped: was N → M, d=<distance>)", " (range degraded to line M)",
                 " (range dropped — GitHub refused the span)",
                 or " (body-surfaced — file not in live diff)" where applicable>
      replies:   <one line per reply — "<file>:<line> → <html_url>"; omit the block when r = 0>
      review:    https://github.com/<owner>/<repo>/pull/<n>#pullrequestreview-<github_review_id>
      entry:     vault/wiki/development/pr-review/<review>.md
    ```

    Replies-only variant — no review event was posted, so no verdict line and no review link:

    ```
    ✓ Answered on GitHub — <review> · pass <target_pass>
      pr:       <canonical_url>
      replied:  <r> threaded reply/replies (no review event — a reply is not a verdict)
      replies:  <one line per reply — "<file>:<line> → <html_url>">
      failed:   <one line per reply that didn't land, with the reason; omit when none>
      entry:    vault/wiki/development/pr-review/<review>.md
    ```

    Dry-run variant (no GitHub call, no writeback):

    ```
    ⚙ Dry run — would publish to <canonical_url>
      event:     <event, or "(none — replies-only publish posts no review event)">
      comments:  <n> would be published, <r> would be sent as threaded replies, <m> would be skipped
      no changes made; re-run without dry_run to submit.
    ```

## Inputs schema notes

- `review`: required. Use the id, not a path.
- `pass`: optional. Defaults to the latest pass in the entry. Useful when you re-reviewed but want to ship the older verdict.
- `dry_run`: optional. Defaults to false. When true, exercises steps 1–11 (minus the actual MCP submits) and step 14, but skips steps 10b + 11 (calls) + 12 (writeback) + 13 (event with `dry_run: true`). The intent is to verify the partition, the verdict mapping, and the publish set before committing.

## Outputs

- Zero or one GitHub PR review event posted to the target PR (one per call) with inline comments attached — zero when the publish was replies-only.
- Zero or more threaded replies posted into existing comment threads, one per `reply_set` comment.
- The pr-review entry's body mutated in-place: each published comment's header gains `status: published` plus `github_comment_id` (and `github_review_id` for comments that went out through the review path).
- The entry's frontmatter `published: true` flipped on first successful publish; `updated:` bumped.
- An `events.db` row tagged with the PR url + pass number, carrying `published_count` / `replied_count` and a null `event` on a replies-only publish.

## What this skill must NOT do

- **Mutate the PR code.** Read-only with respect to the source tree. Only the GitHub review timeline is written.
- **Publish dismissed comments.** Dismiss is the user's "no, this isn't worth the PR author's time" signal; never override it.
- **Mark un-accepted comments published.** If the user wants `new` comments shipped, they accept them first in the dashboard. The skill enforces this gate.
- **Submit verdicts the user didn't choose.** Verdict is read from the entry; this skill never asks the user to pick at publish time. If the user wants a different verdict, they edit `result` on the entry (or re-run `dev-pr-review`).
- **Submit twice.** Already-published comments are skipped by header inspection; the skill can be re-run safely after partial failures or after new accepts land.
- **Post a verdict alongside an answer.** A publish carrying only replies creates no review event. Re-requesting changes because the OS answered a question would block a PR on the strength of a conversation.
- **Touch operator text.** A body marked `body_source: operator` is published exactly as stored or not at all. No marker, no footer, no summarizing, no reflowing, no "helpful" prefix.
- **Open a new thread when a thread exists.** A comment with a resolvable `in_reply_to` goes out as a reply. Posting it as a fresh top-level comment strands the answer away from the question.

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
- `Comment <n>: parent has no GitHub thread — published as a fresh comment` — the `in_reply_to` ref pointed at a comment that never reached GitHub, so there was nothing to reply into. The text still shipped, through the review path. Not fatal.
- `Comment <n>: parent thread <id> is gone on GitHub` — the parent comment was deleted or the thread disappeared; the reply was not sent and the comment stays `accepted`. Re-run after re-pulling comments to find the current thread.
- `Comment <n>: no inline anchor — left unpublished` — an operator-supplied body whose anchor fell out of the live diff. Not body-surfaced by design (that would wrap a person's words in framing). Re-anchor it or send it as a reply, then re-run.
- `Review landed with ranges dropped` — GitHub refused the multi-line spans and the MCP re-submitted once with single-line anchors (`range_fallback: true`). The review is on the PR; the comments sit on their end lines. Not fatal.
- `Entry has no result field — run dev-pr-review first.` does NOT fire on a replies-only publish — there is no verdict to map.

## See also

- [[archetype-pr-review]] § Comments — the data contract for `status: published`, `github_review_id`, `github_comment_id`, `in_reply_to`, `body_source`, and the optional `start_line` / `side` / `start_side` range fields
- [[dev-pr-review]] — produces the entry this skill consumes; sets the `result` that maps to the GitHub event, validates anchors at write time (layer 1), and drafts replies in response mode
- [[dev-pull-pr-comments]] — ingests the external comments and author replies this skill answers, and threads later answers against the reply ids written back in step 12
- [[decision-github-mcp-custom-not-hosted]] — why the github MCP uses PAT, not OAuth
- [[standard-mcp-usage]] — calling MCP tools from a skill
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
- `scripts/annotate-diff-lines.mjs` — live-diff anchor validate/snap used in step 7b
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 13
