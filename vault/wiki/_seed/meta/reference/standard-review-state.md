---
id: standard-review-state
type: reference
domain: meta
created: 2026-06-11T22:30:00Z
updated: 2026-06-11T22:30:00Z
tags: [standard, review, lifecycle, archetype]
source: manual
private: false
title: Shared review-state contract
---

# Shared review-state contract

One review-verdict vocabulary across every reviewed artifact. Before this
contract, the three review pipelines spoke private dialects: "awaiting
review" was `reviewed-pending` on projects but `pending` on change plans and
research-reports; override was an enum value on two archetypes and
impossible on the third; and `plan_status` on projects mixed lifecycle and
verdict into one 7-value enum (Fable review, Finding 4.2). Per the review's
abstraction verdict: this normalizes the **contract**, deliberately NOT a
generic lifecycle engine.

## The cluster

Every reviewed artifact (change plan, research-report, project plan) carries:

| field           | type   | meaning                                                                   |
| --------------- | ------ | ------------------------------------------------------------------------- |
| `review_status` | enum   | The verdict — see the shared enum below                                   |
| `review_path`   | string | Where the reviewer's verdict artifact lives (`vault/output/...`)          |
| `reviewed_at`   | string | ISO timestamp of the most recent review                                   |
| revision        | int    | Artifact-specific counter name stays: `plan_revision` / `report_revision` |

## The shared enum

```
pending          — awaiting review (default once the artifact exists)
approved         — reviewer cleared it; downstream gates open
request-changes  — reviewer wants revisions; revise skills re-arm to pending
rejected         — reviewer's terminal no
overridden       — human overrode a non-approve verdict (escape hatch)
not-required     — review deliberately skipped (e.g. trivial changes)
```

Per-archetype extensions stay where they belong: research keeps `notes_log`
mid-flight guidance; changes keep the orthogonal `pr_review_status`
(EXTERNAL PR review — different reviewer, different artifact); projects keep
the plan lifecycle in `plan_status`.

## plan_status is lifecycle-only

`plan_status` on projects: `pending | in-research | drafted | scaffolded |
active`. The verdict on a drafted plan lives in `review_status`. The legacy
mixed values map as:

| legacy plan_status | new pair                                     |
| ------------------ | -------------------------------------------- |
| `reviewed-pending` | `drafted` + `review_status: pending`         |
| `request-changes`  | `drafted` + `review_status: request-changes` |
| `approved`         | `drafted` + `review_status: approved`        |

`scripts/migrate-review-state.mjs` applies this table mechanically — run it
once per install after pulling the contract (idempotent; `--dry-run` to
preview). It also renames `plan_review_path` → `review_path` and
`plan_reviewed_at` → `reviewed_at`. `install.sh` runs it automatically.

Steppers/timelines render a LINEAR collapse of the pair (`planStageId` in
`domains/meta/app/server/lib/lifecycle-state.ts` — stage ids like
`awaiting-review` are rendering vocabulary, never persisted).

## Enforcement

Audit checks `review-status-enum` and `plan-status-enum` (ERROR) pin both
vocabularies across all three archetypes. Writers: `dev-review-change` /
`dev-revise-plan` (changes), `research-review` / `research-revise` /
`meta-mark-research-approved` (reports), `meta-review-project-plan` /
`meta-revise-project-plan` / `meta-scaffold-project-plan` (project plans).

## Related

- [[archetype-change]] · [[archetype-research-report]] · [[archetype-project]]
- [[standard-change-workflow]] · [[standard-project-workflow]]
