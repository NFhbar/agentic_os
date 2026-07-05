---
name: research-update
description: 'Delta-driven rewrite of a research-report when new materials land, a milestone fires, or a recommended change merges. Re-walks materials, rewrites the body, appends `## Update N`, mutates `recommended_changes` (preserves scaffolded/merged, abandons superseded, adds new proposals). May reset `review_status` when the update is substantive.'
user-invocable: true
recommended_effort: max
version: 1
domain: research
tags: [research, update, delta, lifecycle, report]
inputs:
  report_id:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Research-report id (slug). Must match an existing entry of `type: research-report`.'
  trigger_source:
    type: string
    required: false
    description: 'Optional enum: `manual` | `materials` | `milestone` | `change-merged`. Surfaced in the audit event and the `## Update N` block''s `### Why this update` sub-section so the audit trail records what kicked the update. Defaults to `manual` when unset.'
  notes:
    type: string
    required: false
    description: 'Free-form additional context — e.g. why the update is happening, what specifically prompted it. Surfaced verbatim in the `## Update N` block''s `### Why this update` sub-section.'
outputs:
  - kind: file
    path: vault/wiki/research/research-report/{{input.report_id}}.md
  - kind: frontmatter
    path: vault/wiki/research/research-report/{{input.report_id}}.md
    fields: [update_count, last_data_ingest, status, review_status, review_path, reviewed_at, recommended_changes, updated]
spawns: []
model: claude-fable-5
effort: max
---

# research-update

## Purpose

Refresh an existing research-report against current reality: re-ingest the materials directory, rewrite the report body to reflect what's known now, and append a `## Update N` block that captures the delta. This is the most novel of the four research-domain skills — the one that closes the loop when reality moves under a previously-approved report.

Three triggers motivate an update (the dashboard surfaces these as banners per [[archetype-research-report]] § Update triggers):

1. **`materials`** — new files have landed under `materials_path` since `last_data_ingest`
2. **`milestone`** — the owning project hit a milestone that warrants a refresh
3. **`change-merged`** — one of `recommended_changes[].status` flipped to `merged`; the rest of the recommendations may reshape

Also callable as `manual` when the user just wants a refresh without a specific trigger.

**Updates produce proposals, never scaffolding.** This skill MUST NOT auto-dispatch [[research-scaffold-recommendations]] (or [[dev-add-change]], which it spawns per item). New recommendations are surfaced for human triage; scaffolding remains an explicit user action.

The update may **reset `review_status: pending`** when the rewrite is substantive (criteria in Step 5) — that signal lets the dashboard re-surface the review banner, and the user re-runs [[research-review]] explicitly.

## Procedure

### Step 1: Validate

1. Validate `inputs.report_id` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the report entry at `vault/wiki/research/research-report/<report_id>.md`. Reject with `report "<id>" not found` if missing or `type != research-report`.
3. Extract: `title`, `project`, `status`, `materials_path`, `last_data_ingest`, `update_count` (default `0`), `report_revision`, `review_status`, `review_path`, `reviewed_at`, `recommended_changes` (default empty array), `dismissed_triggers`.
4. Validate `inputs.trigger_source` if set is one of `manual`, `materials`, `milestone`, `change-merged`. Default to `manual` when unset.
5. Locate the owning project at `vault/wiki/*/project/<project>.md`. Read its body for context. Warn but don't reject if missing (a project rename may have orphaned the report; update can still proceed against the materials).

### Step 2: Read the report

1. Read the report file in full. Capture every section verbatim:
   - Frontmatter (preserved unless explicitly mutated)
   - `# <title>`
   - `> User intent:` blockquote (preserve)
   - `## Why`
   - `## Findings` (with subsections)
   - `## Recommended changes`
   - `## Notes`
   - Any prior `## Revision N notes` sections (carry-forward verbatim — `research-revise` owns those)
   - Any prior `## Update N` sections (carry-forward verbatim — preserves the delta trail)
2. Note the highest existing `## Update N` number (N = `update_count` per archetype invariant). The new block will be `## Update <update_count + 1>`.
3. Read `notes_log` from the frontmatter (parsed as JSON array). Build a list of unconsidered notes (entries where `considered_by` is empty). When folding new materials, weight unconsidered notes alongside the materials themselves — they're user-added context for THIS update pass. Severity: `info` = take into account; `warn` = strongly consider; `blocker` = must address (or document why the update can't, with what would unblock).

### Step 3: Detect new materials

1. If `materials_path` is unset (legacy or hand-authored report), default to `vault/raw/project-research/<project>/<report_id>/` and use that.
2. Walk `materials_path`. List `.md` / `.txt` / `.pdf` files with their mtimes.
3. Compare each file's mtime to `last_data_ingest`:
   - If mtime > `last_data_ingest` → **new material**, include in this update's ingestion set.
   - If mtime ≤ `last_data_ingest` → already-ingested, skip from the new set (but still resolvable as context if the rewrite needs it).
