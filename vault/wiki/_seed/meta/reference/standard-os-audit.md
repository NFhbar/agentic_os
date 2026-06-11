---
id: standard-os-audit
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-27T04:10:10Z
tags: [standard, compliance, diagnostic]
source: seed
private: false
title: OS compliance audit
url: internal://standard/os-audit
kind: doc
last_verified: 2026-05-20
---

# OS compliance audit

## What this covers

How the OS verifies its own structure. The runner is `scripts/audit.mjs` (pure Node, no deps), invoked manually via `/os audit` (or `/meta-audit` directly) or from CI. Read-only; never mutates state.

Every check has an `id` (e.g. `skill-name-matches-dir`) that points at the standard it enforces, so a failing audit always tells you which canonical doc to consult.

## Why it exists

Standards documents drift apart from actual files as the OS grows. The audit makes that drift visible in one command. It is the OS's own linter, complementing — not duplicating — Biome (TS/CSS/JSON), Prettier (markdown), and the rebuild-vault-index hook (frontmatter parse).

## Severity model

| severity | meaning                                                    | exit code impact |
| -------- | ---------------------------------------------------------- | ---------------- |
| `error`  | structural violation — the OS would not work correctly     | exits 1          |
| `warn`   | convention deviation — works today but invites future bugs | no impact        |
| `info`   | opportunity / hygiene signal (stale doc, stale manifest)   | no impact        |

## Sections

