---
id: archetype-change
type: reference
domain: meta
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [archetype, memory, development]
source: seed
private: false
title: Change archetype
url: internal://archetype/change
kind: doc
last_verified: 2026-05-21
---

# Change archetype

## What it is

A **change** is a single unit of code work — one repo, one branch, one PR. Smaller than a project (no milestones, no reporting cadence), larger than an ad-hoc note. The atomic work unit for "I'm going to make a code change."

When work spans multiple repos, the right shape is a **project** owning **multiple changes**, one per repo. A change is single-repo by design — that constraint enables clean composition into cross-repo projects.

## Required frontmatter (in addition to shared)

| field    | type   | notes                                                                 |
| -------- | ------ | --------------------------------------------------------------------- |
| `title`  | string | Short, scannable ("Add search debounce", "Bump biome to v2")          |
| `repo`   | string | Entity id of an ingested repo (`kind: repo`) — the repo this touches  |
| `status` | enum   | `planning`, `in-progress`, `in-review`, `merged`, `abandoned`         |
| `branch` | string | Branch name in the repo this change owns (convention: `agent/<slug>`) |

## Optional frontmatter

| field           | type   | notes                                                                      |
| --------------- | ------ | -------------------------------------------------------------------------- |
| `scope`         | string | Free text — files/dirs the change affects (`src/search/Input.tsx, tests/`) |
| `pr_url`        | string | GitHub PR URL — set when the PR opens                                      |
| `size`          | enum   | `small`, `medium`, `large` — informs downstream skills' depth-of-analysis  |
| `project`       | string | Owning project id — when this change is part of a larger initiative        |
| `parent_change` | string | Previous change id this supersedes/extends (cross-change dependency)       |

## Review-gate fields (managed by dev-write-change / dev-review-change)

A change carries a **review gate** that `dev-write-change` consults as a state machine. The gate fields are written by the writer and reviewer skills — you don't typically hand-edit them, but the audit ensures they stay consistent.

| field                      | type    | notes                                                                                                                                                                                              |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_required`          | boolean | Default `true`. Set `false` at scaffolding time for trivial changes; skips the review gate.                                                                                                        |
| `review_status`            | enum    | `pending` (default), `approved`, `request-changes`, `rejected`, `overridden`, `not-required`                                                                                                       |
| `plan_path`                | string  | Set by `dev-write-change` PLAN phase. Points at `vault/output/<domain>/changes/<slug>-plan.md`.                                                                                                    |
| `review_path`              | string  | Set by `dev-review-change`. Points at `vault/output/<domain>/changes/<slug>-review.md`.                                                                                                            |
| `plan_generated_at`        | string  | ISO timestamp — when the most recent plan was written (PLAN or REVISE phase).                                                                                                                      |
| `reviewed_at`              | string  | ISO timestamp — when the most recent review completed.                                                                                                                                             |
| `plan_revision`            | integer | Optional. Defaults to `1` for the original plan; bumped to `2`, `3`, … by `dev-revise-plan` each time it folds review findings back into the plan. Unset on legacy entries — treat missing as `1`. |
| `plan_revised_at`          | string  | ISO timestamp — when `dev-revise-plan` most recently rewrote the plan. Distinct from `plan_generated_at` (which moves on every write); this only moves on REVISE. Null until first revision.       |
| `plan_revised_from_review` | string  | Path to the review file whose findings drove the most recent revision. Null until first revision. Lets future readers (and the next review pass) see which verdict the revision was responding to. |

See [[standard-change-workflow]] for the full review state machine and the plan/review document templates.

## PR lifecycle fields (managed by dev-open-pr + runbook-pr-ci-monitor)

After `dev-open-pr` runs, the PR-side of the lifecycle is tracked by these fields. The author doesn't hand-edit them — `dev-open-pr` writes the first three on PR creation, then `runbook-pr-ci-monitor` keeps them current by polling GitHub every ~15 minutes.

| field             | type   | notes                                                                                                                                                        |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pr_title`        | string | Final title used on GitHub — explicit `pr_title` input wins; else semantic-release inferred from branch + change.title. Written by `dev-open-pr`.            |
| `ci_state`        | enum   | `pass`, `fail`, `running`, `none`. Snapshot at the most recent poll. Aggregates check_runs + commit_statuses.                                                |
| `ci_completed_at` | string | ISO timestamp — when `ci_state` last became conclusive (pass/fail/none). Null while still running.                                                           |
| `merged_at`       | string | ISO timestamp — when the PR was merged on GitHub. Set by the CI-monitor runbook when it detects merge; triggers the transition `status: in-review → merged`. |

Skill / runbook responsibilities:

