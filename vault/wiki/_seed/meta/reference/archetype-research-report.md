---
id: archetype-research-report
type: reference
domain: meta
created: 2026-05-26T22:30:00Z
updated: 2026-05-26T22:30:00Z
tags: [archetype, memory, research]
source: seed
private: false
title: Research-report archetype
url: internal://archetype/research-report
kind: doc
last_verified: 2026-05-26
---

# Research-report archetype

## What it is

A **research-report** is a durable artifact produced by the research domain — the structured output of one focused investigation, owned by a project, that synthesizes ingested materials into findings and (optionally) **recommended changes** the OS can hand off to the development domain.

Where a `note` is free-form and an ad-hoc `decision` captures a single conclusion, a research-report is the full investigative loop: materials → synthesis → findings → recommendations. Reports go through their own review gate (mirrors changes) and can be updated multiple times as new data lands — each update appends a `## Update N` section to the body.

A research-report is **single-project by design**. Cross-project syntheses are a project of their own, with one report each.

## Required frontmatter (in addition to shared)

| field     | type   | notes                                                                            |
| --------- | ------ | -------------------------------------------------------------------------------- |
| `title`   | string | Short, scannable ("LLM evaluation harness landscape", "MCP transport tradeoffs") |
| `project` | string | Owning project id — many-to-one (a project can own multiple reports)             |
| `status`  | enum   | `draft`, `reviewed`, `request-changes`, `approved`, `updated`                    |

## Status enum

| value             | meaning                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `draft`           | Report just written, awaiting review                                                                       |
| `reviewed`        | `research-review` completed with verdict `approve`; suggestions may exist but no blockers                  |
| `request-changes` | Reviewer flagged blockers — author must revise via `research-revise`                                       |
| `approved`        | Cleared for downstream consumption (`meta-scaffold-project-plan` can read `recommended_changes` from here) |
| `updated`         | Report has received at least one `## Update N` since approval (new materials triggered a refresh)          |

The `reviewed → approved` transition is a **separate explicit user action**, not an automatic flip on a successful review. `research-review` writes `status: reviewed` on the `approved` verdict; an explicit human edit (or a future `research-approve` skill) flips `reviewed → approved` before `meta-scaffold-project-plan` consumes `recommended_changes`. This preserves the human-ack gate the archetype was designed to provide — the reviewer's verdict and the scaffolding green-light are deliberately distinct steps.

## Optional frontmatter

