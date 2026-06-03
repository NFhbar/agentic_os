---
id: walkthrough-write-change
type: reference
domain: meta
created: 2026-06-01T20:30:00Z
updated: 2026-06-01T20:30:00Z
tags: [walkthrough, tutorial, change, lifecycle, pr]
source: vault/wiki/development/change/guide-walkthroughs-section.md
private: false
title: "Walkthrough — write a change end-to-end"
url: internal://walkthrough/write-change
kind: walkthrough
last_verified: 2026-06-01
---

# Walkthrough — write a change end-to-end

A **change** is the atomic unit of code work: single repo, single branch, single PR. This walkthrough covers the full lifecycle from scaffolding a change to merging the PR.

## Goal

After this walkthrough you have:

- A `change` wiki entry capturing the intent, plan, and audit trail
- A working branch with the code change committed
- A GitHub PR with a local pr-review pass recorded
- The change merged back to main with the wiki entry's `status: merged`

## Prerequisites

- A target repo, ingested ([[walkthrough-ingest-repo]])
- Optionally: a parent project ([[walkthrough-add-project]]) the change rolls up to
- The intent is concrete — "fix X" or "add Y" — not exploratory (use a research report for exploratory work)

## The lifecycle (mental model)

```
add → write/PLAN → review-plan → approve → write/EXECUTE → open-pr → pr-review → merge
       │                          │                                    │
       └─ optional gate ──────────┘                                    └─ merge watcher
                                                                          auto-detects
```

Three review gates exist by default; trivial changes (typo fixes, dep bumps) can mark `review_required: false` at scaffold time to skip the plan-review gate.

## Steps (UI)

### 1. Scaffold the change

- **Overview Quick Actions** → **`+ Change`**, or
- **Project page → Changes tab** → **`+ Add change`** (auto-fills `project:`)

Fill in:

- **`title`** _(required)_ — Short conventional-commit-shaped title
- **`description`** _(required)_ — A paragraph: what changes, why, where. The body's "Why" / "Approach" / "Risk" sections scaffold from this.
- **`repo`** _(required)_ — The ingested repo entity slug
- **`size`** _(optional)_ — `xs | small | medium | large`. Influences review depth + automation pacing.
- **`review_required`** _(optional, default true)_ — Set `false` for trivial changes that skip plan-review.

The new change entry lands with `status: planning`, `review_status: pending`. Auto-drafted body sections carry **DRAFT** markers — accept them before plan runs.

### 2. Accept the auto-drafted body

The audit's `change-body-template-placeholder` finding flags unreviewed DRAFT markers in scaffolded changes. Two paths:

- **Recommended** — edit the body in the dashboard's vault view or your editor. Replace placeholders, fill the Why/Approach/Risk sections with real content, save.
- **Quick path** — Overview's action-items panel → finding row → **`Accept`** button. Strips DRAFT lines without editing the content. Use when the auto-draft is already good enough.

### 3. PLAN — generate the structured plan

- **Change page → Plan tab** → **`Run plan`**, or
- `/os write change <id>` (the PLAN phase runs when `review_status: pending`)

`dev-write-change` reads the body + repo + universal standards (code quality, git hygiene), then writes a plan to `vault/output/<domain>/changes/<slug>-plan.md`. The plan structures the work: files modified/created/NOT-touched, tests, risks, dependencies. Cost ≈ $1–3.

### 4. Review the plan

- **Change page → Plan tab** → **`Review`**, or
- `/os review change <id>`

`dev-review-change` is **read-only**: walks the plan + repo + conventions, runs a 6-category checklist (scope discipline / convention alignment / risk / test coverage / existing code respect / git hygiene), writes a verdict to `vault/output/<domain>/changes/<slug>-review.md`, and flips `review_status`.

Verdicts:

- `approved` → unlocks EXECUTE
- `request-changes` → surface concerns; user picks re-plan / override (`review_status: overridden`) / abandon
- `rejected` → suggests `status: abandoned`

### 5. EXECUTE — write the code

Once `review_status` is `approved` or `not-required`:

- **Change page → Plan tab** → **`Execute`** (button activates), or
- `/os write change <id>` (the EXECUTE phase runs because the plan exists + review passed)

The writer:

- Pre-flight verifies repo is on `main` + clean tree + ff-only pull (per [[standard-git-hygiene]])
- Creates branch `<type>/<slug>` (semantic-release types)
- Follows the plan exactly, edits files, runs tests
- Commits with conventional-commit format
- Sets `status: in-progress`

