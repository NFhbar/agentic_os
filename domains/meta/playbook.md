---
domain: meta
version: 1
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
---

# Meta — the OS itself as a domain

## Purpose

Meta holds the OS's self-knowledge: standards, evolution skills, scaffolding templates, the dashboard. Every action that modifies OS structure — adding domains, skills, apps, archetypes — routes through this domain.

## Entities

- **Skill** — invokable action, lives in `.claude/skills/<name>.md`
- **Playbook** — domain's markdown protocol, lives in `domains/<domain>/playbook.md`
- **App** — optional visual UI for a domain, lives in `domains/<domain>/<app>/app/`
- **Archetype** — typed wiki entry kind (entity, decision, runbook, reference, project, note + any registered later)
- **Template** — scaffolder source, lives in `_templates/<thing>/`
- **Hook** — lifecycle script, lives in `.claude/hooks/<name>.sh`
- **MCP** — structured tool surface for external services or internal subsystems, lives in `mcps/<id>/`. See `standard-mcp-architecture.md`.

## Skills

- `os` — router; dispatches `/os <intent>` to the right downstream skill
- `meta-dashboard` — launch the OS dashboard
- `meta-add-domain` — scaffold a new domain
- `meta-add-skill` — scaffold a new skill
- `meta-add-app` — scaffold a new Vite + React + Fastify app inside a domain
- `meta-add-mcp` — scaffold a new MCP server (structured tool surface — GitHub, Slack, etc.) under `mcps/<id>/`
- `meta-add-archetype` — register a new wiki archetype
- `meta-curate` — promote raw items into typed wiki entries
- `meta-evolve` — generic OS modification (escape hatch)
- `meta-rename` — rename a skill, domain, or wiki entry; updates cross-references
- `meta-delete` — delete a skill, domain, or wiki entry; cleans up cross-references
- `meta-brief` — session brief / status
- `meta-add-schedule` — scaffold a scheduled runbook (cron + prompt the OS fires when due)
- `meta-add-project` — scaffold a project (scope + lifecycle + reporting cadence; optionally linked to an ingested repo)
- `meta-reopen-project` — flip a completed project back to `status: active` (vault-only frontmatter edit). CLI equivalent of the dashboard's Reopen button on the project status banner.
- `meta-status-report` — generate a project status report — synthesizes commits, decisions, scheduler activity, milestones into structured markdown
- `meta-audit` — audit the OS for compliance with documented standards (skills, wiki, domains, archetypes, router, logs)
- `meta-vault-query` — typed query interface over the OS vault via the `vault` MCP. Three modes: `search` (full-text + filters), `get` (fetch entry by id/path), `list-archetypes` (enumeration). Read-only. The canonical access pattern when skills or the user need vault context richer than a manifest read.
- `meta-research-project` — (deprecated) alias for [[research-write]]; emits a one-time warning + delegates. Removal candidate after phase E of the [[research-domain]] project.
- `meta-mark-research-approved` — override a research-report's `review_status: request-changes → approved` (vault-only). The CLI escape hatch when the user disagrees with the reviewer's verdict; parallel to the dashboard's Mark approved banner action.
- `meta-add-research-note` — append a mid-lifecycle guidance note to a research-report's `notes_log`. Note carries severity (info/warn/blocker) + considered_by chain that downstream skills (review/revise/update) extend as they fold the note in.
- `meta-add-note` — scaffold a generic note entry (domain- or project-scoped observation, lesson, friction log). Vault-only — writes a single markdown file under `vault/wiki/<domain>/note/`. For stand-alone notes that don't fit decision / change / research-report archetypes.
- `meta-add-skill-to-playbook` — register an existing skill in its domain's playbook Skills section. Idempotent. Resolves the `playbook-skill-coverage` audit finding for skills added outside meta-add-skill.
- `meta-add-skill-to-router-vocab` — register an existing skill in OS.md's Intent vocabulary table so `/os <intent>` can route to it. Idempotent. Resolves the `router-vocab-skill-uncovered` audit finding.
- `meta-overseer-review` — audit a completed change lifecycle. Reads the full lifecycle (plan + review + execute + PR-review passes + events.db), applies the 3-dimension rubric (correctness / completeness / efficiency) per skill that ran, emits a structured `lifecycle-audit` entry with scores, categorical tags, and concrete skill-tuning suggestions. Drives the self-improvement loop. Opt-in per project via `audit:` frontmatter block.
- `meta-audit-followups` — Phase 3 forward-link aggregator for the Overseer arc. Scans provisional `lifecycle-audit` entries, finds subsequent merged changes that touched the same files, classifies each follow-up (fix / refactor / feat-extension / feat-rewrite / test / docs), appends `followup_signals[]`, and retroactively adjusts the audit's `correctness` score. Promotes audits to `final` after the 90-day forward-look window closes with no recent follow-ups. Designed as a daily scheduled job.
- `meta-apply-tuning-suggestion` — Phase 4 of the Overseer arc. Converts a tuning suggestion from a `lifecycle-audit` into a proposed unified diff against the target SKILL.md. Two modes: `propose` (default — writes diff + rationale to `vault/output/meta/tuning-proposals/`, no mutation) and `apply` (gated on a decision-archetype entry citing `implements_tuning_suggestions: [{audit_id, suggestion_index}]`). The decision gate is the design discipline: skill changes are never auto-applied from suggestion text alone. Exposed in the dashboard via Overseer audit detail's "Propose edit" / "Promote to decision" / "Dismiss" action buttons.
- `meta-review-project-plan` — read-only peer-review of a project plan; writes a structured verdict (approve / request-changes / reject) and flips `plan_status` accordingly
- `meta-revise-project-plan` — folds review findings back into the project plan in place; bumps `plan_revision`, resets `plan_status: reviewed-pending` so the revised plan returns to review
- `meta-scaffold-project-plan` — terminal phase; gated on `plan_status: approved`; dispatches `dev-add-change` / `meta-add-schedule` / direct frontmatter edits to materialize the approved plan's items

