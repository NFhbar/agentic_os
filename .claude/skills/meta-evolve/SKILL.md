---
name: meta-evolve
description: Generic OS modification — escape hatch for changes that don't fit other meta skills
user-invocable: true
version: 1
domain: meta
tags: [evolution, escape-hatch]
inputs:
  intent:
    type: string
    required: true
    description: Free-form description of the change the user wants to make
---

# meta-evolve

## Purpose

Catch-all for OS modifications that don't fit a specific `meta-add-*` or `meta-curate` skill. Examples:

- Rename a domain
- Deprecate a skill
- Refactor an archetype's frontmatter contract
- Restructure a playbook
- Adjust intent vocabulary

Uses reasoning to identify the right files to touch, proposes a plan, executes after approval.

## Procedure

1. Read `OS.md` and `domains/meta/playbook.md` to refresh on current state and standards.
2. Parse the user's `intent`. Identify affected OS artifacts:
   - Skills (`.claude/skills/`)
   - Playbooks (`domains/*/playbook.md`)
   - Templates (`_templates/`)
   - Archetypes (`vault/wiki/_seed/meta/`)
   - Vault structure
3. If the intent is purely additive AND fits an existing `meta-add-*` skill, suggest that skill instead and stop. Don't reinvent.
4. Otherwise, draft a plan: list every file to be modified and how. Present via ExitPlanMode for approval.
5. After approval, execute edits via Edit/Write tools.
6. Self-consistency check:
   - All skills mentioned in playbooks exist in `.claude/skills/`
   - All archetypes referenced in entries are registered in `OS.md`
   - Intent vocabulary in `OS.md` maps to skills that exist
   - Domain references in skill frontmatter point to real domains
7. If any inconsistency found, report and offer to fix.
8. Record the audit event via the dual-write wrapper:
   ```bash
   node scripts/record-dashboard-action.mjs \
     --action evolve \
     --skill meta-evolve \
     --args '{"intent":"<short summary>"}' \
     --files-touched '[<modified paths as JSON array>]'
   ```

## Outputs

- Modified OS files
- Consistency report

## Errors

- Inconsistency detected → abort, report, ask the user how to proceed
- Change would delete user data (e.g. archived raw files) → confirm explicitly