| field                 | type   | notes                                                                                                                                 |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `materials_path`      | string | Directory holding raw materials this report was synthesized from. Convention: `vault/raw/project-research/<project-id>/<report-id>/`. |
| `last_data_ingest`    | string | ISO timestamp — when materials were most recently dropped under `materials_path`. Drives the new-materials update trigger.            |
| `update_count`        | int    | Number of `## Update N` sections in the body. Bumped by the update skill. Defaults to `0` for fresh reports.                          |
| `dismissed_triggers`  | array  | Trigger ids the user has dismissed (so the same update banner doesn't re-fire). See "Update triggers" below.                          |
| `recommended_changes` | array  | The bridge to the development domain — see shape below.                                                                               |
| `notes_log`           | array  | Mid-lifecycle guidance notes consumed by `research-review` / `-revise` / `-update`. See "Notes log" below.                            |

### `recommended_changes` item shape

Each item is an object:

```yaml
- id: <change-id-or-null>      # set once meta-scaffold-project-plan creates the change
  summary: <one-line>          # what the change should do
  domain: development          # target domain (almost always development)
  size: small | medium | large # informs downstream depth-of-analysis
  status: proposed             # proposed | scaffolded | merged | abandoned
```

`status` lifecycle:

- `proposed` — report recommends it; no change entry exists yet
- `scaffolded` — `meta-scaffold-project-plan` has created the change (its `id` is set)
- `merged` — the linked change reached `status: merged`
- `abandoned` — the linked change reached `status: abandoned`, or the recommendation was overruled

### `notes_log` item shape

Each note is an object. The `notes_log` array is append-only — notes are immutable once added; subsequent skill runs append to a note's `considered_by` rather than mutating its `body` or `severity`.

```yaml
- ts: 2026-05-29T18:00:00Z        # ISO when the user added the note
  severity: warn                  # info | warn | blocker
  body: "Free-form guidance text"
  considered_by:                  # appended by skills as they fold the note in
    - skill: research-revise
      ts: 2026-05-29T19:00:00Z
      run_id: run-abc123          # optional
```

`severity` weights:

- `info` — take into account; skill is free to deprioritize
- `warn` — strongly consider; if not addressed, the skill should explain why in its output
- `blocker` — must address, OR the skill must explicitly document why it can't (and what would unblock)

`considered_by` semantics: a note with an empty `considered_by` is **unconsidered** — the UI marks it as such, and the next skill run is expected to fold it in (or explain why not). After folding, the skill appends a `{ skill, ts, run_id? }` entry. Hybrid persistence: notes themselves never expire, but the `unconsidered` signal makes it obvious which guidance is still pending action.

Skills that consume notes:

- `research-review` — reads notes before producing the verdict; folds them into the suggestions/blockers list
- `research-revise` — reads notes when rewriting; addresses them in the revised body
- `research-update` — reads notes when folding new materials; weights them alongside the new evidence

`research-write` (the initial draft) does NOT read notes — they're mid-lifecycle by definition.

### Frontmatter caveats

The flat-frontmatter parser in `.claude/hooks/rebuild-vault-index.mjs` does NOT handle nested YAML well. When `research-write` (or any future skill) writes a research-report entry:

- `recommended_changes` MUST be emitted as a single-line JSON array (the same trick the parser uses for `tags` and `repos`). Multi-line YAML arrays of objects will be silently dropped — `fm.recommended_changes` will be `undefined`.
- `dismissed_triggers` MUST likewise be a single-line JSON array.
- `notes_log` MUST likewise be a single-line JSON array. The `POST /api/research/:id/notes` endpoint and any skill that appends a `considered_by` entry should use the same `replaceField` regex pattern documented for `recommended_changes`.

The `recommended_changes_count` manifest field gracefully degrades to `null` for entries the parser couldn't read, so a missing array isn't a hard failure — it just means the count won't be queryable until the parser is upgraded or the entry is rewritten with the inline form.

## Review-gate fields (managed by research-write / research-review / research-revise)

A research-report carries a **review gate** that mirrors the change archetype's pattern. The four research-domain skills (landing in phase B) consult these as a state machine.

| field                        | type    | notes                                                                                                                                    |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `review_required`            | boolean | Default `true`. Set `false` at scaffolding time for trivial reports; skips the review gate.                                              |
| `review_status`              | enum    | `pending` (default), `approved`, `request-changes`, `rejected`, `overridden`, `not-required`                                             |
| `review_path`                | string  | Set by `research-review`. Points at `vault/output/research/reports/<report-id>-review.md`.                                               |
| `reviewed_at`                | string  | ISO timestamp — when the most recent review completed.                                                                                   |
| `report_generated_at`        | string  | ISO timestamp — when the most recent report version was written (`research-write` initial draft or `research-revise` rewrite).           |
| `report_revision`            | integer | Starts at `1` for the original report; bumped to `2`, `3`, … by `research-revise` each time it folds review findings back in.            |
| `report_revised_at`          | string  | ISO timestamp — when `research-revise` most recently rewrote the report. Distinct from `report_generated_at`. Null until first revision. |
| `report_revised_from_review` | string  | Path to the review file whose findings drove the most recent revision. Null until first revision.                                        |

`report_revision` is the deliberate analog of `plan_revision` (on changes) and not a rename of either — `plan_revision` exists on both changes and projects already; reusing the name on research-reports would collide. The `report_` prefix avoids ambiguity.

## Update triggers (consumed by `research-update`)

A report can trigger an update banner in the dashboard when one of these conditions fires. The user accepts (run `research-update`) or dismisses (id appended to `dismissed_triggers`).

| trigger id                   | fires when                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `new-materials-ingested`     | `last_data_ingest` is newer than `report_generated_at` (new raw materials landed since the last write)    |
| `staleness-threshold-passed` | `report_generated_at` is older than the report's project's configured staleness window (default: 30 days) |
| `recommended-change-merged`  | One of `recommended_changes[].status` flipped to `merged` (might reshape the rest of the recommendations) |

Phase B's `research-update` skill writes the trigger handling — for phase A this is contract-only.

**Update may reset `review_status`.** When `research-update` rewrites the report, it evaluates whether the rewrite is substantive: if EITHER (a) `recommended_changes.length` grew (≥1 new proposal appended) OR (b) the `## Findings` section was rewritten beyond cosmetic edits, then `research-update` resets `review_status: pending` and clears `reviewed_at` + `review_path` — the prior verdict no longer describes the still-current state, and the dashboard re-surfaces the review banner. When neither condition fires, `review_status` is preserved (the prior verdict still applies to the still-current content). The decision (reset or preserved) and its trigger condition are recorded in the `## Update N` block's `### What changed` sub-section so the audit trail is explicit. See `research-update` Step 5d for the precise criteria.

## Body sections

```markdown
# <title>

## Why
One paragraph: the question this report investigates and why it matters.

## Findings
The structured synthesis of the materials. Subsections as needed — the
report's body is the most flexible section by design.

## Recommended changes
- [ ] <summary> — links to the row in `recommended_changes` frontmatter
- ...

## Notes
Open questions, ambiguities, follow-up reading.

## Update 1
(Appended by `research-update` — never hand-written. Carries
its own `### Why this update` + `### What changed` sub-sections.)
```

The `## Update N` convention is load-bearing — `update_count` in frontmatter MUST equal the number of `## Update N` H2s in the body. Audit enforces this in phase B.

## Lifecycle

| stage             | what it means                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `draft`           | Report written by `research-write`; review not yet run                                                                             |
| `reviewed`        | `research-review` verdict was `approve`; no blockers. Waiting for the explicit human flip to `approved` before downstream consume. |
| `request-changes` | Reviewer flagged blockers; awaiting `research-revise`                                                                              |
| `approved`        | Cleared for downstream consumption by `meta-scaffold-project-plan` (manual flip from `reviewed`, or future `research-approve`)     |
| `updated`         | Has at least one update past approval                                                                                              |

There is no `abandoned` terminal state — research isn't "thrown away" the same way a change can be. A report that turned out to be wrong gets a final update saying so and stays in `updated`.

## When to use

- A focused investigation with a clear question ("which embedding library should we standardize on?")
- A landscape survey ("what observability tools are people using for LLM apps in 2026?")
- A retrospective ("what did we learn from the auth migration?") — produces decisions + zero recommended_changes

If the output is one short paragraph + one decision, use `note` + `decision` directly. If the work spans multiple distinct investigations, use one `project` owning multiple `research-report` entries.

## Composition with project

A research-report ALWAYS owns a `project: <project-id>` field — the project is the umbrella the report lives under. The Projects view's detail panel surfaces all owned reports inline; `meta-scaffold-project-plan` reads `recommended_changes` from each approved report under a project to derive the project's change list.

A research project is one project + N reports:

```
project: investigate-llm-eval                ← coordinates milestones, reporting
  ├─ report-eval-harness-landscape           ← report.project: investigate-llm-eval
  ├─ report-eval-metrics-survey              ← report.project: investigate-llm-eval
  └─ report-eval-recommendation              ← report.project: investigate-llm-eval (final synthesis)
```

## Outputs / artifacts produced

| artifact       | location                                          | when                                                                         |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Report entry   | `vault/wiki/research/research-report/<slug>.md`   | Created by `research-write`                                                  |
| Review         | `vault/output/research/reports/<slug>-review.md`  | Created by `research-review`                                                 |
| Materials drop | `vault/raw/project-research/<project-id>/<slug>/` | Populated by the user (or future ingest skills) before/between report writes |

## Example

```markdown
---
id: report-llm-eval-harness-landscape
type: research-report
domain: research
created: 2026-05-26T00:00:00Z
updated: 2026-05-26T00:00:00Z
tags: [llm, eval, landscape]
source: manual
private: false
title: LLM eval harness landscape (2026 H1)
project: investigate-llm-eval
status: draft
materials_path: vault/raw/project-research/investigate-llm-eval/report-llm-eval-harness-landscape/
last_data_ingest: 2026-05-25T18:00:00Z
update_count: 0
review_required: true
review_status: pending
recommended_changes: [{"summary":"Spike on inspect_ai as our default harness","domain":"development","size":"small","status":"proposed"}]
dismissed_triggers: []
---

# LLM eval harness landscape (2026 H1)

## Why
We need to lock in an eval harness before scaling our internal evals.
Six contenders shortlisted; this report compares.

## Findings
... (synthesis) ...

## Recommended changes
- [ ] Spike on inspect_ai as our default harness — small, dev domain

## Notes
- Open question: how does Promptfoo handle multi-turn evals natively?
```

## Related

- [[archetype-change]] — the downstream that consumes `recommended_changes`
- [[archetype-project]] — the upstream container (a research-report MUST live under a project)
- [[archetype-decision]] — capture significant choices that emerge from a report
- [[standard-change-workflow]] — the review-gate pattern this archetype mirrors
