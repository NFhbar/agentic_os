---
name: meta-rename
description: Rename a skill, domain, or wiki entry — moves files and updates all cross-references (OS.md vocab, playbook listings, wikilinks).
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [evolution, rename, destructive]
inputs:
  target_type:
    type: string
    required: true
    pattern: "^(skill|domain|wiki-entry)$"
    description: One of `skill`, `domain`, or `wiki-entry`
  target_path:
    type: string
    required: true
    description: Current repo-relative path of the artifact (e.g. `.claude/skills/dev-pr-review` or `domains/development/pr-review` or `vault/wiki/.../foo.md`)
  new_name:
    type: string
    required: true
    pattern: "^[a-z][a-z0-9-]*$"
    description: New last-segment name (kebab-case). For wiki entries, this is the new slug — the `id` frontmatter field is also updated.
outputs:
  - kind: folder-or-file
    description: Renamed artifact at new path
---

# meta-rename

## Purpose

Rename a skill, domain, or wiki entry. Updates the file/folder name AND all known cross-references so the OS stays self-consistent. Designed to be invoked from the dashboard (which has already obtained user confirmation), so this skill **executes directly without entering plan mode**.

## Inputs

- `target_type` — `skill | domain | wiki-entry`
- `target_path` — current repo-relative path
- `new_name` — new last segment (kebab-case)

## Procedure

1. **Validate**: `target_path` exists; `new_name` matches `^[a-z][a-z0-9-]*$`. If invalid, report and stop.
2. **Compute new path**: replace the last path segment with `new_name`. Reject if the new path already exists.
3. **Execute the rename** based on `target_type`:

   ### skill
   - `target_path` is `.claude/skills/<old>/` (containing SKILL.md)
   - Move directory: `git mv` if in git, else `mv` via Bash
   - Edit SKILL.md frontmatter: set `name: <new_name>` (must match new directory name)
   - Update **OS.md** Intent vocabulary table: replace `<old>` with `<new_name>` in any matching row
   - Find domain playbook for this skill (parse the skill's `domain:` frontmatter) and update its `## Skills` section: replace any `` `<old>` `` reference with `` `<new_name>` ``
   - Grep all other skills' `spawns:` arrays for `<old>` and replace with `<new_name>`

   ### domain
   - `target_path` is `domains/<...>/<old>/` (containing playbook.md)
   - Move directory
   - Edit playbook.md frontmatter: `domain: <new domain path>`
   - Update **OS.md** Domains table: replace path
   - Rename matching vault paths if they exist: `vault/wiki/<old>` → `vault/wiki/<new>` and `vault/output/<old>` → `vault/output/<new>`. (For sub-domains, only the leaf segment renames — preserve parent prefix.)
   - If this is a sub-domain, update the parent playbook's `## Sub-domains` section
   - Grep all wiki entries' `domain:` frontmatter for the old path and update to the new path
   - Grep `.claude/skills/*/SKILL.md` frontmatter for `domain: <old-path>` and update to `domain: <new-path>` — skills claim their domain in frontmatter (outside `domains/`), and the audit's `skill-domain-exists` check ERRORs on every skill still pointing at the old path. Then run `node scripts/audit.mjs --skills --domains` to confirm zero `skill-domain-exists` findings.

   ### wiki-entry
   - `target_path` is `vault/wiki/<domain>/<archetype>/<old-slug>.md`
   - Move the file to `<...>/<new_name>.md`
   - Edit frontmatter: `id: <new_name>` (must match new slug)
   - Grep all `vault/wiki/` files for `[[<old-id>]]` and replace with `[[<new_name>]]`
   - Trigger vault index rebuild: run `node .claude/hooks/rebuild-vault-index.mjs`

3b. **Regenerate the skill-id constants module** (skill renames only): `node scripts/generate-skill-ids.mjs` — app TypeScript references skills via the generated `domains/meta/app/server/lib/skill-ids.ts`; the audit's `skill-ids-module-stale` check ERRORs until regenerated. Then run `node scripts/audit.mjs --skills`: the `app-stale-skill-literal` check lists any app-code site still naming the OLD id (the class of breakage that kept the meta-research-project alias undeletable).

4. **Record the audit event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action rename \
     --skill meta-rename \
     --args '{"target_type":"<type>","target_path":"<old>","new_name":"<new>"}' \
     --files-touched '[<old and new paths as a JSON array>]'
   ```

5. **Report** the new path + count of references updated.

## Errors

- New path already exists → abort, report, do nothing
- Target not found → abort
- For `wiki-entry` rename, if the entry has many backlinks (>20), warn but proceed (the user confirmed from the dashboard)

## Notes

- This skill assumes the user has already confirmed from the dashboard. **Do not enter plan mode.** Execute directly using Read/Write/Edit/Bash tools.
- If anything fails mid-execution, restore the original path if possible and report.
