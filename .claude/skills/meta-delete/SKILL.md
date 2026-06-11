---
name: meta-delete
description: Delete a skill, domain, or wiki entry — removes files and cleans up cross-references (OS.md vocab, playbook listings, wikilinks).
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [evolution, delete, destructive]
inputs:
  target_type:
    type: string
    required: true
    pattern: "^(skill|domain|wiki-entry)$"
    description: One of `skill`, `domain`, or `wiki-entry`
  target_path:
    type: string
    required: true
    description: Current repo-relative path of the artifact to delete
outputs:
  - kind: deletion
    description: Removed artifact + updated cross-references
---

# meta-delete

## Purpose

Permanently delete a skill, domain, or wiki entry. Recursively removes contents for domains. Updates all cross-references so the OS stays self-consistent. Designed for dashboard invocation (user has already confirmed), so this skill **executes directly without entering plan mode**.

## Inputs

- `target_type` — `skill | domain | wiki-entry`
- `target_path` — current repo-relative path

## Procedure

1. **Validate**: `target_path` exists. If not, report and stop.
2. **Determine scope** based on `target_type`:

   ### skill
   - Path: `.claude/skills/<name>/`
   - Will remove: this directory and SKILL.md inside it

   ### domain
   - Path: `domains/<...>/<name>/`
   - Will remove:
     - The domain folder (recursive, including sub-domains and apps)
     - `vault/wiki/<...>/<name>/` (if exists)
     - `vault/output/<...>/<name>/` (if exists)
   - Will NOT remove wiki entries in unrelated domains that happen to reference this one
   - **Warn explicitly** in output: "This will remove N files."

   ### wiki-entry
   - Path: `vault/wiki/.../<slug>.md`
   - Will remove just the file
   - Note: `[[<slug>]]` references in other entries will become dangling links (acceptable; clean up later)

3. **Execute** removal via Bash:
   - `git rm -rf <path>` if in git
   - Else `rm -rf <path>` (for safety, verify path starts with the repo root)

4. **Clean up cross-references** based on `target_type`:

   ### skill
   - Edit **OS.md**: remove any Intent vocabulary row pointing to `<name>`
   - Edit owning domain's `playbook.md`: remove the line `- \`<name>\` — ...`from`## Skills` section
   - Grep all other skills' `spawns:` arrays for `<name>` and remove

   ### domain
   - Edit **OS.md**: remove the domain's row from the Domains table
   - If this was a sub-domain, edit the parent's `playbook.md` `## Sub-domains` section to remove the listing

   ### wiki-entry
   - Trigger vault index rebuild: `node .claude/hooks/rebuild-vault-index.mjs`
   - (Optional, defer): grep `vault/wiki/` for `[[<old-id>]]` and surface count of dangling links

4b. **Regenerate the skill-id constants module** (skill deletions only): `node scripts/generate-skill-ids.mjs`, then `node scripts/audit.mjs --skills` — `skill-ids-module-stale` ERRORs until regenerated, and `app-stale-skill-literal` lists any app-code site still naming the deleted skill.

5. **Record the audit event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action delete \
     --skill meta-delete \
     --args '{"target_type":"<type>","target_path":"<path>"}' \
     --files-touched '[<the removed paths as a JSON array>]'
   ```

6. **Report** what was removed + dangling references (if any).

## Errors

- Path not found → abort
- Path escapes repo root → abort with security error
- If the deletion would orphan a parent domain (e.g. deleting `meta` — the OS depends on it), warn loudly but proceed (the user has confirmed)

## Notes

- The user has already confirmed from the dashboard with a type-to-match step. **Do not enter plan mode.** Execute directly.
- If `rm -rf` fails partway, report what was deleted and what remains.
- Deletion is destructive and not easily reversible (unless `git rm` was used). The audit log captures what was touched so the user can recover from git history.
