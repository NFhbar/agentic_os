---
name: meta-add-schedule
description: Scaffold a scheduled runbook — wiki entry + cron schedule + prompt the OS fires when due
user-invocable: true
version: 1
domain: meta
tags: [scaffold, evolution, scheduling]
inputs:
  name:
    type: string
    required: true
    pattern: '^[a-z][a-z0-9-]*$'
    description: Schedule slug (lowercase kebab-case, becomes the file + id)
  title:
    type: string
    required: true
    description: Human-readable title (e.g. "Morning brief")
  domain:
    type: string
    required: true
    description: Owning domain (must already exist as a folder under domains/)
  schedule:
    type: string
    required: true
    description: '5-field cron (machine local time), e.g. "0 9 * * *" for 9am daily'
  prompt:
    type: string
    required: true
    description: 'Intent to fire when due, e.g. "/os brief" or "scan vault/raw for stale items"'
  trigger:
    type: string
    required: false
    description: Plain-English description of when this fires (defaults to humanized schedule)
  project:
    type: string
    required: false
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Project id (slug) to scope this schedule to. When set, the scheduler tick fires this runbook only while the project's status is `active`. Pausing the project pauses this schedule automatically.
outputs:
  - kind: file
    path: vault/wiki/{{input.domain}}/runbook/{{input.name}}.md
---

# meta-add-schedule

## Purpose

Register a new scheduled job. Creates a `runbook` archetype entry with the
optional `schedule:` + `prompt:` frontmatter fields populated. The scheduler
tick (`scripts/scheduler-tick.mjs`) picks it up on the next minute and fires
`prompt` via `claude -p` whenever `schedule` matches.

## Procedure

1. Validate `inputs.name` against `^[a-z][a-z0-9-]*$`. Reject if invalid.
2. Validate `inputs.schedule` parses as a 5-field cron — split on whitespace,
   confirm exactly 5 segments. Reject with an example if not.
3. Confirm `domains/<input.domain>/` exists. If not, reject and suggest
   `/os add-domain` first.
4. Target path: `vault/wiki/<input.domain>/runbook/<input.name>.md`.
   If it already exists, AskUserQuestion: overwrite, rename, or abort? Default abort.
5. Read `_templates/wiki-entry/runbook.md.tmpl`.
6. Substitute Mustache placeholders:
   - `{{slug}}` → input.name
   - `{{domain}}` → input.domain
   - `{{title}}` → input.title
   - `{{trigger}}` → input.trigger if set, else a humanized form of the cron
     (e.g. "every day at 09:00") — fall back to the raw expression if humanization is hard
   - `{{owner}}` → `<domain>-domain` (the convention used elsewhere)
   - `{{source}}` → "schedule"
   - `{{datetime}}` → current ISO 8601 UTC
7. After substitution, **uncomment** the `schedule:` and `prompt:` lines (they
   ship commented in the template) and set them to the input values. Quote
   both with double quotes to keep YAML parsing safe.
8. If `inputs.project` is provided: verify a project entity with that id exists
   (`vault/wiki/*/project/<project>.md` with `type: project`). Reject if missing,
   hinting at `/os add-project <id>` first. Otherwise, add `project: <id>` to the
   runbook's frontmatter — the scheduler tick will gate firing on project status.
9. Rewrite the body Steps section so it lists what the agent should do when
   the prompt fires — a one-line list pointing at the prompt is fine for v1.
10. Write the rendered content via the Write tool.
11. Record the audit event via the dual-write wrapper:
    ```bash
    node scripts/record-dashboard-action.mjs \
      --action add-schedule \
      --skill meta-add-schedule \
      --args '{"id":"<name>","schedule":"<cron>"}'
    ```
12. Print a one-line confirmation showing the next run time. (Optional — best-effort.)

## Outputs

- New `vault/wiki/<domain>/runbook/<name>.md` with `type: runbook`, `schedule`, `prompt`.

## Errors

- Invalid name → reject with reason
- Invalid cron (not 5 fields) → reject with example: `"0 9 * * *"`
- Domain does not exist → suggest `/os add-domain <domain>` first
- Target file exists → ask before overwriting
- Missing template → OS templates broken, report and stop

## See also

- `vault/wiki/_seed/meta/reference/standard-scheduled-jobs.md` — full pattern
- `vault/wiki/_seed/meta/reference/archetype-runbook.md` — the underlying archetype
- `scripts/scheduler-tick.mjs` — what fires the schedule
- `scripts/install-scheduler.sh` — installs the macOS launchd agent that ticks every minute
