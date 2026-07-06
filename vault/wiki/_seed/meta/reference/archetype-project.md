---
id: archetype-project
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-26T22:30:00Z
tags: [archetype, memory]
source: manual
private: false
title: Project archetype
url: internal://archetype/project
kind: doc
last_verified: 2026-05-26
---

# Project archetype

## What it is

An active initiative with goals, status, and (optionally) a deadline. Projects bundle related decisions, notes, and references into a coherent thread.

## Required frontmatter (in addition to shared)

| field          | type   | notes                                                                                    |
| -------------- | ------ | ---------------------------------------------------------------------------------------- |
| `title`        | string | initiative name                                                                          |
| `status`       | enum   | `active`, `paused`, `completed`, or `cancelled`                                          |
| `deadline`     | date   | optional; YYYY-MM-DD                                                                     |
| `stakeholders` | array  | list of `[[entity-id]]` references and/or plain-string names — see resolution note below |

**Stakeholder resolution:** `meta-add-project` resolves each supplied name against the manifest — a match becomes `[[entity-id]]` (for stakeholders that exist as entities), a miss is written as a plain string (ad-hoc people not yet promoted to entities), never a blind-wrapped display name that can't resolve. Promote a plain-string stakeholder to a reference later via `meta-add-entity`.

## Optional frontmatter — for projects that drive code or scheduled work

A `project` becomes a **workflow scope** when it carries any of the fields
below. Other primitives reference it via `[[project-id]]` wikilinks; the
manifest's backlinks make those references queryable. Full pattern is
documented in `standard-project-workflow.md`.

