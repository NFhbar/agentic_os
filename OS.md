# Agentic OS

The entry-point map for an interconnected, self-extending workflow OS built on Claude Code.

---

## Domains

| domain      | purpose                                        | playbook                                                           |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| meta        | evolve the OS itself; ships with the dashboard | [domains/meta/playbook.md](domains/meta/playbook.md)               |
| development | code, repos, PR review                         | [domains/development/playbook.md](domains/development/playbook.md) |
| research    | read, synthesize, capture decisions            | [domains/research/playbook.md](domains/research/playbook.md)       |

New domains are scaffolded via `/os add-domain <name>`.

---

## Primitives

The "kinds of things" the OS understands. Each is composable, scaffoldable, and documented. Full registry: `vault/wiki/_seed/meta/reference/concept-primitives.md`.

| primitive   | scaffolded by       | lives at                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`    | `/os add-domain`    | `domains/<name>/`                                                                                                                                                                                                                                                                                 |
| `skill`     | `/os add-skill`     | `.claude/skills/<name>/SKILL.md`                                                                                                                                                                                                                                                                  |
| `app`       | `/os add-app`       | **Physically** `domains/meta/app/src/apps/<id>/` — the meta dashboard bundle hosts every app. The `manifest.domain` field controls sidebar grouping (apps surface under their declared domain). Per-domain app bundles are unrealized today; the per-domain location was originally aspirational. |
| `mcp`       | `/os add-mcp`       | `mcps/<id>/` (manifest + server + .env) — see [standard-mcp-architecture.md](vault/wiki/_seed/meta/reference/standard-mcp-architecture.md)                                                                                                                                                        |
| `archetype` | `/os add-archetype` | `_templates/wiki-entry/<name>.md.tmpl` + ref entry                                                                                                                                                                                                                                                |
| `schedule`  | `/os add-schedule`  | `vault/wiki/<domain>/runbook/<slug>.md` (with `schedule:` field)                                                                                                                                                                                                                                  |
| `hook`      | manual              | `.claude/hooks/<purpose>.sh`                                                                                                                                                                                                                                                                      |
| `template`  | other scaffolders   | `_templates/<thing>.<ext>.tmpl`                                                                                                                                                                                                                                                                   |
| `runner`    | feature anatomy     | `scripts/<feature>-*.mjs`                                                                                                                                                                                                                                                                         |
| `installer` | feature anatomy     | `scripts/install-<feature>.sh`                                                                                                                                                                                                                                                                    |

Adding a new capability that spans multiple primitives: follow `vault/wiki/_seed/meta/reference/standard-feature-anatomy.md` (the meta-scaffolder rubric).

---

## Dispatch

Canonical entry: `/os <intent>` invokes the `os` router skill.

Flow:

1. Router parses intent
2. Looks up this vocabulary table
3. Reads the relevant playbook for context
4. Either invokes a downstream skill via the Skill tool, or executes inline using the playbook
5. Records the dispatch via `node scripts/record-router-event.mjs` — dual-writes to `vault/raw/router-log.jsonl` AND `.claude/state/events.db` in one call

Direct invocation (`/dev-pr-review`, `/meta-dashboard`) is a power-user escape hatch.

### Intent vocabulary

| if intent matches…                                                                         | route to                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------- |
| `dashboard`, `open dashboard`, `show dashboard`                                            | `meta-dashboard`                    |
| `add domain`, `new domain`, `scaffold domain`                                              | `meta-add-domain`                   |
| `add skill`, `new skill`, `scaffold skill`                                                 | `meta-add-skill`                    |
| `add app`, `new app`, `scaffold app`                                                       | `meta-add-app`                      |
| `add mcp`, `new mcp`, `scaffold mcp`, `add integration`                                    | `meta-add-mcp`                      |
| `add archetype`, `new archetype`                                                           | `meta-add-archetype`                |
| `curate`, `save this`, `promote to wiki`, `organize raw`                                   | `meta-curate`                       |
| `evolve`, `modify os`, `change os structure`                                               | `meta-evolve`                       |
| `rename`, `move skill`, `rename domain`                                                    | `meta-rename`                       |
| `delete`, `remove skill`, `remove domain`                                                  | `meta-delete`                       |
| `brief`, `session brief`, `what's new`, `status`                                           | `meta-brief`                        |
| `add schedule`, `new schedule`, `schedule this`                                            | `meta-add-schedule`                 |
| `add project`, `new project`, `start project`                                              | `meta-add-project`                  |
| `reopen project`, `un-complete project`, `revive project`                                  | `meta-reopen-project`               |
| `status report`, `weekly update`, `report`                                                 | `meta-status-report`                |
| `audit`, `check`, `lint os`, `health`                                                      | `meta-audit`                        |
| `vault search`, `search wiki`, `find entry`, `list archetypes`                             | `meta-vault-query`                  |
| `research project (legacy)`                                                                | `meta-research-project`             |
| `research write`, `write research`, `author research report`                               | `research-write`                    |
| `research review`, `review research`, `peer review research`                               | `research-review`                   |
| `research revise`, `apply research review findings`, `fold review into research`           | `research-revise`                   |
| `research update`, `update research report`, `refresh research`                            | `research-update`                   |
| `mark research approved`, `approve research`, `override research review`                   | `meta-mark-research-approved`       |
| `add research note`, `note on research`, `flag research issue`                             | `meta-add-research-note`            |
| `add note`, `new note`, `scaffold note`, `note this`, `jot note`                           | `meta-add-note`                     |
| `register skill in playbook`, `add skill to playbook`, `playbook skill coverage`           | `meta-add-skill-to-playbook`        |
| `register skill in router`, `add skill to router vocab`, `router vocab coverage`           | `meta-add-skill-to-router-vocab`    |
| `audit lifecycle`, `overseer review`, `audit change`, `lifecycle audit`                    | `meta-overseer-review`              |
| `audit followups`, `update audit signals`, `sweep audits`, `forward-look audits`           | `meta-audit-followups`              |
| `apply tuning suggestion`, `propose skill edit`, `materialize tuning suggestion`           | `meta-apply-tuning-suggestion`      |
| `scaffold research recommendations`, `scaffold research changes`, `materialize research`   | `research-scaffold-recommendations` |
| `review project plan`, `review plan`, `peer review project plan`                           | `meta-review-project-plan`          |
| `revise project plan`, `apply project review findings`, `fold review into project plan`    | `meta-revise-project-plan`          |
| `scaffold project plan`, `create project changes`, `materialize project plan`              | `meta-scaffold-project-plan`        |
| `review pr`, `pr review`, `check pr`                                                       | `dev-pr-review`                     |
| `ingest repo`, `add repo`, `ingest <url>`                                                  | `dev-ingest-repo`                   |
| `add change`, `new change`, `change this`                                                  | `dev-add-change`                    |
| `write change`, `execute change`, `implement change`                                       | `dev-write-change`                  |
| `review change`, `review plan`, `peer review`                                              | `dev-review-change`                 |
| `revise plan`, `apply review findings`, `address nits`, `fold review into plan`            | `dev-revise-plan`                   |
| `open pr`, `push pr`, `create pr`, `publish change`                                        | `dev-open-pr`                       |
| `cache repo`, `pull repo for review`, `refresh review cache`                               | `dev-cache-pr-review-repo`          |
| `analyze repo`, `index repo conventions`, `re-analyze repo`                                | `dev-analyze-repo-for-review`       |
| `mark pr ready`, `pr ready for human`, `sign off pr review`, `ready to merge`              | `dev-mark-pr-ready`                 |
| `publish pr review`, `post review to github`, `submit review`, `publish comments`          | `dev-pr-review-publish`             |
| `close change`, `mark merged`, `finalize change`, `pr merged`                              | `dev-close-change`                  |
| `pull pr comments`, `ingest review comments`, `sync external review`, `import pr feedback` | `dev-pull-pr-comments`              |

