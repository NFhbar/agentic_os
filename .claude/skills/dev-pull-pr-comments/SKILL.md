---
name: dev-pull-pr-comments
description: 'Ingest external reviewers'' comments, author replies, and thread replies from a GitHub PR into the linked pr-review entry as a new pass. Closes the loop on the external-review flow — the OS can then treat external comments with the same accept/dismiss/re-implement flow as its own model-generated ones, and can answer the ones that asked a question.'
user-invocable: true
recommended_effort: medium
version: 2
domain: development
tags: [pr-review, github, ingest, external]
inputs:
  review:
    type: string
    required: true
    description: 'pr-review entry id (e.g. `pr-review-acme-backend-1284`). The skill resolves the file via the vault manifest and reads its `pr_url` for the GitHub call.'
  since:
    type: string
    required: false
    description: 'ISO 8601 timestamp — only fetch comments created at or after this time. Defaults to the linked entry''s most-recent `completed` timestamp (so re-runs catch only new comments). Pass an older timestamp to backfill, or `1970-01-01T00:00:00Z` to pull everything.'
  category:
    type: string
    required: false
    default: external
    description: 'Comment category to apply to all ingested comments. Defaults to `external` (a non-standard but semantically clear marker that the comment came from a human reviewer, not the OS''s model).'
  severity:
    type: string
    required: false
    enum: [nit, suggestion, bug, blocker]
    default: suggestion
    description: 'Default severity for ingested comments. External reviewers don''t express severity in a structured way, so the skill applies a uniform default rather than trying to parse intent. The user can edit the header field after ingestion if needed.'
outputs:
  - kind: file
    path: vault/wiki/development/pr-review/{{input.review}}.md
spawns: []
---

# dev-pull-pr-comments

## Purpose

Pull external reviewers' comments — including author replies and replies inside threads the OS itself started — from a GitHub PR into the linked `pr-review` entry as a new pass. This is the **mirror** of `dev-pr-review-publish`:

- `dev-pr-review-publish` ships the OS-side review **outward** to GitHub
- `dev-pull-pr-comments` pulls external feedback **inward** from GitHub

