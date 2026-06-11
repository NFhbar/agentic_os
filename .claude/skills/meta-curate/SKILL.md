---
name: meta-curate
description: Promote items from vault/raw/ into structured wiki/ entries with archetype frontmatter
user-invocable: true
version: 1
domain: meta
tags: [memory, curation]
inputs:
  source_path:
    type: string
    required: false
    description: Specific raw file to curate. If omitted, processes the pending-curation queue.
outputs:
  - kind: wiki-entry
    description: One or more new entries under vault/wiki/<domain>/<archetype>/
---

# meta-curate

## Purpose

Promote unstructured content from `vault/raw/` into typed `vault/wiki/` entries with proper archetype frontmatter and provenance. Either processes a specific file or works through the pending-curation queue at `.claude/state/pending-curation.txt`.

## Procedure

1. Determine sources:
   - If `source_path` is given, process just that file
   - Otherwise read `.claude/state/pending-curation.txt` (one path per line) and iterate
2. For each source:
   a. Read content
   b. Classify by content:
   - URL or link → `reference`
   - Decision text ("we chose X because Y") → `decision`
   - Person/project/repo description → `entity`
   - Step-by-step procedure → `runbook`
   - Initiative with goals + status → `project`
   - Else → `note`

   **Telemetry is NEVER promoted to wiki** (Finding 5.2; OS.md layer contract: "vault holds knowledge … events.db holds telemetry"). Scheduler/run output (`scheduled-runs.jsonl`, run journals, tick logs, CI-poll results) does not become a date-bucketed note — events.db and the raw JSONL already hold the data, and restating it adds token noise to search while telling future sessions nothing. When a telemetry source surfaces in the queue:
   - If it reveals a DURABLE pattern (a recurring failure mode, an idiom worth naming, a design gap) → fold that observation into an existing pattern/retrospective note or the owning project's note — analysis, not event restatement, and never a date-bucketed id.
   - Otherwise → drop it from the queue (step 6) without creating an entry; archive the raw file if asked.
     The audit enforces this as `note-run-telemetry` (WARNs on `type: note` entries with a `.jsonl` source AND a date-bucketed id).
     c. Suggest a domain (use source path or content cues). If ambiguous, AskUserQuestion with 2-3 options.
     d. Suggest a slug (kebab-case derived from title or first heading)
     e. Present the proposed archetype, domain, slug, and title to the user via AskUserQuestion. Allow corrections.

3. Read `_templates/wiki-entry/<archetype>.md.tmpl`.
4. Render with substitutions:
   - `{{slug}}`, `{{domain}}`, `{{datetime}}`, `{{source}}` (the raw path), archetype-specific fields
   - For body content: extract from the raw file rather than leaving TODO placeholders
5. Write to `vault/wiki/<domain>/<archetype>/<slug>.md`.
6. Remove the processed line from `.claude/state/pending-curation.txt`.
7. AskUserQuestion: archive the raw file? If yes, move to `vault/raw/.archived/<date>/`.
8. Audit log.

## Outputs

- New wiki entries with full frontmatter and provenance
- Cleaned pending-curation queue
- Optionally archived raw files

## Errors

- Source unreadable → leave in queue, log
- Existing target path → ask before overwriting
- Cannot classify confidently → leave in queue with a `[needs-review]` marker
