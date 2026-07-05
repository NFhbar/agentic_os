---
name: research-revise
description: 'Revises an existing research-report to address findings from research-review. Reads review_path + current report body + re-walks materials, rewrites the report in place, bumps report_revision. Preserves review_status — the original verdict still describes the prior revision.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: research
tags: [research, revise, review, lifecycle, report]
inputs:
  report_id:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Research-report id (slug). Must match an existing entry of `type: research-report` with both `review_path` set + the review file present on disk.'
outputs:
  - kind: file
    path: vault/wiki/research/research-report/{{input.report_id}}.md
  - kind: frontmatter
    path: vault/wiki/research/research-report/{{input.report_id}}.md
    fields: [report_revision, report_revised_at, report_revised_from_review, report_generated_at, updated]
spawns: []
model: claude-fable-5
---

# research-revise

## Purpose

Fold the findings from a [[research-review]] verdict back into a research-report, so the next review pass sees a report that already addresses the reviewer's concerns and suggested changes.

This is the research-domain analog of [[dev-revise-plan]] (one altitude up: report instead of change plan) and [[meta-revise-project-plan]] (one altitude down: report instead of project plan). Same revise contract: rewrite in place, bump the revision counter, preserve the prior verdict on disk.

**The verdict from the prior review is preserved on disk** — this skill does NOT touch `review_path`, `reviewed_at`, or `review_status`. Those describe the PRIOR report revision's review; the audit trail across revisions is the point. If the user wants a fresh verdict against the revised report, they re-run [[research-review]] — which is the standard followup (`research-revise` does not auto-trigger it).

## Procedure

### Step 1: Validate

1. Validate `inputs.report_id` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the report entry at `vault/wiki/research/research-report/<report_id>.md`. Reject with `report "<id>" not found` if missing or `type != research-report`.
3. Extract: `title`, `project`, `status`, `materials_path`, `report_revision` (default `1`), `review_path`, `recommended_changes`.
4. Verify `review_path` is set AND the file exists at that path. Reject with `no review findings to apply — run /os research review <id> first` if not.
5. Locate the owning project at `vault/wiki/*/project/<project>.md`. Read its body for context (the `## Why`, `## Approach`). Warn but don't reject if missing.

### Step 2: Read inputs

1. Read the report file at `vault/wiki/research/research-report/<report_id>.md` in full. Capture every section verbatim:
   - The frontmatter (every field — preserve unchanged ones)
   - `# <title>`
   - `> User intent:` blockquote (if present — preserve)
   - `## Why`
   - `## Findings` (with subsections)
   - `## Recommended changes`
   - `## Notes`
   - Any prior `## Revision N notes` sections
   - Any `## Update N` sections (carry-forward verbatim — `research-update` owns those)
2. Read the review file at `review_path` in full. Parse:
   - **Verdict** from the header (`approve` | `request-changes` | `reject`)
   - **Concerns section** — `blocker` / `concern` / `nit` items, each with description + suggested resolution
   - **Suggested changes section** — numbered list of concrete revisions (only present on `request-changes` verdicts)
3. Read `notes_log` from the report frontmatter (parsed as JSON array). Build a list of unconsidered notes (entries where `considered_by` is empty). These are user-added mid-lifecycle guidance you MUST fold into the revision alongside the review's concerns/suggestions. Treat severity as weight: `info` = take into account; `warn` = strongly consider; `blocker` = must address (or document in `## Revision N notes` why the revision can't, and what would unblock).

### Step 3: Refusal gate — nothing to revise

If the review has ZERO items in BOTH `## Concerns` AND `## Suggested changes`, refuse:

```
✗ Nothing to revise — the review has no concerns or suggested changes.

review:    <review_path>
verdict:   <verdict>

If you wanted to regenerate the report against fresh context, use:
  /os research update <report_id>   (delta-driven rewrite when new materials land)

Or delete the existing report and re-author from scratch via:
  /os research write <project> <report_topic>
```

Then stop.

### Step 4: Re-read context (materials + project)

The revised report stays grounded in the same context the original write ingested. Re-read what's available:

1. Re-walk `materials_path` using the same FIFO-by-mtime + chunked-PDF pattern as [[research-write]] Step 2. **No `material_limit` cap applied** — the revise pass reads what's on disk now, mirroring the [[meta-revise-project-plan]] Step 4 + [[research-review]] Step 4 precedent. The cap is a `research-write`-time concept only.
2. If the per-report directory is empty AND `vault/raw/project-research/<project>/` (project-level fallback) contains files, walk there instead.
3. Read the project entry body for current narrative.
4. If `materials_path` is unset or unreadable, warn and proceed with the report body + review on their own — don't hard-fail.

### Step 5: Compose the revised report

Produce a NEW report body that:

1. Keeps the SAME body structure as [[archetype-research-report]] § Body sections:
   - `# <title>` (preserve)
   - `> User intent:` blockquote (preserve if present)
   - `## Why`
   - `## Findings` (with subsections)
   - `## Recommended changes`
   - `## Notes`
   - `## Revision <N+1> notes` (NEW — added at the end of the original body, before any carry-forward `## Revision K notes` or `## Update N` sections)
   - Prior `## Revision K notes` sections carried forward verbatim, chronological order (oldest first)
   - Prior `## Update N` sections carried forward verbatim
