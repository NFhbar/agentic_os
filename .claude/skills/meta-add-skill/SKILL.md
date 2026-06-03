---
name: meta-add-skill
description: Scaffold a new skill in .claude/skills/ from template, register in domain playbook
user-invocable: true
version: 1
domain: meta
tags: [scaffold, evolution]
inputs:
  name:
    type: string
    required: true
    pattern: "^[a-z][a-z0-9-]*$"
    description: Skill filename (with domain prefix, e.g. dev-pr-review)
  domain:
    type: string
    required: true
    description: Owning domain
  description:
    type: string
    required: true
    description: One-line skill description (becomes the harness-visible description)
  display_name:
    type: string
    required: false
    description: H1 title (defaults to a Title-Cased version of name)
  intent_phrases:
    type: string
    required: false
    description: |
      Pipe-separated list of natural-language phrasings that should route to this skill via `/os <intent>`. Becomes a row in OS.md's Intent vocabulary table.
      Example: `mark pr ready|pr ready for human|sign off pr review|ready to merge`.
      Required when `user-invocable: true` (the default for new skills) so the `router-vocab-skill-uncovered` audit warning never fires. When omitted, the skill is scaffolded but the OS.md row is left as a TODO comment and the audit will warn.
outputs:
  - kind: file
    path: .claude/skills/{{input.name}}/SKILL.md
---

# meta-add-skill

## Purpose

Create a new Claude Code skill at `.claude/skills/<name>/SKILL.md` from `_templates/skill/skill.md.tmpl`, then append a one-line registration to the owning domain's playbook.

## Procedure

1. Validate `inputs.name` against `^[a-z][a-z0-9-]*$`.
2. Verify `domains/<domain>/playbook.md` (or nested `domains/<parent>/<domain>/playbook.md`) exists. If not, reject — domain must exist first. Suggest `/os add-domain`.
3. Verify `.claude/skills/<name>/SKILL.md` does not exist. If it does, ask the user.
4. Read `_templates/skill/skill.md.tmpl`.
5. Substitute placeholders:
   - `{{name}}` → input.name
   - `{{display_name}}` → input.display_name or Title-Cased name
   - `{{description}}` → input.description
   - `{{domain}}` → input.domain
6. Create the directory `.claude/skills/<name>/` and write the rendered content to `.claude/skills/<name>/SKILL.md`. The frontmatter MUST include `user-invocable: true` so the harness exposes it as a slash command.
7. Edit the domain playbook (`domains/<domain>/playbook.md`) — locate the `## Skills` section and append:
   `- \`<name>\` — <description>`

   The description should be a one-sentence summary suitable as a Skills-section entry — same shape as the existing entries above it. Don't change formatting or re-order the section.

8. Edit `OS.md` to add the intent-vocab row. This step is what makes the skill addressable via `/os <intent>` and what clears the `router-vocab-skill-uncovered` audit warning.
   - **If `inputs.intent_phrases` is set**: locate the `### Intent vocabulary` section's markdown table, then append (or insert near similar-domain rows) one row of the form:

     ```
     | `<phrase 1>`, `<phrase 2>`, `<phrase 3>`        | `<name>`            |
     ```

     The phrases come from `inputs.intent_phrases.split('|')`. Wrap each in backticks. Match column widths to the surrounding rows so the table stays aligned (don't worry about pixel-perfect padding — biome/prettier won't reformat OS.md, but keep the pipe positions consistent enough to be human-readable). The right column is the skill name in backticks.

   - **If `inputs.intent_phrases` is NOT set** AND `user-invocable: true`: still append a placeholder row so the gap is visible, but mark it TODO:

     ```
     | `TODO: add intent phrasings for <name>`         | `<name>`            |
     ```

     This deliberately leaves the audit `router-vocab-skill-uncovered` warning unresolved — the placeholder won't satisfy the audit's vocab scan because the audit treats the skill name in the right column as the source-of-truth, not the placeholder phrase. Surface this in the final report (step 10) so the user knows to come back and fill it in.

   - **If the skill is not user-invocable** (rare; e.g. internal helper skills): skip this step entirely. The audit's router check only fires on `user-invocable: true` skills.

9. Validate by running the audit against just this skill. Quick check via the scoped flag:

   ```bash
   node scripts/audit.mjs --json --skills 2>/dev/null \
     | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const hits=(d.findings||[]).filter(f=>(f.message||'').includes('<name>')||(f.path||'').includes('<name>')); if(hits.length){console.error(JSON.stringify(hits,null,2)); process.exit(1)}"
   ```

   If findings appear, surface them in the report and let the user decide whether to fix in-line or accept the gap.

   The `.claude/hooks/audit-skill-write.sh` PostToolUse hook also runs automatically after the SKILL.md write in step 6, so any findings will already have surfaced to stderr by the time you reach this step. This is a belt-and-braces double-check before the success report.

10. Record the audit event via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action add-skill \
      --skill meta-add-skill \
      --args '{"name":"<name>","domain":"<domain>","intent_phrases":<true_or_false>}' \
      --files-touched '[".claude/skills/<name>/SKILL.md","domains/<domain>/playbook.md","OS.md"]'
    ```

11. Print the success report:
    ```
    ✓ Scaffolded skill `<name>` (domain: <domain>)
      skill:    .claude/skills/<name>/SKILL.md
      playbook: domains/<domain>/playbook.md (Skills section)
      vocab:    OS.md (Intent vocabulary)   ← or "OS.md (TODO placeholder — fill in intent_phrases)" when not provided
      next:     edit the SKILL.md procedure body — the template ships with a stub
                Pre-conditions/Procedure/Outputs/Errors/See also structure.
    ```

## Outputs

- New `.claude/skills/<name>/SKILL.md`
- Updated domain playbook Skills section
- Updated `OS.md` Intent vocabulary table (row added or TODO placeholder)

## Errors

- Domain missing → suggest `/os add-domain` first
- Skill already exists → ask whether to overwrite
- Name doesn't start with `<domain>-` prefix → warn but allow (router skill `os` is an exception)
- `intent_phrases` empty AND `user-invocable: true` → warn (placeholder row written; audit will still flag `router-vocab-skill-uncovered` until filled in)