Misses (no match) are logged with the original intent so we can grow the vocabulary.

---

## Vault conventions

| stage                        | purpose                                                                                                                                                           | committed?        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `vault/raw/`                 | unstructured ingest (drops, snippets, URLs, log files)                                                                                                            | no                |
| `vault/wiki/`                | structured memory, organized by domain, archetype-tagged                                                                                                          | only `_seed/`     |
| `vault/output/`              | generated artifacts (reports, drafts) by domain                                                                                                                   | no                |
| `vault/.index/manifest.json` | derived index of wiki entries, rebuilt by hook                                                                                                                    | no                |
| `mcps/`                      | MCP servers (structured external integration). One folder per server. Each owns its own `package.json`, `.env`, `server.mjs`. See `standard-mcp-architecture.md`. | yes (sans `.env`) |
| `.mcp.json`                  | Discovered MCP config for Claude Code, written by `scripts/sync-mcp-config.mjs` from the `mcps/` manifests                                                        | yes               |

The vault is **knowledge**. For the OS's runtime **telemetry** (every action recorded with model, tokens, cost, duration) see the State section below — the two layers stay separate by design.

---

## State

Local-only OS state. Never committed; never shipped. Distinct from vault — telemetry, dedupe markers, queues.

| location                             | purpose                                                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/state/events.db`            | Structured event store (SQLite). One row per action — model, tokens, cost, duration, files_touched, status. Surfaced in the dashboard's **Insights** view. See `standard-event-store.md`. |
| `.claude/state/schedule-runs.json`   | Scheduler dedupe state (last-fired minute per schedule id)                                                                                                                                |
| `.claude/state/installed-at`         | ISO 8601 install marker (used by SessionStart for first-run detection)                                                                                                                    |
| `.claude/state/pending-curation.txt` | One relative path per line — raw drops awaiting curation                                                                                                                                  |

---

## Memory archetypes

Every wiki entry must declare one of these `type:` values in its frontmatter.

| archetype             | purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `entity`              | person, project, repo, system you have ongoing relationship with                                   |
| `decision`            | architectural or design decision + rationale                                                       |
| `runbook`             | repeatable procedure for a recurring task                                                          |
| `reference`           | pointer to an external resource (URL, dashboard, doc)                                              |
| `project`             | active initiative with goals + status + deadline                                                   |
| `change`              | atomic unit of code work — single repo, single branch, single PR                                   |
| `research-report`     | structured research output: materials → findings → recommended changes                             |
| `notification-config` | one routing rule for the dispatch engine — per (event, channel) with filters + rate-limit override |
| `note`                | free-form (escape hatch)                                                                           |

Per-archetype frontmatter contracts: `vault/wiki/_seed/meta/` (one reference entry per archetype).

---

## Standards

The full set of OS standards (skill format, playbook format, app layout, hook protocol, log formats, template syntax, file-naming conventions) is documented in two places:

- `domains/meta/playbook.md` — master index + overview
- `vault/wiki/_seed/meta/` — one `reference` archetype entry per standard

Both are committed and ship with the OS.

---

## See also

- `CLAUDE.md` — workspace instructions auto-loaded by Claude Code
- `README.md` — first-run / install / quick tour
- `_templates/` — scaffolder templates (do not edit freehand)