## Apps

- `meta-dashboard-app` — Vite + React + Fastify OS dashboard (ships with v1, lives at `domains/meta/app/`)

## Sub-domains

(none for meta; one exists in `development/pr-review/`)

### How sub-domains work today

Sub-domains are **playbook nesting only** — a folder under a domain that carries its own `playbook.md` and shows up in the sidebar tree under its parent. They do NOT carry independent runtime behavior:

- The `manifest.domain` field on apps targets a **top-level domain**, not a sub-domain (e.g. the pr-review app declares `domain: development`, not `domains: development/pr-review`).
- Skills declare their owning top-level domain in frontmatter (`domain: development`); the skill name prefix (`dev-pr-review`) carries the sub-area hint as a _convention_, not as enforced state.
- The per-domain rollup at `GET /api/domains/rollup?path=<x>` matches the `domain` column in `events.db` literally — sub-domain rollups currently mirror their parent's totals because the event-attribution helper writes the top-level domain.
- Vault paths follow `vault/wiki/<top-level-domain>/<archetype>/<slug>.md`. The sub-domain folder under `domains/` is independent of the vault layout.

**When to create a sub-domain:** when a domain has a substantial sub-area worth its own playbook + conventions (e.g. PR review within development). The sub-domain folder hosts its playbook; everything else (skills, apps, vault paths) attributes to the parent.

**When NOT to create one:** if you'd just write 2–3 paragraphs in the playbook — keep it inline as an H2 section under the parent. Sub-domains are reserved for areas with their own contracts, conventions, or extension points.

A future evolution might promote sub-domains to first-class (per-sub-domain rollups, sidebar nesting, sub-domain-scoped audit). For now, treat them as documentation-grouping affordances.

## Conventions

- Skills live ONLY in `.claude/skills/` (flat, filename == skill name)
- Templates live in `_templates/` at repo root
- Hooks are bash scripts in `.claude/hooks/` (+ .mjs helpers when needed)
- Standards documented here + reference entries in `vault/wiki/_seed/meta/`

