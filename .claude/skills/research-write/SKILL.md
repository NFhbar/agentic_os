---
name: research-write
description: 'Author a research-report entry under a project. Reads materials from the drop zone + wikilinks + URLs, composes a structured report, writes it to vault/wiki/research/research-report/. First phase of the research-domain lifecycle (graduated from meta-research-project).'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: research
tags: [research, write, lifecycle, report]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Owning project id (slug). Must match an existing entry of `type: project`. The report attaches to this project and is appended to the project entry`s `research_paths` array.'
  report_topic:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'
    description: 'Short slug-safe summary of the report`s focus (lowercase, alphanumerics + hyphens, 3–60 chars). The report id is composed as `<project>-<report_topic>`. Predictable so re-running with the same `<project, report_topic>` is idempotent (the existence check at step 1 detects a prior write and points at research-update).'
  notes:
    type: string
    required: false
    description: 'Free-form intent / additional context preserved verbatim. When non-empty, prefaces `## Why` as a `> User intent:` blockquote so the original phrasing isn`t lost behind the slug-safe `report_topic`. The deprecation alias `meta-research-project` uses this to preserve the dispatcher`s natural-language prompt while `report_topic` carries a derived slug.'
  materials:
    type: object
    required: false
    description: 'Optional shape `materials: { wikilinks: ["entry-id", ...], urls: ["https://...", ...] }`. The drop zone at `vault/raw/project-research/<project>/<report_id>/` (with project-level fallback) is always read; this object adds explicit references on top.'
  material_limit:
    type: integer
    required: false
    default: 10
    description: 'UNION cap across drop zone + wikilinks + URLs. Default 10. Truncation is never an error — the summary surfaces a `truncated:` line when the cap clips any source. (The cap applies only at `research-write` time; `research-review` and `research-revise` re-walk materials without a cap by design.)'
outputs:
  - kind: file
    path: vault/wiki/research/research-report/{{input.project}}-{{input.report_topic}}.md
  - kind: frontmatter
    path: vault/wiki/{{project.domain}}/project/{{input.project}}.md
    fields: [research_paths, updated]
spawns: []
model: claude-fable-5
---

# research-write

## Purpose

Compose a **research-report** entry — the durable, queryable artifact that captures one focused investigation under a project. Reads materials from the drop zone (with project-level fallback), wikilinks, and URLs; synthesizes them into findings and recommended changes; writes the result to `vault/wiki/research/research-report/<report_id>.md` and registers the path on the owning project entry.

This skill is the **entry phase** of the research-domain lifecycle. It mirrors [[dev-write-change]]'s PLAN phase and the original `meta-research-project` research phase — but produces a durable typed wiki entry (with its own review gate, update loop, and `recommended_changes` array) rather than a transient output markdown.

Graduated from `meta-research-project` during the research-domain refactor (per-install project tracking the graduation phases). The legacy skill is retained as a deprecation alias that derives `report_topic` from its free-form `prompt` and delegates here — callers that haven't migrated continue to work transparently.

Downstream: [[research-review]] gates the report; [[research-revise]] folds review findings back in; [[research-update]] rewrites the report when new materials land or milestones fire.

## Procedure

### Step 1: Validate inputs + idempotency check