### 6. Open the PR

- **Change page → PR tab** → **`Open PR`**, or
- `/os open-pr <id>`

`dev-open-pr` pushes the branch, opens the GitHub PR via the github MCP, writes `pr_url` + `pr_number` to the change frontmatter, fires the `dashboard.open-pr` event (which can trigger a Slack notification — see the notification template).

### 7. PR review

The PR-review flow has its own page (PR Review app) and supports multi-pass review. Each pass writes a `pr-review` wiki entry tied to the change.

- **PR Review app** → click the change row → **`Re-review`** (or first review)
- `dev-pr-review` walks the diff + repo-knowledge + conventions, writes a structured verdict, surfaces inline comments. `pr_review_status` flips to `approved` | `request-changes` | `comments`.

If `request-changes` with inline comments to address:

- **Change page → PR Review tab** → click comments → **`Accept all`** (or per-comment)
- Then dispatch `dev-write-change` in **address-comments** mode (or click the page's affordance) — folds the accepted comments into the code, commits, pushes.

Repeat review passes as needed. Multi-pass is normal.

### 8. Merge

- **GitHub UI** (squash, rebase, or merge per the repo's policy), or
- `/os close change <id>` after merging remotely

The merge watcher polls open PRs every 60s; once GitHub reports merged, it flips the change's `status: merged` + `merged_at: <ts>` automatically. No manual sync needed.

## Steps (CLI summary)

```bash
/os add change "Fix Y in module X"           # 1. scaffold
# 2. Accept drafts via Overview action items or hand-edit
/os write change fix-y-in-module-x            # 3. PLAN (review_status=pending)
/os review change fix-y-in-module-x           # 4. plan review
/os write change fix-y-in-module-x            # 5. EXECUTE (review_status=approved)
/os open-pr fix-y-in-module-x                 # 6. open PR
/os pr-review fix-y-in-module-x               # 7. local PR review
# 8. Merge remotely; watcher detects + closes
```

## What gets created

```
vault/wiki/<domain>/change/<slug>.md           ← change entry
vault/output/<domain>/changes/<slug>-plan.md   ← structured plan
vault/output/<domain>/changes/<slug>-review.md ← plan-review verdict
vault/wiki/development/pr-review/<id>.md       ← one per PR review pass
.claude/state/events.db                        ← rows per lifecycle step
```

The change entry's frontmatter accumulates audit fields across the lifecycle: `branch`, `commits`, `pr_url`, `pr_number`, `ci_state`, `pr_review_status`, `merged_at`, etc.

## Automation: hands-off lifecycle

Once you trust a project's process, opt into automation:

- **Project page → Automation tab** → enable + pick `mode: sequential-changes`
- The orchestrator picks the oldest `status: planning` change, runs write → open-pr → review through to MERGE, parks until merge watcher closes it, then advances to the next change
- Pause gates: `skill-failure` (any step exits non-zero) + `review-not-approved` (pr-review writes `request-changes`)

See the README's `## Process automation` section for the full state machine.

## Gotchas

- **Body must be accepted before PLAN runs.** The dev-write-change skill refuses on unreviewed DRAFT markers. The audit + the action-items panel surface this clearly; ignore at your own peril.
- **`/os write change` is overloaded.** Same skill, different phase based on `review_status`. PLAN when pending, EXECUTE when approved/not-required. The skill detects the phase from the entry's current state.
- **Address-comments is a third phase.** Not `write change` again — it's `dev-write-change` in address-comments mode (different dispatch). The PR Review tab's affordance routes to the right call.
- **`status: planning` vs `status: in-progress` vs `status: merged`** — the chain advances automatically as each lifecycle step lands. Don't edit these by hand unless you're recovering from a broken state.
- **Local repo on wrong branch after merge.** If the previous change's branch is still checked out, the next EXECUTE's pre-flight will refuse. Currently a manual `git checkout main && git pull --ff-only` is needed — tracked as a deferred finding.

## See also

- [[archetype-change]] — full change archetype reference
- [[standard-change-workflow]] — the canonical lifecycle standard
- [[standard-git-hygiene]] — branch naming + commit format
- [[walkthrough-add-research-report]] — generate changes from a research report instead of writing them by hand
- [[walkthrough-pr-review-vs-ingestion]] — when reviewing PRs against external repos (not your changes)
