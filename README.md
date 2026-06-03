# Agentic OS

A self-extending, file-based agentic operating system built on Claude Code.

## TL;DR

You clone this repo, run `./install.sh`, then `claude`. You now have:

- A **router** (`/os <intent>`) that dispatches every action — `/os write change`, `/os pr review`, `/os status report`, etc.
- A **lifecycle for engineering work**: scaffold a change → plan it → peer-review the plan → execute it → open a PR → review the PR → publish the review → close on merge. Each step is a skill; the orchestrator can drive them automatically.
- A **dashboard** (`/os dashboard`) with live views over changes, projects, PR reviews, runs, costs, notifications, and audit findings.
- A **vault** (`vault/wiki/`) that accumulates structured knowledge as you work — every change, decision, review, and research report is a markdown file with frontmatter the OS understands.
- **GitHub + Slack integration** via MCPs (set up in 2 minutes after install with your PAT/webhook).
- **Cost telemetry + event tracking** for every skill run, queryable + visible per-project.

Teams of 2-10 engineers fork this repo, customize for their stack, and each engineer runs their own instance. See [`vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md`](vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md) for the team-install model and [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to extend.

## What this is

A workspace where Claude acts as the kernel for end-to-end workflow automation:

- **Domains** organize knowledge and skills by area (development, research, meta)
- **Skills** are invokable actions; `/os <intent>` dispatches to the right one
- **Apps** are optional visual UIs over domain state (the dashboard is the first)
- **MCPs** are structured tool surfaces — bridges to external services (GitHub, Slack…) or internal subsystems, exposed via the Model Context Protocol
- **Vault** is structured persistent memory: `raw/` → `wiki/` → `output/`
- The OS extends itself: new domains, skills, apps, and MCPs are scaffolded _through_ the OS

## Install

```bash
./install.sh
```

Verifies prerequisites (node version pinned in `.nvmrc` — currently `v26.1.0`, claude CLI), installs root tooling + dashboard deps, stamps the install marker, **scaffolds `.env` files** for each MCP (`mcps/<id>/.env`) and each app server (`domains/<domain>/app/.env`) from their committed `.env.example` siblings. The scaffolds ship with empty secrets — fill them in before the corresponding feature is exercised:

- `mcps/github/.env` — `GITHUB_TOKEN` for PR open/read/list (used by `dev-open-pr`, `dev-pr-review`)
- `domains/meta/app/.env` — `SLACK_BOT_TOKEN` or `SLACK_WEBHOOK_URL` for notification delivery (see **Notifications**); optional `GITHUB_TOKEN` for server-side GitHub calls separate from the MCP

The `.env` files are gitignored per `standard-env-config`; the loader (`server/load-env.ts` for apps, the MCP's own `loadEnv()` for MCPs) populates `process.env` at process start with shell-exported values winning.

## First run

Open Claude Code in this directory:

```bash
claude
```

Then dispatch through the router (`/os <intent>`). See **Commands** below for the full list.

## First 10 minutes

A walkthrough for your first session. Each step takes a minute or two.

1. **Launch the dashboard.** From your `claude` session: `/os dashboard`. Opens a browser at localhost. The dashboard is the visual surface for everything below — changes, projects, PR reviews, runs, audit, notifications.

2. **Ingest your team's repo.** Tell the OS about the code you'll be working on:

   ```
   /os ingest repo https://github.com/your-org/your-app
   ```

   This clones into `repos/your-app/` (gitignored, local-only), analyzes the stack, and writes an entity wiki entry the downstream skills consume.

3. **(Optional) Set up GitHub.** If you want PR review / open-PR / publish flows, configure the github MCP:

   ```
   cp mcps/github/.env.example mcps/github/.env
   # Edit mcps/github/.env, paste a token (see comments for required scopes)
   ```

   Restart `claude` so the MCP picks up the new env. Confirm with `/mcp`.

4. **(Optional) Set up Slack.** For notification delivery to Slack channels:

   ```
   cp domains/meta/app/.env.example domains/meta/app/.env
   # Add SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL
   ```

5. **Scaffold your first change.** Try a small one:

   ```
   /os add change   # interactive — provide title + repo
   ```

   The change lands in `vault/wiki/development/change/<slug>.md`. The dashboard's Changes view shows it in the planning state.

6. **Plan + review + execute.** From the dashboard's change detail page, click **Write plan**. Once the plan is generated, click **Review plan**. Once approved, click **Execute**. Each step writes structured artifacts (`vault/output/development/changes/`) and updates the change's lifecycle state.

7. **Open the PR.** Once execution is done, click **Open PR** — pushes the branch + creates the PR via the github MCP.

8. **Review the PR.** Click **Review PR** — runs `dev-pr-review` against the open PR, produces a structured review with categorized comments.

9. **Look at the runs drawer.** Top-right of the dashboard. Every skill dispatch lives here with cost + duration + output. The Insights view rolls these up into per-skill and per-project totals.

10. **Check the audit panel.** Bottom of the Overview page. Surfaces drift (dangling wikilinks, stale repo caches, missing skill registrations, etc.) with one-click Accept buttons for the common ones.

After this loop, you'll have a clear feel for the canonical workflow. Everything else in this README is reference material for specific features.

## Commands

All actions are dispatched through the `/os` router skill. The router reads `OS.md`'s intent vocabulary and routes to the matching meta-\* or domain skill. Direct invocation (e.g. `/meta-brief`) is also supported as a power-user escape hatch.

### Info

| command             | what                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/os brief`         | session brief — pending curation, **plans awaiting review**, **changes in flight**, active projects with deadlines, scheduler health, recent OS activity |
| `/os dashboard`     | launch the OS dashboard (Vite + Fastify on localhost; opens browser)                                                                                     |
| `/os audit`         | compliance check across skills, wiki, domains, archetypes, router, logs (exits non-zero on errors)                                                       |
| `/os status report` | generate a project status report — synthesizes recent commits + decisions + scheduler runs + milestones into copy-pastable markdown                      |

### Authoring (AI-driven scaffolders)

| command             | what                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/os add-domain`    | scaffold a new domain (top-level or sub-domain) — folder + playbook + vault dirs                                           |
| `/os add-skill`     | scaffold a new skill in `.claude/skills/<name>/SKILL.md` + register in playbook                                            |
| `/os add-app`       | scaffold a new Vite + React + Fastify app inside a domain + install deps + launch skill                                    |
| `/os add-mcp`       | scaffold a new MCP server (structured tool surface — `mcps/<id>/` with manifest + server.mjs + .env) — see Integrations    |
| `/os add-archetype` | register a new wiki archetype (template + reference entry + OS.md table)                                                   |
| `/os add-schedule`  | scaffold a scheduled runbook (cron + prompt the OS fires when due — see Heartbeat)                                         |
| `/os add-project`   | scaffold a project (scope + lifecycle + reporting cadence; optionally linked to one or more ingested repos) — see Projects |
| `/os add-change`    | scaffold a code change (single repo, single branch, single PR; the atomic work unit) — see Changes                         |
| `/os ingest repo`   | clone (GitHub) or reference (local) an external repository; produces a `kind: repo` entity entry — see Repo ingestion      |
| `/os curate`        | promote `vault/raw/` items into typed `vault/wiki/` entries with archetype frontmatter                                     |

### Destructive (require confirmation)

| command      | what                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `/os rename` | rename a skill / domain / wiki entry; updates all cross-references                                         |
| `/os delete` | delete a skill / domain / wiki entry; cleans up references; recursive for domains                          |
| `/os evolve` | generic OS-structure modification (interactive plan mode) — escape hatch for non-add/rename/delete changes |

### Domain-specific

| command               | what                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/os review pr`       | review a pull request — fetch via gh, analyze, write structured report to `vault/output/development/pr-review/`                                                                 |
| `/os write change`    | state-machine driven: PLAN phase composes a structured plan; EXECUTE phase (after review approval) creates branch + edits + tests — see Changes                                 |
| `/os review change`   | peer-review a plan produced by write-change (read-only). Walks plan + repo + conventions; writes structured verdict (approve / request-changes / reject) — see Changes          |
| `/os research write`  | author a structured research-report against a project — investigates open questions, walks materials, produces `recommended_changes[]` in frontmatter — see Research reports    |
| `/os research review` | peer-review a research-report (approve / request-changes / reject). Reads `notes_log` for any mid-lifecycle guidance the user added since the prior pass — see Research reports |
| `/os research revise` | fold review findings + unconsidered notes back into a new revision of the report — see Research reports                                                                         |
| `/os research update` | incorporate new materials after approval — produces a `## Update N` section + may extend `recommended_changes[]` with new proposals — see Research reports                      |

Adding new commands: scaffold a skill via `/os add-skill` and add a row to `OS.md`'s Intent vocabulary table. Both can be done from the dashboard (Skills view → **+ New Skill**).

The canonical intent → skill mapping lives in [OS.md](OS.md). Misses (intents that don't match any vocabulary row) get logged to `vault/raw/router-log.jsonl` so the vocabulary can grow with use.

## Heartbeat (scheduled jobs)

The OS fires actions on a schedule without a human prompt. A scheduled job is a `runbook` wiki entry with two optional frontmatter fields:

```yaml
schedule: "0 9 * * *"   # standard 5-field cron, machine local time
prompt: "/os brief"     # intent fed to `claude -p` when due
```

`scripts/scheduler-tick.mjs` runs every 60s under a launchd LaunchAgent, finds due jobs, and fires each via `claude -p`. Runs append to `vault/raw/scheduled-runs.jsonl`.

```bash
./scripts/install-scheduler.sh        # install the LaunchAgent (macOS)
node scripts/scheduler-tick.mjs --list    # see all schedules + next-run times
node scripts/scheduler-tick.mjs --dry-run # show what would fire right now
```

From the dashboard, the **Schedules** view lists every scheduled runbook with its cron, next run, last run + exit code, and a **Run now** button for manual firing. Scaffold new ones with **+ New Schedule** or `/os add-schedule`.

Three schedules ship by default:

- `runbook-morning-brief` — fires `/os brief` daily at 9am
- `runbook-weekly-curation-check` — Sunday 8am scan for stale `vault/raw/` items
- `runbook-weekly-health-check` — Sunday 8:30am runs `/os audit`, writes a dated summary to `vault/output/meta/health-checks/<date>.md` (proactive drift surfacing — the audit is otherwise pull-based)

Edit or delete the seed entries in `vault/wiki/_seed/meta/runbook/`.

Full standard: [`vault/wiki/_seed/meta/reference/standard-scheduled-jobs.md`](vault/wiki/_seed/meta/reference/standard-scheduled-jobs.md).

## Integrations (MCPs)

MCPs (Model Context Protocol servers) are how the OS gives Claude structured access to things outside the markdown — external services like GitHub or Slack, and internal subsystems like the vault or scheduler. Each MCP exposes a typed tool surface (`create_pull_request`, `search_wiki`, …) that any skill or session can call.

Two kinds, with different homes:

| kind            | lives at                         | when to use                                                                                 |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| **OS-built**    | `mcps/<id>/` (custom Node code)  | Tight tool surfaces, OS-specific composites (call + log + write-back), no vendor MCP exists |
| **Third-party** | `.mcp.json` row only (no folder) | A vendor offers a maintained MCP that covers what you need — pass through unchanged         |

The OS ships with two OS-built MCPs wired up:

- **`github`** (`mcps/github/`) — PR open/read/list + check status. PAT-based auth via `mcps/github/.env`. Used by `dev-open-pr` and the planned PR-review backend.
- **`vault`** (`mcps/vault/`) — wiki search + entry read + archetype listing. No auth required (local filesystem read).

After cloning and running `./install.sh`, drop a GitHub PAT into the github MCP's env:

```bash
cp mcps/github/.env.example mcps/github/.env
# Edit mcps/github/.env, paste a token (see the comments inside for required scopes)
```

Then start Claude Code from this directory (`claude`). The MCPs are auto-spawned via stdio on session start; confirm with `/mcp`.

**Hosted MCPs** (vendor-run OAuth endpoints, e.g. for Linear / Notion / Slack) are also fully supported via `/os add-mcp --kind hosted`. There's one gotcha: Claude Code uses OAuth Dynamic Client Registration (RFC 7591), and some vendors (notably GitHub's hosted MCP) don't support DCR — you'll see _"SDK auth failed: Incompatible auth server"_ in `/mcp`. When that happens, fall back to a custom OS-built MCP with PAT auth (which is exactly the path the github MCP uses). The MCP architecture standard documents this contract.

Scaffold a new MCP with `/os add-mcp` (custom or hosted mode). `scripts/sync-mcp-config.mjs` regenerates `.mcp.json` after each scaffold, preserving any third-party rows.

Full standard: [`vault/wiki/_seed/meta/reference/standard-mcp-architecture.md`](vault/wiki/_seed/meta/reference/standard-mcp-architecture.md).

## Repo ingestion

Before the OS can write code, it needs to know about the repos you work on. `/os ingest repo` accepts a GitHub URL, GitHub shorthand (`owner/name`), or a local path:

```bash
/os ingest repo https://github.com/me/my-app
/os ingest repo /Users/me/code/my-thing
```

The skill clones the repo (GitHub only) to `repos/<slug>/`, walks it, and produces a `kind: repo` **entity** wiki entry at `vault/wiki/<domain>/entity/<slug>.md`. The entry captures:

- Stack (language, framework, build/test commands)
- Top-level structure
- Entry points
- Style configs + CI
- Conventions inferred from CONTRIBUTING / `.github/`

Downstream skills (`dev-pr-review`, `dev-write-change`, future PR-writers) read the entity entry to know how to operate on the repo without re-discovering metadata. `repos/<slug>/` is gitignored — it's a local working copy, not OS state.

Re-ingest with `overwrite: true` to refresh after upstream changes. Multi-repo work is handled by projects (see below), not by ingesting differently.

Full standard: [`vault/wiki/_seed/meta/reference/standard-repo-ingestion.md`](vault/wiki/_seed/meta/reference/standard-repo-ingestion.md).

## Projects

A **project** is the workflow scope between a single change and "an ongoing area." Projects own a deadline, milestones, a reporting cadence, and (optionally) one or more ingested repos. They coordinate work that crosses repos and accumulates decisions over time.

```bash
/os add-project
# prompts for: name, title, domain, repos (comma-separated entity ids),
#              deadline, reporting cadence + target
```

Lifecycle: `planning` → `active` → `review` → `shipped` → `archived`. Status (`active` / `paused` / `completed` / `cancelled`) gates project-scoped scheduled runbooks — pausing a project pauses its weekly status reports automatically.

**Two ways entries relate to a project:**

- **Owned** — `project: <project-id>` in the entry's frontmatter. The Projects dashboard view groups owned decisions, notes, and changes under the project as its accumulated work product.
- **Referenced** — `[[<project-id>]]` in the entry's body. Mentions / cross-references / context.

Cross-repo features compose as one project + N changes (one per repo) — each change's `project:` field auto-aggregates it under the project.

A seed project ships with the OS: `build-agentic-os-v1` (`vault/wiki/_seed/meta/project/build-agentic-os-v1.md`) — the OS dogfooding itself. The existing seed decisions are owned by this project, so the Projects view's drill-down shows real content out of the box.

### Status reports

`/os status report` (or the dashboard's "Generate status report" button) walks recent commits + backlinked decisions + scheduler runs + milestone changes, then writes markdown to `vault/output/<domain>/status-reports/<id>-<YYYY-MM-DDTHHMMSS-TZ>.md`. v1 ships `target: clipboard` only — copy the markdown into Notion / Linear / Slack manually. Native integrations are deferred.

A few patterns are worth knowing:

- **Multiple reports per day, no clobber.** Filenames include `HHMMSS` and a TZ suffix, so back-to-back generations during the same project produce distinct files instead of overwriting. The project's `reporting.last_sent` is the canonical "most recent" pointer; the file tree is the audit trail.
- **Local time in filenames and bodies.** Timestamps render in the user's local timezone (e.g. `2026-06-01T143022-PDT`) rather than UTC. The Status app's report list groups by local day. Skills authored before this convention may still emit UTC — those will be migrated as they surface.
- **Continuous change-lifecycle tracking.** Every status report includes a `### Changes` section that lists every non-terminal change owned by the project and its current step (`planning / in-progress / in-review / merged / abandoned`) derived from the change's `status` + `review_status` + `pr_review_status`. The same change can appear in consecutive reports as it walks the lifecycle — the report is a _snapshot_, not a delta.
- **Slack template.** A status-report-specific Slack template (`vault/wiki/_seed/meta/template/notification-dashboard-status-report.md`) renders the report into a Slack message when a `dashboard.status-report.generated` notification rule is configured. The skill stuffs `title`, `tldr`, `progress_summary`, `blockers`, `next`, `report_path`, `period_local` into the event's `args` payload; the template references those as flat vars (see [Template syntax](#template-syntax) above).

Full standard: [`vault/wiki/_seed/meta/reference/standard-project-workflow.md`](vault/wiki/_seed/meta/reference/standard-project-workflow.md).

## Changes (with peer review)

A **change** is the atomic unit of code work — **single repo, single branch, single PR**. Smaller than a project; larger than an ad-hoc edit. Composes into projects when work spans repos.

```bash
/os add-change       # scaffolds entry; auto-drafts Why/Approach/Done-when when context allows
/os write-change     # state-machine driven (PLAN or EXECUTE depending on review_status)
/os review-change    # peer review the plan
```

Status lifecycle: `planning` → `in-progress` → `in-review` → `merged` | `abandoned`. Required fields: `title`, `repo` (must reference an ingested-repo entity), `status`, `branch`.

### Auto-drafted bodies (with human accept gate)

`dev-add-change` accepts an optional `description` input. When provided (or when the title is specific enough to derive intent from), the scaffolder drafts a first-pass `## Why` / `## Approach` / `## Done when` from: title + description + repo entity context. Each section ships with a `> **DRAFT** — review and refine before invoking dev-write-change.` blockquote.

The human's job is to **review and accept** the draft — not write it from scratch. Accept happens during `/os write-change` PLAN: the gate prints the drafted sections, then `AskUserQuestion` offers **Accept as-is** (strips the DRAFT lines in place) or **Stop & edit first**. No separate manual-edit step required for clear-intent changes.

### Plan / review / execute state machine

`dev-write-change` reads the change entry's `review_status` field and picks the right phase:

| `review_status`         | what happens                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending` (no plan yet) | **PLAN phase** — agent walks repo, composes structured plan (files modified/created/NOT-touched, tests, risks). Writes to `vault/output/<domain>/changes/<slug>-plan.md`. |
| `pending` (plan exists) | "Run `/os review-change <id>`" — the writer won't execute without review                                                                                                  |
| `approved`              | **EXECUTE phase** — creates branch (per [[standard-git-hygiene]]), follows plan exactly, runs tests, commits with conventional-commit format, sets `status: in-progress`  |
| `request-changes`       | Surface concerns. User picks: re-plan / override (`review_status: overridden`) / abandon                                                                                  |
| `rejected`              | Surface verdict; suggests `status: abandoned`                                                                                                                             |
| `not-required`          | Skip review; go straight to EXECUTE. Set at scaffolding via `review_required: false` for trivial changes (dep bumps, typo fixes)                                          |

`dev-review-change` is **read-only**: walks the plan + repo + conventions, runs a 6-category checklist (scope discipline / convention alignment / risk / test coverage / existing code respect / git hygiene), writes a structured verdict to `vault/output/<domain>/changes/<slug>-review.md`, updates `review_status`. **Cannot edit code, create branches, or run tests** — the separation is the safety property.

### Universal standards every change respects

Both `dev-write-change` PLAN/EXECUTE and `dev-review-change` read these standards at start of procedure. Repo-specific overrides in the entity entry's `## Conventions` section take precedence where they conflict — but the standards are the floor.

- [`standard-code-quality`](vault/wiki/_seed/development/reference/standard-code-quality.md) — idiomatic code, dependency hygiene, backwards compat, security, tests, comments, repo-convention adherence
- [`standard-git-hygiene`](vault/wiki/_seed/development/reference/standard-git-hygiene.md) — pre-branch state (clean tree + ff-only pull), branch naming (`<type>/<slug>` or `<type>/<issue>/<slug>` using semantic-release types `feat|fix|docs|style|refactor|test|chore`), conventional commits with the Angular format, PR structure

### Description gate (layered defense)

Three layers enforce that the change body is human-reviewed before the writer plans:

1. **Skill gate** — `dev-write-change` PLAN phase refuses on either template placeholders OR un-accepted `**DRAFT**` markers (the latter triggers an interactive accept prompt rather than a hard reject)
2. **Audit check** — `change-body-template-placeholder` warns on planning-state changes with either symptom, surfaces in `/os audit` and the Health view
3. **Dashboard hint** — yellow state-hint card in the Changes view when the body needs editing/accepting

Full standard: [`vault/wiki/_seed/meta/reference/standard-change-workflow.md`](vault/wiki/_seed/meta/reference/standard-change-workflow.md).

## Research reports

A **research-report** is the formal spec output of a structured investigation against a project's open questions. Lifecycle mirrors the change workflow's review gate: draft → review → revise → approve → scaffold recommendations into changes.

```bash
/os research write    # research-write — investigates the question, drafts the report
/os research review   # peer-review the draft (approve / request-changes / reject)
/os research revise   # fold review findings back into a new revision
/os research update   # incorporate new materials after approval
```

The skill outputs land at `vault/wiki/research/research-report/<project>-<topic>.md` with `recommended_changes[]` in frontmatter. Once approved, **research-scaffold-recommendations** fans each recommendation out to a `dev-add-change` invocation, populating `derived_from_report` + `recommendation_index` on each new change entry so the audit trail traces back to the source report.

### Mid-lifecycle inputs

Three input channels feed the research skills:

- **Materials** (`vault/raw/project-research/<project>/<topic>/`) — files dropped into a per-report directory. URLs/wikilinks/file uploads can be seeded **before** dispatch via the Add-report modal's drag-drop zone (writes to the materials dir; research-write picks them up on first walk).
- **Notes log** (`notes_log:` frontmatter array) — mid-lifecycle guidance the user adds after a report has been drafted. Each note carries `severity` (`info` / `warn` / `blocker`) + a hybrid persistent-`considered_by` chain: skills (research-review/revise/update) read unconsidered notes, fold them in, and append their run id. The UI surfaces an "unconsidered" badge so it's obvious which guidance is still pending action.
- **Mark approved** (UI escape hatch) — overrides the reviewer's verdict when the user disagrees. Flips `review_status: request-changes → approved` via vault-only endpoint. Gated to that specific transition; not a way to bypass review on a fresh report.

### Plan tab inline

When a project has `research_paths` populated (via `/os research write`), the project's Plan tab renders the report inline — the legacy `/plan/research` flow stays as the fallback for projects authored before the research-report lifecycle existed. Both paths produce the same downstream artifact (`recommended_changes[]` → `dev-add-change` fan-out).

Full archetype: [`vault/wiki/_seed/meta/reference/archetype-research-report.md`](vault/wiki/_seed/meta/reference/archetype-research-report.md). Decision behind the inline rendering: [`vault/wiki/meta/decision/decision-research-report-vs-project-plan.md`](vault/wiki/meta/decision/decision-research-report-vs-project-plan.md).

## Notifications

The OS dispatches structured notifications to Slack / email / desktop based on per-`(event_type, channel)` rules. Every event the system records (project complete, change merged, research approved, …) can trigger one. Rules live as `notification-config` wiki entries; the dispatch engine runs inside the dashboard server fed by two parallel paths so it catches events from any source.

```
event lands in events.db
    │
    │  Path A: in-process afterInsert hook fires immediately for events
    │          recorded inside the dashboard server (test-sends, internal flows)
    │  Path B: server poller reads events.db every 10s for id > lastSeen,
    │          catches inserts from EXTERNAL processes (skills via
    │          record-dashboard-action.mjs — the canonical event source)
    ▼
dispatcher matches rules    ← reads vault/wiki/<domain>/notification-config/*.md
    │  rate-limit check (global 100/day, per-rule override)
    │  render via template     ← reads vault/wiki/_seed/meta/template/
    │                            notification-<event-type>.md (per-event
    │                            override) → notification-default.md (fallback)
    ▼
channel adapter routes by rule.channel: slack | email | desktop
    │
    ▼
events.db ← kind='notification', action='sent'|'failed'|'suppressed-rate-limit'
```

**Why two paths.** The afterInsert hook is a per-process module variable — it only fires when `recordEvent` runs inside the dashboard server. Skills invoke `record-dashboard-action.mjs` as a separate Node process that imports events-db fresh, has no hook registered, writes the row, and exits. Without the poller, every skill-driven event would silently bypass the dispatcher.

### Template syntax

Templates use Mustache-style `{{var}}` substitution with one important convention:

- **`event.raw.args` is flattened into top-level template vars.** Skills stuff per-event metadata into the event's `args` payload (e.g. `meta-status-report` writes `title`, `tldr`, `progress_summary`, `blockers`, `next`, `report_path`, `period_local`). Templates reference these as flat keys: `{{title}}`, `{{tldr}}` — **not** `{{args.title}}`. The renderer's regex (`\w+`) doesn't support dotted paths.
- **Reserved keys win.** Args fields named `project`, `kind`, `change_id`, `domain`, `skill`, `description`, `status`, `event_type`, `rule_id`, `ts` can't shadow the canonical event fields. Skills should pick non-conflicting names.
- **`{{delivery_tags}}`** — space-joined string of the rule's `delivery.tags` array (e.g. `@nico @sarah`). For Slack CC lines.
- **No sections / loops.** The renderer doesn't support `{{#X}}...{{/X}}`. Skills that need iteration should pre-join into strings.

### Setup

1. **Slack** (most common channel): copy `domains/meta/app/.env.example` → `domains/meta/app/.env` and set ONE of:
   - **`SLACK_BOT_TOKEN=xoxb-…`** (preferred) — per-rule channel routing via `chat.postMessage`. Requires a Slack app with `chat:write` scope (+ `chat:write.public` to skip per-channel bot invites). Create at `api.slack.com/apps`.
   - **`SLACK_WEBHOOK_URL=https://hooks.slack.com/…`** (fallback) — single bound channel chosen at webhook install time; per-rule `delivery.slack_channel` is ignored. Zero-config but fixed-channel.

   Both set? Bot-token wins. The Rule Editor's `slack_channel` field is editable in bot-token mode, disabled with a clear hint in webhook mode.

2. **Email** — same `.env`, set `SMTP_*` (deferred; the email channel adapter was abandoned in v1 in favor of Slack-first).

3. **Desktop** — no env needed; uses the browser's Notification API from any open dashboard tab.

### Dashboard surfaces

- **Notifications** sidebar item: defaults to the **Activity log** (table of every dispatch — rule, event, channel, outcome, error). **Rules** tab shows the per-`(event, channel)` matrix; click any cell to add or edit a rule.
- **Rule Editor**: per-rule channel + filters (project / domain / severity) + delivery shape + optional rate-limit override + **Test send** button. Severity-tinted alert hint reflects the active Slack transport.
- **Per-lifecycle-step bells**: project / change / research lifecycle steppers render a small bell next to each step. Click → Rule Editor pre-filled with that step's `event_type` + `filter.project`. Maps the right event to the step contextually (per the **event catalog**).
- **Project page → Notifications tab**: lists rules where `filter.project === <this project>`. Per-project subscription view; `+ Add` button pre-fills the filter.

### The event catalog

[`vault/wiki/_seed/meta/reference/event-catalog.md`](vault/wiki/_seed/meta/reference/event-catalog.md) is the curated registry of every user-facing lifecycle event worth subscribing to. ~35 events organized by entity (project / change / research-report). Both the rule editor's event-type picker and the bell affordances read from it. To add a new subscribable event: add a row to the catalog + (optionally) ship a `notification-<event-type>.md` template for richer message rendering.

### Audit hooks

Three audit checks instrument the notification pipeline:

- **`notification-rule-orphan`** (warn) — flags events tagged to `rule:<id>` where the rule no longer exists
- **`notification-rate-limit-exceeded`** (info) — surfaces suppression events in the trailing 24h
- **`notification-delivery-failed`** (warn) — surfaces permanent send failures with the adapter's error verbatim

Full standards:

- [`vault/wiki/_seed/meta/reference/archetype-notification-config.md`](vault/wiki/_seed/meta/reference/archetype-notification-config.md) — rule schema
- [`vault/wiki/_seed/meta/reference/event-catalog.md`](vault/wiki/_seed/meta/reference/event-catalog.md) — subscribable event registry
- [`vault/wiki/_seed/development/reference/standard-env-config.md`](vault/wiki/_seed/development/reference/standard-env-config.md) — per-surface `.env` pattern
- [`vault/wiki/_seed/development/reference/standard-shared-types.md`](vault/wiki/_seed/development/reference/standard-shared-types.md) — sibling `.types.ts` pattern (used by notifications routes)

## Process automation

Projects can opt into running the change lifecycle (write → open PR → review → merge) without a human in the driver's seat. Automation is **per-project**, configured under the project's `automation:` frontmatter block; the orchestrator lives in the dashboard server and ticks state forward as each step lands.

```
project.automation: { enabled: true, mode: 'sequential-changes', pause_on: [...] }
    │
    ▼
orchestrator picks next change with status: planning  (oldest-first by `created`)
    │
    ▼
state machine ──▶  WRITE         ← dev-write-change      (PLAN → REVIEW → EXECUTE)
                   OPEN_PR       ← dev-open-pr
                   REVIEW        ← dev-pr-review         (writes pass entries)
                   MERGE         ← (parks here; merge watcher closes the loop)
                   ↓
                   on merge: advance to next planning change, repeat
                   ↓
                   on failure / review-not-approved: PAUSE with reason
```

**Pause gates.** The orchestrator pauses (rather than aborting) on two conditions, listed in the project's `pause_on:` array:

- **`skill-failure`** — any orchestrated skill exits non-zero. The failure is captured in the events log; the user resumes after addressing.
- **`review-not-approved`** — `dev-pr-review` records a pass with `result: request-changes`. The orchestrator stops and waits for the user to revise the change (re-running `dev-write-change` in REVISE mode) before resuming.

**Merge watcher.** Once a PR is opened, the orchestrator's WRITE → OPEN_PR → REVIEW steps are complete but the change isn't merged yet. A server-side poller (60s interval) calls `gh pr view` against any open PR for changes currently in MERGE state; when GitHub reports it merged, the watcher updates the change's frontmatter (`status: merged`, `merged_at: <ts>`) and ticks the orchestrator forward to the next change.

**Auto-tick on step completion.** When a skill subprocess wrapped by `record-dashboard-action.mjs` exits with `exit: 0`, an `onAutomationStepComplete()` hook runs inside the dashboard server (called from `routes/runs.ts`). It re-evaluates the project's automation state and dispatches the next step immediately — no polling delay for in-process advancement, only the merge watcher polls externally.

**Surfaces.**

- **Project page → Automation tab** — enable/disable, edit `pause_on`, see current phase + which change is in flight, Start / Pause / Resume / Stop buttons.
- **Project page → Overview tab** — the `ChangesLifecycleStepper` shows distribution across `planning / in-progress / in-review / merged / abandoned`, updating live as the orchestrator advances.
- **Audit hooks** — `automation-paused` (info), `automation-skill-failure` (warn), `automation-stalled` (warn, when in MERGE state for >24h without GitHub reporting merged).

**Why no global automation.** Automation is project-scoped on purpose: different projects have different review tolerances, different cost budgets, different stakeholder expectations. A single "auto-merge everything" toggle would lose that nuance. The per-project block makes the consent explicit and the scope obvious.

## Observability (event store)

Every action the OS executes — router dispatches, dashboard AI bridge calls, vault edits, scheduler fires — writes a structured row to a pure-Node SQLite database at `.claude/state/events.db`. Captured per row: timestamp, kind, action, skill, project, model, tokens (in/out/cache), cost, duration, exit status, files touched.

This is **telemetry, not knowledge**. The vault holds what you _know_; events.db holds what _happened_. The two layers stay separate:

| Vault (`vault/`)             | events.db (`.claude/state/events.db`) |
| ---------------------------- | ------------------------------------- |
| Curated, semantic, archetype | Automatic, mechanical, instrumented   |
| One entry per concept        | One row per action                    |
| Git-tracked (in `_seed/`)    | Gitignored, machine-local             |
| Markdown + YAML frontmatter  | Indexed SQL columns                   |

Bootstrap + seed from existing JSONL logs:

```bash
node scripts/events-db-init.mjs           # idempotent schema
node scripts/events-db-backfill.mjs       # seed from vault/raw/*.jsonl
node scripts/import-session-usage.mjs     # import per-turn token usage from
                                          # Claude Code session JSONL (in-session
                                          # cost attribution for slash commands
                                          # + interactive turns)
```

### Event sources

| event source                               | captured?                                    | model/tokens/cost?                                     |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------ |
| Scheduler tick (subprocess)                | ✓ via `record-router-event` / dual-write     | full metrics                                           |
| Dashboard AI bridge (subprocess)           | ✓ via `routes/action.ts` stream-json parsing | full metrics                                           |
| Dashboard edits                            | ✓ via `routes/edit.ts` dual-write            | metric-less (no LLM)                                   |
| Router CLI dispatches (`/os …`)            | ✓ via `record-router-event` wrapper          | audit-only (subprocess outside)                        |
| Skill-body audit logs                      | ✓ via `record-dashboard-action` wrapper      | audit-only                                             |
| **In-session turns** (slash + interactive) | ✓ via `import-session-usage.mjs`             | full metrics (parsed from Claude Code's session JSONL) |

Audit-only rows show a small `audit-only` pill in the Insights table — they record that the action happened but lack model/tokens/cost because no subprocess wrapped the LLM call.

Query from CLI:

```bash
sqlite3 .claude/state/events.db "SELECT kind, count(*) FROM events GROUP BY kind"
sqlite3 .claude/state/events.db "SELECT skill, count(*) AS n, printf('%.4f', sum(cost_usd)) AS cost FROM events WHERE skill IS NOT NULL GROUP BY skill ORDER BY 3 DESC"
```

Or from the dashboard's **Insights** view — counts by kind/skill/model, total cost, slowest events, recent events table with click-to-expand + column resize. JSONL audit files in `vault/raw/` continue to be appended for backward compatibility; future cleanup may retire them once events.db proves itself.

Full standard: [`vault/wiki/_seed/meta/reference/standard-event-store.md`](vault/wiki/_seed/meta/reference/standard-event-store.md).

## Structure

```
.claude/skills/      Invokable actions (one directory per skill: <name>/SKILL.md)
.claude/hooks/       Lifecycle hooks (curation, index rebuild, session brief)
.claude/state/       Internal state (install marker, schedule dedupe, launchd logs, events.db)
_templates/          Scaffolder templates for new domains/skills/apps/archetypes
scripts/             Out-of-band runners (scheduler tick + audit + macOS installer)
repos/               Ingested external repositories (gitignored; one clone per slug)
domains/             Domain playbooks + optional apps + sub-domains
  meta/              The OS itself as a domain (includes the dashboard app)
  development/
  research/
vault/               3-stage memory lifecycle
  raw/               Unstructured ingest + JSONL audit logs (gitignored)
  wiki/              Structured memory: <domain>/<archetype>/<slug>.md (only _seed/ committed)
  output/            Generated artifacts (gitignored) — briefs, status reports,
                     change plans, change reviews, health checks
  .index/            Derived manifest, rebuilt by hook (gitignored)
```

## Key files

- `CLAUDE.md` — workspace instructions auto-loaded by Claude Code on every session
- `OS.md` — entry-point map, intent vocabulary, domain index
- `CONTRIBUTING.md` — how to extend the OS (add skills, domains, MCPs, archetypes)
- `TROUBLESHOOTING.md` — common failure modes + fixes for install, MCP setup, skill failures, vault state, commit/CI
- `domains/meta/playbook.md` — full OS standards and evolution protocol
- `vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md` — why the OS is shaped this way
- `vault/wiki/_seed/meta/reference/standard-team-customization.md` — extension model for team forks
- `vault/wiki/_seed/meta/reference/` — detailed reference entries for each standard

## Design principles

1. **Plain files, no databases.** Wiki entries are markdown with frontmatter; logs are JSONL; the index is JSON. Greppable, git-friendly, portable.
2. **Self-extending.** The dashboard's `add domain`, `add skill`, `add app` workflows are how the OS grows. No bespoke kernel changes needed for new capabilities.
3. **Two-layer memory.** Claude Code's built-in memory holds user profile + feedback; the OS's vault holds structured domain knowledge.
4. **Router-first dispatch.** All actions flow through `/os`. Misses are logged to evolve the vocabulary.
5. **Apps are optional UI over the same files.** Reading vault from React is just `fs.readFile`. No new auth, no new storage.
6. **Layered defense.** For every load-bearing constraint we want to enforce (filled-in change descriptions, valid YAML, project-scoped scheduler firing, …), the enforcement lives in three places: the **skill** (fail-fast at the point of harm), the **audit** (passive scan, surfaces drift), and the **dashboard** (visual nudge). One layer alone fails silently; three layers catch what each misses.
7. **Backlinks are the inverse query.** Manifest collects `[[wikilinks]]` from every entry. "What belongs to project X" / "what mentions decision Y" / "what changes touched repo Z" are all manifest reads, not stored lists. No dual-write, no list maintenance.

## Status

v1 build, distribution-ready for small-team installs. The architecture is locked (see [`vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md`](vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md)), the standards are documented in [`vault/wiki/_seed/meta/reference/`](vault/wiki/_seed/meta/reference/), and the OS scaffolds itself for everything beyond the initial bootstrap. End-to-end automation has been validated on real changes through the full lifecycle (research → plan → review → execute → PR → review → publish → close).

Deferred to v2+: bot-account separation for true PR APPROVE events (currently auto-downgrades to COMMENT when the PAT-holder is also the PR author), team-shared metrics aggregation across engineers, skill marketplace / upstream-tracking model.