After ingest, the new pass lands in the pr-review entry with each external comment carrying `github_comment_id` + `github_review_id` upfront (so they're never re-pulled on idempotent re-runs) and `status: new` (so the human triages each one via the existing dashboard Accept/Dismiss flow — same UX as model-generated comments).

Replies carry an `in_reply_to` header naming the comment they answer, so a thread reads as a thread on the OS side too: an OS comment, the author's push-back on it, and the OS's answer all link up. That linkage is what lets [[dev-pr-review]] run in response mode against the questions nobody has answered yet, and what lets [[dev-pr-review-publish]] send an answer back into the right GitHub thread instead of opening a new one.

The result: external comments flow through the **same** triage → accept → re-implement loop as the OS's own, with the extra affordance that a comment which asked a question can be answered rather than only accepted or dismissed.

## Pre-conditions

- github MCP configured and authenticated. Pre-flight via:

  ```bash
  node scripts/check-mcp.mjs github
  ```

- The pr-review entry exists at `vault/wiki/development/pr-review/<review>.md`. If not, run `dev-pr-review` first to create it.
- The entry's frontmatter carries `pr_url`. Otherwise nothing to fetch against.

## Procedure

1. **Pre-flight: verify the github MCP.** Run `node scripts/check-mcp.mjs github --json`. Non-zero exit → surface hint and stop.

2. **Resolve the entry path.** Read `vault/.index/manifest.json`. Find the entry whose `id === inputs.review` AND `type === 'pr-review'`. If none, reject:

   ```
   pr-review `<review>` not found in the vault manifest.
   ```

3. **Parse the entry.** Load the file; split frontmatter from body. Capture:
   - `pr_url` (required; reject if missing)
   - `pass_count` (defaults to 1 if absent)
   - `completed` (used as `since` default in step 4)

   Parse the body's `## Pass N` sections per [[archetype-pr-review]]. For each comment in any pass, collect `github_comment_id` into a `<seen_github_ids>` Set so the ingest can skip already-pulled comments idempotently.

   While walking those comments, also build `<id_to_ref>`: a map from `github_comment_id` → `pass-<N>-comment-<M>` (the comment's position in the entry). Every comment that ever reached GitHub carries that id — comments the OS published, replies the OS sent, and comments a previous ingest pulled in — so this map is what step 7 uses to recognize "this new reply is answering something the entry already knows about".

4. **Compute the `since` window.**
   - If `inputs.since` is set → use it verbatim.
   - Else → use the entry's `completed` timestamp (the moment the prior pass finished). External comments newer than that are the candidates.
   - If neither is available, pass `null` and let the MCP return everything.

5. **Parse the PR url.** Extract `owner`, `repo`, `n` (integer) from `pr_url`. Reject malformed URLs with `pr_url has unexpected shape: <pr_url>.`

6. **Fetch external reviews + inline comments via the github MCP.** Two calls in parallel (or serial; both are cheap):
   - `mcp__github__list_pull_request_reviews` with `{ owner, repo, pull_number: n }` → returns top-level review events with `state` / `body` / `author` / `submitted_at`. Used for the verdict/summary line in the new pass body.
   - `mcp__github__list_pull_request_review_comments` with `{ owner, repo, pull_number: n, since: <window> }` → returns inline comments with `path` / `line` / `body` / `author` / `created_at` / `id` / `review_id` / `in_reply_to_id`.

   Also fetch `mcp__github__get_pull_request` to capture the current `head_sha` (used as the pass's commit anchor — matches what `dev-pr-review` writes).

   **Error handling:**
   - Auth failure → surface `mcps/github/.env not configured` and stop.
   - Empty result → idempotent stop (see step 7).

7. **Build the ingest set.** From the inline comments, filter out those whose `id` is already in `<seen_github_ids>` — they're already in the entry from a prior run. Everything else is ingested: top-level comments AND replies (`in_reply_to_id` set). A reply is where an author pushes back, asks a question, or says "done" — dropping it loses exactly the half of the conversation the OS needs to answer.

   For each surviving comment, resolve its `<parent_ref>`:
   - `in_reply_to_id` unset → no parent; the comment is a thread root. Emit no `in_reply_to` header.
   - `in_reply_to_id` present AND found in `<id_to_ref>` (step 3) → `pass-<N>-comment-<M>`. The parent is a comment the entry already holds, so the reply links to it inside the entry and the UI can render the thread.
   - `in_reply_to_id` present but NOT in `<id_to_ref>` → `github:<in_reply_to_id>`. The parent lives only on GitHub (a thread between two external reviewers, or a comment from before this entry existed). The raw id keeps the link honest instead of guessing at a local parent.

   Process the set in `created_at` order and add each comment's own `id` to `<id_to_ref>` as you go, mapped to its position in the pass being written (`pass-<pass_count + 1>-comment-<M>`, the number step 8 confirms). A thread pulled in one run often contains a reply to another comment from the same run; walking in time order means the later one resolves to a real position instead of falling through to the raw-id form.

   If the filtered set is empty:
   - AND `seen_github_ids.size === 0` (nothing has ever been pulled): surface `↻ No external comments to pull — PR has no review comments yet.` and stop without an event (or record `noop: true`).
   - AND `seen_github_ids.size > 0`: surface `↻ Already up to date — <n> previously-pulled comment(s); no new external comments since.` and stop.

8. **Compute the new pass number.** `pass_n = pass_count + 1`.

9. **Compose the new pass body.** Mirror the `## Pass N` shape from [[archetype-pr-review]] § Body sections, with these adjustments for the external-source case:

   ```markdown
   ## Pass <pass_n> — <now ISO>

   ### Pass config
   - agent: external            ← marks this pass as ingest rather than model-generated
   - reviewers: <comma-separated list of unique authors from step 6>
   - github_reviews: <comma-separated list of review ids from step 6's first call>
   - commit_id: <head_sha from step 6>

   ### Comments

   #### Comment 1: <inputs.category> · <inputs.severity>
   - file: `<comment.path>`
   - line: <comment.line>
   - status: new
   - github_review_id: <comment.review_id>
   - github_comment_id: <comment.id>
   - author: <comment.author>
   - in_reply_to: <parent_ref>  ← emit ONLY for a reply (step 7); omit entirely on a thread root

   <comment.body verbatim>

   #### Comment 2: ...
   ```

   Notes:
   - Comment numbering restarts at 1 within this pass (matches the existing pass-N-comment-M id scheme).
   - `- agent: external` on the pass is the single marker that says "a person wrote these, the model didn't". Every consumer keys off it: the dashboard renders the pass and its comments as external, and [[dev-pr-review]]'s response mode reads it to find what still needs answering.
   - `- author:` carries the GitHub login. It is a header, not prose — attribution belongs in the comment's metadata, so the body stays the reviewer's own words with nothing wrapped around them.
   - `- in_reply_to:` carries the `<parent_ref>` from step 7 in one of exactly two forms: `pass-<N>-comment-<M>` (parent is a comment this entry holds) or `github:<id>` (parent lives only on GitHub). Never invent a third form.
   - The body is the GitHub comment verbatim — no blockquote, no `@author wrote` preamble, no framing. Leave one blank line between the last header and the body so a body that happens to start with a `- key: value` line is not mistaken for another header.
   - `line` may be `null` on a reply whose thread has gone outdated (the anchor moved out of the diff). Write `null` and keep the comment — the conversation still matters even when the anchor is gone.

10. **Append the new pass to the entry body.** Surgical Edit (NOT a full rewrite): locate the last `## Pass N` section's end (next `## ` header or EOF), insert the new pass section there.

11. **Update frontmatter:**
    - `pass_count: <pass_n>`
    - `updated: <now>`
    - Leave `result` alone — external pulls don't override the OS-side verdict. The user can choose to update the entry's `result` manually if external reviewers reached a different conclusion.

12. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action pr-pull-comments \
      --skill dev-pull-pr-comments \
      --args '{"review":"<review>","pr":"<canonical_url>","pass":<pass_n>,"ingested_count":<n>,"reply_count":<r>,"skipped_count":<m>,"reviewers":["<authors>"],"since":"<since>"}' \
      --files-touched '["vault/wiki/development/pr-review/<review>.md"]' \
      --exit-status 0
    ```

    `ingested_count` is the number of new comments written; `reply_count` is how many of those carried an `in_reply_to` header. `skipped_count` is the number filtered out by idempotency (already-pulled). All three are useful for the activity timeline — a pull that is all replies means a conversation is waiting on an answer, not that new findings landed.

    The shared event-attribution helper picks up `change_id` via the review-id lookup we added in scripts/extract-event-attribution.mjs — so this event attributes to the owning change for OS-authored PRs automatically (no extra args needed).

13. **Confirm to the user** with a tight report:

    ```
    ✓ Pulled external comments — <review> · pass <pass_n>
      pr:         <canonical_url>
      reviewers:  <comma-separated unique authors>
      ingested:   <n> new comment(s) (<r> reply/replies)
      skipped:    <m> already-pulled
      entry:      vault/wiki/development/pr-review/<review>.md
      next:       triage in the dashboard — Accept / Dismiss / Re-analyze per comment.
                  Accepted comments become eligible for Re-implement via dev-write-change.
                  <when r > 0:> <r> reply/replies are waiting on an answer — Draft response
                  runs dev-pr-review in response mode against them.
    ```

    Idempotent variants per step 7.

## Inputs schema notes

- `review`: required. Use the id, not a path.
- `since`: optional. Defaults to the entry's `completed` timestamp so re-runs are incremental. Override to backfill historical comments or to re-pull after editing the entry.
- `category` / `severity`: defaults to `external` / `suggestion` respectively. Apply uniformly to every ingested comment; the user can adjust per-comment after the fact via direct edit (no skill needed for that).

## Outputs

- A new `## Pass N` section appended to the pr-review entry's body, marked `- agent: external` in its pass config and populated with the external comments (each carrying its `github_comment_id` + `github_review_id` + `author` upfront, plus `in_reply_to` on replies).
- The entry's frontmatter `pass_count` bumped + `updated` refreshed.
- An `events.db` row tagged with `pr-pull-comments` action + the review id + (when linked) the change id.

## What this skill must NOT do

- **Mutate the PR on GitHub.** Read-only — only `list_pull_request_reviews`, `list_pull_request_review_comments`, and `get_pull_request` are called. Answering a thread is [[dev-pr-review-publish]]'s job, not this skill's; ingest never posts.
- **Override existing OS-side verdict.** The entry's `result` field stays as whatever `dev-pr-review` set. If external reviewers approved/blocked, the user updates `result` manually.
- **Auto-triage.** Every ingested comment lands as `status: new` — the human decides what to accept/dismiss. Auto-classification would bias the workflow.
- **Mix with model-generated comments in a single pass.** A pass is one source. If a re-review by the model is also needed, run `dev-pr-review` separately (it'll get its own pass).
- **Rewrite what a reviewer wrote.** Bodies land verbatim. Summarizing, trimming, or reformatting someone else's comment changes what the entry says they said.
- **Answer anything.** Ingest records the question; [[dev-pr-review]]'s response mode drafts the answer and [[dev-pr-review-publish]] sends it. Keeping those separate means a human sees the question before an answer goes out.

## Errors

- `pr-review \`<review>\` not found in the vault manifest.` — verify the id.
- `Entry has no pr_url field — nothing to fetch against.` — fix the entry's frontmatter.
- `pr_url has unexpected shape: <url>.` — malformed; canonicalize to `https://github.com/<owner>/<repo>/pull/<N>`.
- `MCP github not configured` → run `/os add-mcp` and add the github MCP.
- `GitHub MCP auth failed` → configure `mcps/github/.env`.
- `No external comments to pull — PR has no review comments yet.` — not an error; idempotent stop.

## See also

- [[archetype-pr-review]] — the entry archetype this skill appends to (data contract for the `## Pass N` shape, comment header fields)
- [[dev-pr-review]] — the model-side counterpart; produces the entry this skill consumes
- [[dev-pr-review-publish]] — the outbound symmetric skill (OS → GitHub); this skill is the inbound (GitHub → OS)
- [[dev-write-change]] § Step 4b ADDRESS-COMMENTS — consumes accepted external comments alongside model-generated ones
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 12
