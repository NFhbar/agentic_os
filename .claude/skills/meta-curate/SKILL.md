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