2. Addresses every Concerns item (blockers + concerns + nits) by either:
   - Incorporating the suggested resolution into the relevant section, OR
   - Explicitly noting in `## Revision <N+1> notes` why the finding does not apply (e.g. `nit acknowledged — kept as-is because <reason>`). Don't silently drop findings; the audit trail is the point.
3. Addresses every Suggested-changes item the same way — incorporated or explicitly justified.
4. Updates `## Recommended changes` body bullets to mirror any frontmatter `recommended_changes` array changes the revision makes (the body-vs-frontmatter mirror is a [[research-review]] checklist item — drift is a concern surface).
5. Composes the `## Revision <N+1> notes` section in this form:

   ```markdown
   ## Revision <N+1> notes

   This revision folds the findings from `<review_path>` (verdict: <verdict>, reviewed <reviewed_at>) back into the report. Every concern, nit, and suggested change is addressed below — incorporated into the relevant section or explicitly justified.

   - [from review rev <prior_N>] **<severity> — <one-line summary>** — <how this revision addresses it; cite the section name(s) edited>
   - ... (one bullet per finding)
   ```

### Step 6: Compose the revised frontmatter

Preserve every field EXCEPT the ones explicitly mutated in Step 7. The single-line JSON encoding of `recommended_changes` and `dismissed_triggers` MUST be preserved (multi-line YAML breaks the parser per [[archetype-research-report]] § Frontmatter caveats). If the revision changes `recommended_changes` (added, dropped, or re-sized entries), re-emit the array as single-line JSON.

### Step 7: Write the report file

1. Overwrite `vault/wiki/research/research-report/<report_id>.md` with the revised content. Same filename — the in-body `## Revision N notes` sections + audit log carry per-revision history.
2. Update the frontmatter via the Edit tool:
   - `report_revision: <N+1>` (where N is the prior value, defaulting to 1 if unset; first revision becomes 2)
   - `report_revised_at: <ISO 8601 UTC now>`
   - `report_revised_from_review: <review_path>`
   - `report_generated_at: <ISO 8601 UTC now>` (semantically "most recent report write")
   - `updated: <ISO 8601 UTC now>`
   - For each unconsidered note from Step 2.3 that you folded into the revision, append a `considered_by` entry: `{ skill: "research-revise", ts: "<ISO 8601 UTC now>" }`. Notes you couldn't address (out of scope for this revision pass) get an entry too with the explanation captured in `## Revision N notes`. Surgical `replaceField` on the `notes_log` line — single-line JSON, same pattern as `recommended_changes`. Per [[archetype-research-report]] § `notes_log` item shape, append; never mutate existing fields.
   - **DO NOT touch** `review_path`, `reviewed_at`, `review_status`, or `status`. The prior verdict still describes the prior report revision; that information stays load-bearing. If the user wants a fresh verdict, they re-run [[research-review]] (which IS the standard followup).

### Step 8: Audit log

```bash
node scripts/record-dashboard-action.mjs \
  --action research-revise \
  --skill research-revise \
  --args '{"report_id":"<id>","report_revision":<N+1>,"findings_addressed":<count>}' \
  --files-touched '["vault/wiki/research/research-report/<report_id>.md"]'
```

### Step 9: Print summary

```
✓ Revised research-report for <title>
  report:             <report_id>
  revision:           <N+1>
  findings addressed: <count>   (blockers: <B>, concerns: <C>, nits: <Nt>)
  path:               vault/wiki/research/research-report/<report_id>.md
  review_status:      <preserved — still <prior verdict> from rev <prior_N>>
  next:               /os research review <report_id>   (verify the revised report clears concerns)
```

## Outputs

- Revised report markdown at `vault/wiki/research/research-report/<report_id>.md` (overwrites; history preserved via in-body `## Revision N notes` sections)
- Report entry frontmatter: `report_revision` bumped; `report_revised_at`, `report_revised_from_review`, `report_generated_at`, `updated` set. `review_path`, `reviewed_at`, `review_status`, `status` UNCHANGED.
- Audit log line

## Errors

- `inputs.report_id` slug invalid → reject with the regex
- Report not found / not `type: research-report` → reject with id
- `review_path` not set or file missing → instruct user to run `/os research review <id>` first
- Review has zero concerns AND zero suggested changes → refuse with the message in Step 3
- `materials_path` unreadable → warn and proceed with report body + review only

## What this skill must NOT do

- Edit any other report entry
- Mutate `review_path`, `reviewed_at`, `review_status`, `status` (those describe the prior review, not this revision)
- Mutate the owning project entry (the `research_paths` array stays — the report id didn't change)
- Touch `dismissed_triggers` (that's owned by [[research-update]])
- Auto-trigger [[research-review]] (the user re-runs review explicitly; this skill stops at the rewrite)

If you need different semantics (e.g. throw out the report and start fresh with new materials), use `/os research write <project> <report_topic>` after deleting the existing report — `research-revise` is a refinement, not a re-author.

## See also

- [[archetype-research-report]] — research-report archetype contract + review-gate fields + body sections
- [[research-write]] — produces the initial report this skill revises
- [[research-review]] — produces the review this skill consumes; the recommended followup after a successful revise
- [[research-update]] — delta-driven rewrite for new materials / milestones (orthogonal to revise — update reads materials, revise reads review findings)
- [[meta-revise-project-plan]] — project-tier analog; this skill mirrors its structure
- [[dev-revise-plan]] — change-tier analog; same revise-preserves-prior-verdict contract