1. Validate `inputs.project` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Validate `inputs.report_topic` matches `^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$`. Reject if not (callers must pass a value matching this regex — the dashboard’s research dispatcher derives the slug from the user intent before invoking).
3. Locate the project entry at `vault/wiki/*/project/<project>.md`. Reject with `project "<id>" not found` if missing or `type != project`. Capture its `domain` (the project's owning domain — usually `development`; used for the project-frontmatter writeback in step 9).
4. Compose `report_id = "<project>-<report_topic>"`. Target path: `vault/wiki/research/research-report/<report_id>.md`.
5. **Idempotency check.** If the target file already exists, reject:

   ```
   ↻ Report "<report_id>" already exists.

   path:  vault/wiki/research/research-report/<report_id>.md
   next:  /os research update <report_id>   (re-ingest new materials + delta-driven rewrite)
          /os research revise <report_id>   (apply review findings, if a review verdict is pending)
   ```

   Then stop.

### Step 2: Walk the drop zone (with project-level fallback)

1. Per-report drop zone path: `vault/raw/project-research/<project>/<report_id>/`. Create if missing (an empty walk is fine — the dir exists for next-time use).
2. List `.md` / `.txt` / `.pdf` files in the directory, sorted by mtime **ascending** (FIFO).
3. **Compatibility fallback.** If the per-report dir is empty AND `vault/raw/project-research/<project>/` (the parent project-level dir) contains files, read from the project-level dir instead — design doc § Compatibility / migration calls for this so legacy project-research dumps don't go silently unread. Record which layout was read in the materials summary (see step 6).
4. For each non-PDF: Read in full.
5. **PDF handling.** Same chunked-read pattern as the original `meta-research-project` implementation:
   1. Probe length with `pages: "1"`.
   2. Issue chunked reads: `pages: "1-20"`, `"21-40"`, `"41-50"` to cover up to the first 50 pages.
   3. Stop at the first range that errors or returns empty.

The cap from `inputs.material_limit` is a UNION cap enforced in step 5 below.

### Step 3: Resolve wikilinks

1. Parse `inputs.materials.wikilinks` (array of entry ids). Skip silently if absent.
2. For each id: locate via `vault/.index/manifest.json` if present, else scan `vault/wiki/*/*/<id>.md`.
3. Read each located entry in full. On miss: print a warning line, never error.

### Step 4: Fetch URLs

1. Parse `inputs.materials.urls` (array of strings). Skip silently if absent.
2. For each URL: invoke WebFetch asking for a 2–3 paragraph synthesis of the page's content (do not store the whole page).
3. On failure (timeout, 4xx, 5xx): print a warning line, never error.

### Step 5: Enforce material cap

1. Cap (`inputs.material_limit`, default `10`) applies as the UNION cap across all three sources.
2. Enforce in dispatch order: drop zone first (FIFO by mtime ascending), then wikilinks (declared order), then URLs (declared order).
3. Once the running material count hits `material_limit`, stop adding from the next source.
4. Record skipped counts per source — used in the step 11 summary.
5. Truncation is NEVER an error.

### Step 6: Compose the report

Compose with EXACTLY these sections, in this order. The body shape MUST match [[archetype-research-report]] § Body sections (audit checks the `## Update N` H2 count vs `update_count` in phase E).

```markdown
# <title>

<!-- if `notes` input is non-empty: -->
> User intent: <inputs.notes verbatim>

## Why

One paragraph: the question this report investigates and why it matters. Anchor in the project's `## Why` + the research materials' framing.

## Findings

The structured synthesis of the materials. Subsections as needed — `### <subtopic>` H3s are encouraged when the synthesis covers multiple distinct threads.

## Recommended changes

- [ ] <one-line summary> — <domain>, <size>
- [ ] ...
- (or "(none — investigative report; no actions recommended)")

Each bullet here MUST mirror an entry in the frontmatter's `recommended_changes` array — same `summary`, same `domain`, same `size`. The bullet text is what humans read; the frontmatter array is what `meta-scaffold-project-plan` consumes.

## Notes

Open questions, ambiguities, follow-up reading. (Empty section allowed; keep the H2 even when nothing to note — it's the anchor `research-update` looks for when appending `## Update N` blocks.)
```

**Title resolution.** Derive a short scannable title from `report_topic` + the report's framing (de-slugify, title-case, optionally extend with a parenthetical year/context when materials suggest a time window — e.g. `"LLM eval harness landscape (2026 H1)"`). The frontmatter `title` field MUST match the H1.

### Step 7: Build the frontmatter

Compose with EXACTLY these fields. **`recommended_changes` and `dismissed_triggers` MUST be emitted as single-line JSON arrays** — multi-line YAML arrays of objects are silently dropped by the parser (see [[archetype-research-report]] § Frontmatter caveats).

```yaml
---
id: <report_id>
type: research-report
domain: research
created: <ISO 8601 UTC now>
updated: <ISO 8601 UTC now>
tags: [<inferred from project + materials, lowercase-kebab>]
source: manual
private: false
title: <derived title>
project: <project>
status: draft
materials_path: vault/raw/project-research/<project>/<report_id>/
last_data_ingest: <ISO 8601 UTC now>
report_generated_at: <ISO 8601 UTC now>
report_revision: 1
update_count: 0
review_required: true
review_status: pending
recommended_changes: [{"summary":"…","domain":"development","size":"small","status":"proposed"}, …]
dismissed_triggers: []
---
```

Defaults:

- `recommended_changes: []` when the report is purely investigative (no actions proposed).
- Each item's `status: proposed` on first write — `meta-scaffold-project-plan` flips to `scaffolded` once it creates the change; downstream skills flip to `merged` / `abandoned`.
- `id: null` per-item until scaffold runs.

### Step 8: Write the report file

1. Target path: `vault/wiki/research/research-report/<report_id>.md`. Create `vault/wiki/research/research-report/` if missing (research-write is the skill that brings this directory into existence on first run).
2. Write the file. The `rebuild-vault-index.mjs` hook will pick it up on next vault-touching operation.

### Step 9: Append to the owning project's `research_paths`

The project entry is the index for its reports — the dashboard renders the list without re-scanning the filesystem.

1. Read the project entry at `vault/wiki/<project.domain>/project/<project>.md`.
2. If `research_paths` is unset, treat as empty array.
3. Compose `report_path = "vault/wiki/research/research-report/<report_id>.md"`.
4. If `report_path` is already present in `research_paths`, no-op (dedupe — keeps the array clean across re-runs that hit the idempotency check in some edge cases).
5. Otherwise, append `report_path` to `research_paths` (preserve existing order — newest at the end).
6. Edit the project frontmatter via the Edit tool:
   - `research_paths: <updated array, single-line JSON per the same nested-YAML caveat as recommended_changes>`
   - `updated: <ISO 8601 UTC now>`

**Failure mode.** If the project entry doesn't exist (the step 1 validation should catch this — but the read in step 9.1 is the canonical failure point), surface the error and DO NOT leave a dangling report on disk: delete the file written in step 8 before returning. The idempotency check + the project-entry validation together make the "write report but fail to register" window vanishingly small.

### Step 10: Audit log

```bash
node scripts/record-dashboard-action.mjs \
  --action research-write \
  --skill research-write \
  --args '{"project":"<id>","report_id":"<report_id>","report_topic":"<report_topic>","materials_count":<M>,"recommended_changes_count":<K>}' \
  --files-touched '["vault/wiki/research/research-report/<report_id>.md","vault/wiki/<project.domain>/project/<project>.md"]'
```

### Step 11: Print summary

```
✓ Wrote research-report for <title>
  project:       <project>
  report:        vault/wiki/research/research-report/<report_id>.md
  status:        draft (review_status: pending)
  materials:     <M> read   (drop zone: <a>, wikilinks: <b>, urls: <c>)
  layout:        per-report | project-level-fallback
  truncated:     <N> additional materials skipped   (omit line when N == 0)
  recommended:   <K> change(s) proposed
  next:          /os research review <report_id>   (run research-review to gate downstream consumption)
```

## Outputs

- Report markdown at `vault/wiki/research/research-report/<report_id>.md` (refuses on existing — use research-update instead)
- Project entry frontmatter: `research_paths` appended (deduped), `updated` bumped
- Audit log line

## Errors

- `inputs.project` slug invalid → reject with the regex
- `inputs.report_topic` slug invalid → reject with the regex (dispatching callers derive the slug before invoking — the dashboard’s research dispatcher does this from the user intent)
- Project not found / not `type: project` → reject with id
- Target report file already exists → idempotent stop; instruct user to use `research-update` or `research-revise`
- Drop zone unreadable → reject (filesystem error; user must resolve)
- Material read errors → warn-and-continue, never abort (drop zone files, wikilinks, URLs all use the same skip-on-miss pattern)
- Project entry missing during step 9 → roll back the report file write; user must scaffold the project first

## See also

- [[archetype-research-report]] — research-report archetype contract + frontmatter caveats
- [[research-review]] — gates the report's `review_status`
- [[research-revise]] — folds review findings back in
- [[research-update]] — delta-driven rewrite when new materials / milestones land
- [[meta-scaffold-project-plan]] — consumes `recommended_changes` from `status: approved` reports
- [[dev-write-change]] — change-tier analog (PLAN phase mirrors this skill's research-then-compose pattern)
