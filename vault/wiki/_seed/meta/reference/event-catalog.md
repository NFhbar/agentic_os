---
id: event-catalog
type: reference
domain: meta
created: 2026-05-30T01:00:00Z
updated: 2026-05-30T01:00:00Z
tags: [reference, notifications, events, catalog]
source: vault/wiki/development/change/event-catalog.md
private: false
title: Event-type catalog
url: internal://reference/event-catalog
kind: catalog
last_verified: 2026-05-30
---

# Event-type catalog

Curated registry of user-facing lifecycle events. The Notifications app reads this to:

- Show every subscribable event in the rule matrix (not just events that have already fired)
- Suggest `notification-<event-type>.md` template overrides per event (per `standard-template-syntax`)
- Drive the per-lifecycle-step "Notify me" bell affordances on entity pages (project / change / research-report)

Not exhaustive — system-level events (`schedule.*`, `router.*`, `session.*`, `dashboard.ai-prompt`) are excluded as noise. Add entries here when introducing a new user-facing lifecycle transition.

## Schema

Each row is `event_type | description | entity | entity_filter_field | lifecycle_step`:

- **event_type**: the literal `kind.action` recorded in events.db. Names are kept verbatim (warts and all) — renaming is a separate cleanup change documented in the slack-mcp wrap-up.
- **description**: one-line human-readable summary (what does this event mean?).
- **entity**: which archetype this event relates to (`project` / `change` / `research-report` / `none`). Drives the bell affordance's surface.
- **entity_filter_field**: the events.db column that holds the entity id (`project` / `change_id` / `report_id`). Used by the bell to pre-fill `filter.<field>` in the new rule.
- **lifecycle_step**: comma-separated `<context>:<step-id>` values declaring which lifecycle-stepper steps subscribe to this event when the user clicks their bell. Contexts: `change` (the change-detail page's stepper), `research-report` (the research-detail page's stepper), `project` (the project Plan tab's stepper). One event can carry multiple values — e.g. `dashboard.research-write` is both the research-stepper "drafted" step AND the project-plan "in-research" step. Leave empty (`—`) for events that don't appear on any stepper.

## Project events

| event_type                     | description                                      | entity  | entity_filter_field | lifecycle_step  |
| ------------------------------ | ------------------------------------------------ | ------- | ------------------- | --------------- |
| dashboard.add-project          | Project scaffolded                               | project | project             | project:pending |
| dashboard.project-research-add | Research note added to a project                 | project | project             | —               |
| dashboard.status-report        | Status report generated (kickoff/status/wrap-up) | project | project             | —               |
| dashboard.project-complete     | Project marked complete                          | project | project             | —               |
| dashboard.project-reopen       | Completed project reopened                       | project | project             | —               |

## Change events

| event_type                              | description                                      | entity | entity_filter_field | lifecycle_step         |
| --------------------------------------- | ------------------------------------------------ | ------ | ------------------- | ---------------------- |
| dashboard.add-change                    | Change scaffolded (planning state begins)        | change | change_id           | change:scaffolded      |
| dashboard.write-change-plan             | dev-write-change plan written                    | change | change_id           | change:plan-written    |
| dashboard.review-change                 | dev-review-change verdict produced               | change | change_id           | change:plan-reviewed   |
| dashboard.revise-plan                   | dev-revise-plan reflowed the plan after review   | change | change_id           | —                      |
| dashboard.write-change-execute          | dev-write-change EXECUTE ran                     | change | change_id           | change:code-executed   |
| dashboard.write-change-address-comments | Inline PR-review comments folded into the change | change | change_id           | —                      |
| dashboard.open-pr                       | PR opened on GitHub                              | change | change_id           | change:pr-opened       |
| dashboard.mark-pr-ready                 | PR marked ready (left draft)                     | change | change_id           | change:ready-for-human |
| dashboard.pr-review                     | PR review run                                    | change | change_id           | —                      |
| dashboard.pr-review-publish             | PR review submitted to GitHub                    | change | change_id           | change:pr-reviewed     |
| dashboard.pr-ci-poll                    | CI snapshot fetched                              | change | change_id           | —                      |
| dashboard.pr-comment-accept-all         | Bulk-accepted inline review comments             | change | change_id           | —                      |
| dashboard.pr-comment-mutate             | Single inline comment accepted/rejected          | change | change_id           | —                      |
| dashboard.change-push                   | Branch pushed                                    | change | change_id           | —                      |
| dashboard.close-change                  | Change closed (remote merge confirmed)           | change | change_id           | —                      |
| dashboard.change-close-local            | Change closed via vault-only mark-merged-local   | change | change_id           | change:merged          |
| dashboard.change-abandon                | Change abandoned                                 | change | change_id           | —                      |

## Change-automation events (Phase 2+)

Per-change automation orchestrator events. Fire when the orchestrator transitions a change's `automation.state.phase` (idle ↔ running ↔ paused/complete) and on each step dispatch. See `[[standard-automation-loop]]` for the state machine.

| event_type                              | description                                                                                      | entity | entity_filter_field | lifecycle_step         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ | ------------------- | ---------------------- |
| dashboard.change-automation-enable      | User toggled automation on for a change                                                          | change | change_id           | —                      |
| dashboard.change-automation-disable     | User toggled automation off for a change                                                         | change | change_id           | —                      |
| dashboard.change-automation-advance     | Orchestrator dispatched the next step (execute / open-pr / pr-review / address-comments)         | change | change_id           | —                      |
| dashboard.change-automation-park        | Orchestrator parked (skill-failure / user-paused / dispatch-failure / unknown-step)              | change | change_id           | —                      |
| dashboard.change-automation-cap-reached | Iteration cap hit on the address-comments loop — automation parked, awaits human                 | change | change_id           | —                      |
| dashboard.change-automation-complete    | Change reached complete (PR open + locally reviewed clean) — automation done, awaits human merge | change | change_id           | change:ready-for-human |
| dashboard.change-automation-resume      | User resumed paused automation                                                                   | change | change_id           | —                      |
| dashboard.change-automation-reset       | User reset automation state (phase: idle, iteration_count: 0)                                    | change | change_id           | —                      |

## Research-report events

| event_type                                           | description                                           | entity          | entity_filter_field | lifecycle_step                               |
| ---------------------------------------------------- | ----------------------------------------------------- | --------------- | ------------------- | -------------------------------------------- |
| dashboard.research-write                             | research-write skill dispatched                       | research-report | report_id           | research-report:drafted, project:in-research |
| dashboard.research-write-dispatch                    | research-write run record (companion to the above)    | research-report | report_id           | —                                            |
| dashboard.research-review-dispatch                   | research-review run record                            | research-report | report_id           | —                                            |
| dashboard.research-revise-dispatch                   | research-revise run record                            | research-report | report_id           | —                                            |
| dashboard.research-update-dispatch                   | research-update run record                            | research-report | report_id           | —                                            |
| dashboard.research-materials-add                     | Material file added to the report's drop zone         | research-report | report_id           | —                                            |
| dashboard.research-materials-delete                  | Material file removed from the drop zone              | research-report | report_id           | —                                            |
| dashboard.research-trigger-dismiss                   | Update-trigger dismissed on a research-report         | research-report | report_id           | —                                            |
| dashboard.research-review                            | research-review skill dispatched                      | research-report | report_id           | research-report:reviewed                     |
| dashboard.research-revise                            | research-revise skill dispatched                      | research-report | report_id           | —                                            |
| dashboard.research-mark-approved                     | review_status overridden to approved (mark approved)  | research-report | report_id           | research-report:approved                     |
| dashboard.research-note-added                        | Note appended to research-report notes_log            | research-report | report_id           | research-report:updated                      |
| dashboard.research-scaffold-recommendations          | Bulk-scaffold of recommended_changes ran              | research-report | report_id           | project:scaffolded                           |
| dashboard.research-scaffold-recommendation-item      | Single recommendation_index scaffolded as a change    | research-report | report_id           | —                                            |
| dashboard.research-scaffold-recommendations-dispatch | Companion dispatch record (orchestrator-side)         | research-report | report_id           | —                                            |
| dashboard.research-seed-materials                    | Files seeded into materials dir before research-write | research-report | report_id           | —                                            |

## Cross-cutting events

| event_type                            | description                             | entity | entity_filter_field | lifecycle_step |
| ------------------------------------- | --------------------------------------- | ------ | ------------------- | -------------- |
| dashboard.curate                      | Vault-curation action (sort/move/merge) | none   | (none)              | —              |
| dashboard.edit                        | Wiki entry edited via the dashboard     | none   | (none)              | —              |
| dashboard.notification-rule-test-send | Notification rule test-sent             | none   | (none)              | —              |

## How the catalog feeds the system

- Server: `GET /api/notifications/event-catalog` parses these tables and returns a flat list. The existing `/event-types` endpoint unions the catalog with events-actually-fired + events-configured-in-rules, so the matrix shows the full subscribable surface.
- Renderer: `template.ts` resolves `notification-<event_type>.md` (with `.` → `-` sanitization) before falling back to `notification-default.md` (per `standard-template-syntax`).
- UI: lifecycle steppers on project / change / research-report pages render a small bell affordance per step; clicking opens RuleEditor pre-filled with the step's event_type + `filter.<entity_filter_field>` set to the current entity id.

## Adding a new event

1. Add a row to the appropriate table above.
2. If a rich message format is wanted, create `vault/wiki/_seed/meta/template/notification-<event-type-with-dots-as-hyphens>.md` (see `standard-template-syntax`).
3. If this event represents a discrete step on an entity's lifecycle, ensure the entity's stepper component carries the event_type so the bell affordance can pre-fill the rule.

## Related

- [[standard-template-syntax]] — Mustache placeholder syntax for templates
- [[standard-os-audit]] — audit hooks that fire against the events table
- [[archetype-notification-config]] — the rule entry that matches these events
