---
id: standard-project-workflow
type: reference
domain: meta
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [standard, project, workflow]
source: seed
private: false
title: Project workflow standard
url: internal://standard/project-workflow
kind: doc
last_verified: 2026-05-21
---

# Project workflow standard

## What a project is

A **project** is the glue between primitives — a scope + lifecycle + outputs that bundles related work into a single queryable thing. A project can drive a feature in a repo, a research effort, or any initiative that lasts longer than a one-off task.

Three properties make something a project rather than a note:

1. **Scope** — there's a defined boundary (a feature, a repo subsystem, a research question)
2. **Lifecycle** — it moves through stages (planning → active → review → shipped → archived) rather than just existing
3. **Outputs** — it accumulates artifacts as it progresses (decisions, PRs, status reports, generated docs)

If something doesn't have all three, use a lighter archetype: `note` for one-off observations, `decision` for individual architecture calls, `runbook` for repeatable procedures.

## Data model: extended archetype + backlink aggregation

We model projects as an **extended `project` archetype** plus implicit **backlink aggregation**. The project entry carries the load-bearing fields; everything else discovers project membership by including `[[project-id]]` wikilinks in their body.

```yaml
---
id: <slug>
type: project
domain: <domain>
# shared frontmatter ...
title: <human title>
status: active                        # active | paused | completed | cancelled
deadline: 2026-06-15
stakeholders: [[entity-id]]

# Workflow extension (optional but populated for code-driving projects)
repos:                                # list of ingested-repo entities this project operates on
  - <repo-entity-id-1>                # projects can span multiple repos (web + api, etc.)
  - <repo-entity-id-2>
lifecycle_stage: planning             # planning | active | review | shipped | archived
milestones:
  - {date: 2026-05-25, label: "Design locked", status: done}
  - {date: 2026-06-01, label: "Backend impl", status: pending}
reporting:
  cadence: weekly                     # daily | weekly | none
  target: clipboard                   # clipboard | notion | linear | slack | none
  target_ref: null                    # platform-specific id when target != clipboard|none
  last_sent: null
  next_due: 2026-05-28
---
```

**Branch tracking lives on the repo entity**, not on the project. Each ingested repo carries its own `current_branch` (set by `dev-ingest-repo`, updated by feature-work skills). When a project touches multiple repos, each repo independently tracks the branch the OS is operating on. v1 supports one project per repo at a time.

## Two ways an entry can relate to a project

There's an important distinction between **ownership** and **reference**:

| relationship   | how it's expressed                                     | semantics                                                                                                               |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Owned**      | `project: <project-id>` in the entry's **frontmatter** | The entry was _captured under this project's work_. Stronger claim. Surfaced as the project's accumulated work product. |
| **Referenced** | `[[<project-id>]]` in the entry's **body**             | The entry _mentions this project_. Loose context — comparison, similar pattern, supporting material.                    |

Both are useful; they answer different questions:

- "What did we produce while working on this project?" → owned
- "What's related context for this project?" → referenced

In the Projects dashboard view, the **Linked artifacts** section splits these into two sub-groups so you can see them separately. An entry can be both (owned AND link to the project in its body), in which case it shows in the owned section.

The owning `project:` field is an **optional shared field** that any archetype can carry (see [[standard-wiki-format]] for the registry of shared optional fields). The audit's `entry-project-exists` check verifies the referenced project entity exists for every entry that claims one.

**Backlinks remain the inverse query for references**. The manifest's `backlinks` field collects body wikilinks — so "show me every entry that mentions this project" is still a one-line query. The new ownership field doesn't replace that — it adds a stronger orthogonal signal.

## Status vs. lifecycle_stage

Both fields exist because they answer different questions:

| `status` (coarse)                                                       | `lifecycle_stage` (fine)                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Is this project still being worked on at all?                           | Where in the dev cycle is it?                                 |
| Values: `active`, `paused`, `completed`, `cancelled`                    | Values: `planning`, `active`, `review`, `shipped`, `archived` |
| Drives scheduler firing (project-scoped runbooks fire only when active) | Informational; helps with reporting and dashboard surfacing   |
| Updated rarely (major state change)                                     | Updated more often (every stage transition)                   |

A project can be `status: active, lifecycle_stage: review` — actively monitored, in code-review phase.

## Project-scoped scheduled runbooks

A `runbook` with `schedule:` + `prompt:` (per [[standard-scheduled-jobs]]) can additionally carry `project: <project-id>` in its frontmatter:

```yaml
type: runbook
schedule: "0 9 * * 1"
prompt: "/os status-report feature-search-revamp"
project: feature-search-revamp
```

The scheduler tick (`scripts/scheduler-tick.mjs`) reads each due schedule's `project` field, looks up the project entry, and **skips firing when `project.status != "active"`**. Pausing or completing a project automatically pauses its scheduled work — no need to disable schedules manually.

For runbooks, the `project:` field has dual purpose: it both expresses **ownership** (the runbook belongs to this project) AND **gates firing** (project must be active). The audit's `entry-project-exists` check verifies the referenced project exists for any entry that claims one.

### Multiple schedules per project

