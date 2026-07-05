---
name: research-scaffold-recommendations
description: 'Materialize approved research-report recommendations into change entries. Per-item orchestrator: derives a slug, dispatches dev-add-change, persists the derived_from_report audit-trail field on the new change, then writes back to the report (recommended_changes[i].id + status: scaffolded). Mirrors meta-scaffold-project-plan but operates on research-reports instead of project plans.'
user-invocable: true
version: 1
domain: research
tags: [research, scaffold, orchestration, recommendations]
inputs:
  report:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Research-report id (slug). Must match an existing `type: research-report` entry.'
  indices:
    type: array
    required: true
    description: 'Explicit array of non-negative integer indices into the report`s `recommended_changes` array. Empty array is an idempotent stop (no mutation). Out-of-range indices cause a hard reject before any dispatch begins.'
outputs:
  - kind: file
    path: vault/wiki/{{project.domain}}/change/<derived-slug>.md
    description: 'One change entry per scaffolded recommendation (created by dev-add-change). Each carries derived_from_report + recommendation_index + recommendation_revision_at_scaffold extra frontmatter.'
  - kind: frontmatter
    path: vault/wiki/research/research-report/{{input.report}}.md
    fields: [recommended_changes, updated]
spawns: [dev-add-change]
---

# research-scaffold-recommendations

## Purpose

Bridge research-domain output into the development domain: take a curated subset of a research-report's `recommended_changes`, materialize each as a `change` entry via `dev-add-change`, and write back to the report so the recommendations carry their scaffolded change ids.

The skill is the **orchestrator** for what was originally drafted as endpoint-side per-item work in `routes/research.ts`'s `POST /:id/scaffold-recommendations`. The endpoint is a thin dispatcher (`startRun` is fire-and-forget; per-item synchronous orchestration belongs in a skill where nested skill invocations are the standard pattern). This skill is the analog of `meta-scaffold-project-plan` for the research surface: same per-item-loop shape, same partial-failure semantics, same post-dispatch surgical frontmatter writeback.

The skill is **gated on the report's `review_status: approved` (or `overridden` / `not-required`)** — same hard gate as `meta-scaffold-project-plan` Step 1.5. Any other state is rejected: the review verdict is load-bearing because scaffolding creates real change entries that downstream skills will pick up, and uncritically materializing an unreviewed report defeats the review loop. [[meta-mark-research-approved]] is the explicit override when the reviewer's verdict conflicts with the user's judgment.

Per-item opt-in is the convention: `inputs.indices` is an explicit array of indices into `recommended_changes`. The endpoint resolves the default (all items with `status: proposed`) before dispatch.

## Procedure

### Step 1: Validate

1. Validate `inputs.report` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the report entry at `vault/wiki/research/research-report/<report>.md`. Reject with `report "<id>" not found` if missing or `type != research-report`.
3. Parse the report's frontmatter via js-yaml (so `recommended_changes` deserializes as real objects rather than the inline-JSON string).
4. **Review gate.** Verify the report's `review_status` is `approved` or `overridden` (or `not-required`, for reports with the review gate switched off — shared review-state enum per `lifecycle-state.ts`). Reject any other state with: `cannot scaffold — review_status is <state>, expected approved`. Escape hatch when the reviewer's verdict conflicts with the user's judgment: [[meta-mark-research-approved]] flips `request-changes → approved`. Mirrors `meta-scaffold-project-plan` SKILL.md Step 1.5.
5. Verify `inputs.indices` is an array of non-negative integers. Reject if any entry is not an integer or is negative.
6. Verify every index is in-range (`0 <= i < recommended_changes.length`). Hard reject the whole call up-front with the list of bad indices if any are out-of-range — partial scaffolds are confusing; fail fast.
7. If `inputs.indices` is an empty array: idempotent stop. Print `↻ No indices selected — nothing to scaffold.` Do NOT mutate any frontmatter. Done.

### Step 2: Resolve the owning project + repo

