---
id: walkthrough-add-research-report
type: reference
domain: meta
created: 2026-06-01T20:30:00Z
updated: 2026-06-01T20:30:00Z
tags: [walkthrough, tutorial, research, report]
source: vault/wiki/development/change/guide-walkthroughs-section.md
private: false
title: "Walkthrough — add a research report"
url: internal://walkthrough/add-research-report
kind: walkthrough
last_verified: 2026-06-01
---

# Walkthrough — add a research report

A **research-report** is the formal spec output of a structured investigation. Use it when the right answer isn't obvious and you want a code-grounded, reviewed plan before scaffolding changes. The output is a markdown entry with strategic prose + a `recommended_changes[]` array that fans out into actual change entries on approval.

## Goal

After this walkthrough you have:

- A reviewed, approved research-report at `vault/wiki/research/research-report/<project>-<topic>.md`
- One or more scaffolded change entries (one per recommendation) that downstream skills can write/execute
- An audit trail (draft → review → revise → approve) of how the spec was vetted

## Prerequisites

- A project to attach the research to ([[walkthrough-add-project]])
- The investigation question is sharp enough to articulate in a sentence

## Steps (UI)

### 1. Dispatch research-write

- **Overview Quick Actions** row → click **`+ Research`**, or
- **Project page → Research tab** → `+ Add research report` (or use the project's `/os` form)

Fill in:

- **`project`** _(required)_ — the project this report attaches to
- **`report_topic`** _(required)_ — a short slug like `q3-features` or `caching-strategy`. Together with `project` this forms the report id.
- **`materials`** _(optional)_ — URLs, file paths, wikilinks the writer should consult. Drag-drop a file into the Add-report modal's materials zone to seed `vault/raw/project-research/<project>/<topic>/`.

Submit. The skill runs as a subprocess; you'll see it in the Runs view. Cost ≈ $2–8 depending on materials volume and code-walk depth.

### 2. Review the draft

When the writer finishes, the report's `review_status: pending`. The project's Research tab + Plan lifecycle stepper surface a "Review" affordance.

- **Project page → Research tab** → click the report card → **`Review`** button
- Or dispatch `research-review` from the Overview

The reviewer reads the draft + the project's open questions, then writes a verdict markdown to `vault/output/research/<report>-review.md` and flips `review_status` to one of:

- `approve` — proceed to scaffold
- `request-changes` — surface specific concerns; revisor folds in
- `reject` — fundamental issue; abandon or restart

### 3. (If needed) Revise

If `request-changes`, dispatch `research-revise`. The skill reads the review verdict + any unconsidered notes from the report's `notes_log:`, writes a new revision, appends an `## Revision N` block to the body, and flips `review_status` back to `pending` for another pass.

Multiple revision rounds are normal — each preserves the prior body in the wiki via the Update blocks.

### 4. Approve

Once the reviewer's verdict is `approve` (either fresh or after revision):

- **Project page → Research tab** → report card → **`Mark approved`** button, or
- Use the UI escape hatch when you want to override a `request-changes` verdict (gated to that specific transition only)

`review_status` flips to `approved`. The Plan lifecycle stepper advances.

### 5. Scaffold the recommendations into changes

- **Project page → Plan tab** → **`Scaffold changes`** button, or
- Dispatch `research-scaffold-recommendations` directly with the report id

The skill fans `recommended_changes[]` out: one `dev-add-change` invocation per item, each new change carrying `derived_from_report: <report-id>` + `recommendation_index: <N>` in its frontmatter. The audit trail stays traceable.

## Steps (CLI)

```bash
# 1. Write the draft
/os research write acme-roadmap q3-features

# 2. Review it
/os research review acme-roadmap-q3-features

# 3. (If review verdict is request-changes)
/os research revise acme-roadmap-q3-features
/os research review acme-roadmap-q3-features   # re-review

# 4. Approve (UI button or)
/os research mark-approved acme-roadmap-q3-features

# 5. Scaffold
/os research scaffold-recommendations acme-roadmap-q3-features
```

## What gets created

```
vault/raw/project-research/<project>/<topic>/          ← materials directory (any files you dropped)
vault/wiki/research/research-report/<project>-<topic>.md
vault/output/research/<report>-review.md               ← review verdict (one per pass)
vault/wiki/<domain>/change/<recommended-slug>.md       ← one per recommendation (after step 5)
```

Each scaffolded change starts with `status: planning`, an auto-drafted body (with **DRAFT** markers the user accepts before `dev-write-change` runs), and a backlink to the source report.

## Mid-lifecycle inputs

The research lifecycle accepts three input channels:

1. **Materials** dropped into the per-report directory before dispatch
2. **Notes log** — Project Research tab → report card → `+ Add research note`. Each note has severity (`info` / `warn` / `blocker`) and a hybrid-persistent `considered_by` chain so skills can track which guidance they've folded in
3. **Mark approved** — UI escape hatch to override the reviewer's verdict (gated to `request-changes → approved` only)

## What to do next

- **Accept the scaffolded change bodies** — the audit's `change-body-template-placeholder` finding surfaces unreviewed DRAFT markers. Either edit the body (recommended) or click the action item's **`Accept`** button to strip the markers.
- **Run the change lifecycle** — see [[walkthrough-write-change]] for the full plan → review → execute → open-pr → pr-review → merge flow.
- **Enable project automation** — once you trust the scaffolded changes, the orchestrator can drive them end-to-end (see README § Process Automation).

## Gotchas

- **`research-write` is the canonical scaffolder.** The deprecated `meta-research-project` alias forwards to it; some legacy callers still name it by string. New invocations should use `research-write`.
- **Review verdict is reviewer-authored, not auto-generated.** The reviewer reads the draft + project context and writes a structured markdown verdict. Cost ≈ $1–3 per pass.
- **Approving overrides reviewer caution.** The "Mark approved" escape hatch flips `review_status: request-changes → approved` without addressing the reviewer's concerns. Use deliberately; the audit trail records who did it and when.
- **Materials are read-once.** The writer walks materials on first dispatch. To incorporate new materials post-draft, use `research-update` (not `research-write`) — it appends an `## Update N` block + may reset review_status.

## See also

- [[archetype-research-report]] — full archetype reference
- [[walkthrough-add-project]] — set up the parent project first
- [[walkthrough-write-change]] — execute the scaffolded changes

The decision-rationale for research-reports replacing the old project-plan flow lives in `decision-research-report-vs-project-plan` (per-install — not shipped in `_seed/`).
