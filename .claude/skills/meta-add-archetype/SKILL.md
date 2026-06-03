---
name: meta-add-archetype
description: Register a new wiki archetype with frontmatter contract + entry template + seed reference
user-invocable: true
version: 1
domain: meta
tags: [scaffold, evolution, memory]
inputs:
  name:
    type: string
    required: true
    pattern: "^[a-z][a-z0-9-]*$"
    description: Archetype name (lowercase kebab-case)
  description:
    type: string
    required: true
    description: What kind of knowledge this archetype captures
  fields:
    type: object
    required: true
    description: 'Required archetype-specific fields, as {field_name: "type description"}'
outputs:
  - kind: file
    path: _templates/wiki-entry/{{input.name}}.md.tmpl
  - kind: file
    path: vault/wiki/_seed/meta/archetype-{{input.name}}.md
---

# meta-add-archetype

## Purpose

Add a new wiki archetype. Three artifacts are created or updated:

1. A template at `_templates/wiki-entry/<name>.md.tmpl` so future entries can be scaffolded
2. A `reference` archetype entry in `vault/wiki/_seed/meta/` documenting the new archetype's frontmatter contract
3. The "Memory archetypes" table in `OS.md` and `domains/meta/playbook.md`

## Procedure

1. Validate inputs.
2. Verify `_templates/wiki-entry/<name>.md.tmpl` does not exist. If it does, reject and suggest `meta-evolve`.
3. Compose the template:

   ```
   ---
   id: {{slug}}
   type: <name>
   domain: {{domain}}
   created: {{datetime}}
   updated: {{datetime}}
   tags: []
   source: {{source}}
   private: false
   <field_name>: <placeholder per type>
   ... (one line per input.fields entry)
   ---

   # {{title or first field}}

   ## ...
   TODO sections
   ```

4. Write template to `_templates/wiki-entry/<name>.md.tmpl`.
5. Create a `reference` archetype entry at `vault/wiki/_seed/meta/archetype-<name>.md`:
   - Frontmatter follows the reference archetype contract
   - `url:` field points to "internal://archetype/<name>"
   - Body lists the required fields, when to use, related archetypes
6. Edit `OS.md` "Memory archetypes" table — add a row.
7. Edit `domains/meta/playbook.md` — add archetype to the standards section.
8. Audit log.

## Outputs

- New template file
- New seed wiki reference entry
- Updated OS.md and meta playbook archetype tables

## Errors

- Archetype exists → suggest editing via `meta-evolve` instead
- `inputs.fields` malformed → reject with example of correct shape