1. Read the report's `project` field. Reject if absent.
2. Locate the project entry at `vault/wiki/*/project/<project>.md`. Reject with `project "<id>" not found` if missing or `type != project`.
3. Extract `project.domain` (the project's owning domain — usually `development`).
4. Extract `project.repos[0]` (mirrors `meta-scaffold-project-plan` SKILL.md line 94 fallback policy: `repos[0]` for v1; per-step `repo:` overrides come later). Reject with `project "<id>" has no repos[0] — cannot scaffold changes without a repo` if the project has no repos.

### Step 3: Sort indices into canonical dispatch order

Sort `inputs.indices` ascending. Capture both the original input order AND the sorted dispatch order so the audit event in Step 6 records both honestly.

### Step 4: Per-item loop

For each index `i` in sorted order, capture an outcome `{ index, change_id?, outcome: 'ok' | 'skipped' | 'failed', reason? }`:

1. **Skip-and-continue when already scaffolded.** Re-read the row at `recommended_changes[i]` (the report frontmatter may have been mutated by a prior partial-success run). If `row.status !== 'proposed'`, record the outcome as `skipped` with reason `already scaffolded (status: <row.status>)`. Carry the existing `row.id` through into the outcome. Do NOT re-dispatch dev-add-change. Continue to the next index.

   Rationale: a user clicking "scaffold all" on a partially-scaffolded report should make forward progress on the still-`proposed` rows, not see the entire call abort because one row was already done. Mirrors `meta-scaffold-project-plan`'s partial-failure semantics at SKILL.md lines 129–154.

2. **Derive `name`.** Slugify the row's `summary`: lowercase, replace non-`[a-z0-9]` runs with `-`, trim leading/trailing hyphens. If longer than 60 chars, truncate at the last `-` at or before position 60 (word boundary) — drops the trailing partial word rather than chopping mid-word. If no hyphen exists at/before 60 (single long word), fall back to a hard cap at 60. If the resulting slug is empty (e.g. summary was all punctuation), use `recommendation-<i>` as the base slug. Same shape as `routes/projects.ts:964-969` but word-aware.

3. **Suffix-on-collision.** Check `vault/wiki/<project.domain>/change/<name>.md`. If exists, try `<name>-1`, `<name>-2`, … up to 50 attempts. If the cap is hit, record the outcome as `failed` with reason `failed to generate non-colliding slug after 50 attempts` and skip to Step 5 (partial-failure handling). Mirrors `routes/projects.ts:972-981`.

4. **Dispatch `dev-add-change`.** Inputs:
   - `name`: the derived non-colliding slug
   - `title`: `row.summary` verbatim. **Do NOT truncate.** Research summaries are 1-2 sentences that capture the actual intent of the change (e.g. "WebSocket head subscription via eth_subscribe with reconnect + fallback to polling"); truncating with `…` produces useless clipped headings everywhere the title surfaces (Changes list, PR card, Project Pulse, status reports). The slug is derived separately in step 2 with the kebab+length cap — the slug carries the URL/branch/filename constraint, the title is free-form prose. Past behavior capped at 80 chars; that was the cause of Task #393. (If a summary is genuinely too long for downstream display, the rendering surface should clip — e.g. with CSS `text-overflow: ellipsis` — not the source data.)
   - `domain`: `project.domain`
   - `repo`: `project.repos[0]`
   - `type`: `row.type` if present, else `feat` (recommendations almost always describe new functionality)
   - `size`: `row.size` if one of `small | medium | large`, else `medium`
   - `description`: `row.summary` + ` — derived from research-report [[<report-id>]]`
   - `project`: `report.project` (composes the new change into the report's owning project)

   Note: `derived_from_report` is NOT passed as an input — it is not in `dev-add-change.inputs` (verified against `.claude/skills/dev-add-change/SKILL.md` lines 8–61). It is persisted via a post-create surgical edit (next step).

   If `dev-add-change` fails (e.g. it raises on a name collision the suffix loop didn't catch, or repo entity is missing): record the outcome as `failed` with the sub-skill's error message, skip to Step 5.

5. **Surgical post-create edit on the new change entry.** Use the Edit tool against the file `dev-add-change` just created (`vault/wiki/<project.domain>/change/<derived-slug>.md`). Add three EXTRA frontmatter fields immediately before the closing `---`:
   - `derived_from_report: <report-id>`
   - `recommendation_index: <i>`
   - `recommendation_revision_at_scaffold: <report.report_revision || 1>`

   Pattern mirrors `meta-scaffold-project-plan` SKILL.md lines 99–102 (`derived_from_plan` / `plan_step` / `plan_revision_at_scaffold`).

   **Additionally, when `i > 0`, set a `parent_change` field** for ordering enforcement. Read `recommended_changes[i-1].id` from the report frontmatter (re-read post any prior writeback in this run so the value reflects the just-flipped sibling, not the stale snapshot). If that previous row has an `id` set (either from a prior run's scaffold or this run's earlier iteration), add `parent_change: <prev-id>` to the new change's frontmatter. If the previous row has no `id` yet (still `status: proposed`, never scaffolded), omit `parent_change` — a missing chain link is honest, false attribution to a non-existent id is not. Without this chain, scaffolded changes are flat (no order signal), which risks parallel Write-plan dispatches conflicting; this mirrors the manual `parent_change` wiring done for `research-domain` and `project-orchestration`.

6. **Writeback to the report.** Surgically edit `recommended_changes[i]` to set `.id` to the new slug and flip `.status: proposed → scaffolded`. Re-emit the whole `recommended_changes` line as a single-line JSON array per [[archetype-research-report]] § Frontmatter caveats — DO NOT round-trip through js-yaml's `dump()` (would lose ordering, comments, inline-JSON form).

   Use the surgical `replaceField` regex pattern: read the report file, regex `^recommended_changes:[^\n]*$`, replace with the new single-line JSON. Same anchored-regex shape as `routes/projects.ts:1747-1752`.

   Bump `updated:` on the report via the same `replaceField` to ISO 8601 UTC now.

7. **Record per-item audit event:**

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action research-scaffold-recommendation-item \
     --skill research-scaffold-recommendations \
     --args '{"report":"<report>","change":"<derived-slug>","recommendation_index":<i>,"outcome":"ok"}' \
     --files-touched '["<new change path>","<report path>"]'
   ```

   **Use args keys `report` and `change` (not `report_id` / `change_id`)** — `record-dashboard-action.mjs` extracts the top-level attribution columns from `parsedArgs.report` and `parsedArgs.change` (see lines 106–109 of the script). Wrong keys leave the event with `report_id: null` / `change_id: null` and the Replay tab skips it. The inner `recommendation_index` + `outcome` keys are detail-only (preserved in the args blob but not attribution).

   On `skipped` or `failed`: the same event runs with the appropriate `outcome` and a `reason` field, plus the empty `change` when `failed`.

8. Record the outcome `{ index: i, change_id: <derived-slug>, outcome: 'ok' }` and continue.

### Step 5: Partial-failure semantics

If ANY iteration in Step 4 fails (records outcome `failed`):

1. **Stop dispatch immediately.** No further items processed in this run.
2. **Do NOT auto-rollback** the already-succeeded items — leaving them on disk is correct (the user can decide whether to keep, delete, or re-dispatch).
3. **Do NOT mutate** the report's top-level `status` — leave it as-is (`recommended_changes[].status` flips are the source of truth on what was scaffolded; the report-level `status` is governed by `research-write` / `research-update` and not by this skill).
4. Surface a per-item outcome block in the print summary, listing EVERY entry in the canonical dispatch order:

   ```
   ✓ idx-0       → dev-add-change ok        (created vault/wiki/development/change/<slug>.md)
   · idx-1       → skipped (already scaffolded as <slug>)
   ✗ idx-2       → dev-add-change FAILED   (<reason from sub-skill>)
   · idx-3       → skipped (prior failure)
   ```

5. Print the explicit retry hint:

   ```
   next: retry with /os scaffold-research-recommendations <report> --indices=<comma-list> after fixing the failure cause.
         Drop the ✓ and · idx-N entries from the list — re-dispatching against an
         already-scaffolded recommendation will just re-skip (idempotent) but adds noise.
   ```

6. Record the final audit event with `--exit-status` set to a non-zero value so the dashboard's Insights view surfaces the partial-success state.

### Step 6: Success path — full summary

When ALL selected items dispatched successfully (or were idempotently skipped):

1. Print summary:

   ```
   ✓ Scaffolded recommendations for <report.title>
     report:             <report-id>
     project:            <project-id>
     report revision:    <N>
     items scaffolded:   <count of ok>
     items skipped:      <count of skipped>
     input order:        [<inputs.indices, verbatim>]
     dispatch order:     [<canonical sorted order>]

     <per-item outcome block, all ✓ or ·>

     next: /os write-change <first-scaffolded-change-slug>   (begin executing the first scaffolded change)
   ```

### Step 7: Final audit event

Record one event listing every per-item outcome (so a partial-failure run is still auditable from a single event):

```bash
node scripts/record-dashboard-action.mjs \
  --action research-scaffold-recommendations \
  --skill research-scaffold-recommendations \
  --args '{"report":"<id>","input_order":[...],"dispatch_order":[...],"items":[{"index":0,"change_id":"<slug>","outcome":"ok"},...]}' \
  --files-touched '[<every file created or edited, as JSON array>]'
```

The top-level `report` key feeds `record-dashboard-action.mjs`'s attribution extractor (same convention as Step 4.7). Items array uses inner `change_id`/`outcome` keys for detail (not attribution — already preserved in the args blob). When the run was a partial-failure (Step 5), `--exit-status` is set to a non-zero value.

## Outputs

- One change entry per scaffolded `recommended_changes[i]` (created by `dev-add-change`, with `derived_from_report` + `recommendation_index` + `recommendation_revision_at_scaffold` extra frontmatter fields)
- Report frontmatter `recommended_changes[i].id` set + `.status` flipped to `scaffolded` for each successful index
- Report frontmatter `updated` bumped on each successful write
- Per-item audit event + one final summary audit event

## Errors

- `inputs.report` slug invalid → reject with the regex
- Report not found / not `type: research-report` → reject with id
- `review_status` not `approved` / `overridden` / `not-required` → reject with `cannot scaffold — review_status is <state>, expected approved` (override via [[meta-mark-research-approved]])
- Report has no `project` → reject (a research-report must own a project per archetype)
- Project not found / no `repos[0]` → reject
- Any index out of range → hard reject before any dispatch begins (lists bad indices)
- Empty `inputs.indices` → idempotent stop (no error)
- Sub-dispatch failure mid-loop → partial-failure path per Step 5 (stops immediately, leaves succeeded items on disk)
- Slug-collision cap exhausted on a single item → partial-failure per Step 5 with reason

## See also

- [[archetype-research-report]] — the archetype that owns `recommended_changes` + its frontmatter caveats
- [[meta-scaffold-project-plan]] — the parallel orchestrator for project plans (this skill mirrors its structure)
- [[dev-add-change]] — the sub-scaffolder dispatched per item
- [[research-write]] — produces the report this skill materializes
- [[research-review]] — produces the `review_status: approved` verdict Step 1's review gate requires before anything is scaffolded
- [[research-update]] — may append new proposals to `recommended_changes` that this skill can scaffold in a follow-up call
