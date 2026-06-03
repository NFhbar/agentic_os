---
id: standard-file-naming
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, conventions]
source: manual
private: false
title: File-naming conventions
url: internal://standard/file-naming
kind: doc
last_verified: 2026-05-19
---

# File-naming conventions

## What it is

Patterns the OS uses for every kind of file it manages. Scaffolders follow these; freehand edits should too.

## Conventions

| thing               | pattern                                           | example                                                               |
| ------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| skill               | `.claude/skills/<domain>-<verb>-<noun>/SKILL.md`  | `.claude/skills/dev-pr-review/SKILL.md`                               |
| router (exception)  | `.claude/skills/os/SKILL.md`                      | —                                                                     |
| domain folder       | `<lowercase-kebab>`                               | `development/`, `pr-review/`                                          |
| sub-domain          | nested folder under parent                        | `development/pr-review/`                                              |
| playbook            | `playbook.md`                                     | `domains/meta/playbook.md`                                            |
| app folder          | `<app-name>/app/` inside a domain                 | `domains/meta/app/`                                                   |
| wiki entry          | `vault/wiki/<domain>/<archetype>/<slug>.md`       | `vault/wiki/research/decision/use-fastify.md`                         |
| seed entry          | `vault/wiki/_seed/<domain>/<archetype>/<slug>.md` | `vault/wiki/_seed/meta/reference/standard-skill-format.md`            |
| output file         | `vault/output/<domain>/<kind>/<slug>.md`          | `vault/output/development/pr-reviews/repo-42.md`                      |
| template            | `<thing>.<ext>.tmpl`                              | `domain/playbook.md.tmpl`, `app/package.json.tmpl`                    |
| log                 | `<purpose>-log.jsonl` or `<feature>-runs.jsonl`   | `router-log.jsonl`, `scheduled-runs.jsonl`                            |
| hook script         | `<purpose>.sh` (+ `.mjs` helpers)                 | `note-raw-write.sh`, `rebuild-vault-index.mjs`                        |
| state file          | `.claude/state/<purpose>.<ext>`                   | `pending-curation.txt`, `installed-at`, `schedule-runs.json`          |
| runtime runner      | `scripts/<feature>-<verb>.mjs`                    | `scripts/scheduler-tick.mjs`                                          |
| installer script    | `scripts/install-<feature>.sh`                    | `scripts/install-scheduler.sh`                                        |
| system template     | `_templates/<artifact>.<ext>.tmpl`                | `_templates/launchagent.plist.tmpl`                                   |
| ingested repo clone | `repos/<slug>/`                                   | `repos/agentic-os-example/` (gitignored; see standard-repo-ingestion) |

## `scripts/` vs `.claude/hooks/`

Both hold executable code, but they answer different questions:

- **`.claude/hooks/`** — Claude Code lifecycle event handlers (PostToolUse, UserPromptSubmit, SessionStart). The CC harness fires them with stdin JSON; the hook returns fast and writes only to `.claude/state/` or `vault/raw/`. Naming: `<purpose>.sh`.
- **`scripts/`** — out-of-band runners and installers. Invoked by cron / launchd / CI / the dashboard — never by the CC harness directly. Free to take longer, write anywhere, depend on Node. Naming: `<feature>-<verb>.mjs` for runners, `install-<feature>.sh` for installers.

If your script is fired by a CC lifecycle event, it's a hook. Otherwise, it lives in `scripts/`.

## Casing

- Folders and filenames: `lowercase-kebab-case`
- TypeScript/React files in apps: `PascalCase` for components (`App.tsx`), `camelCase` for libs (`vault.ts`)
- Frontmatter keys: `snake_case`
- Wikilink IDs: `kebab-case`

## Slugs

Wiki entry `id` is also the filename slug (without `.md`). They must match.

## Rationale

- Predictable patterns let scaffolders generate paths without guessing
- The grep test: given any concept, you can `find` the file in one try
- Consistent casing across the system reduces typo bugs

## Related

[[standard-wiki-format]], [[standard-skill-format]], [[standard-feature-anatomy]]
