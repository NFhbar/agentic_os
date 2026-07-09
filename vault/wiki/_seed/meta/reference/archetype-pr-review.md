---
id: archetype-pr-review
type: reference
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [archetype, memory, development, review]
source: seed
private: false
title: PR review archetype
url: internal://archetype/pr-review
kind: doc
last_verified: 2026-05-22
---

# PR review archetype

## What it is

A **pr-review** is a single review run against one pull request. One entry captures the full review — metadata about the PR, the config the review ran under, one or more passes (re-runs against newer commits), and the comments produced.

A pr-review is the OS's primitive for **reviewing code**, just as a [[archetype-change]] is the primitive for **writing code**. The two compose: a change has a `pr_url`; a pr-review's `change_id` (optional) points back at the change that opened that PR. Reviews of external PRs (PRs the OS didn't write) simply omit `change_id`.

A review is single-PR by design. Re-reviewing the same PR after new commits creates a **new pass** within the same pr-review entry, not a new entry — passes share history so the UI can show "what's resolved, what's new" diffs across iterations.

## Required frontmatter (in addition to shared)

| field    | type   | notes                                                                      |
| -------- | ------ | -------------------------------------------------------------------------- |
| `title`  | string | Short, scannable (`"PR Review: #42 add search debounce"`)                  |
| `pr_url` | string | GitHub PR URL (canonical form: `https://github.com/<owner>/<repo>/pull/N`) |
| `repo`   | string | Entity id of the repo (`kind: repo`) — the PR's repo                       |
| `status` | enum   | `pending`, `running`, `completed`, `failed`                                |

## Optional frontmatter

| field           | type    | notes                                                                                                                                                                                                                                                                                          |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr_number`     | integer | Convenience — extracted from `pr_url`                                                                                                                                                                                                                                                          |
| `change_id`     | string  | Owning [[archetype-change]] id when the OS authored the PR; omit for external PRs                                                                                                                                                                                                              |
| `pr_author`     | string  | GitHub login of the PR author                                                                                                                                                                                                                                                                  |
| `branch`        | string  | Head branch of the PR                                                                                                                                                                                                                                                                          |
| `base`          | string  | Base branch the PR targets                                                                                                                                                                                                                                                                     |
| `result`        | enum    | `approved`, `request-changes`, `comment`, `none` — set only when `status: completed`                                                                                                                                                                                                           |
| `started`       | string  | ISO timestamp — when the first pass began                                                                                                                                                                                                                                                      |
| `completed`     | string  | ISO timestamp — when the most recent pass finished                                                                                                                                                                                                                                             |
| `pass_count`    | integer | Number of passes in the body. Defaults to 1; increments when re-reviewed                                                                                                                                                                                                                       |
| `last_head_sha` | string  | The PR's `head.sha` at the time of the most recent pass. Used by `dev-pr-review`'s step 8a debounce gate to short-circuit re-reviews against an unchanged commit (the `pr-review-re-runs-against-unchanged-head-sha` waste pattern). Written on every pass; the gate reads it on continuations |
| `published`     | boolean | `true` if any pass has been published to GitHub via `dev-pr-review-publish` (planned)                                                                                                                                                                                                          |

## Stats fields (snapshotted from GitHub)

Captured at review time so the entry is self-contained and renderable without an extra fetch. Refreshed on each new pass.

| field           | type    | notes                                            |
| --------------- | ------- | ------------------------------------------------ |
| `files_changed` | integer | Number of files touched by the PR at review time |
| `additions`     | integer | Lines added (sum across files)                   |
| `deletions`     | integer | Lines deleted (sum across files)                 |
| `commits`       | integer | Number of commits in the PR head at review time  |

## Config snapshot (per-review)

Captured at review time from `[[reference-pr-review-config]]` so historical reviews stay reproducible even when global config changes later. Lives as a nested block in frontmatter.

| field                             | type   | notes                                                                            |
| --------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `config.primary_model`            | string | Model id used for the review pass                                                |
| `config.comment_style`            | enum   | `concise`, `detailed`, `terse`                                                   |
| `config.focus_areas`              | list   | Subset of `logic, security, performance, style, tests, docs` (or custom strings) |
| `config.context_strategy`         | enum   | `full-diff`, `symbol-graph`, `semantic` (v1: `full-diff` only)                   |
| `config.custom_instructions_hash` | string | Hex digest of the custom instructions text; `null` if empty                      |

The hash lets us detect "this review was produced under config v3" without bloating frontmatter with the full prompt text. The text itself lives in `[[reference-pr-review-config]]`.

## Lifecycle

| stage       | what it means                                                                        |
| ----------- | ------------------------------------------------------------------------------------ |
| `pending`   | Entry written by submit handler; pass not yet started                                |
| `running`   | `dev-pr-review` is mid-pass                                                          |
| `completed` | Most recent pass finished. `result` is set. New passes transition back to `running`. |
| `failed`    | The pass errored (network failure, MCP error, model timeout). Body holds the error.  |

Re-reviewing a `completed` pr-review (e.g., after new commits land) transitions it back to `running`, appends a new `## Pass N` body section, then settles back to `completed` with a fresh `result`.

## Comments — embedded in body

Comments live in the body, not in frontmatter. Each comment is a structured markdown section under its owning `## Pass N`. This keeps comments human-readable, diff-friendly, and avoids YAML for multi-line code suggestions.

Each comment carries enough structured metadata in its header that future code can parse + index it without a full markdown AST walk. The header is a small inline block under the section heading; mutations (accept/dismiss/edit) rewrite the section in place.

```markdown
### Comment <n>: <category> · <severity>

- file: `src/auth/login.ts`
- line: 58
- start_line: 42                              ← only on a multi-line range (line = END)
- side: LEFT                                  ← only when anchoring to deleted lines
- status: new
- prior: <comment-id-from-previous-pass>      ← only set on re-reviews

<comment body — free markdown, can include code blocks + suggestions>
```

The optional `start_line` / `side` / `start_side` lines are emitted between `- line:` and `- status:` (single-line RIGHT-side comments omit all three). A parser reading these headers MUST recognize them as header keys so an unrecognized line never leaks `- status:` into the message body.

Field reference:

| header field        | values                                                                                              | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category`          | `logic`, `security`, `performance`, `style`, `tests`, `docs`, or custom                             | The aspect the comment addresses. Set by the model per-comment (single-call review).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `severity`          | `nit`, `suggestion`, `bug`, `blocker`                                                               | Determines whether the comment can block publish (see automation config)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `file`              | string                                                                                              | Relative path within the repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `line`              | integer or `null`                                                                                   | Anchor line in the new file (RIGHT side). When `start_line` is set, `line` is the range END. `null` for file-level / PR-level comments. Legacy entries may carry a range string (`42-58`) — still parsed (first number → start, last → end), but new passes author the structured `start_line` field below instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `start_line`        | integer                                                                                             | Optional. START line of a multi-line range comment — `line` is the END (`start_line < line`, same file, same side, same hunk). GitHub-API naming. Absent → single-line anchor. Written by `dev-pr-review`; forwarded through the github MCP by `dev-pr-review-publish` as a true multi-line GitHub comment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `side`              | `LEFT` or `RIGHT`                                                                                   | Optional. Diff side the anchor is on — absent means `RIGHT` (the post-change view). Set `LEFT` only when the comment is about deleted (old-file) lines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `start_side`        | `LEFT` or `RIGHT`                                                                                   | Optional. Diff side of the range START — defaults to `side`. Only needed on the rare cross-side range.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `status`            | `new`, `accepted`, `dismissed`, `resolved`, `wontfix`, `published`, `published-as-body`, `acted-on` | `new` is the initial state from `dev-pr-review`. `accepted` / `dismissed` are user actions written by `/api/reviews/:id/comments/:passN/:commentN` (Phase 2). `resolved` is auto-set by `dev-pr-review` continuation passes when a prior comment is no longer flagged. `published` is set by `dev-pr-review-publish` (Phase 4) after the comment is posted as an inline GitHub review comment (carries `github_comment_id`). `published-as-body` is set by the same skill when a comment couldn't be inlined (e.g. file-level comment on a file not in the diff, or out-of-diff line) — the comment was instead surfaced as quoted text in the review body. Carries `github_review_id` (the parent review) but not `github_comment_id`. Terminal for publish purposes — won't be re-attempted. `acted-on` is set by `dev-write-change` (Phase 5) once a re-run addressed the comment in code — paired with the `acted_on_at` timestamp. Lifecycle invariant: every comment must leave `new` before merge — typically `new → acted-on` (reimplemented) or `new → dismissed` (+ written rationale), though any non-`new` status satisfies the gate. A comment still `new` at merge time is illegal; `dev-mark-pr-ready` enforces this (override available, recorded). |
| `prior`             | comment id from a previous pass                                                                     | Links a comment across passes when the model re-raises the same issue. Format: `pass-<N>-comment-<n>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `accept_note`       | free-text string                                                                                    | Optional rationale captured when the user accepts the comment. Surfaces in the ReviewDetail UI and (Phase 4) appended to the GitHub-side comment body when published.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `dismiss_reason`    | free-text string                                                                                    | Optional rationale captured when the user dismisses the comment. Documents WHY the comment was rejected — useful for future review passes' re-evaluation and for audit trails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `github_review_id`  | integer                                                                                             | GitHub's numeric id for the parent review this comment was published under. Set by `dev-pr-review-publish` after a successful submit. Shared across all comments in the same batch publish — useful for deep-linking back to the review event on GitHub.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `github_comment_id` | integer                                                                                             | GitHub's numeric id for THIS comment's inline review-comment row. Set by `dev-pr-review-publish`. The canonical comment URL is `<pr_url>#discussion_r<github_comment_id>` — the dashboard turns this into a deep link on the per-comment card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `acted_on_at`       | ISO 8601 timestamp                                                                                  | Set by `dev-write-change` when a re-run addresses this comment in code. Pairs with `status: acted-on`. Provides the audit trail (when was this comment turned into a commit?) and the idempotency anchor (subsequent re-runs skip comments already acted on).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Body sections

```markdown
# <title>

## Summary
<one paragraph: overall assessment + counts by category>

## Pass 1 — <started ISO>

### Pass config
- model: <model-id>
- focus areas: logic, security
- style: concise

### Comments

#### Comment 1: logic · suggestion
- file: `src/auth/login.ts`
- line: 42
- status: new

<comment body>

#### Comment 2: tests · bug
- file: `src/auth/login.test.ts`
- line: null
- status: new

<comment body>

### Stats
- files: 4
- +120 / -18
- commits: 3

## Pass 2 — <started ISO>     ← appended on re-review; structure mirrors Pass 1
```

A single-pass review has just one `## Pass 1` section. Multi-pass reviews accumulate `## Pass 2`, `## Pass 3`, etc. — each pass references prior comments via the `prior:` header field so the UI can render resolved/unresolved/new groupings.

## When to use

- Reviewing a PR opened by the OS via [[dev-open-pr]]
- Reviewing an external PR (paste a URL into the dashboard)
- Re-reviewing a PR after new commits → adds a pass to the existing pr-review entry
- (Planned) Publishing a review to GitHub via `dev-pr-review-publish`

If you want to write a code change, use [[archetype-change]]. If you want to capture a general observation about reviewed code that's worth keeping outside a specific review, use [[archetype-note]] or [[archetype-decision]] as appropriate.

## Composition

```
change                               ← pr_url: https://github.com/.../pull/42
  └─ pr-review (change_id: change-…) ← pr_url: same URL; one or more passes
       ├─ Pass 1 (5 comments)
       └─ Pass 2 (2 new + 1 resolved)
```

For external PRs, the `change` link is absent — the pr-review stands alone.

## Outputs / artifacts produced

| artifact                        | location                                                 | when                                                       |
| ------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| PR review entry                 | `vault/wiki/<domain>/pr-review/<id>.md`                  | Created at submit time (status: pending)                   |
| Pass body section               | Appended to the entry under `## Pass N`                  | Written by `dev-pr-review` as each pass completes          |
| (Future) Diff cache             | `vault/output/<domain>/pr-review/<id>/diff-pass-N.patch` | Optional — only if `context_strategy != full-diff`         |
| (Future) GitHub publish receipt | Recorded on the event row, not as a file                 | When `dev-pr-review-publish` posts comments back to GitHub |

## Example

```markdown
---
id: pr-review-add-license-1
type: pr-review
domain: development
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [review]
source: dev-pr-review
private: false
title: 'PR Review: #1 Add LICENSE'
pr_url: https://github.com/acme/example-repo/pull/1
pr_number: 1
repo: entity-example-repo
change_id: change-add-license
pr_author: octocat
branch: agent/add-license
base: main
status: completed
result: approved
started: 2026-05-22T14:00:00Z
completed: 2026-05-22T14:00:42Z
pass_count: 1
files_changed: 1
additions: 21
deletions: 0
commits: 1
config:
  primary_model: claude-opus-4-7
  comment_style: concise
  focus_areas: [logic, docs]
  context_strategy: full-diff
  custom_instructions_hash: null
---

# PR Review: #1 Add LICENSE

## Summary
A clean MIT LICENSE drop. One nit on the copyright year; otherwise approved.

## Pass 1 — 2026-05-22T14:00:00Z

### Pass config
- model: claude-opus-4-7
- focus areas: logic, docs
- style: concise

### Comments

#### Comment 1: docs · nit
- file: `LICENSE`
- line: 3
- status: new

Copyright year reads `2025` but this is a 2026 drop. Consider `2026` for accuracy.

### Stats
- files: 1
- +21 / -0
- commits: 1
```

## Related

- [[reference-pr-review-config]] — global defaults (model, focus areas, custom instructions) that this archetype snapshots into each entry
- [[archetype-change]] — the OS primitive for writing code; a change's `pr_url` is what a pr-review reviews
- [[archetype-entity]] — repos that PRs belong to (`kind: repo`)
- [[dev-pr-review]] — the skill that creates and appends to pr-review entries
- [[standard-pr-description]] — companion standard for the PR-writing side of the lifecycle
