---
name: meta-add-research-note
description: Append a mid-lifecycle guidance note to a research-report's `notes_log` array. The skills that consume notes (`research-review` / `-revise` / `-update`) read unconsidered notes at the start of each run and append `considered_by` entries as they fold them in.
user-invocable: true
version: 1
domain: meta
tags: [research, notes, vault-only]
inputs:
  report:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Research-report id
  severity:
    type: string
    required: true
    description: 'One of: info, warn, blocker. Per archetype-research-report: info = take into account; warn = strongly consider; blocker = must address or document why not.'
  body:
    type: string
    required: true
    description: The note content (free-form prose; what the next research skill run should know)
outputs:
  - kind: frontmatter
    path: vault/wiki/research/research-report/<report>.md
    fields: [notes_log, updated]
---

# meta-add-research-note

## Purpose

Appends to a research-report's `notes_log` frontmatter array. Notes are the mid-lifecycle input channel between skill runs — captured guidance the user wants the next `research-review` / `-revise` / `-update` to weight alongside the original materials. Each note carries severity + a `considered_by` chain (initially empty; downstream skills append per-run entries as they fold the note in).

The dashboard exposes the same operation via the **Add note** form on the research-report Detail page's Notes tab (see `POST /api/research/:id/notes`); this skill is the CLI dispatch path.

Append-only: notes are immutable once added. Mistakes get corrected via a follow-up note (this preserves the audit trail of guidance over time, per the hybrid persistence model documented in `archetype-research-report`).

## Procedure

1. **Locate the report** at `vault/wiki/research/research-report/<inputs.report>.md`. Reject with `research-report "<id>" not found` if missing or if `type !== research-report`.

2. **Validate severity**: `inputs.severity` must be one of `info` / `warn` / `blocker`. Reject `severity must be one of: info, warn, blocker (got "<value>")` otherwise.

3. **Validate body**: trimmed `inputs.body` must be non-empty. Reject `body is required and must be non-empty` otherwise.

4. **Read current notes_log**. The frontmatter parser may surface `notes_log` as a JSON array (single-line, per `archetype-research-report § Frontmatter caveats`). Treat missing as `[]`. Each existing note must have shape `{ ts, severity, body, considered_by }` — preserve verbatim.

5. **Append the new note**. Compute `now` = ISO 8601 UTC. Build the new entry:

   ```js
   {
     ts: now,
     severity: <inputs.severity>,
     body: <trimmed inputs.body>,
     considered_by: []
   }
   ```

   Append to the existing array (or create a fresh `[<entry>]` if `notes_log` was empty).

6. **Surgical frontmatter rewrite**. Re-emit `notes_log:` as a single-line JSON array (mirror the pattern used for `recommended_changes` / `dismissed_triggers` — the OS's flat frontmatter parser does NOT handle multi-line YAML arrays of objects, would silently drop the field). Use the `replaceField` regex from `domains/meta/app/server/routes/research.ts::POST /:id/notes` (look for `^notes_log:[^\n]*$`); insert the line before `---` if it's absent. Bump `updated:` to `now`.

7. **Record audit event**:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action research-note-added \
     --args '{"report":"<id>","severity":"<info|warn|blocker>","note_index":<new-index>}' \
     --files-touched '["<relative path>"]' \
     --exit-status 0
   ```

   `note_index` = the 0-based position of the newly-appended entry in the resulting array (length - 1).

8. **Print summary**:

   ```
   ✓ Added note to <report>
     severity:    <info|warn|blocker>
     index:       <N>
     considered_by:  []  (empty — pending consideration by the next research skill run)

     next: the next /os research-review / -revise / -update on this report will
           fold this note into the run + append a considered_by entry.
   ```

## Outputs

- Frontmatter updates on `vault/wiki/research/research-report/<report>.md`: `notes_log` extended (or created), `updated` bumped
- One audit event with action `research-note-added`

## Errors

- `research-report "<id>" not found`
- `severity must be one of: info, warn, blocker (got "<value>")`
- `body is required and must be non-empty`

## Design notes

- Mirrors `POST /api/research/:id/notes` in `routes/research.ts`. Both intentionally exist per "apps are optional UI." The dashboard's Note tab is the discoverable path; this skill enables CLI workflows like `/os add note <report> warn "remember to consider X"` from a terminal mid-session.
- Single-line JSON encoding of `notes_log` is load-bearing per the flat-frontmatter parser — multi-line YAML object arrays get silently dropped. Documented in `archetype-research-report § Frontmatter caveats`.

## See also

- [[archetype-research-report]] — `notes_log` item shape + considered_by semantics + skill consumption rules
- [[research-review]], [[research-revise]], [[research-update]] — the three skills that consume unconsidered notes
- `POST /api/research/:id/notes` — the parallel dashboard endpoint
