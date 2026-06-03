---
name: os
description: Agentic OS router — dispatch /os <intent> to the right domain skill
user-invocable: true
version: 1
domain: meta
tags: [router, dispatch]
inputs:
  intent:
    type: string
    required: true
    description: Free-form user intent (everything typed after /os)
spawns:
  - meta-dashboard
  - meta-add-domain
  - meta-add-skill
  - meta-add-app
  - meta-add-archetype
  - meta-curate
  - meta-evolve
  - meta-brief
---

# OS router

## Purpose

Canonical entry point for all OS actions. Parses the user's intent, looks up the vocabulary in `OS.md`, picks the best downstream skill, and dispatches via the Skill tool.

## Inputs

- `intent` — everything typed after `/os` (free-form)

## Procedure

1. Read `OS.md` from the repo root and locate the **Intent vocabulary** table.
2. Match the user's intent against the table rows. If multiple rows match, prefer the most specific.
3. If a match is found:
   a. Read `domains/<owning-domain>/playbook.md` for context (the matched skill's domain).
   b. Invoke the matched skill via the Skill tool, passing the user's intent and any extracted arguments.
4. If no row matches:
   a. Read the `description:` frontmatter from each file in `.claude/skills/` to see if any self-described skill fits.
   b. If 2-3 candidates exist with low confidence, present them via AskUserQuestion. Do NOT guess.
   c. If still nothing fits, suggest the user run `/os add-skill` to scaffold the missing capability.
5. After dispatch (or fallback), record one router event via the dual-write
   wrapper (appends to `vault/raw/router-log.jsonl` AND inserts into
   `.claude/state/events.db` in one call):
   ```bash
   node scripts/record-router-event.mjs \
     --intent "<original user phrase>" \
     [--skill <matched-skill-name>] \
     [--confidence high|low|miss] \
     [--fallback asked-user]
   ```
   Omit `--skill` when no match. Omit `--fallback` when not applicable.
   The wrapper handles JSON shape + timestamp so the skill body doesn't
   need to construct anything inline.

## Outputs

- Whatever the downstream skill produces
- One new line in `vault/raw/router-log.jsonl` + one row in `.claude/state/events.db` per invocation

## Errors

- If `OS.md` is missing or unparseable, report and stop — the OS is broken
- If a matched skill file doesn't exist on disk, mark `confidence: miss`, log, and ask the user how to proceed