| field             | type   | notes                                                                                                                                                                        |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`           | array  | list of entity ids (each `kind: repo`) — projects can span multiple repos (web + api, monorepo + service, etc.). Empty/omitted for projects that don't touch code.           |
| `lifecycle_stage` | enum   | `planning`, `active`, `review`, `shipped`, `archived` (finer-grained than `status`)                                                                                          |
| `milestones`      | array  | list of `{date, label, status}` objects — checkpoints toward the deadline                                                                                                    |
| `reporting`       | object | reporting cadence + target — see below                                                                                                                                       |
| `research_paths`  | array  | optional list of `[[research-report-id]]` references — the research-reports this project owns (see below).                                                                   |
| `completed_at`    | string | ISO timestamp — stamped by `meta-close-project` (`mode: complete`) when the project closes as `status: completed`. Cleared by `meta-reopen-project`. See § Closure contract. |
| `cancelled_at`    | string | ISO timestamp — stamped by `meta-close-project` (`mode: abandon`) when the project closes as `status: cancelled`. Cleared by `meta-reopen-project`. See § Closure contract.  |

With the research domain landing, **research-reports become the source of `recommended_changes`**: each approved `research-report` (`type: research-report`) under a project carries a `recommended_changes` array, and phase B's `meta-scaffold-project-plan` extension reads those arrays in addition to the project plan when materializing the project's owned changes. `research_paths` is the optional explicit list — the manifest's backlinks already make `report.project: <project-id>` → owning-project queries cheap, so `research_paths` is mostly documentation (skills derive it from backlinks at scaffold time).

Branch tracking lives on each **repo entity** (`current_branch` field set by `dev-ingest-repo`), not on the project. The project knows which repos it touches; each repo knows which branch the OS is operating on. v1 supports one project per repo at a time; cross-repo branch coordination is the agent's responsibility.

## Plan-tracking fields (managed by `research-write` / `meta-review-project-plan` / `meta-revise-project-plan` / `meta-scaffold-project-plan`)

A project carries a **plan-lifecycle gate** that the four project-orchestration skills consult as a state machine. The fields are written by those skills — you don't hand-edit them, but the audit ensures they stay consistent. Mirrors the change archetype's "Review-gate fields" pattern, but at the project tier (planning the bundle of changes a project will own, before any of them are scaffolded).

| field                      | type    | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan_path`                | string  | Set by `research-write` on first run. Points at `vault/output/<domain>/project-plans/<project-id>-plan.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `plan_status`              | enum    | **Lifecycle-only** (shared review-state contract — see `standard-review-state`): `pending` (default for new projects), `in-research` (plan being researched/written), `drafted` (plan exists; the review verdict lives in `review_status`), `scaffolded` (children created), `active` (post-scaffold, project is running its changes). Distinct from `lifecycle_stage: active` — `plan_status: active` is the plan-lifecycle terminal, `lifecycle_stage: active` is the coarse dev-cycle phase; the audit + UI keep them disambiguated. _Migration note:_ the pre-contract enum mixed review verdicts in (`reviewed-pending` / `request-changes` / `approved`); those map to `drafted` + the matching `review_status`. |
| `review_status`            | enum    | The **shared review verdict** — same 6-value enum changes and research-reports use: `pending` \| `approved` \| `request-changes` \| `rejected` \| `overridden` \| `not-required`. Written by `meta-review-project-plan`; reset to `pending` by `meta-revise-project-plan`. Absent until a plan exists.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `plan_revision`            | integer | Starts at `1` for the original plan; bumped to `2`, `3`, … by `meta-revise-project-plan` each time it folds review findings back into the plan. Unset on legacy entries — treat missing as `1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `review_path`              | string  | Set by `meta-review-project-plan`. Points at `vault/output/<domain>/project-plans/<project-id>-plan-review.md`. (Formerly `plan_review_path`.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reviewed_at`              | string  | ISO timestamp — when the most recent review completed. (Formerly `plan_reviewed_at`.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plan_revised_at`          | string  | ISO timestamp — when `meta-revise-project-plan` most recently rewrote the plan. Distinct from `plan_generated_at` (which moves on every write); this only moves on REVISE. Null until first revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `plan_revised_from_review` | string  | Path to the review file whose findings drove the most recent revision. Null until first revision. Lets future readers (and the next review pass) see which verdict the revision was responding to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `plan_generated_at`        | string  | ISO timestamp — when the most recent plan was written (initial research or revise).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

See `standard-project-workflow.md` for the full plan-lifecycle state machine.

### Reporting object shape

```yaml
reporting:
  cadence: weekly                 # daily | weekly | none
  target: clipboard               # clipboard | notion | linear | slack | none
  target_ref: null                # platform-specific id (Notion DB id, Linear project id, Slack channel)
  last_sent: null                 # ISO timestamp of the most recent generated report
  next_due: 2026-05-28            # YYYY-MM-DD when the next report should be generated
```

In v1, `target: clipboard` is the only fully-wired path — the (future)
`meta-status-report` skill writes a markdown file to
`vault/output/<domain>/status-reports/<project-id>-<date>.md` and the user
copies it to their tool of choice. MCP-based integrations for Notion/Linear/Slack
are deferred until projects are dogfooded.

### Lifecycle vs. status

`status` is the coarse user-facing state (active/paused/completed/cancelled).
`lifecycle_stage` is the finer dev-cycle phase (planning/active/review/shipped/archived).
A project can be `status: active, lifecycle_stage: review` — actively monitored
but in code-review phase, not feature-development phase.

Project-scoped scheduled runbooks (runbooks with `project: <id>`) only fire when
`status: active`. The scheduler tick skips them otherwise — pausing a project
pauses its scheduled work automatically.

### Closure contract

Closing a project is **not** a bare status flip — it goes through
[[meta-close-project]] (dispatched by the dashboard's Complete / Abandon buttons or
`/os close project`), which enforces an owned-work disposition gate. The inverse is
[[meta-reopen-project]].

- **Owned open work** — the items a project must resolve before it can close:
  - non-terminal owned changes (`project == <id>`, `status ∉ {merged, abandoned}`);
  - approved-family reports' (`status: approved | updated`) `recommended_changes` rows
    that are `proposed`, or `scaffolded` with an unmerged linked change (a `scaffolded`
    row whose change is itself in the change list is **covered** — dispositioning the
    change flips the row);
  - `notes_log` items with an empty `considered_by` on any report under the project.
- **Disposition gate** — every open item must carry a disposition: `abandon`
  (rationale required), `transfer` (changes only, to an existing non-terminal project),
  or `block`. If any item blocks, closure **refuses** with an itemized list and mutates
  nothing.
- **Terminal mapping** — `complete` → `status: completed` + `completed_at`; `abandon` →
  `status: cancelled` + `cancelled_at`; both → `lifecycle_stage: archived` + `updated`.
- **Reopen inverse** — `meta-reopen-project` flips `completed | cancelled → active`,
  restores `lifecycle_stage: active`, and clears whichever closure stamp is present.

## When to use

- Something you'll come back to multiple times over days/weeks
- Work with a defined goal (vs. an ongoing area, which is a domain)
- When you want a single place that aggregates a thread's decisions/notes/refs

For a one-time question, use `note`. For an ongoing area (research/development), use a domain.

## Example

```markdown
---
id: build-agentic-os-v1
type: project
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [v1, build]
source: manual
private: false
title: Build Agentic OS v1
status: active
deadline: 2026-06-01
stakeholders: [[user-alice]]
---

# Build Agentic OS v1

## Goal

Ship a self-extending agentic OS with: 3 domains, 9 skills, dashboard with full read-write and AI bridge. Use it daily.

## Status

Active — currently in scaffolding phase (Layer 6 of 11).

## Milestones

- [x] Architecture & standards lock-down
- [x] Bootstrap skeleton (Layer 1)
- [x] Templates (Layer 2)
- [x] Skills (Layer 3)
- [x] Hooks (Layer 4)
- [x] Playbooks (Layer 5)
- [ ] Seed wiki (Layer 6)
- [ ] Dashboard (Layers 7-10)
- [ ] PR reviewer dogfood (Layer 11)

## Stakeholders

[[user-alice]]

## Notes

- Design phase took ~half the conversation — worth it for standards clarity
- See `[[use-fastify]]` for backend stack rationale
- See `[[two-layer-memory]]` for memory model
```

## Related

[[archetype-decision]] (decisions emerge from projects), [[archetype-entity]] (for ongoing areas)