A project commonly needs more than one cadence — daily progress checks, weekly status reports, pre-deploy verifications, end-of-sprint retrospectives. **Each is a separate runbook** with its own `schedule:` cron and `prompt:`, all carrying the same `project: <id>`. The scheduler discovers and fires them independently; the Projects dashboard view lists all of them under the project's "Active schedules" section.

Example for a project that wants three cadences:

```
vault/wiki/<domain>/runbook/
  feature-x-daily-progress.md       schedule: "0 9 * * 1-5"   project: feature-x
  feature-x-weekly-status.md        schedule: "0 9 * * 1"     project: feature-x
  feature-x-pre-deploy-check.md     schedule: "0 15 * * 1-5"  project: feature-x
```

All three pause automatically when the project moves to `status: paused`. Scaffold each with `/os add-schedule` (the schedule scaffolder takes a `project` input to wire this in one shot).

## Reporting model

A project's `reporting` block declares how status updates flow out of the OS.

| target      | what happens                                                                                                                                              | v1 status     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `clipboard` | `meta-status-report` skill (future) writes markdown to `vault/output/<domain>/status-reports/<project-id>-<date>.md`; user copies to their tool of choice | **supported** |
| `notion`    | Same markdown + post to a Notion database via MCP server                                                                                                  | deferred      |
| `linear`    | Same markdown + create/update a Linear cycle update                                                                                                       | deferred      |
| `slack`     | Same markdown + post to a configured channel                                                                                                              | deferred      |
| `none`      | No report generated even when cadence fires                                                                                                               | supported     |

For v1, `target: clipboard` is the load-bearing path. The agent writes a structured markdown report; the user pastes it wherever. MCP integrations are deferred until projects are dogfooded — once we know what shape reports actually take in practice, we'll know what platform integration is worth.

The (future) `meta-status-report` skill walks the project's recent activity:

- Commits in `repos/<repo-slug>/` on `current_branch` since `last_sent`
- Backlinked decisions/notes created since `last_sent`
- Scheduler runs tagged with this project
- Milestone status changes

It updates `reporting.last_sent` and recomputes `reporting.next_due` based on `cadence`.

## Lifecycle transitions

In v1 transitions are **manual** — edit the project entry's frontmatter via the Vault view's `EditableMarkdown` or directly on disk. The cookbook below documents what each transition should accomplish.

### Cookbook