- `dev-open-pr` sets `pr_url`, `pr_title`, `status: in-review` on PR creation. Initial `ci_state` snapshot is captured but not persisted (it lives in the event row's args).
- `runbook-pr-ci-monitor` polls every ~15 min for in-review changes with non-conclusive `ci_state`. Updates `ci_state` + `ci_completed_at` on each poll. When it detects `pr.merged === true`, sets `merged_at` + transitions `status: merged`.
- `dev-close-change` (planned) handles the terminal cleanup once `status: merged` (vault sync, summary writing). Until that skill lands, the CI-monitor's merge transition is the de-facto closer.

## PR review fields (managed by dev-pr-review)

When the OS reviews its own PR via [[dev-pr-review]], these fields capture the result on the change entry. The actual review CONTENT (passes, comments) lives in the linked [[archetype-pr-review]] entry — these fields are the roll-up summary so the change's lifecycle stepper and PR tab can render review state without a second fetch.

| field              | type    | notes                                                                                                                                                                                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pr_review_status` | enum    | `pending` (no review yet, OR latest pass produced no blockers — suggestions may exist), `needs-changes` (latest pass's result was `request-changes`), `ready-for-human` (user clicked Mark ready — set by `dev-mark-pr-ready`; vault-only, no GitHub side-effects) |
| `pr_review_path`   | string  | Path to the linked `pr-review` entry — `vault/wiki/<domain>/pr-review/pr-review-<owner>-<repo>-<n>.md`                                                                                                                                                             |
| `pr_review_passes` | integer | Count of review passes the linked entry contains. Bumps on every dev-pr-review run for this change.                                                                                                                                                                |
| `pr_reviewed_at`   | string  | ISO timestamp — when the most recent pass completed. Bumped on every pass.                                                                                                                                                                                         |
| `pr_ready_at`      | string  | ISO timestamp — when the user clicked Mark ready. Set once by `dev-mark-pr-ready`; never overwritten on subsequent review passes.                                                                                                                                  |

Skill responsibilities:

- `dev-pr-review` writes all four fields when invoked with a `change` input (the OS-authored flow). For external PRs (no `change_id` link), these fields don't exist — the pr-review entry stands alone.
- `dev-pr-review-mutate-comment` (planned) doesn't touch these fields — comment accept/dismiss is per-comment state in the pr-review entry's body.
- `dev-mark-pr-ready` flips `pr_review_status: ready-for-human` and sets `pr_ready_at`. Vault-only — no GitHub calls. The user reviews and merges the PR on GitHub themselves.
- `dev-write-change` EXECUTE phase (planned extension) reads accepted-comments from the linked pr-review entry to re-implement; on re-run of `dev-pr-review`, the next pass's resolved/unresolved/new groupings let the stepper signal progress.

These fields are orthogonal to the plan-review fields above (`review_status`, `review_path`, etc.) — those track the LOCAL plan review by `dev-review-change`; these track the EXTERNAL PR review by `dev-pr-review`. A change can have both.

## Automation (optional `automation:` block)

Per-change automation config. **Absent block = automation has never been touched for this change.** Present block = automation may operate on this change (gated by `enabled`). The change entry is the source of truth — both project-owned and orphan (no `project:` field) changes use the same shape.

```yaml
automation:
  enabled: true              # opt-in toggle; orchestrator only runs when true
  iteration_cap: 4           # max EXECUTE → PR-REVIEW loops before park
  state:
    phase: idle              # idle | running | paused | complete
    current_step: null       # free-form string — orchestrator owns vocabulary
    iteration_count: 0       # increments each completed loop pass
    paused_reason: null      # free-form when paused; null otherwise
    paused_at: null          # ISO 8601 UTC
    last_transition: null    # ISO 8601 UTC of last state mutation
    last_run_id: null        # most recent orchestrator-dispatched run id
```

**The v1 loop** (managed by the orchestrator):

```
EXECUTE  ──▶  OPEN-PR  ──▶  PR-REVIEW  ──┬─ no blockers ──▶  complete
                                          │                  (PR open + reviewed clean,
                                          │                   awaiting human merge)
                                          │
                                          └─ needs-changes ──▶  ADDRESS-COMMENTS  ──▶  PR-REVIEW
                                                                (loops; iteration_count++ when
                                                                 entering address-comments;
                                                                 parks on iteration-cap-reached)
```

`dev-pr-review` walks an open PR (not a local branch), so OPEN-PR precedes PR-REVIEW. Boundary: automation stops at `complete` after the first clean review pass. The PR sits on GitHub awaiting the human's review verdict + merge.

**Canonical step vocabulary for v1:** `execute | pr-review | address-comments | open-pr`. The data layer doesn't enforce this set — new step kinds land without a frontmatter migration (orchestrator owns the canonical list per [[standard-automation-loop]]).

**Canonical pause reasons for v1:** `skill-failure | iteration-cap-reached | user-paused`. Same extensibility — free-form string at the data layer.

**Closed enum:** `state.phase`. Adding a new phase is a deliberate orchestrator + UI change, not a config tweak.

| field                      | type    | written by                                          |
| -------------------------- | ------- | --------------------------------------------------- |
| `automation.enabled`       | boolean | user (UI toggle or hand-edit)                       |
| `automation.iteration_cap` | integer | user (default 4; rarely changed)                    |
| `automation.state.*`       | various | orchestrator only; user touches via Pause/Resume UI |

Skill responsibilities (Phase 2 onward — not yet wired):

- The orchestrator iterates over changes where `automation.enabled === true AND status === in-progress AND state.phase ∈ {idle, running}`.
- Pause/Resume gestures from the UI translate to `state.phase: paused/idle` writes via a dedicated endpoint; the orchestrator never resumes itself.
- On `iteration_cap` hit: orchestrator writes `phase: paused, paused_reason: iteration-cap-reached`, fires `dashboard.automation-cap-reached` event, awaits human.

## Lifecycle

| stage         | what it means                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `planning`    | Change entry written; branch + edits not started                                               |
| `in-progress` | Branch created in the repo; edits underway                                                     |
| `in-review`   | PR opened (`pr_url` set); awaiting human review/merge                                          |
| `merged`      | PR merged; change is complete                                                                  |
| `abandoned`   | Change not pursued (different from "rejected" — sometimes you discover it's unneeded mid-work) |

The two terminal states are `merged` and `abandoned`. Unlike projects, there's no "archived" — completed changes stay in their terminal state for historical record.

## When to use

- Fixing a defined bug
- Implementing one small feature in one repo
- Bumping a dependency
- Refactoring one module
- Adding tests to one area

If the work would touch multiple repos, create a **project** with multiple changes underneath. If it's a one-off observation with no associated code work, use a **note**. If it's an architectural decision, use **decision**.

## Body sections

```markdown
# <title>

## Why
One paragraph: what's broken / what's missing / what we're improving.

## Approach
How you plan to do it. Touched files, key functions, test strategy.

## Done when
- [ ] Concrete checklist of "this is finished"

## Notes
Append observations as work progresses. If a decision emerges that
others should know, spawn a [[decision-...]] entry pointing back at
this change via `[[<change-id>]]` in its body.
```

## Composition with project

A change owned by a project carries `project: <project-id>` in its frontmatter. The Projects view's detail panel surfaces all owned changes inline (see `standard-project-workflow.md`).

A cross-repo feature is one project + N changes:

```
project: feature-auth-overhaul          ← coordinates milestones, reporting
  ├─ change-auth-overhaul-web           ← change.repo: my-app-web,    change.project: feature-auth-overhaul
  ├─ change-auth-overhaul-api           ← change.repo: my-app-api,    change.project: feature-auth-overhaul
  └─ change-auth-overhaul-mobile        ← change.repo: my-app-mobile, change.project: feature-auth-overhaul
```

## Outputs / artifacts produced

| artifact                               | location                                                                      | when                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Change entry                           | `vault/wiki/<domain>/change/<slug>.md`                                        | Created at scaffolding time                                                     |
| Branch                                 | `agent/<slug>` in the named repo                                              | Created when status moves to `in-progress`                                      |
| Pull request                           | GitHub PR URL captured in `pr_url:`                                           | Created when status moves to `in-review`                                        |
| (Future) Change summary                | `vault/output/<domain>/changes/<slug>-merged.md`                              | Auto-generated by future `dev-close-change` skill when status moves to `merged` |
| (Future) Decisions emerged during work | `vault/wiki/<domain>/decision/<slug>.md` (carrying `[[<change-id>]]` in body) | Captured ad-hoc during work                                                     |

## Example

```markdown
---
id: change-add-search-debounce
type: change
domain: development
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [bug-fix, search]
source: manual
private: false
title: Add search debounce
repo: my-app-web
status: planning
branch: agent/add-search-debounce
scope: src/search/Input.tsx
size: small
---

# Add search debounce

## Why
Autocomplete is firing on every keystroke — 60+ rpm during a typical query, and backend rate-limits us at 30. 300ms debounce keeps us under the limit.

## Approach
Wrap the input's onChange with useDebouncedCallback from lib/hooks. Update snapshot tests.

## Done when
- [ ] Debounce wrapping in place
- [ ] Tests updated
- [ ] No regression in keyboard navigation
- [ ] PR opened and linked here
```

## Related

- [[standard-change-workflow]] — full workflow standard
- [[archetype-project]] — projects coordinate multiple changes
- [[archetype-entity]] — repos that changes operate on (`kind: repo`)
- [[archetype-decision]] — capture significant choices made during a change