## Cross-domain links

Meta touches every other domain because OS evolution affects them all. Significant evolution decisions get a `decision` archetype entry here and links from affected domains.

---

# OS Standards (master reference)

The detailed contracts live as `reference` archetype entries under `vault/wiki/_seed/meta/`. The summaries below are enough to act; consult the seed entries when authoring scaffolders or validators.

## 1. Skill format

Every skill lives at `.claude/skills/<name>/SKILL.md` (one directory per skill — the CC harness does NOT discover flat `.md` files at `.claude/skills/<name>.md`). Required frontmatter:

| field            | type    | required | notes                                                 |
| ---------------- | ------- | -------- | ----------------------------------------------------- |
| `name`           | string  | yes      | kebab-case, == directory name                         |
| `description`    | string  | yes      | one-line summary; used by harness for discovery       |
| `user-invocable` | boolean | yes      | `true` exposes the skill as `/<name>` slash command   |
| `version`        | integer | yes      | bump on breaking change                               |
| `domain`         | string  | yes      | owning domain (OS extension)                          |
| `tags`           | array   | no       | for filtering                                         |
| `inputs`         | object  | no       | schema map; if present, dashboard auto-renders a form |
| `outputs`        | array   | no       | declarative side-effects                              |
| `spawns`         | array   | no       | other skills this one delegates to                    |

Body sections (h2, in order): Purpose → Inputs → Procedure → Outputs → Errors.

Detail: `vault/wiki/_seed/meta/reference/standard-skill-format.md`

## 2. Wiki entry format

Every entry under `vault/wiki/` carries shared frontmatter:

`id, type, domain, created, updated, tags, source, private`

Plus per-archetype required fields (see archetype reference entries).

**Primary key convention.** Every archetype's primary key is the bare `id:` field — never `<entity>_id:` (e.g., `rule_id`, `report_id`, `change_id`). The `<entity>_id` form is **only** used as a foreign-key reference from a different entry. When authoring a new archetype contract or template, the primary key is always `id:`. Surfaced 2026-05-27 after LLM-authored plans repeatedly introduced `<entity>_id` as the primary key on new archetypes, requiring revise rounds to reconcile.

Detail: `vault/wiki/_seed/meta/reference/standard-wiki-format.md` and `vault/wiki/_seed/meta/reference/archetype-*.md`

## 3. Playbook format

Every `domains/<x>/playbook.md` has:

- Frontmatter: `domain, version, created, updated`
- H1 title
- H2 sections: Purpose, Entities, Skills, Apps, Sub-domains, Conventions, Cross-domain links

Optional additional H2s allowed below the required set.

Detail: `vault/wiki/_seed/meta/reference/standard-playbook-format.md`

## 4. App layout

Every app at `domains/<x>/<app>/app/` contains:

