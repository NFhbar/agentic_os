---
id: standard-change-workflow
type: reference
domain: meta
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [standard, change, development, workflow]
source: seed
private: false
title: Change workflow standard
url: internal://standard/change-workflow
kind: doc
last_verified: 2026-05-21
---

# Change workflow standard

## What this covers

How the OS handles a unit of code work smaller than a project: one repo, one branch, one PR. The `change` archetype is the tracking artifact; downstream skills (`dev-write-change`, `dev-open-pr`, `dev-close-change` — future) consume it to execute and close the work.

## Why a separate archetype

We have `project` (heavy: milestones, reporting, multi-repo) and `note` (too unstructured). A change is the missing middle:

- Has a status lifecycle (planning → in-progress → in-review → merged | abandoned)
- Mandates a single repo + branch
- Composes into projects when the work scales
- Captures intent without forcing milestones or reporting cadence

Applying the archetype-vs-extend rubric from [[standard-feature-anatomy]]:

- ✓ Distinct lifecycle (different terminal states from project — no "shipped"/"archived")
- ✓ ≥3 distinct required fields (`repo`, `branch` are REQUIRED on change but OPTIONAL on project)
- ✓ Would force many optional fields on `project` (size, pr_url, parent_change don't fit there)
- ✓ Distinct query pattern ("what's in flight?" / "what touched module X?" — distinct from "what initiatives are active?")

Four of four → new archetype, not an extension.

## Where the description lives across the lifecycle

The "what is this change and why" description is **layered** across multiple artifacts. Each stage adds detail. Knowing which stage owns which content prevents both over-engineering early and under-describing late.

| stage                                                 | what's captured                                                                                                                      | by whom                    | where it lives                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Scaffold** (`dev-add-change`)                       | Short title (label for lists, PR title)                                                                                              | User (via form)            | `title:` frontmatter                                                                                              |
| **Pre-plan** — _fill in before invoking write-change_ | **Why** (intent, problem statement) + **Approach** (high-level direction) + **Done when** (concrete completion criteria)             | **User** (manual edit)     | `change.body` Why / Approach / Done-when sections                                                                 |
| **PLAN phase** (`dev-write-change`)                   | Agent's detailed interpretation: files touched, new files, files NOT touched (scope guard), test cases, risks, out-of-scope concerns | Agent                      | `vault/output/<domain>/changes/<slug>-plan.md`                                                                    |
| **REVIEW phase** (`dev-review-change`)                | Verdict + concerns by severity (blocker / concern / nit)                                                                             | Reviewer agent (read-only) | `vault/output/<domain>/changes/<slug>-review.md`                                                                  |
| **During execution**                                  | Observations, surprises, captured decisions                                                                                          | User or agent (ad-hoc)     | `change.body` Notes section; OR spawn standalone `decision`/`note` entries that include `[[<change-id>]]` in body |
| **PR open** _(future, `dev-open-pr`)_                 | Synthesized narrative for human reviewers (combines body + plan + diff stat)                                                         | Future skill               | GitHub PR description                                                                                             |
| **Post-merge summary** _(future, `dev-close-change`)_ | Final record: what shipped, what changed, lessons                                                                                    | Future skill               | `vault/output/<domain>/changes/<slug>-merged.md`                                                                  |

### The "pre-plan" gate

The most error-prone moment is **between scaffold and write-change**. After `dev-add-change` runs, the change body is a template with placeholder text (`"One paragraph: what's broken..."`, `"How you plan to do it. Touched files..."`). The user is expected to **replace those placeholders with actual content** before invoking `dev-write-change`.

If the user forgets, the PLAN phase reads "One paragraph: what's broken..." verbatim into the plan as the Intent — garbage in, garbage out. To prevent this:

- **`dev-write-change` PLAN phase rejects** with a clear message when placeholder strings are still present in the body. Fail-fast: "Edit the change entry's Why and Approach sections, then re-run."
- **The audit (`change-body-template-placeholder`)** surfaces planning-state changes with template still in body as a warning — catches forgotten descriptions even before invoking write-change.
- **The dashboard's Changes view** shows a yellow state-hint card _"This change's Why/Approach is still placeholder. Edit before generating the plan."_

Three layers of defense: the writer skill won't operate on a half-described change, the audit catches it, and the dashboard surfaces it visually.

### Capturing decisions mid-work

If a significant architectural choice emerges during execution (not "I picked debounce time 300ms" — that's a code comment; but "we now standardize on lodash.debounce across the repo" — that's a decision), **spawn a standalone `decision` entry** rather than burying it in the change's Notes section. The decision entry should include `[[<change-id>]]` in its body so the manifest's backlinks index makes the relationship queryable.

Don't write decisions as Notes — they accumulate in the change entry's body and get lost when the change is merged. A standalone decision entry survives independently.

## Single-repo by design

A change is **single-repo**. This is a deliberate constraint, not a limitation:

- When work spans repos, a **project** owns multiple changes (one per repo)
- Each change has a clean atomic semantic: one branch in one repo, one PR
- The composition story stays simple: project = portfolio of changes
- The Projects dashboard view's owned-changes section surfaces them all

A cross-repo example:

```
project: feature-auth-overhaul              ← coordinates, has reporting
  ├─ change-auth-overhaul-web               ← repo: my-app-web,    project: feature-auth-overhaul
  ├─ change-auth-overhaul-api               ← repo: my-app-api,    project: feature-auth-overhaul
  └─ change-auth-overhaul-mobile            ← repo: my-app-mobile, project: feature-auth-overhaul
```

Each child change is fully self-contained — it can be paused, abandoned, or rebased independently. The project tracks the overall progress.

## Lifecycle transitions

| transition              | trigger                | check before                                                     | update                                                                                                                                                                                    | side-effects                                                                                                                         |
| ----------------------- | ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| → planning              | New change             | Repo entity exists; project entity exists if cross-referenced    | `meta-add-change` sets `status: planning, branch: agent/<slug>`                                                                                                                           | None — entry is just tracking until you actually start work                                                                          |
| planning → in-progress  | Starting the code work | Working tree on the repo's default branch is clean               | `status: in-progress`. Create `agent/<slug>` branch in `repos/<repo>/`. Update the repo entity's `current_branch` to match.                                                               | Future `dev-write-change` skill will execute the procedure described in the change body. Repo entity is now "in use" by this change. |
| in-progress → in-review | PR opened              | All "Done when" checklist items done; tests green                | `status: in-review`. Set `pr_url:` to the GitHub PR link.                                                                                                                                 | Trivially composes with `dev-pr-review` — pass the change id and it looks up the URL.                                                |
| in-review → merged      | PR merged upstream     | PR is actually merged on GitHub (verify with `gh pr view <url>`) | `status: merged`. Future `dev-close-change` can auto-write a summary at `vault/output/<domain>/changes/<slug>-merged.md`. Reset the repo entity's `current_branch` to the default branch. | Branch is typically deleted post-merge; the change entry stays as historical record.                                                 |
| any → abandoned         | Decided not to pursue  | Write a 1-line note in the entry's body explaining why           | `status: abandoned`.                                                                                                                                                                      | Branch (if exists) can be deleted. The entry stays for institutional memory.                                                         |

In v1 transitions are **manual** — edit the entry's frontmatter. v2 may add `dev-write-change` (planning → in-progress + edits), `dev-open-pr` (in-progress → in-review + PR), `dev-close-change` (in-review → merged + summary file).

## Outputs / artifacts produced

A change is the entry point to multiple artifacts. Standardizing where each lives:

| artifact                                   | location                                                                    | when                              | written by                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| **Change entry** (canonical tracking)      | `vault/wiki/<domain>/change/<slug>.md`                                      | At scaffolding                    | `dev-add-change`                                           |
| **Plan** (proposed work, pre-execution)    | `vault/output/<domain>/changes/<slug>-plan.md`                              | `dev-write-change` PLAN phase     | `dev-write-change`                                         |
| **Review** (peer-review verdict on plan)   | `vault/output/<domain>/changes/<slug>-review.md`                            | `dev-review-change` runs          | `dev-review-change`                                        |
| **Branch** (the code work)                 | `agent/<slug>` in `repos/<repo>/`                                           | `dev-write-change` EXECUTE phase  | `dev-write-change`                                         |
| **Execution log** (failures only)          | `vault/output/<domain>/changes/<slug>-execution-log.md`                     | Execute phase hits test failures  | `dev-write-change`                                         |
| **Pull request** (review surface)          | GitHub; URL captured in `pr_url:` field                                     | Status moves to `in-review`       | Future `dev-open-pr` (manually for now via `gh pr create`) |
| **Change summary** (final record)          | `vault/output/<domain>/changes/<slug>-merged.md`                            | Status moves to `merged` (FUTURE) | Future `dev-close-change`                                  |
| **Decision entries** (significant choices) | `vault/wiki/<domain>/decision/<slug>.md` carrying `[[<change-id>]]` in body | Ad-hoc during work                | Manual or via `/os capture decision` (future)              |

The change entry itself is **always** the canonical reference. Other artifacts may not exist (small changes may produce zero decisions; abandoned changes never get summaries). The Changes dashboard view surfaces them all from the entry's frontmatter + filesystem inspection.

## Review gate — plan / review / execute state machine

Every change passes through a peer-review gate by default. The gate is implemented as a **state machine in the change entry's frontmatter**, driven by two skills (`dev-write-change` and `dev-review-change`) that read and update the same fields.

### State machine

`dev-write-change` consults `review_status` and behaves accordingly:

| `review_status`   | `plan_path` set? | `dev-write-change` does                                                                                                                                                                                            |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`         | no               | **PLAN phase** — compose structured plan, write to `vault/output/<domain>/changes/<slug>-plan.md`, set `plan_path` + `plan_generated_at`. Stop.                                                                    |
| `pending`         | yes              | "Plan exists at <path>. Run `/os review-change <id>` to gate execution."                                                                                                                                           |
| `approved`        | yes              | **EXECUTE phase** — verify working tree, create `agent/<slug>` branch, follow the plan exactly, run tests, set `status: in-progress`.                                                                              |
| `request-changes` | yes              | Surface review concerns. Three options: re-plan, override (set `review_status: overridden`), or set `status: abandoned`.                                                                                           |
| `rejected`        | yes              | Surface review verdict. Suggest setting `status: abandoned`.                                                                                                                                                       |
| `overridden`      | yes              | **EXECUTE phase** — but log the override in `vault/raw/dashboard-actions.jsonl` so the bypass is auditable.                                                                                                        |
| `not-required`    | (irrelevant)     | Skip the review gate only: PLAN first when no plan exists, then EXECUTE without waiting for a verdict. EXECUTE always requires a plan. For trivial changes only (set via `review_required: false` at scaffolding). |

### Plan document template

The PLAN phase writes a structured plan to `vault/output/<domain>/changes/<slug>-plan.md`:

```markdown
# Plan — <change title>

**Generated:** <ISO>
**Change:** [[<change-id>]]
**Repo:** [[<repo-id>]] · branch will be `<branch>`

## Intent (verbatim from change entry)
<change body's Why section>

## Approach
1. <numbered step>
2. <numbered step>

## Files I will modify
- `src/path/foo.ts` — <one-line summary>
- `src/path/bar.test.ts` — <new test cases / modifications>

## Files I will create
- `src/path/new.ts` — <purpose>

## Files I will NOT touch (even if related)
- <list, each with one-line reason — guards against scope creep>

## Tests
- New cases planned: <list>
- Existing tests likely to need updates: <list>
- Test command (from repo entity): `<command>`

## Risk
- <area>: <severity + mitigation>

## Out-of-scope concerns surfaced
<things noticed that are NOT part of this change — candidates for follow-up changes>
```

### Review document template

`dev-review-change` reads the plan + change + relevant repo files, then writes to `vault/output/<domain>/changes/<slug>-review.md`:

```markdown
# Review — <change title>

**Reviewed:** <ISO>
**Plan:** <plan_path>
**Verdict:** approve | request-changes | reject

## TL;DR
<one sentence — what's good, what's concerning, what's blocking>

## Checklist

### Scope discipline
- [ ] Plan stays within change entry's stated scope
- [ ] "Files I will NOT touch" correctly excluded

### Repo convention alignment
- [ ] Code style matches repo's biome/prettier/ruff/etc config
- [ ] Test framework correct (uses repo's actual framework)
- [ ] File placement follows repo conventions
- [ ] Naming conventions respected

### Risk
- [ ] No touches to auth / data migrations / security boundaries (or explicitly justified)
- [ ] No breaking API changes (or justified)
- [ ] Backward compatibility considered

### Test coverage
- [ ] New code has planned tests
- [ ] Edge cases enumerated
- [ ] Test count seems appropriate for change size

### Existing code respect
- [ ] Reuses existing utilities / patterns
- [ ] Doesn't reinvent something already in the repo

## Concerns

- **blocker** — <description>
- **concern** — <description>
- **nit** — <description>

## Suggested changes
(only if verdict is `request-changes`)
```

### Override path

If the reviewer requests changes but the user disagrees, they can:

1. Manually edit the change entry: set `review_status: overridden`
2. Run `/os write-change <id>` again — it'll go to EXECUTE phase
3. The override is logged to `dashboard-actions.jsonl` for audit
4. The original `review.md` stays as historical record — the override doesn't erase the disagreement, just acts in spite of it

This trades safety for autonomy. Use sparingly. For autonomous OS operation (e.g. scheduled feature work — far future), overrides should require human action.

### Skipping review (trivial changes)

For dep bumps, typo fixes, version constant updates, etc., scaffold with `review_required: false`:

```
/os add-change --name=bump-biome-v2 --review_required=false
```

This sets `review_status: not-required` from the start. `dev-write-change` runs PLAN on first invocation (a plan is always required), then EXECUTE immediately on the next — no review verdict in between.

The convention: opt-out is for **changes a careful human would skip review on too**. Anything that touches business logic, data flow, or external contracts should keep `review_required: true`.

## PR body template (future, when `dev-open-pr` lands)

When the future `dev-open-pr` skill creates a PR, it should follow a standardized body so PRs are scannable and easy to review:

```markdown
## Why
<change.body Why section, verbatim>

## What changed
<auto-generated from `git diff --stat` + brief summary of each touched file>

## Testing
<change.body Approach section's test strategy>

## Done when
<change.body Done when checklist, current state>

## Tracking
- Change entry: [[<change-id>]] (`vault/wiki/<domain>/change/<slug>.md`)
- Project (if any): [[<project-id>]]

---
Generated from the OS's change tracker. Manual edits to this PR body are fine — they don't sync back.
```

Documenting this now so the future skill has a contract to implement against.

## Composition with project

A change owned by a project carries `project: <project-id>` in its frontmatter. This is the same shared `project:` field decisions and notes use (per [[standard-wiki-format]] under "Optional shared fields"). The Projects view's **detail panel** lists owned changes in a dedicated **Changes** section with status badges, and the audit's `entry-project-exists` check verifies the named project exists.

A change can also link to OTHER changes via:

- `parent_change: <id>` — supersedes or extends another change (e.g., a follow-up that handles edge cases)
- `[[<other-change-id>]]` in body — informal reference

## Composition with dev-pr-review

When a change reaches `status: in-review` with `pr_url:` set, the existing `dev-pr-review` skill can take EITHER the URL directly OR a change id. The future enhancement: `dev-pr-review` accepts `change: <id>`, looks up the PR URL from the change's frontmatter, runs its review, attaches the review output to `vault/output/<domain>/pr-review/<slug>.md` AND back-references the change.

For v1, the coupling is loose: change tracks `pr_url`, user invokes `dev-pr-review <url>` independently.

## Audit support

The OS audit (`scripts/audit.mjs`) enforces change shape:

| check id                           | severity | what it enforces                                                                                             |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `change-status-enum`               | error    | `status` is one of `planning`, `in-progress`, `in-review`, `merged`, `abandoned`                             |
| `change-repo-exists`               | error    | `repo` field matches an existing `kind: repo` entity                                                         |
| `change-size-enum`                 | warn     | `size`, when set, is one of `small`, `medium`, `large`                                                       |
| `change-pr-url-format`             | warn     | `pr_url`, when set, looks like a URL (loose check)                                                           |
| `change-review-status-enum`        | error    | `review_status` is one of `pending`, `approved`, `request-changes`, `rejected`, `overridden`, `not-required` |
| `change-body-template-placeholder` | warn     | Planning-state change body still contains scaffolder template placeholders (Why/Approach not filled in)      |
| `entry-project-exists`             | error    | Shared check — `project:` field (when set) references an existing project entity                             |

## Retirement

To retire a change:

- `merged`: leave as-is. The entry is historical record. The branch is deleted post-merge by GitHub's default flow.
- `abandoned`: set `status: abandoned` with a one-line "why not" note appended to the body. Branch (if exists) can be deleted manually with `git branch -D agent/<slug>`.
- Removing the change entry itself: use `/os delete change <id>` (the existing `meta-delete` skill handles wiki entries with cross-reference cleanup).

Don't delete merged or recently-abandoned changes — they're context for future work and surface in the Projects detail panel's history.

## Related

- [[archetype-change]] — the underlying archetype with required + optional fields
- [[archetype-project]] — projects own changes; changes compose via the `project:` field
- [[standard-project-workflow]] — projects coordinate multiple changes
- [[standard-repo-ingestion]] — every change references an ingested repo
- [[dev-ingest-repo]] — produces the repo entity that a change targets
- [[dev-add-change]] — the scaffolder skill
- [[standard-feature-anatomy]] — change archetype was added against this anatomy (data: new archetype; runtime: none yet; scaffolder: dev-add-change; dashboard: Changes view; docs: this entry)
