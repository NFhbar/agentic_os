---
name: dev-pull-pr-comments
description: 'Ingest external reviewers'' comments from a GitHub PR into the linked pr-review entry as a new pass. Closes the loop on the external-review flow — the OS can then treat external comments with the same accept/dismiss/re-implement flow as its own model-generated ones.'
user-invocable: true
version: 1
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

Pull external reviewers' comments from a GitHub PR into the linked `pr-review` entry as a new pass. This is the **mirror** of `dev-pr-review-publish`:

- `dev-pr-review-publish` ships the OS-side review **outward** to GitHub
- `dev-pull-pr-comments` pulls external feedback **inward** from GitHub

After ingest, the new pass lands in the pr-review entry with each external comment carrying `github_comment_id` + `github_review_id` upfront (so they're never re-pulled on idempotent re-runs) and `status: new` (so the human triages each one via the existing dashboard Accept/Dismiss flow — same UX as model-generated comments).

The result: external comments flow through the **same** triage → accept → re-implement loop as the OS's own. The dashboard doesn't need to distinguish "model-generated" from "human-generated" — both are equally addressable.

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

7. **Build the ingest set.** From the inline comments, filter out those whose `id` is already in `<seen_github_ids>` — they're already in the entry from a prior run. Also filter out replies (`in_reply_to_id` set) for the MVP scope: only top-level comments anchor cleanly to file/line; replies get folded into the body of the comment they reply to via a `> @author wrote:` block as future work.

   If the filtered set is empty:
   - AND `seen_github_ids.size === 0` (nothing has ever been pulled): surface `↻ No external comments to pull — PR has no review comments yet.` and stop without an event (or record `noop: true`).
   - AND `seen_github_ids.size > 0`: surface `↻ Already up to date — <n> previously-pulled comment(s); no new external comments since.` and stop.

8. **Compute the new pass number.** `pass_n = pass_count + 1`.

9. **Compose the new pass body.** Mirror the `## Pass N` shape from [[archetype-pr-review]] § Body sections, with these adjustments for the external-source case:

   ```markdown
   ## Pass <pass_n> — <now ISO>

   ### Pass config
   - source: external           ← new field marking this pass as ingest rather than model-generated
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

   > @<author> wrote at <created_at>:
   >
   > <comment.body verbatim, indented with `> `>

   #### Comment 2: ...
   ```

   Notes:
   - Comment numbering restarts at 1 within this pass (matches the existing pass-N-comment-M id scheme).
   - The `author:` header field is non-standard but useful for external comments — surface in the UI's per-comment card; safe to read by ignorers.
   - The body wraps the verbatim GitHub comment in a markdown blockquote with author attribution. Preserves the original wording while distinguishing it from model-generated prose.

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
      --args '{"review":"<review>","pr":"<canonical_url>","pass":<pass_n>,"ingested_count":<n>,"skipped_count":<m>,"reviewers":["<authors>"],"since":"<since>"}' \
      --files-touched '["vault/wiki/development/pr-review/<review>.md"]' \
      --exit-status 0
    ```

    `ingested_count` is the number of new comments written. `skipped_count` is the number filtered out by idempotency (already-pulled). Both are useful for the activity timeline.

    The shared event-attribution helper picks up `change_id` via the review-id lookup we added in scripts/extract-event-attribution.mjs — so this event attributes to the owning change for OS-authored PRs automatically (no extra args needed).

13. **Confirm to the user** with a tight report:

    ```
    ✓ Pulled external comments — <review> · pass <pass_n>
      pr:         <canonical_url>
      reviewers:  <comma-separated unique authors>
      ingested:   <n> new comment(s)
      skipped:    <m> already-pulled
      entry:      vault/wiki/development/pr-review/<review>.md
      next:       triage in the dashboard — Accept / Dismiss / Re-analyze per comment.
                  Accepted comments become eligible for Re-implement via dev-write-change.
    ```

    Idempotent variants per step 7.

## Inputs schema notes

- `review`: required. Use the id, not a path.
- `since`: optional. Defaults to the entry's `completed` timestamp so re-runs are incremental. Override to backfill historical comments or to re-pull after editing the entry.
- `category` / `severity`: defaults to `external` / `suggestion` respectively. Apply uniformly to every ingested comment; the user can adjust per-comment after the fact via direct edit (no skill needed for that).

## Outputs

- A new `## Pass N` section appended to the pr-review entry's body, populated with the external comments (each carrying its `github_comment_id` + `github_review_id` upfront).
- The entry's frontmatter `pass_count` bumped + `updated` refreshed.
- An `events.db` row tagged with `pr-pull-comments` action + the review id + (when linked) the change id.

## What this skill must NOT do

- **Mutate the PR on GitHub.** Read-only — only `list_pull_request_reviews`, `list_pull_request_review_comments`, and `get_pull_request` are called. No replies, reactions, or comment edits.
- **Override existing OS-side verdict.** The entry's `result` field stays as whatever `dev-pr-review` set. If external reviewers approved/blocked, the user updates `result` manually.
- **Auto-triage.** Every ingested comment lands as `status: new` — the human decides what to accept/dismiss. Auto-classification would bias the workflow.
- **Mix with model-generated comments in a single pass.** A pass is one source. If a re-review by the model is also needed, run `dev-pr-review` separately (it'll get its own pass).
- **Handle reply threads.** Top-level comments only for v1. Replies surface as future work — they need a different rendering model (anchored to a parent comment, not a file/line).

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