- `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- `src/main.tsx`, `src/App.tsx`, `src/lib/{vault,api}.ts`
- `server/index.ts`, `server/auth.ts`, `server/routes/{vault,action}.ts`
- `README.md`

Launch skill lives at `.claude/skills/<domain>-<app>-app.md` (not in the app folder).

Detail: `vault/wiki/_seed/meta/reference/standard-app-layout.md`

## 5. Log formats

Two layers, written in parallel (dual-write) for safety during the events.db rollout:

**JSONL** — append-only audit trail, one event per line, grep-friendly.

| log               | path                                | shape                                                                             |
| ----------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| router dispatch   | `vault/raw/router-log.jsonl`        | `{ts, intent, matched_skill, confidence, fallback}`                               |
| dashboard actions | `vault/raw/dashboard-actions.jsonl` | `{ts, action, args?, files_touched?, exit_status, prompt?}`                       |
| scheduled fires   | `vault/raw/scheduled-runs.jsonl`    | `{ts, id, schedule, prompt, project?, exit, duration_ms, stdout_preview, stderr}` |

**Structured event store** — indexed SQL, one row per action, queryable for analytics.

| store                     | purpose                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `.claude/state/events.db` | Single `events` table; columns include model, tokens, cost, duration, files_touched, status. See §20. |

**Plain-text state:**
| file | format |
|------|--------|
| `.claude/state/pending-curation.txt` | one relative path per line |
| `.claude/state/installed-at` | single ISO 8601 line |

The audit's `dual-write-parity` check warns if JSONL line count diverges from events.db row count per kind — catches a write site that forgets one of the two layers.

Detail: `vault/wiki/_seed/meta/reference/standard-log-formats.md` + `vault/wiki/_seed/meta/reference/standard-event-store.md`

## 6. Template syntax

Mustache placeholders: `{{var}}`. Standard variables:

- `{{name}}`, `{{display_name}}`, `{{purpose}}`, `{{description}}`
- `{{domain}}`, `{{app_name}}`
- `{{datetime}}` (ISO 8601 UTC), `{{date}}` (YYYY-MM-DD)
- `{{uuid}}`, `{{slug}}`, `{{source}}`, `{{title}}`, `{{body}}`

No loops or conditionals in v1. Complex generation → use a scaffolder skill instead.

Detail: `vault/wiki/_seed/meta/reference/standard-template-syntax.md`

## 7. Hook protocol

Every script in `.claude/hooks/`:

- Reads CC's hook JSON event from stdin
- Writes only to `.claude/state/` or `vault/raw/`
- Exits 0 on success, non-zero on failure
- Is idempotent and fast (<200ms target)
- Written in bash (with `.mjs` Node helpers when JSON/YAML parsing is needed)

Detail: `vault/wiki/_seed/meta/reference/standard-hook-protocol.md`

## 8. File-naming

| thing         | pattern                                                 |
| ------------- | ------------------------------------------------------- |
| skill         | `<domain>-<verb>-<noun>.md` (or `os.md` for the router) |
| domain folder | lowercase-kebab                                         |
| wiki entry    | `vault/wiki/<domain>/<archetype>/<slug>.md`             |
| output file   | `vault/output/<domain>/<kind>/<slug>.md`                |
| template      | `<thing>.md.tmpl` (or matching extension)               |
| log           | `<purpose>-log.jsonl`                                   |
| hook script   | `<purpose>.sh`                                          |

Detail: `vault/wiki/_seed/meta/reference/standard-file-naming.md`

## 9. Index manifest schema

`vault/.index/manifest.json`:

```json
{
  "version": 1,
  "generated": "<ISO>",
  "entries": [
    {
      "path": "vault/wiki/<...>",
      "id": "...",
      "type": "<archetype>",
      "domain": "...",
      "title": "...",
      "created": "...", "updated": "...",
      "tags": [...],
      "source": "...",
      "private": false,
      "snippet": "<200 chars>",
      "backlinks": [...]
    }
  ]
}
```

Rebuilt by `.claude/hooks/rebuild-vault-index.sh` after any Write/Edit to `vault/wiki/`.

Detail: `vault/wiki/_seed/meta/reference/standard-index-schema.md`

## 10. Memory archetypes (current registry)

| archetype             | purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `entity`              | person, project, repo, system                                                                      |
| `decision`            | architectural/design decision + rationale                                                          |
| `runbook`             | repeatable procedure                                                                               |
| `reference`           | pointer to external resource                                                                       |
| `project`             | active initiative                                                                                  |
| `notification-config` | one routing rule for the dispatch engine — per (event, channel) with filters + rate-limit override |
| `note`                | free-form (escape hatch)                                                                           |

Adding new archetypes: `/os add-archetype`. Detail per archetype: `vault/wiki/_seed/meta/reference/archetype-*.md`.

## 11. AI bridge (dashboard → claude CLI)

How an app's UI triggers AI-driven OS actions: backend shells out to `claude -p`, streams output via SSE, audit-logs to `vault/raw/dashboard-actions.jsonl`. All "add X" / "rename X" / "delete X" dashboard flows go through this bridge.

Detail: `vault/wiki/_seed/meta/reference/standard-ai-bridge.md`

## 12. Linting + formatting

Biome for TS/JS/CSS/JSON inside apps (per-app); Prettier for Markdown OS-wide (root). A single PostToolUse hook (`auto-format.sh`) routes each file to the right tool.

Detail: `vault/wiki/_seed/meta/reference/standard-linting.md`

## 13. Dashboard authoring patterns

Reusable components and libs for any app: `ActionRunner` (AI bridge UI), `ScaffoldForm` (schema-driven forms), `EditableMarkdown` (view+edit), `RenameModal`/`ConfirmModal` (destructive ops), `NavigationContext` (cross-view wikilink nav).

Detail: `vault/wiki/_seed/meta/reference/standard-dashboard-patterns.md`

## 14. Scheduled jobs (heartbeat)

A `runbook` entry with optional `schedule:` (5-field cron, machine local time) + `prompt:` (intent fired via `claude -p`) becomes a scheduled job. The runner is `scripts/scheduler-tick.mjs`, invoked every 60s by the `com.agentic-os.scheduler` LaunchAgent. Runs append to `vault/raw/scheduled-runs.jsonl`. Install with `./scripts/install-scheduler.sh`. Dashboard surface: **Schedules** view (list, run-now, recent output). Two seed schedules ship: `runbook-morning-brief` (`/os brief` at 9am daily) and `runbook-weekly-curation-check` (Sunday 8am).

Detail: `vault/wiki/_seed/meta/reference/standard-scheduled-jobs.md`

## 15. Primitives + feature anatomy (meta-process)

The OS understands a fixed set of **primitives** (domain, skill, app, archetype, hook, template, schedule, runner, installer). Adding instances uses the matching `meta-add-*` scaffolder. Adding a new **capability** that spans multiple primitives (like scheduled jobs did) follows the feature-anatomy rubric — a checklist of slots a capability may fill (data model, runtime, installer, scaffolder, dashboard, router, docs) plus rules for archetype-vs-extend, retirement, and versioning. Use scheduled jobs as the worked example.

Detail: `vault/wiki/_seed/meta/reference/concept-primitives.md` (registry) + `vault/wiki/_seed/meta/reference/standard-feature-anatomy.md` (process)

## 16. Compliance audit

`scripts/audit.mjs` walks the repo and checks every primitive against the standards above. Sections: skills, wiki, domains, templates, router, logs. Severities: ERROR (exits 1), WARN, INFO. Each check has a stable `id` mapping to the standard it enforces. Invoke via `/os audit`, `/meta-audit`, or directly: `node scripts/audit.mjs [--skills|--wiki|--domains|--templates|--router|--logs|--json]`. Use before adding a new capability (clean baseline) or after a freehand edit.

Detail: `vault/wiki/_seed/meta/reference/standard-os-audit.md`

## 17. Repository ingestion

`dev-ingest-repo` clones (GitHub) or references (local) external repositories and writes a `kind: repo` `entity` wiki entry that captures: stack, structure, build/test commands, CI, conventions, entry points. GitHub clones live at `repos/<slug>/` (gitignored). Same clone serves both ingestion and downstream feature work — branches managed by future PR-writing skills. Re-ingestion requires a clean working tree.

Detail: `vault/wiki/_seed/meta/reference/standard-repo-ingestion.md`

## 18. Project workflow

A `project` archetype becomes a **workflow scope** when it carries the extended fields (`repo`, `lifecycle_stage`, `current_branch`, `milestones`, `reporting`). The project entry holds the load-bearing fields; everything else discovers project membership via `[[project-id]]` wikilinks (the manifest's backlinks make this queryable). Scheduler tick respects project status — runbooks with `project: <id>` only fire when the project is active. Reporting in v1 is `target: clipboard` (generated markdown to `vault/output/<domain>/status-reports/`); MCP/webhook integrations deferred.

Detail: `vault/wiki/_seed/meta/reference/standard-project-workflow.md`

## 19. Change workflow

A `change` archetype is the atomic unit of code work — **single repo, single branch, single PR**. Status lifecycle: planning → in-progress → in-review → merged | abandoned. Required fields: `title`, `repo` (must reference an ingested-repo entity), `status`, `branch`. Optional `project: <id>` field composes a change into a larger initiative — the Projects detail view's Changes section aggregates them. Cross-repo work = one project + N changes (one per repo).

**Peer-review gate** (default-on): `dev-write-change` is state-machine driven. PLAN phase composes a structured plan; `dev-review-change` reads the plan + repo and produces a verdict (approve / request-changes / reject); EXECUTE phase only runs after approval (or explicit `review_status: overridden`). Outputs: change entry, plan at `vault/output/<domain>/changes/<slug>-plan.md`, review at `<slug>-review.md`, branch in repo, execution log on test failure, future summary on merge. Trivial changes can opt out with `review_required: false`. Scaffolder: `dev-add-change`. Writer/reviewer: `dev-write-change` + `dev-review-change`. Future: `dev-open-pr` + `dev-close-change`.

Detail: `vault/wiki/_seed/meta/reference/standard-change-workflow.md`

## 20. Event store / telemetry layer

A pure-Node SQLite database at `.claude/state/events.db` records every router dispatch, dashboard AI bridge call, vault edit, and scheduler fire. Captured columns include `ts`, `kind`, `action`, `skill`, `project`, `change_id`, `model`, `tokens_in/out/cache_*`, `cost_usd`, `duration_ms`, `exit_status`, `status`, `description`, `files_touched`, `prompt`, `stdout_preview`, `stderr`, `origin_log`, `raw`. Schema bootstrapped by `scripts/events-db-init.mjs`; helper at `scripts/events-db.mjs` exports `recordEvent` / `queryEvents` / `statsEvents`; backfill from existing JSONL via `scripts/events-db-backfill.mjs`.

**Vault vs telemetry separation:** vault holds knowledge (curated, semantic, git-tracked); events.db holds telemetry (automatic, mechanical, gitignored). Both layers can reference the same files — events.db.`files_touched` points at the vault paths each action produced — but knowledge never embeds execution metadata.

Write sites dual-write: existing JSONL append continues (backward compat) and `recordEvent()` adds a structured row. Read surface: `GET /api/events-db?…` (filtered rows) + `GET /api/events-db/stats?window=N` (aggregate counts/cost/slowest). Surfaced in the dashboard's **Insights** view. Audit checks: `events-db-exists`, `events-db-readable`, `events-db-schema-current`.

Detail: `vault/wiki/_seed/meta/reference/standard-event-store.md`

---

# Captured decisions

Architectural decisions that shape the OS. Each entry lives under `vault/wiki/_seed/meta/decision/` and explains _why_ the current shape exists.

- [[decision-subdir-skills]] — skills live at `.claude/skills/<name>/SKILL.md` (subdir per skill)
- [[decision-biome-and-prettier]] — Biome for code, Prettier for markdown (split-tool linting)
- [[decision-fastify]] — Fastify chosen over Express/Hono/raw http for app backends
- [[decision-react-markdown]] — react-markdown + remark-gfm for content rendering
- [[decision-skip-plan-mode]] — dashboard-driven destructive skills skip plan mode

---

# How to evolve the OS

Prefer scaffolders over freehand edits. Order of preference:

1. **Additive change** (new domain, skill, app, archetype, schedule) → use the matching `meta-add-*` skill
2. **New capability spanning multiple primitives** (heartbeat, workflows, goals) → follow [[standard-feature-anatomy]] — the meta-scaffolder rubric — before writing code
3. **Structural change within a single artifact** (rename a skill, deprecate an archetype) → use `meta-evolve`
4. **Cross-cutting structural change** (e.g. changing the wiki frontmatter contract) → use `meta-evolve` after thinking carefully; this is a kernel revision
5. **Freehand edits** → only when scaffolders are themselves broken. Document why in a `decision` entry.

Every evolution gets logged to `vault/raw/dashboard-actions.jsonl` for audit.
