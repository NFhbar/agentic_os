---
id: walkthrough-add-project
type: reference
domain: meta
created: 2026-06-01T20:30:00Z
updated: 2026-06-01T20:30:00Z
tags: [walkthrough, tutorial, project, getting-started]
source: vault/wiki/development/change/guide-walkthroughs-section.md
private: false
title: "Walkthrough — add a project"
url: internal://walkthrough/add-project
kind: walkthrough
last_verified: 2026-06-01
---

# Walkthrough — add a project

A **project** is the workflow scope between a single change and an ongoing area of work. Projects own a deadline, milestones, a reporting cadence, and (optionally) one or more ingested repos. Use a project when work crosses multiple changes, accumulates decisions over time, or spans repos.

## Goal

After this walkthrough you have:

- A project entry at `vault/wiki/<domain>/project/<slug>.md`
- A registered scope that owned changes, decisions, notes, and research reports can attach to
- A status-report cadence (clipboard target by default)
- Optionally: linked ingested repos as the project's implementation targets

## Prerequisites

- The OS is installed and running
- If the project will target a repo, ingest it first (see [[walkthrough-ingest-repo]])

## Steps (UI)

1. **Open the Overview page**. In the Quick Actions row, click **`+ Project`**.
2. The form opens. Fill in:
   - **`name`** _(required)_ — Human-readable project name. Used to derive the slug.
   - **`title`** _(required)_ — Display title (can match `name`).
   - **`domain`** _(required)_ — Which domain owns this project (e.g. `development`, `research`, `meta`).
   - **`repos`** _(optional)_ — Comma-separated entity ids of ingested repos the project targets. Example: `api` or `api,my-frontend`. Each must already exist as an entity (run [[walkthrough-ingest-repo]] first).
   - **`deadline`** _(optional)_ — ISO date. The dashboard surfaces overdue / due-soon status across views.
   - **`reporting`** _(optional)_ — Cadence + target. Cadence ∈ `daily | weekly | biweekly | monthly`. Target defaults to `clipboard` — copy-paste workflow; native integrations are deferred.
3. Click **Submit**. `meta-add-project` runs and writes the entry.
4. **Open the new project page** — sidebar → Projects → click the new row. You'll see Overview / Plan / Changes / Research / Decisions / Notes / Status tabs.

## Steps (CLI)

```bash
/os add project "Mull Version 2"
# answers prompts for domain, repos, deadline, reporting
```

## What gets created

```
vault/wiki/<domain>/project/<slug>.md           ← project entry (frontmatter + sections)
```

The body has scaffolded sections for **Goal · Scope · Milestones · Stakeholders · Decisions · Notes** — placeholder text that you fill in. The dashboard renders this body on the project Overview tab (now editable inline via the About card).

## Edit the project body

The Goal / Scope / Milestones / Stakeholders are placeholders. Edit them by:

- **In-app**: Project page → Overview tab → About card. Click to edit, save on blur.
- **By hand**: `$EDITOR vault/wiki/<domain>/project/<slug>.md`.

Frontmatter fields worth setting:

- `milestones:` — array of `{date: "YYYY-MM-DD", label: "<short>", status: pending|done}`. Surfaces in the Overview phase timeline + every status report.
- `automation:` — set to `{enabled: true, mode: sequential-changes, ...}` to opt into the project automation orchestrator. See the Process Automation section in the README.

## What to do next

- **Spec out the work** — see [[walkthrough-add-research-report]] for a research-first flow, or jump straight to changes via [[walkthrough-write-change]].
- **Add decisions as they happen** — Decisions tab → `+ Add decision`. Decisions backlink the project via `[[<project-id>]]` in the body.
- **Schedule status reports** — the cadence you set above feeds `meta-status-report`. Reports land in `vault/output/<domain>/status-reports/`.
- **Enable automation** — Project page → Automation tab. The orchestrator drives the change lifecycle (write → open-pr → review → merge) end-to-end. See the README's Process Automation section.

## Gotchas

- **Repos must already be entities.** If you reference a repo that hasn't been ingested, the project's `repos:` field still saves but downstream skills (status reports, change scaffolders) will warn. Ingest first.
- **Reporting cadence is advisory.** v1 doesn't fire reports automatically — you trigger them via the project's Status tab "Generate report" button or `/os status report <project>`.
- **Lifecycle stage vs. status.** `lifecycle_stage` (`planning → active → review → shipped → archived`) is for sequencing; `status` (`active | paused | completed | cancelled`) gates scheduled runbooks. Pause a project to silence its status reports.

## See also

- [[archetype-project]] — full project archetype reference
- [[walkthrough-add-research-report]] — research-first project flow
- [[walkthrough-write-change]] — change lifecycle inside a project