4. If `materials_path` is empty AND `vault/raw/project-research/<project>/` (project-level fallback) contains files, walk there as well — same mtime comparison.
5. Record the count of new materials. **No `material_limit` cap applied** — updates read what's on disk now, mirroring [[research-revise]] Step 4 + [[research-review]] Step 4 precedent.

### Step 4: Ingest new materials

1. For each new (non-PDF) material: Read in full.
2. For each new PDF: use the chunked-read pattern from [[research-write]] Step 2 (probe with `pages: "1"`, then `"1-20"`, `"21-40"`, `"41-50"`; stop on first error or empty range).
3. If `inputs.notes` is non-empty, treat it as additional context for the rewrite (carries the user's framing of WHY this update is happening).
4. If the trigger source is `change-merged`, fetch the merged change's entry (it should be linked via a `recommended_changes` entry whose `status` is `merged`) so the rewrite can reflect what shipped. Track which `recommended_changes` items now point to merged code.

### Step 5: Delta-driven rewrite

This is the heart of the skill. Rewrite the report body to reflect current state — **actual rewrite, not append-only**.

#### 5a. Rewrite `## Findings`

Rewrite `## Findings` (and its subsections) to incorporate the new materials and any merged-change context. Existing findings that remain accurate are preserved; findings that the new context contradicts or supersedes are rewritten with the corrected position. Don't preserve obsolete prose just for continuity — the `## Update N` block is where the delta trail lives.

#### 5b. Update `recommended_changes` (frontmatter + body mirror)

Apply these rules in order:

1. **Preserve** entries with `status: scaffolded` or `status: merged` — they describe work already in flight or shipped. Don't drop them.
2. **Flip `status: scaffolded → merged`** for entries whose linked change entry (`row.id`) has reached `status: merged` (keep the `id`). Step 4.4 already tracked these; this writeback is what makes the `merged` enum value reachable — the dashboard's `recommended-change-merged` trigger fires on exactly this condition (linked change merged, row still `scaffolded`), and the flip is what resolves it. Count the flips for the `## Update N` block's Preserved line and the audit args.
3. **Mark `status: abandoned`** for entries the new context supersedes. The `## Update N` block's `### What changed` sub-section must explain why (a sentence per abandoned entry is enough).
4. **Append new proposals** with `status: proposed` for recommendations the update introduces.
5. Re-emit `recommended_changes` as a single-line JSON array per [[archetype-research-report]] § Frontmatter caveats — multi-line YAML breaks the parser.
6. Update the body's `## Recommended changes` bullets to mirror the new frontmatter array (per the body-vs-frontmatter mirror [[research-review]] checks).

#### 5c. Append `## Update N` block

Append at the bottom of the body (after any prior `## Update K` sections, chronological order). Structure:

```markdown
## Update <update_count + 1>

**Triggered:** <ISO 8601 UTC now>
**Trigger source:** <inputs.trigger_source>
**New materials:** <count of new materials ingested>

### Why this update

<one paragraph: what kicked this update — derived from trigger_source + inputs.notes if present>

### What changed

- **Findings rewritten:** <true | false; if true, one-sentence summary of the substantive shift>
- **Recommendations updated:**
  - Preserved (scaffolded/merged): <N entries> — of which <G> flipped `scaffolded → merged` this update (linked change reached `status: merged`)
  - Abandoned (superseded): <list — one bullet per, with one-sentence reason>
  - Added (new proposals): <list — one bullet per, with one-sentence motivation>
- **Review-status reset decision:** <reset | preserved> — <reason; see §5d>
```

#### 5d. Review-status reset decision

Evaluate whether the update materially changed the report. **Reset `review_status: pending`** (and clear `reviewed_at` + `review_path`) when EITHER:

- (a) `recommended_changes.length` **grew** — ≥1 new proposal was appended this update, OR
- (b) The Findings section was rewritten **beyond cosmetic edits**. Examples that count as substantive: a new subsection added, a previously-stated conclusion contradicted, a finding's evidence base expanded by a new material. Examples that do NOT count: typo fixes, sentence-level rephrasing, formatting tweaks.

Otherwise (no new proposals AND Findings unchanged or cosmetic-only), **preserve** `review_status` and the related fields — the prior verdict still describes the still-current state.

Record the decision AND its trigger condition in the `## Update N` block's `### What changed` sub-section so the audit trail is explicit. This LLM-judgment seam (criterion b) is the false-negative risk surfaced in the change plan's §Risk — when in doubt, lean toward reset; extra reviews are cheap.

### Step 6: Compose the updated frontmatter

Mutate these fields:

- `update_count: <prior + 1>` (the new total — must equal the count of `## Update N` H2s in the body per archetype invariant)
- `last_data_ingest: <ISO 8601 UTC now>` (mtime baseline for the next update)
- `status: updated` (the post-approved status enum value per [[archetype-research-report]] § Status enum; if the report was still in `draft` or `request-changes`, leave it — updates against unreviewed reports are unusual but valid)
- `recommended_changes: <single-line JSON of the mutated array>`
- `updated: <ISO 8601 UTC now>`

Conditionally (per §5d's reset decision):

- If reset: `review_status: pending`, `review_path: null`, `reviewed_at: null`
- If preserved: leave `review_status`, `review_path`, `reviewed_at` unchanged

For each unconsidered note from Step 2.3 that you folded into the update, append a `considered_by` entry to its row: `{ skill: "research-update", ts: "<ISO 8601 UTC now>" }`. Notes you couldn't address get an entry too with the explanation captured in the new `## Update N` block. Surgical `replaceField` on the `notes_log` line — single-line JSON, same pattern as `recommended_changes`. Per [[archetype-research-report]] § `notes_log` item shape, append; never mutate existing fields.

Preserve every other field — `report_revision`, `report_revised_at`, `report_revised_from_review`, `report_generated_at`, `dismissed_triggers`, `materials_path`, `project`, `title`, `id`, `type`, `domain`, `tags`, `created`, `source`, `private`.

### Step 7: Write the report file

1. Overwrite `vault/wiki/research/research-report/<report_id>.md` with the rewritten content.
2. Update the frontmatter via the Edit tool with the Step 6 mutations.

### Step 8: Audit log

```bash
node scripts/record-dashboard-action.mjs \
  --action research-update \
  --skill research-update \
  --args '{"report_id":"<id>","update_n":<update_count + 1>,"trigger_source":"<source>","new_materials":<M>,"recommendations_added":<A>,"recommendations_abandoned":<X>,"recommendations_merged":<G>,"review_status_reset":<true|false>}' \
  --files-touched '["vault/wiki/research/research-report/<report_id>.md"]'
```

### Step 9: Print summary

```
↻ Updated research-report for <title>
  report:           <report_id>
  update:           N=<update_count + 1>
  trigger:          <inputs.trigger_source>
  new materials:    <M> ingested
  recommendations:  +<A> added, <X> abandoned, <P> preserved (scaffolded/merged)
  status:           updated
  review_status:    <reset to pending — re-run /os research review <id> | preserved — prior verdict still applies>
  next:             <re-run /os research review <id> if reset fired> | <consider scaffolding new proposals via /os scaffold research recommendations <report_id> if review status is approved>
```

The `next:` line surfaces the review re-run as a recommendation when the reset fired — but this skill MUST NOT auto-dispatch [[research-review]] (the soft signal stops at the summary line). Likewise, MUST NOT auto-dispatch [[research-scaffold-recommendations]] — new recommendations are proposals, not scaffolds.

## Outputs

- Rewritten report markdown at `vault/wiki/research/research-report/<report_id>.md` (overwrites; delta trail preserved via in-body `## Update N` sections)
- Report entry frontmatter: `update_count`, `last_data_ingest`, `status`, `recommended_changes`, `updated` mutated; conditionally `review_status`, `review_path`, `reviewed_at` reset per §5d.
- Audit log line

## Errors

- `inputs.report_id` slug invalid → reject with the regex
- Report not found / not `type: research-report` → reject with id
- `trigger_source` set to a value not in the allowed enum → reject with the bad value + the allowed set
- `materials_path` set but unreadable → reject (filesystem error — user must resolve before update can proceed)
- New-materials walk finds zero new files AND no other trigger context (manual run with no `notes`, no merged changes, no milestone signal) → soft-warn but proceed: an update can still rewrite Findings prose against existing materials. Don't refuse; the user knows what they invoked.

## What this skill must NOT do

- Auto-dispatch [[research-review]] (the reset is a signal; the user re-runs review explicitly)
- Auto-dispatch [[research-scaffold-recommendations]] (new recommendations are proposals; scaffolding stays user-driven)
- Mutate `report_revision` / `report_revised_at` / `report_revised_from_review` — those belong to [[research-revise]]
- Drop `recommended_changes` entries with `status: scaffolded` or `merged` — those describe work in flight or shipped, not the report's current proposals
- Touch `dismissed_triggers` — that's set by the dashboard banner when the user dismisses a trigger
- Modify the owning project entry's `research_paths` (the report id didn't change)

## See also

- [[archetype-research-report]] — research-report archetype contract + status enum + update triggers + body sections
- [[research-write]] — produces the initial report this skill updates
- [[research-review]] — the natural followup when an update resets `review_status: pending`
- [[research-revise]] — orthogonal sibling: revise reads review findings, update reads new materials / merged changes
- [[research-scaffold-recommendations]] — terminal phase; per-item consumer of `status: proposed` rows once `review_status` is `approved`; this skill produces new proposals that scaffolding picks up next time it runs
- [[dev-write-change]] — change-tier analog of the report lifecycle; no direct counterpart for update because changes are atomic (one PR, then close) while reports are durable (multiple updates over time)
