---
name: meta-add-skill-to-router-vocab
description: Register an existing skill in OS.md's Intent vocabulary table so `/os <intent>` can route to it. Idempotent — skips when the skill is already listed. Resolves the audit finding `router-vocab-skill-uncovered` for skills that were added outside meta-add-skill (or had step 8 skipped).
user-invocable: true
version: 1
domain: meta
tags: [scaffold, registration, router, audit-resolver, vault-only]
inputs:
  skill:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Name of the skill to register (e.g. `meta-add-note`). Must already exist at `.claude/skills/<skill>/SKILL.md`.'
  phrasings:
    type: string
    required: true
    description: 'Comma-separated natural-language phrasings that should route to this skill via `/os <intent>` (e.g. `add note,new note,scaffold note`). Becomes the left-hand cell of the OS.md vocabulary row. Backticks wrap each phrasing in the output.'
outputs:
  - kind: file
    path: OS.md
spawns: []
---

# meta-add-skill-to-router-vocab

## Purpose

Add a row to `OS.md`'s `### Intent vocabulary` table so the router can dispatch `/os <intent>` to an existing skill. The audit check `router-vocab-skill-uncovered` fires when a user-invocable skill has no row mapped to it — this skill is the one-click resolver wired to that finding.

Most new skills get this registration automatically (via `meta-add-skill` step 8). This standalone scaffolder exists for: (a) skills added before that step existed; (b) skills where step 8 was skipped (e.g. `intent_phrases` wasn't provided); (c) one-click resolution from the Action Items panel.

The companion skill is [[meta-add-skill-to-playbook]] — same pattern, but for the domain playbook's Skills section.

## Pre-conditions

- `.claude/skills/<skill>/SKILL.md` exists
- `OS.md` exists and has an `### Intent vocabulary` markdown table

## Procedure

1. **Validate inputs.**
   - `skill` is required and matches `^[a-z0-9][a-z0-9-]*$`.
   - `.claude/skills/<skill>/SKILL.md` must exist. Reject with `skill "<value>" not found at .claude/skills/<value>/SKILL.md — create it first via meta-add-skill` otherwise.
   - `phrasings` is required, non-empty after trim. Split on `,` then trim each element. After dedup + empty-strip, at least one phrasing must remain. Reject with `phrasings is required — supply at least one natural-language phrasing` otherwise.

2. **Idempotency check.** Read `OS.md`. Scan the Intent vocabulary table for an existing row whose right-hand cell is `` `<skill>` `` (backtick-wrapped match on the exact skill name). If found, succeed as a no-op:

   ```
   ↻ Skill `<skill>` already has an Intent vocabulary row in OS.md. Nothing to do.
   ```

   Record the event with `noop: true` per step 4 and stop.

3. **Insert the row.** Locate the `### Intent vocabulary` section's markdown table. The table runs from the header line (`| if intent matches… | route to |`) through subsequent rows until a blank line or next `##`/`###` header.

   Compose the new row:

   ```
   | `<phrasing-1>`, `<phrasing-2>`, ...                                                          | `<skill>`                           |
   ```

   Per-cell formatting:
   - Left cell: comma-separated phrasings, each wrapped in backticks. Use a single space after each comma.
   - Right cell: the skill name in backticks.
   - Column widths: match the table's existing visual width with trailing spaces so the pipes line up. Best-effort — readability beats exact alignment.

   Use the Edit tool with a surgical replace — find the LAST existing data row in the table, replace it with `<existing-row>\n<new-row>`. Append-only; preserves the table's manual grouping (router rows tend to cluster by domain).

4. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action add-skill-to-router-vocab \
     --skill meta-add-skill-to-router-vocab \
     --args '{"skill":"<skill>","phrasings":["<p1>","<p2>"],"noop":<true|false>}' \
     --files-touched '<["OS.md"] when step 3 wrote, else []>' \
     --exit-status 0
   ```

5. **Report to the user** with a tight summary:

   ```
   ✓ Registered <skill> in OS.md's Intent vocabulary
     phrasings: <comma-list>
     route:     /os <first-phrasing> → <skill>
     next:      /os audit (or refresh the Overview action items) to verify the router-vocab-skill-uncovered finding clears.
   ```

## What this skill must NOT do

- **Create the skill.** Use `meta-add-skill` for that — this skill only registers an existing one.
- **Update domain playbooks.** Use [[meta-add-skill-to-playbook]] in tandem when needed.
- **Edit the skill's own SKILL.md.** Read-only with respect to the skill being registered.
- **Modify existing rows.** Append-only — preserves the table's manual ordering and existing phrasings.

## Errors

- `skill is required and must match ^[a-z0-9][a-z0-9-]*$` — invalid or missing skill input.
- `skill "<value>" not found at .claude/skills/<value>/SKILL.md` — the skill doesn't exist.
- `phrasings is required — supply at least one natural-language phrasing` — empty or whitespace-only input.
- `OS.md has no ### Intent vocabulary table` — OS.md is malformed; fix manually before retrying.

## See also

- [[meta-add-skill-to-playbook]] — sibling skill for the playbook side
- [[meta-add-skill]] — full skill scaffolder (does this registration as step 8 for new skills)
- `OS.md` § Intent vocabulary — the target table
- `standard-os-audit.md` — the `router-vocab-skill-uncovered` check this skill resolves