| flag          | what it audits                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--skills`    | `.claude/skills/<name>/SKILL.md` layout + required frontmatter + name/dir match + domain exists                                                       |
| `--wiki`      | `vault/wiki/**/*.md` shared frontmatter, id-filename match, archetype registration, schedule cron validity, dangling wikilinks, stale `last_verified` |
| `--domains`   | every domain has `playbook.md` with required frontmatter; skill listings match reality                                                                |
| `--templates` | every archetype has BOTH a `_templates/wiki-entry/<name>.md.tmpl` and an `archetype-<name>.md` reference entry                                        |
| `--router`    | every `OS.md` intent vocabulary row maps to an existing skill                                                                                         |
| `--logs`      | every `vault/raw/*.jsonl` parses as one JSON object per line                                                                                          |
| `--dispatch`  | every `claude` subprocess is spawned via `scripts/dispatch-claude.mjs` (the single effort/model resolution point)                                     |
| (default)     | all sections                                                                                                                                          |

## Check registry

Each check has a stable `id`. Standards entries it enforces are listed.

### Skills

| id                                 | severity | what it enforces                                                                                                                                                                                                                                                                                                               | source standard          |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `skill-no-flat-files`              | error    | No `.claude/skills/<name>.md` flat files                                                                                                                                                                                                                                                                                       | `decision-subdir-skills` |
| `skill-subdir-layout`              | error    | Every skill dir contains `SKILL.md`                                                                                                                                                                                                                                                                                            | `standard-skill-format`  |
| `skill-frontmatter-missing`        | error    | Skill `SKILL.md` has a frontmatter block                                                                                                                                                                                                                                                                                       | `standard-skill-format`  |
| `skill-frontmatter-required`       | error    | Required fields: `name`, `description`, `user-invocable`, `version`, `domain`                                                                                                                                                                                                                                                  | `standard-skill-format`  |
| `skill-name-matches-dir`           | error    | Frontmatter `name` matches the directory name                                                                                                                                                                                                                                                                                  | `standard-file-naming`   |
| `skill-user-invocable-bool`        | warn     | `user-invocable` is boolean `true` (not the string `"true"`)                                                                                                                                                                                                                                                                   | `standard-skill-format`  |
| `skill-domain-exists`              | error    | Skill's `domain` field matches a folder under `domains/`                                                                                                                                                                                                                                                                       | `standard-skill-format`  |
| `skill-frontmatter-unquoted-colon` | warn     | Any line in skill frontmatter (top-level or indented) with an unquoted value containing `": "` (the colon-space pattern js-yaml interprets as a nested mapping). Common offender: `description:` lines with inline-code like `` `type: project` `` or `` `status: completed` ``. Catches the parse error before js-yaml fails. | `standard-skill-format`  |
| `skill-frontmatter-parse-error`    | error    | Skill frontmatter failed to parse via js-yaml entirely. Catches edge cases the unquoted-colon scan misses (multi-line YAML, anchor refs, etc.). The dashboard's `/api/skills` ignores domain/description/etc. when parseError is set, so an unparseable skill silently loses metadata.                                         | `standard-skill-format`  |

### Wiki

| id                                  | severity | what it enforces                                                                                                                                                                                                                                                       | source standard             |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `wiki-frontmatter-missing`          | error    | Every entry has a frontmatter block                                                                                                                                                                                                                                    | `standard-wiki-format`      |
| `wiki-frontmatter-required`         | error    | Shared fields: `id`, `type`, `domain`, `created`, `updated`, `tags`, `source`, `private`                                                                                                                                                                               | `standard-wiki-format`      |
| `wiki-id-matches-filename`          | error    | Frontmatter `id` equals filename slug                                                                                                                                                                                                                                  | `standard-file-naming`      |
| `wiki-id-unique`                    | warn     | No two entries share the same `{type, id}` pair. Duplicates cause the dashboard API to pick one arbitrarily and silently drift lifecycle state on the un-picked twin.                                                                                                  | `standard-wiki-format`      |
| `wiki-type-registered`              | error    | `type` is a known archetype                                                                                                                                                                                                                                            | `concept-primitives`        |
| `wiki-domain-exists`                | error    | `domain` matches a folder under `domains/`                                                                                                                                                                                                                             | `standard-file-naming`      |
| `schedule-valid-cron`               | error    | `runbook` with `schedule` field has a valid 5-field cron                                                                                                                                                                                                               | `standard-scheduled-jobs`   |
| `schedule-prompt-required`          | error    | `runbook` with `schedule` also has a non-empty `prompt`                                                                                                                                                                                                                | `standard-scheduled-jobs`   |
| `entry-project-exists`              | error    | Any entry (decision, note, runbook, …) carrying `project: <id>` in frontmatter references a project entity that exists. Covers ownership claims AND scheduled-runbook project scoping in one check.                                                                    | `standard-project-workflow` |
| `project-status-enum`               | error    | `project.status` is one of `active`, `paused`, `completed`, `cancelled`                                                                                                                                                                                                | `standard-project-workflow` |
| `project-lifecycle-stage-enum`      | warn     | `project.lifecycle_stage`, when set, is one of `planning`, `active`, `review`, `shipped`, `archived`                                                                                                                                                                   | `standard-project-workflow` |
| `project-repos-exist`               | error    | Every id in `project.repos` (when set) matches an existing entity with `kind: repo`                                                                                                                                                                                    | `standard-project-workflow` |
| `project-deadline-overdue`          | info     | `project.deadline` is in the past but `status == active`                                                                                                                                                                                                               | `standard-project-workflow` |
| `project-stale`                     | info     | `project.status == active` but newest `updated` across the project entry + any entries it owns is >30 days old. Surfaces "is this still real?" candidates.                                                                                                             | `standard-project-workflow` |
| `project-reporting-target-enum`     | error    | `project.reporting.target` is one of `clipboard`, `notion`, `linear`, `slack`, `none`                                                                                                                                                                                  | `standard-project-workflow` |
| `project-reporting-target-ref`      | error    | When `project.reporting.target` is `notion`/`linear`/`slack`, `target_ref` must be set                                                                                                                                                                                 | `standard-project-workflow` |
| `change-status-enum`                | error    | `change.status` is one of `planning`, `in-progress`, `in-review`, `merged`, `abandoned`                                                                                                                                                                                | `standard-change-workflow`  |
| `change-repo-required`              | error    | Every `change` entry must have a `repo:` field (single-repo by design)                                                                                                                                                                                                 | `standard-change-workflow`  |
| `change-repo-exists`                | error    | `change.repo` references an existing entity with `kind: repo`                                                                                                                                                                                                          | `standard-change-workflow`  |
| `change-size-enum`                  | warn     | `change.size`, when set, is one of `small`, `medium`, `large`                                                                                                                                                                                                          | `standard-change-workflow`  |
| `change-pr-url-format`              | warn     | `change.pr_url`, when set, looks like an HTTP(S) URL                                                                                                                                                                                                                   | `standard-change-workflow`  |
| `change-review-status-enum`         | error    | `change.review_status` is one of `pending`, `approved`, `request-changes`, `rejected`, `overridden`, `not-required`                                                                                                                                                    | `standard-change-workflow`  |
| `change-body-template-placeholder`  | warn     | Planning-state changes whose body has unreviewed content — either template placeholder strings (scaffolder skipped auto-draft, human never filled) OR `**DRAFT**` markers (scaffolder drafted but human hasn't accepted). Catches both before `dev-write-change` does. | `standard-change-workflow`  |
| `change-frontmatter-stale-comments` | warn     | Change frontmatter has inline `# …` hints on active value lines (`size`, `review_required`, `review_status`). The current template carries no such hints, so this fires when a writer composed from memory instead of reading the live template.                       | `standard-change-workflow`  |
| `reference-stale-verified`          | info     | `reference` entries with `last_verified` > 90 days old                                                                                                                                                                                                                 | (hygiene)                   |
| `wiki-link-dangling`                | warn     | `[[id]]` in any wiki entry OR SKILL.md body resolves to either a wiki entry id or a skill name (code fences are skipped). EditableMarkdown resolves the same set: skills route to the Skills view, others to Vault.                                                    | `standard-wiki-format`      |
| `automation-stuck-running`          | warn     | A project's `automation.state.phase` has been `running` for more than 60 minutes. Usually means the dispatched skill hung or the auto-tick path failed silently. Resolution: Pause + inspect the current run, then Resume or Stop.                                     | `standard-project-workflow` |
| `automation-stale-paused`           | info     | A project's `automation.state.phase` has been `paused` for more than 7 days. Surfaces forgotten pauses so the user makes the explicit Resume-or-Stop decision instead of leaving the orchestrator dormant indefinitely.                                                | `standard-project-workflow` |

### Domains

| id                                     | severity | what it enforces                                                  | source standard            |
| -------------------------------------- | -------- | ----------------------------------------------------------------- | -------------------------- |
| `domain-playbook-required`             | error    | Every domain folder has a `playbook.md`                           | `standard-playbook-format` |
| `domain-playbook-frontmatter-missing`  | error    | Playbook has a frontmatter block                                  | `standard-playbook-format` |
| `domain-playbook-frontmatter-required` | error    | Frontmatter has `domain`, `version`, `created`, `updated`         | `standard-playbook-format` |
| `playbook-skill-coverage`              | warn     | Every skill claiming a domain is listed in that domain's playbook | `standard-playbook-format` |
| `playbook-skill-exists`                | warn     | Every skill listed in a playbook actually exists                  | `standard-playbook-format` |

The skill-coverage checks deliberately stop at "Planned" sub-headings or subsequent H2/H3 — aspirational entries don't count as claims.

### Templates / archetypes

| id                             | severity | what it enforces                                                               | source standard      |
| ------------------------------ | -------- | ------------------------------------------------------------------------------ | -------------------- |
| `archetype-template-required`  | error    | Every archetype with a reference entry has a matching `.md.tmpl`               | `concept-primitives` |
| `archetype-reference-required` | error    | Every archetype with a template has a matching `archetype-<name>.md` reference | `concept-primitives` |

### Router

| id                              | severity | what it enforces                                                                                                                                      | source standard |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `router-os-md-missing`          | error    | `OS.md` exists at repo root                                                                                                                           | `OS.md`         |
| `router-vocab-missing`          | warn     | `OS.md` has an "Intent vocabulary" section                                                                                                            | `OS.md`         |
| `router-vocab-skill-exists`     | error    | Every vocab row maps to a skill that exists                                                                                                           | `OS.md`         |
| `router-vocab-skill-uncovered`  | warn     | Every `user-invocable: true` skill appears in OS.md's intent vocabulary (so `/os <intent>` can route to it)                                           | `OS.md`         |
| `router-vocab-duplicate-phrase` | error    | No intent phrase appears on two vocabulary rows — an exact-tie phrase makes `/os <phrase>` dispatch ambiguous (and invisible to the miss-rate metric) | `OS.md`         |

### Logs

| id                           | severity | what it enforces                                                             | source standard        |
| ---------------------------- | -------- | ---------------------------------------------------------------------------- | ---------------------- |
| `log-jsonl-valid`            | warn     | Every line of `vault/raw/*.jsonl` parses as JSON (empty lines allowed)       | `standard-log-formats` |
| `log-documented-in-standard` | warn     | Every `vault/raw/*.jsonl` filename is mentioned in `standard-log-formats.md` | `standard-log-formats` |

### Skill-id constants (app ↔ skill coupling)

| id                        | severity | what it enforces                                                                                                                                                                                               | source standard          |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `skill-ids-module-stale`  | error    | `domains/meta/app/server/lib/skill-ids.ts` byte-equals what `scripts/generate-skill-ids.mjs` would emit from `.claude/skills/`. Regenerated by meta-add-skill / meta-rename / meta-delete.                     | `generate-skill-ids.mjs` |
| `app-stale-skill-literal` | error    | No whole-string literal in app server/src code looks like a skill id without naming a real skill, wiki entry id, or archetype — the residue class a rename/deletion leaves behind (the undeletable-alias bug). | `generate-skill-ids.mjs` |

### Dispatch

| id                              | severity | what it enforces                                                                                                                                                                                           | source standard       |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `dispatch-spawn-outside-helper` | error    | No `spawn('claude', …)` outside `scripts/dispatch-claude.mjs`. Every other spawn site silently skips effort/model resolution — the drift class that left cron-fired runs unconfigured across two releases. | `dispatch-claude.mjs` |

### Manifest

| id                | severity | what it enforces                                          | source standard         |
| ----------------- | -------- | --------------------------------------------------------- | ----------------------- |
| `manifest-exists` | info     | `vault/.index/manifest.json` exists                       | `standard-index-schema` |
| `manifest-valid`  | error    | Manifest parses as JSON                                   | `standard-index-schema` |
| `manifest-stale`  | info     | Newest wiki entry mtime is not after `manifest.generated` | `standard-index-schema` |

### Event store

| id                                 | severity | what it enforces                                                                                                                                                                                                                                                                                                                                                               | source standard        |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `events-db-exists`                 | info     | `.claude/state/events.db` is present. Surfaced only when missing — opt-in until the user runs `events-db-init`.                                                                                                                                                                                                                                                                | `standard-event-store` |
| `events-db-readable`               | error    | When `events.db` exists, it can be opened via `node:sqlite`. Fires only on a corrupt or permission-denied file.                                                                                                                                                                                                                                                                | `standard-event-store` |
| `events-db-schema-current`         | error    | Actual `events` table columns match the `EXPECTED_COLUMNS` set declared in `scripts/events-db-init.mjs`. Missing columns are errors; extra columns are info.                                                                                                                                                                                                                   | `standard-event-store` |
| `dual-write-parity`                | warn     | For each JSONL/kind pair (`router-log` ↔ `router`, `dashboard-actions` ↔ `dashboard`, `scheduled-runs` ↔ `schedule`), JSONL line count is within 2 of the events.db row count. Catches a write site that appends JSONL but skips `recordEvent`.                                                                                                                                | `standard-event-store` |
| `events-skill-attribution-missing` | warn     | Events whose `skill` is one of the change-scoped skills (`dev-write-change`, `dev-review-change`, `dev-open-pr`, `dev-close-change`, `dev-pr-review`, `dev-add-change`, `dev-address-comments`) MUST have `change_id` set. Catches drift in `recordEvent` callers that forget to lift the change id out of the prompt/intent/path via `scripts/extract-event-attribution.mjs`. | `standard-event-store` |

### Installer

| id                            | severity | what it enforces                                                                                                                                    | source standard        |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `installer-exists`            | warn     | `install.sh` is present at repo root.                                                                                                               | `standard-event-store` |
| `installer-seeds-event-store` | warn     | `install.sh` calls `scripts/events-db-init.mjs` so a fresh clone gets a ready DB. Catches drift between the installer and the event-store standard. | `standard-event-store` |

### MCPs

| id                             | severity | what it enforces                                                                                                                                                                                                                 | source standard             |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `mcp-manifest-required-fields` | error    | Every `mcps/<id>/manifest.json` has `id, domain, description, transport, command, args`                                                                                                                                          | `standard-mcp-architecture` |
| `mcp-id-folder-match`          | error    | `manifest.id` equals the parent folder name                                                                                                                                                                                      | `standard-mcp-architecture` |
| `mcp-domain-exists`            | error    | `manifest.domain` exists as a directory under `domains/`                                                                                                                                                                         | `standard-mcp-architecture` |
| `mcp-env-example-present`      | warn     | If `manifest.env` declares vars, `.env.example` exists and documents each                                                                                                                                                        | `standard-mcp-architecture` |
| `mcp-env-example-no-secrets`   | error    | `.env.example` has no non-empty `KEY=value` lines. The template is committed; real values belong in `.env` (gitignored). Catches the common foot-gun of pasting a real PAT into the template.                                    | `standard-mcp-architecture` |
| `mcp-config-stale`             | info     | `.mcp.json` at repo root matches the discovered manifests — suggests `node scripts/sync-mcp-config.mjs`                                                                                                                          | `standard-mcp-architecture` |
| `mcp-tool-orphan`              | info     | Every tool declared in an MCP manifest is referenced by at least one skill (via `mcp__<server>__<tool>` or the bare tool name). Orphans suggest dead infra OR a planned-but-unbuilt consumer skill. Either wire it up or remove. | `standard-mcp-architecture` |

### Event store

| id                | severity | what it enforces                                                                                                                                                                                                                          | source standard        |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `events-db-stale` | info     | `events.db` has been written to within the last 14 days. Distinguishes "nobody's using the OS" (legitimate quiet period) from "OS is being used but recording pipeline is broken" — both surface as the same warning since we can't tell. | `standard-event-store` |

### Changes (lifecycle drift)

| id                                 | severity  | what it enforces                                                                                                                                                                                                                                                                            | source standard            |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `change-pr-frozen-but-not-merged`  | info      | Changes with `pr_url` set + `status: in-review` + `ci_state: pass` and no activity for >7 days. CI is green but the PR is sitting — the human probably forgot to merge.                                                                                                                     | `standard-change-workflow` |
| `stale-pr-review-status-on-merged` | info/warn | A merged change carries `pr_review_status` other than `ready-for-human` (excluding cases where review was not required). Indicates the merge bypassed the OS-side sign-off — flag so the audit trail can be back-filled. `warn` severity when status is `needs-changes` on a merged change. | `standard-change-workflow` |
| `deferred-comments-age`            | info      | At least one comment with `status: new` sits on a `pr-review` entry linked to a `merged` change, older than 7 days. Untriaged feedback after merge — either dismiss or scaffold a follow-up change.                                                                                         | `standard-change-workflow` |

### Reviews (indexing drift)

| id                                 | severity | what it enforces                                                                                                                                                                                                                                                                           | source standard                  |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `repo-knowledge-stale`             | info     | A `repo-knowledge` entry's `analyzed_at` is older than 30 days, OR its `based_on_commit` no longer matches the companion cache's `head_sha`. Reviews against this repo may use generic-best-practice judgments instead of repo-specific ones. Hint: re-analyze via the Repos tab or `/os`. | `archetype-repo-knowledge`       |
| `pr-review-cache-orphan-owner-dir` | info     | An empty `<owner>/` shell remains under `.claude/state/pr-review-cache/`. Leftover from a partial eviction (e.g. an ad-hoc `rm` of just the inner repo dir from a script). Cosmetic; not dangerous. Hint: `rmdir` the surfaced path.                                                       | `archetype-pr-review-repo-cache` |

### Runtime / sync gaps

| id                 | severity | what it enforces                                                                                                                                                                                                      | source standard        |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `git-sync-gap`     | info     | For every `kind: repo` entity with a `remote_url`, local `default_branch` HEAD matches `origin/<default_branch>` HEAD (via `git ls-remote`, no fetch). Catches the local clone drifting after a GitHub-side merge.    | `archetype-entity`     |
| `orphan-run-jsonl` | info     | Every `.claude/state/runs/*.jsonl` file has a matching row in `events.db.runs`. Orphans accumulate from manual deletes or crashed cap-evictors. Hint: remove the JSONL files whose id isn't in `SELECT id FROM runs`. | `standard-event-store` |

### Project orchestration (plan lifecycle drift)

| id                                   | severity | what it enforces                                                                                                                                                                                                                                                   | source standard             |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `plan-file-orphan`                   | info     | Every `vault/output/<domain>/project-plans/*.md` file (excluding `*-plan-review.md`) is referenced by some project entry's `plan_path`. Catches plan files left over after a project was deleted.                                                                  | `standard-project-workflow` |
| `plan-status-stuck-in-research`      | warn     | A project with `plan_status: in-research` and no `updated` activity for >1 hour. Strong signal the `meta-research-project` run crashed without resetting the frontmatter.                                                                                          | `standard-project-workflow` |
| `plan-approved-but-unscaffolded`     | info     | A project with `plan_status: approved` and no `updated` activity for >7 days. Cost was spent on planning that never converted to work — either scaffold or revise/abandon.                                                                                         | `standard-project-workflow` |
| `materials-orphan`                   | info     | `vault/raw/project-research/<id>/` directory exists but no project entry has that id, OR the matching project is `completed`/`cancelled` and `updated` is >30 days old. Cleanup signal.                                                                            | `standard-project-workflow` |
| `events-project-attribution-missing` | warn     | Events whose `skill` is one of the project-scoped skills (`meta-research-project`, `meta-review-project-plan`, `meta-revise-project-plan`, `meta-scaffold-project-plan`) MUST have `project` set. Mirrors `events-skill-attribution-missing` for the project axis. | `standard-event-store`      |

### Research lifecycle

| id                                                   | severity | what it enforces                                                                                                                                                                                                                                                      | source standard             |
| ---------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `research-materials-stale`                           | warn     | A `research-report`'s `last_data_ingest` is >7 days old AND at least one file under `materials_path` has an mtime newer than `last_data_ingest`. Surfaces drift between an existing report and freshly-dropped materials.                                             | `archetype-research-report` |
| `research-orphan-materials-dir`                      | info     | A `vault/raw/project-research/<project>/<report>/` directory exists with no matching `research-report` entry. Either the report was deleted or never created.                                                                                                         | `archetype-research-report` |
| `research-recommended-changes-scaffolded-not-merged` | info     | A `research-report.recommended_changes[]` item with `status: scaffolded` points at a change still in-flight (`planning`/`in-progress`/`in-review`) that has been idle for >14 days. Cost was spent recommending work that's blocked.                                  | `archetype-research-report` |
| `research-recommended-changes-status-drift`          | warn     | A `research-report.recommended_changes[].status` disagrees with the linked change's actual `status` (e.g. report says `scaffolded` but the change is `merged`, or the change has been deleted entirely). Audit-trail rot — re-run `research-update`.                  | `archetype-research-report` |
| `events-report-attribution-missing`                  | warn     | Events whose `skill` is one of the report-scoped skills (`research-write`, `research-review`, `research-revise`, `research-update`, `research-scaffold-recommendations`) MUST have `report_id` set. Mirrors `events-project-attribution-missing` for the report axis. | `standard-event-store`      |

### App design

| id                          | severity | what it enforces                                                                                                                                                                                                                                                                     | source standard             |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `app-design-banner-reducer` | warn     | A `.tsx` under `apps/<id>/` that renders `<ActionBanner>` from 3+ inline if-branches without defining/importing/calling a `stateFor()` reducer. Multi-state banners belong behind a named reducer for testability + match-case rendering.                                            | `standard-app-design` §11.1 |
| `app-design-filter-chips`   | info     | A `.tsx` under `apps/<id>/pages/List.tsx` (or `List*.tsx`) that uses `<select>` for status-style filtering instead of the canonical chip-row pattern. Suggestive — many list pages legitimately keep selects for non-status axes.                                                    | `standard-app-design` §11.3 |
| `app-design-stepper`        | info     | A `.tsx` under `apps/<id>/pages/Detail.tsx` (or `View.tsx`) that renders a tabbar without importing `<Stepper>` from `shared/stepper.tsx`. Multi-stage workflow detail pages should show their stage progression above the tab bar. Soft-flag — not every detail page is a workflow. | `standard-app-design` §11.4 |

### Notifications

| id                                 | severity | what it enforces                                                                                                                                                                                                                                                               | source standard                                    |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `notification-rule-orphan`         | warn     | An `events.db` row with `kind='notification'` and `source='rule:<id>'` (with optional `:test` suffix) whose `<id>` no longer matches any rule on disk under `vault/wiki/<domain>/notification-config/`. Indicates a deleted/renamed rule with orphaned historical attribution. | `archetype-notification-config`                    |
| `notification-rate-limit-exceeded` | info     | One or more rules hit their rate-limit cap in the last 24h (`kind='notification' AND action='suppressed-rate-limit'`). Auto-clears when the cap stops biting. By-design surface — caps tripping is normal but worth knowing per-rule.                                          | `automation-and-notifications-notification-config` |
| `notification-delivery-failed`     | warn     | One or more rules had permanent delivery failures in the last 24h (`kind='notification' AND action='failed'`). The dispatcher is fire-and-forget after one synchronous retry; this surfaces the loss with the latest adapter error in the hint.                                | `automation-and-notifications-notification-config` |

### New-state coverage (session 2026-05-30)

Hooks that cover state introduced after the bell-affordance + research-notes + dismissed-action-items work landed. Each catches the drift case for one piece of new OS state.

| id                             | severity | what it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                               | source standard                           |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `runbook-orphan`               | warn     | A `runbook` entry has `project: <id>` in frontmatter but no project entity has that id. The schedule-report endpoint scaffolds project-scoped runbooks; if the project is later deleted/renamed, the runbook keeps firing with a broken reference. Fix by restoring the project, editing the runbook, or deleting it.                                                                                                                                          | `archetype-runbook`                       |
| `notes-unconsidered-stale`     | info     | A research-report's `notes_log` contains entries with empty `considered_by` AND `ts > 14 days ago`. The hybrid-persistence model expects unconsidered notes to be folded into the NEXT review/revise/update run; stale-unconsidered means user guidance is silently sitting unaddressed.                                                                                                                                                                       | `archetype-research-report` § `notes_log` |
| `dismissed-action-items-stale` | info     | `.claude/state/dismissed-action-items.jsonl` contains entries whose audit-check-id is no longer in the live check registry. Common cause: a check was renamed/removed but the user's old dismissal still references the old id. Housekeeping — the file can be edited to drop the stale rows.                                                                                                                                                                  | this standard                             |
| `env-var-undocumented`         | warn     | A `process.env.<NAME>` read in server or MCP source code where `<NAME>` isn't declared (commented or uncommented) in any `.env.example` file. Walks `domains/*/app/server/**` + `mcps/**` for refs; reads `domains/*/app/.env.example` + `mcps/*/.env.example` for docs. Whitelists runtime-injected names (`CLAUDE_PROJECT_DIR`) + Node conventions (`NODE_ENV`, `HOME`, `PATH`, etc). Drift case: new env var added to code without updating `.env.example`. | `standard-env-config`                     |

### Self-healing fills (closing standard-self-healing known gaps)

| id                                       | severity | what it enforces                                                                                                                                                                                                                                                                                        | source standard            |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `runbook-schedule-invalid`               | warn     | A `runbook` entry has `schedule:` frontmatter that isn't a valid 5-field cron expression. The scheduler tick silently skips invalid crons; this surfaces the gap proactively. Validates field count + characters (digits, `*`, `/`, `,`, `-`).                                                          | `standard-scheduled-jobs`  |
| `notification-template-missing-override` | info     | An event_type in the event-catalog has fired at least once in events.db but has no `notification-<event>.md` template override. Suggestion-only (the fallback to `notification-default.md` is by-design). Gentle nudge for polish on actively-firing events.                                            | `standard-template-syntax` |
| `catalog-lifecycle-step-invalid`         | warn     | A row in `event-catalog.md` has a `lifecycle_step` value with malformed syntax (missing `:`) OR references an unknown context. Valid contexts: `change`, `research-report`, `project`. Typos would silently break bell rendering — the stepper queries by context prefix and finds nothing.             | `event-catalog`            |
| `dynamic-process-env-indexing`           | info     | A `process.env[<expr>]` dynamic access in server or MCP source. Complements `env-var-undocumented` (static accesses only). Dynamic accesses bypass static doc enforcement; flagged as info so the maintainer can decide (often: add the file to the in-script whitelist if it's loader/bootstrap code). | `standard-env-config`      |

### Audit-of-the-audit

| id                          | severity | what it enforces                                                                                                                                                         | source standard |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `audit-check-id-documented` | warn     | Every audit check `id` implemented in `scripts/audit.mjs` is documented in this file, and vice versa (no orphaned doc rows). Catches drift in the audit registry itself. | this entry      |

This check runs unconditionally (no `--section` flag gates it) because the drift it catches is global to the audit — not scoped to any one primitive. The check exempts itself from the implemented-set so it doesn't self-report.

## What it deliberately does not check

- **Code formatting** — Biome and Prettier own that
- **Body structure** ("does skill have H2 'Purpose'") — too easy to false-positive; not worth the noise
- **Judgement** ("are two entries duplicates", "is this skill useful") — Claude's job, not the linter's
- **Auto-fix** — v1 is read-only. Fix via the appropriate `meta-*` skill or freehand

## Usage

```bash
# Run all checks
node scripts/audit.mjs

# Filter by section
node scripts/audit.mjs --skills
node scripts/audit.mjs --wiki

# Machine-readable output for CI / pre-commit hooks
node scripts/audit.mjs --json

# From within Claude Code
/os audit
/meta-audit              # direct invocation
```

Exit code: `0` if no ERRORs, `1` otherwise. WARNs and INFO don't fail the audit.

## How to add a new check

1. Add a function (or extend an existing one) in `scripts/audit.mjs`.
2. Push findings with a unique `id` — kebab-case, scoped (`skills-*`, `wiki-*`, `schedule-*`, etc.).
3. Add a row in this standard's **Check registry** with severity + source standard.
4. Run the audit against the current OS — it must pass before you ship the new check (otherwise it's a backlog item, not a check).

## Retirement

If a check produces consistent false positives, soften (error → warn → info → remove) — but only after writing a `decision-*.md` explaining why. Removing a check silently is the same kind of debt as removing a test.

## Related

- [[standard-self-healing]] — the broader principle this audit script implements (one pillar of four; coverage matrix lives there)
- [[standard-feature-anatomy]] — every new feature should pass an audit before shipping
- [[concept-primitives]] — what kinds of things the audit knows about
- [[meta-audit]] — the user-facing skill wrapper around `scripts/audit.mjs`
- [[standard-skill-format]] · [[standard-wiki-format]] · [[standard-playbook-format]] · [[standard-file-naming]] · [[standard-log-formats]] · [[standard-scheduled-jobs]] · [[standard-change-workflow]] · [[standard-project-workflow]]
