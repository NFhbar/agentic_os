---
name: meta-audit
description: Audit the OS for compliance with documented standards (skills, wiki, domains, archetypes, router, logs)
user-invocable: true
version: 1
domain: meta
tags: [diagnostic, compliance, evolution]
inputs:
  section:
    type: string
    required: false
    description: 'Limit to one section: skills | wiki | domains | templates | router | logs (default: all)'
outputs:
  - kind: report
    path: stdout (or vault/raw/audit-runs.jsonl if --log)
---

# meta-audit

## Purpose

Read-only diagnostic. Walks the repo and checks every primitive against its documented standard. Surfaces drift, dangling references, missing required fields, and broken cross-references.

Use before adding a new capability (clean baseline) or after a freehand edit (catch regressions).

## Procedure

1. Resolve the section filter (if `inputs.section` is provided, map to the matching `--<section>` flag).
2. Shell out to `scripts/audit.mjs` with the appropriate flags. Capture stdout + exit code.
3. Summarize the result for the user:
   - If exit 0 and no findings → "✓ OS audit clean."
   - If exit 0 with warnings/info → list findings grouped by severity, recommend next steps
   - If exit 1 (any errors) → list errors first, then warnings, then recommend the fix for each
4. For each finding, point at the standard it references (the finding `id` maps to a check; e.g. `wiki-id-matches-filename` → `standard-file-naming.md`).
5. Offer to invoke the relevant `meta-*` skill to fix anything actionable (`meta-rename`, `meta-evolve`, etc.). Do not auto-fix in v1.

## Outputs

- Text report (one section per severity)
- Exit code: 0 on clean, 1 on any error

## What it checks

| section     | checks                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `skills`    | subdir layout, required frontmatter, name == directory, domain exists                                                                 |
| `wiki`      | shared frontmatter, id == filename, type registered, domain exists, schedule cron validity, dangling wikilinks, stale `last_verified` |
| `domains`   | playbook present, playbook frontmatter, skill listings match reality                                                                  |
| `templates` | every archetype has BOTH a template and a reference entry                                                                             |
| `router`    | every `OS.md` intent vocab row points to an existing skill                                                                            |
| `logs`      | every `vault/raw/*.jsonl` parses as one JSON object per line                                                                          |

Full check list with rule IDs + rationale: `vault/wiki/_seed/meta/reference/standard-os-audit.md`.

## Errors

- `scripts/audit.mjs` missing → OS is broken; cannot audit. Report and stop.
- Section filter not in known list → reject with the list of valid sections.

## See also

- [[standard-os-audit]] — the standard this skill enforces
- [[standard-feature-anatomy]] — what a "feature" must comply with
- [[concept-primitives]] — what kinds of things the OS understands
