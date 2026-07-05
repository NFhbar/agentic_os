---
name: meta-add-skill-to-playbook
description: Register an existing skill in its domain's playbook Skills section. Idempotent — skips when the skill is already listed. Resolves the audit finding `playbook-skill-coverage` for skills that were added outside meta-add-skill (or had step 7 skipped).
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [scaffold, registration, audit-resolver, vault-only]
inputs:
  skill:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Name of the skill to register (e.g. `meta-add-note`). Must already exist at `.claude/skills/<skill>/SKILL.md`; the owning domain is read from its frontmatter.'
outputs:
  - kind: file
    path: domains/{{resolved.domain}}/playbook.md
spawns: []
---

# meta-add-skill-to-playbook

## Purpose

Add a one-line registration for an existing skill to its owning domain's `playbook.md` Skills section. The audit check `playbook-skill-coverage` fires when a user-invocable skill exists on disk but isn't listed in the playbook — this skill is the one-click resolver wired to that finding.

Most new skills get this registration automatically (via `meta-add-skill` step 7). This standalone scaffolder exists for: (a) skills added before that step existed; (b) skills where the registration was skipped or undone; (c) one-click resolution from the Action Items panel.

The companion skill is [[meta-add-skill-to-router-vocab]] — same pattern, but for `OS.md`'s intent vocabulary table.

## Pre-conditions

- `.claude/skills/<skill>/SKILL.md` exists and parses as valid markdown with frontmatter
- The SKILL.md frontmatter carries a `domain:` field that resolves to a real domain (i.e. `domains/<domain>/playbook.md` exists)

## Procedure

1. **Validate the input.**
   - `skill` is required and matches `^[a-z0-9][a-z0-9-]*$`.
   - `.claude/skills/<skill>/SKILL.md` must exist. Reject with `skill "<value>" not found at .claude/skills/<value>/SKILL.md — create it first via meta-add-skill` otherwise.

2. **Resolve the owning domain.** Read the skill's SKILL.md frontmatter. Capture:
   - `domain:` — the owning domain. If absent, reject with `skill "<value>" has no domain in its frontmatter — add one and retry`.
   - `description:` — used as the right-hand side of the playbook entry. If absent, fall back to the skill name with a "(no description)" suffix.

   Verify `domains/<domain>/playbook.md` exists. If not, reject with `domain "<domain>" claimed by the skill has no playbook at domains/<domain>/playbook.md — fix the skill's frontmatter or scaffold the domain first`.

3. **Idempotency check.** Read the playbook. Scan its `## Skills` section — bounded exactly as the audit parses it: from the `## Skills` line to the FIRST of the next `## `/`### ` header OR a line starting with `Planned` (see `scripts/audit.mjs` `checkPlaybookSkillCoverage`; entries after a `Planned` marker are aspirational and invisible to the audit) — for an existing line matching `` - `<skill>` `` (the exact backtick-wrapped skill name at the start of a list item). A listing that appears ONLY inside a Planned block does NOT count as registered (the audit can't see it — treating it as registered would loop forever against the finding). If found within the audit-visible region, succeed as a no-op:

   ```
   ↻ Skill `<skill>` is already listed in domains/<domain>/playbook.md. Nothing to do.
   ```

   Record the event with `noop: true` per step 5 and stop.

4. **Insert the registration.** Locate the `## Skills` section in the playbook. The insertion region runs from the `## Skills` line until the FIRST of: the next `## ` or `### ` header, a line starting with `Planned`, or EOF — the same boundary the audit's `checkPlaybookSkillCoverage` uses (`scripts/audit.mjs`: `/^##\s+Skills\s*\n([\s\S]*?)(?=^##\s|^###\s|^Planned\b|\Z)/m`). Append a new list item after the last list item WITHIN that region:

   ```
   - `<skill>` — <description-from-frontmatter>
   ```

   Use the Edit tool with a surgical replace — find the last existing skill-list line within the audit-visible region + replace it with `<existing>\n- \`<skill>\` — <description>`. Do NOT rewrite the whole section.

   Edge cases:
   - If the Skills section is empty (header exists but no list items), insert the line right after the `## Skills` header + a blank line.
   - If the section contains a `Planned` block (e.g. `Planned for v1.5:` followed by aspirational list items — `domains/development/playbook.md` has this shape), the new line goes BEFORE the `Planned` marker, after the last real list item. Appending after the Planned items would place the registration outside the audit's parse boundary — the `playbook-skill-coverage` finding would never clear and the skill would be mislabeled as planned.

5. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action add-skill-to-playbook \
     --skill meta-add-skill-to-playbook \
     --args '{"skill":"<skill>","domain":"<domain>","noop":<true|false>}' \
     --files-touched '<["domains/<domain>/playbook.md"] when step 4 wrote, else []>' \
     --exit-status 0
   ```

6. **Report to the user** with a tight summary:

   ```
   ✓ Registered <skill> in domains/<domain>/playbook.md
     section:  ## Skills
     line:     - `<skill>` — <description>
     next:     /os audit (or refresh the Overview action items) to verify the playbook-skill-coverage finding clears.
   ```

## What this skill must NOT do

- **Create the skill.** Use `meta-add-skill` for that — this skill only registers an existing one.
- **Update OS.md's intent vocabulary.** Use [[meta-add-skill-to-router-vocab]] in tandem when needed.
- **Edit the skill's own SKILL.md.** Read-only with respect to the skill being registered.
- **Reorder existing entries.** Append-only — preserves the playbook's manual ordering.

## Errors

- `skill is required and must match ^[a-z0-9][a-z0-9-]*$` — invalid or missing skill input.
- `skill "<value>" not found at .claude/skills/<value>/SKILL.md` — the skill doesn't exist.
- `skill "<value>" has no domain in its frontmatter` — fix the SKILL.md first.
- `domain "<domain>" has no playbook at domains/<domain>/playbook.md` — scaffold the domain first.
- `playbook has no ## Skills section` — the playbook is malformed; fix manually before retrying.

## See also

- [[meta-add-skill-to-router-vocab]] — sibling skill for the OS.md vocabulary side
- [[meta-add-skill]] — full skill scaffolder (does this registration as step 7 for new skills)
- `domains/meta/playbook.md` — example of the target file shape
- `standard-os-audit.md` — the `playbook-skill-coverage` check this skill resolves
