---
name: meta-add-domain
description: Scaffold a new domain with playbook + vault dirs + intent-vocab registration
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [scaffold, evolution]
inputs:
  name:
    type: string
    required: true
    pattern: "^[a-z][a-z0-9-]*$"
    description: Domain name (lowercase kebab-case)
  display_name:
    type: string
    required: true
    description: Human-readable name (e.g. "Personal Operations")
  purpose:
    type: string
    required: true
    description: One paragraph describing what this domain captures
  parent:
    type: string
    required: false
    description: Parent domain name if this is a sub-domain (creates domains/<parent>/<name>/)
outputs:
  - kind: folder
    path: domains/{{input.name}}/
  - kind: file
    path: domains/{{input.name}}/playbook.md
  - kind: folder
    path: vault/wiki/{{input.name}}/
  - kind: folder
    path: vault/output/{{input.name}}/
---

# meta-add-domain

## Purpose

Create a new domain folder with a scaffolded playbook from `_templates/domain/playbook.md.tmpl`, plus matching `vault/wiki/<name>/` and `vault/output/<name>/` directories. Register the new domain in `OS.md`.

## Procedure

1. Validate `inputs.name` against `^[a-z][a-z0-9-]*$`. Reject if invalid.
2. Determine target path:
   - With `parent`: `domains/<parent>/<name>/` (parent must already exist as a domain)
   - Without: `domains/<name>/`
3. If target already exists, AskUserQuestion: overwrite, rename, or abort? Default to abort. `Headless: refuse` — formalizes that default: abort (never overwrite a domain in a headless run) — print `⊘ Domain <name> already exists — aborting in a headless run` and stop with no side effects.
4. Read `_templates/domain/playbook.md.tmpl`.
5. Substitute Mustache placeholders:
   - `{{name}}` → input.name
   - `{{display_name}}` → input.display_name
   - `{{purpose}}` → input.purpose
   - `{{datetime}}` → current ISO 8601 UTC timestamp
6. Write rendered content to `<target>/playbook.md` (Write tool).
7. Create empty vault directories with .gitkeep markers via Bash:
   `mkdir -p vault/wiki/<name> vault/output/<name> && touch vault/wiki/<name>/.gitkeep vault/output/<name>/.gitkeep`
   (Or nested path if sub-domain.)
8. Update `OS.md`:
   - Add a row to the **Domains** table
   - (Optional) suggest 1-2 intent vocabulary entries for common actions in the new domain — present via AskUserQuestion before editing. `Headless: default(skip-edit)` — never edit OS.md's Intent vocabulary without confirmation; emit the suggested rows in the run report so a human can apply them later via [[meta-add-skill-to-router-vocab]].
9. Record the audit event via the dual-write wrapper:
   ```bash
   node scripts/record-dashboard-action.mjs \
     --action add-domain \
     --skill meta-add-domain \
     --args '{"name":"<name>","parent":"<parent|null>"}'
   ```

## Outputs

- New `domains/<name>/playbook.md`
- New empty wiki and output directories
- Updated OS.md Domains table

## Errors

- Invalid name → reject with reason
- Parent doesn't exist → suggest creating it first
- Target exists (interactive) → ask before overwriting. `Headless: refuse` — abort, never overwrite a domain in a headless run (`⊘ Domain <name> already exists`)
- Missing template → OS templates broken, report and stop
