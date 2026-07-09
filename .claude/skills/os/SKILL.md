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
4. If no row matches, **record the miss FIRST, then fall back** (a stalled or
   abandoned fallback can no longer lose the log line):
   a. Record the router event immediately with `--confidence miss` (the step 5
   command shape, no `--skill`). This is the single record for the miss path —
   step 5 does NOT re-record.
   b. Read the `description:` frontmatter from each file in `.claude/skills/` to
   collect 2-3 self-described candidates.
   c. Branch on run context:
   - **Interactive**: if 2-3 low-confidence candidates exist, present them via
     AskUserQuestion. Do NOT guess. `Headless: refuse` — a router miss is
     exactly the coin-flip a headless guess must not resolve.
   - **Headless**: print `⊘ Router miss — no vocabulary match for "<intent>"`,
     name the candidate skills (from 4b), suggest `/os add-skill` to scaffold
     the missing capability, and stop cleanly with no dispatch.

   d. If nothing fits at all (no candidates), suggest `/os add-skill` in both modes.

   **Trade-off (deliberate):** recording before the ask drops the
   `--fallback asked-user` attribution on the interactive path. That field exists
   in `record-router-event.mjs` but no consumer reads it today (`router-log.ts`,
   the only reader of `router-log.jsonl`, never touches it), so the loss is
   inert — and not losing the miss event to a stalled ask is the point. The ask's
   outcome is captured in the run report instead.

5. After a **matched** dispatch, record one router event via the dual-write
   wrapper (appends to `vault/raw/router-log.jsonl` AND inserts into
   `.claude/state/events.db` in one call). The miss path already recorded in
   step 4 — do NOT double-record:
   ```bash
   node scripts/record-router-event.mjs \
     --intent "<original user phrase>" \
     --skill <matched-skill-name> \
     --confidence high|low
   ```
   The wrapper handles JSON shape + timestamp so the skill body doesn't
   need to construct anything inline.

## Outputs

- Whatever the downstream skill produces
- One new line in `vault/raw/router-log.jsonl` + one row in `.claude/state/events.db` per invocation

## Errors

- If `OS.md` is missing or unparseable, report and stop — the OS is broken
- If a matched skill file doesn't exist on disk, treat it as a miss: record the router event with `--confidence miss` FIRST (per step 4a), then branch by run context — interactive: ask the user how to proceed; `Headless: refuse` — print `⊘ Router miss — matched skill file missing on disk`, name the intent, suggest `/os add-skill`, and stop cleanly with no dispatch
