---
id: build-agentic-os-v1
type: project
domain: meta
created: 2026-05-19T16:40:00Z
updated: '2026-05-31T20:06:47.556Z'
tags: [feature, bootstrap, dogfood]
source: seed
private: false
title: Build Agentic OS v1
status: active
deadline: 2026-06-30
stakeholders: [[meta-domain]]
lifecycle_stage: active
milestones:
  - {date: 2026-05-19, label: "Architecture + standards lockdown", status: done}
  - {date: 2026-05-19, label: "Bootstrap skeleton + templates + skills", status: done}
  - {date: 2026-05-19, label: "Dashboard layers 1-11", status: done}
  - {date: 2026-05-20, label: "Heartbeat (scheduled jobs)", status: done}
  - {date: 2026-05-20, label: "Compliance audit + Health view", status: done}
  - {date: 2026-05-20, label: "Repo ingestion + dev-ingest-repo skill", status: done}
  - {date: 2026-05-21, label: "Projects as scope + lifecycle + reporting", status: done}
  - {date: 2026-05-21, label: "Changes archetype + multi-tier composition with projects", status: done}
  - {date: 2026-05-21, label: "Change workflow: dev-write-change + dev-review-change (plan/review/execute gate)", status: done}
  - {date: 2026-06-01, label: "dev-open-pr + dev-close-change (PR lifecycle automation)", status: pending}
  - {date: 2026-06-15, label: "MCP integrations (Notion/Linear/Slack)", status: pending}
  - {date: 2026-06-30, label: "v1 frozen — daily use stable", status: pending}
reporting:
  cadence: weekly
  target: clipboard
  target_ref: null
  last_sent: null
  next_due: 2026-05-28
automation: {"enabled":false,"mode":"sequential-changes","pause_on":["review-not-approved","skill-failure"],"state":{"phase":"idle","current_change":null,"current_step":null,"paused_reason":null,"last_transition":null}}
---

# Build Agentic OS v1

The OS dogfooding itself. This entry is the canonical worked example of how `project` is meant to be used — extended frontmatter (lifecycle_stage, milestones, reporting), owned decisions (via `project: build-agentic-os-v1` in their frontmatter), and weekly clipboard-target status reports.

## Goal

Ship a self-extending agentic OS built on Claude Code where every primitive (domain, skill, app, archetype, hook, schedule, project, …) can be added through the OS itself. Daily use stable by 2026-06-30.

## Scope

In scope:

- Local-first file-based OS — every primitive is markdown/JSONL on disk
- Dashboard for visual editing + AI bridge
- Self-extending: new domains/skills/apps/archetypes/schedules/projects via `meta-*` skills
- Heartbeat: scheduled runbooks via launchd
- Repository ingestion: clone + map external repos
- Projects: scope + lifecycle + reporting glue

Out of scope (v1):

- Multi-user collaboration
- Cloud-hosted dashboard
- Per-Claude-invocation cost tracking
- MCP integrations (deferred to v1.5 — `lifecycle_stage` flows from v1 to v1.5)

## Owned decisions

The architectural decisions captured under this project carry `project: build-agentic-os-v1` in their frontmatter. The dashboard's **Projects → Build Agentic OS v1 → Owned by this project → decisions** section surfaces them all. As of 2026-05-21:

- Skills live at subdirectories
- Biome + Prettier split-tool linting
- Fastify chosen over alternatives for app backends
- react-markdown + remark-gfm for content rendering
- Dashboard-driven destructive skills skip plan mode
- Stale-detection pattern (mtime vs. manifest)

(Each is an entry under `vault/wiki/_seed/meta/decision/` — clicking through in the dashboard navigates there.)

## Stakeholders

[[meta-domain]] — the OS as an entity owns this project. Single-stakeholder; this is bootstrap work.

## Notes

- The OS is its own first user. Every primitive shipped is exercised here.
- The dashboard's Projects view is the canonical surface for this entry — open it to see the Owned/Referenced split, the milestone progress, the reporting cadence, and (eventually) the generated status reports under `vault/output/meta/status-reports/`.
- This entry ships in `_seed/` and gets committed to git — it's documentation, not user state.
- A real user-created project (e.g., a feature in your own repo) would NOT live in `_seed/`; it'd live at `vault/wiki/<your-domain>/project/<your-slug>.md` (gitignored except for `_seed/`).