| transition         | trigger                                    | check before                                                                         | update                                                                                            | side-effects to expect                                                                                                                                                |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| → `planning`       | New project                                | —                                                                                    | `meta-add-project` sets `status: active, lifecycle_stage: planning`                               | Scheduler ignores any project-scoped schedules until status stays active AND lifecycle_stage moves to active or later.                                                |
| planning → active  | Feature work starting                      | All design decisions captured under the project? Milestones realistic?               | `lifecycle_stage: active`. In the linked repo entity, set `current_branch: agent/<feature-slug>`. | Project-scoped scheduled runbooks (`project: <id>` with `schedule:`) start firing. Status reports begin generating real content.                                      |
| active → review    | PR opened, awaiting review                 | All planned milestones except the deploy/ship one done? Tests green?                 | `lifecycle_stage: review`. (Status stays `active`.)                                               | No automatic side-effects. Status reports note "in review" phase.                                                                                                     |
| review → shipped   | PR merged                                  | Deploy milestone done? Any open follow-ups captured as notes/decisions?              | `lifecycle_stage: shipped`. Mark the deploy milestone `status: done`.                             | Scheduled runbooks keep firing (project is still active) — useful for monitoring/follow-ups. Move to `archived` to fully stand down.                                  |
| any → paused       | Work blocked / deferred                    | Capture the blocker as a `[[note-...]]` linked from the project                      | `status: paused`. (lifecycle_stage stays where it was.)                                           | Scheduler **immediately stops firing** project-scoped runbooks. Set a target return date in the body.                                                                 |
| any → cancelled    | Work abandoned                             | Write a `[[decision-...]]` capturing why (owned by this project)                     | `status: cancelled`.                                                                              | Scheduler stops firing. Existing artifacts (status reports, owned decisions/notes) stay as historical record.                                                         |
| shipped → archived | Project complete, no further work expected | Generate one final status report. Confirm no open dependencies from other projects.  | `status: completed`. `lifecycle_stage: archived`.                                                 | Scheduler stops firing. The clone in `repos/<id>/` can be removed manually if no other project references it. Status reports stay where they are (don't move/delete). |
| paused → active    | Unblocked, resuming                        | Re-read the body's blocker notes — still relevant? Are linked entities still around? | `status: active`. (lifecycle_stage stays where it was; promote if the situation changed.)         | Project-scoped scheduled runbooks start firing again.                                                                                                                 |

### When to capture a decision as part of a transition

Stage transitions are good moments to capture an architectural decision under the project. Example: when moving `active → review`, if there were technical choices made that downstream developers should know about, write a `decision` entry with `project: <project-id>` in its frontmatter. It then appears in the project's **Owned by this project** section automatically. This is the canonical mechanism for accumulating institutional knowledge under a project.

v2 may add a `meta-project-transition` skill that automates side-effects (write a milestone-done entry, generate a final status report on archival, prompt for the decision capture). Not v1 — manual edits are fine for now.

## Tag conventions

The `tags:` array is freeform — the OS doesn't enforce a vocabulary. But consistency pays off as projects accumulate, both for dashboard filtering and for the `meta-status-report` skill's TL;DR synthesis. Recommended top-level kind tags (pick one per project):

| tag           | meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `feature`     | New user-facing capability in a repo                                      |
| `bug`         | Tracked investigation + fix of a defect                                   |
| `migration`   | Schema/system/dependency move; one-shot                                   |
| `experiment`  | Time-boxed exploration; expected to either ship or get cancelled          |
| `research`    | Read + synthesize; no code expected                                       |
| `maintenance` | Refactor, dep bumps, doc sweeps                                           |
| `bootstrap`   | Building/extending the OS itself (the seed project uses this + `dogfood`) |

Combine kind tags with topic tags (`auth`, `search`, `billing`, etc) and platform tags (`web`, `api`, `mobile`). Example: `tags: [feature, search, web, api]` for a search feature spanning web + api.

Avoid invent-a-tag-per-project — tags are useful in aggregate. The `By archetype` view (Vault) and project list both filter by tag, so a small consistent vocabulary lets you ask "show me all active feature projects" cleanly.

## Cross-project relationships

Projects don't exist in isolation. Common relationships:

| relationship                                                                                      | how to express it                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dependency** — project B can't start until project A ships                                      | In project B's body, write a line like: `> Blocked on [[project-a]] shipping the foo refactor.` Body wikilink, no frontmatter. The manifest's backlinks make this discoverable from project A's **Referenced from elsewhere** section. |
| **Parent / sub-project** — large initiative split into smaller efforts                            | Parent's body lists sub-projects: `## Sub-projects` then `- [[project-sub-a]]`, `- [[project-sub-b]]`. Each sub-project's body links back: `## Parent`, `[[project-parent]]`. Pure wikilinks, no new frontmatter field.                |
| **Successor** — this project replaces another                                                     | New project body: `> Supersedes [[project-old]] — see its archived state for context.` The old project gets a body note added on archival pointing at the successor.                                                                   |
| **Cross-cutting context** — projects that operate on the same codebase but pursue different goals | Each carries a `[[repo-entity-id]]` reference; the repo entity's body could list `## Active projects` with backlinks. Or rely on the manifest's backlinks-by-entity query.                                                             |

The `[[project-id]]` body wikilink pattern handles all of these without new schema. The dashboard's **Referenced from elsewhere** section surfaces incoming references; outgoing references are visible in the rendered body.

A project that imports a decision from another project (e.g. "we're using the same auth pattern as `[[project-x]]`") just `[[project-x]]`s in the body — that's a reference, not ownership. The `project:` frontmatter field is **single-valued** for ownership; an entry has at most one owning project.

## Audit support

The OS audit (`scripts/audit.mjs`) enforces project shape:

| check id                       | severity | what it enforces                                                                                                   |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `project-status-enum`          | error    | `status` is one of `active`, `paused`, `completed`, `cancelled`                                                    |
| `project-lifecycle-stage-enum` | warn     | `lifecycle_stage`, when set, is one of the documented values                                                       |
| `project-repos-exist`          | error    | every id in the `repos` array (when set) matches an existing `kind: repo` entity                                   |
| `project-deadline-overdue`     | info     | `deadline` is in the past but `status == active` (surface for review)                                              |
| `project-stale`                | info     | `status == active` but no updates in 30+ days (counting project entry + owned entries) — flag for triage           |
| `project-reporting-target-ref` | error    | `reporting.target_ref` is non-empty when `target` is `notion`/`linear`/`slack`                                     |
| `entry-project-exists`         | error    | when any entry carries `project: <id>` in frontmatter (decision, note, runbook, …), that project entity must exist |

## Retirement

To retire a project:

1. Set `status: completed` (or `cancelled` if abandoned). Scheduler stops firing project-scoped runbooks.
2. Optionally set `lifecycle_stage: archived` for clarity.
3. Generated artifacts (`vault/output/<domain>/status-reports/<project-id>-*.md`) stay as historical record — do not delete.
4. The repo clone in `repos/<repo-slug>/` is separately managed — delete only if no other project references the same repo.
5. Decisions, notes, runbooks with `[[<project-id>]]` backlinks stay — they're context. The dangling-link audit check tolerates references to completed projects.

## Related

- [[archetype-project]] — the underlying archetype + the new optional workflow fields
- [[archetype-entity]] — repo entities that projects reference
- [[standard-scheduled-jobs]] — runbooks can carry `project: <id>` for project-scoped firing
- [[standard-repo-ingestion]] — where the repo entity comes from
- [[standard-feature-anatomy]] — projects built against the standard anatomy (data: extended archetype; runtime: scheduler integration; scaffolder: meta-add-project; docs: this entry)
- [[meta-add-project]] — the scaffolder skill
- [[meta-status-report]] — generates the periodic status report described in this workflow
- [[dev-ingest-repo]] — produces the repo a project can reference
