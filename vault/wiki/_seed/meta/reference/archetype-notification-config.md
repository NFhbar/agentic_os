---
id: archetype-notification-config
type: reference
domain: meta
created: 2026-05-27T18:00:00Z
updated: 2026-05-29T22:50:00Z
tags: [archetype, memory, notifications, dispatch, automation]
source: seed
private: false
title: Notification config archetype
url: internal://archetype/notification-config
kind: doc
last_verified: 2026-05-29
---

# Notification config archetype

## What it is

A **notification-config** entry defines one notification rule: which lifecycle event, on which channel, with which filters, rate-limit override, and delivery shape. One entry = one rule = one row in the per-(event, channel) routing matrix the dispatch engine consults on every event insert.

Locked from [[automation-and-notifications-notification-config]] § Findings:

- Primary key is `(event_type, channel)` — the rule schema is intentionally per-event × per-channel so the settings UI can render as a matrix and the dispatcher can short-circuit on event arrival.
- Filters are optional and conjunctive: every populated `filter.*` sub-key must match the event for the rule to fire.
- Rate-limit override is per-rule and feeds the rate limiter's `source: 'rule:<id>'` attribution.

## Required frontmatter (in addition to shared)

| field        | type    | notes                                                                                                                             |
| ------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | string  | Short, scannable (`"change.merged → Slack #eng-updates"`)                                                                         |
| `event_type` | string  | `{kind}.{action}` from events.db — e.g. `change.merged`, `review.verdict-request-changes`, `run.failed`, `schedule.daily-summary` |
| `channel`    | enum    | `slack`, `email`, `desktop`                                                                                                       |
| `enabled`    | boolean | `true` activates the rule; `false` keeps the entry as documentation without firing it                                             |

### Primary key

The entry's shared `id:` IS the rule's primary key. It is the value the dispatcher stamps onto outbound `kind: notification` events as `source: 'rule:<id>'` (see [[automation-and-notifications-notification-config]] § Findings § Dispatch model — "Rule attribution on dispatched events"). Implications:

- The settings UI must preserve `id` across edits and only issue a new id on rule creation — historical attribution in `events.db` breaks if an id is reissued.
- The rate limiter's per-rule queries (`WHERE source = 'rule:' || :rule_id`) read this id directly; there is no separate `rule_id` field.
- The shared `id:` already required by `standard-wiki-format` is sufficient; do NOT add a parallel `rule_id` field.

## Optional frontmatter

The three blocks below are commented out in the template by default. Uncomment and populate the ones the rule needs.

### `filter:` (nested)

All populated sub-keys must match the event for the rule to fire. Any sub-key set to `null` (or absent) matches any value. The dispatcher reads filters from the event row's columns of the same name.

**Per-project scoping is the primary filter use case.** A rule with `filter.project: <id>` fires only for events tagged to that project — letting `project-a` route `change.merged` to one Slack channel while `project-b` routes the same event elsewhere (or not at all). The matrix UI's project facet and the per-project Notifications tab on each project page both build on this filter.

```yaml
# Project-scoped rule — fires only for events from one project.
filter:
  project: project-a          # match events.project; primary scoping mechanism
  domain: null                # match events.domain
  severity: null              # success | info | warning | urgent — collapsed from exit_status + status

# Global rule — no project filter; fires across all projects.
filter:
  project: null               # any project (or no project — e.g. ad-hoc runs)
  domain: development
  severity: urgent
```

### Patterns

- **Project-scoped** — `filter.project: <id>` confines the rule to one project. Use when projects have distinct stakeholders or notification preferences.
- **Global** — `filter.project: null` (or absent). Fires across all projects. Use for cross-cutting concerns like "all `run.failed` events page oncall."
- **Project + severity** — combine `filter.project` and `filter.severity: urgent` to narrow a project's notifications to only its high-signal events.
- **Project-scoped + global, side by side** — both fire when an event matches. A global `change.merged → Slack` AND a project-scoped `change.merged → Slack` for the same project means two notifications. Pick one.

### `delivery:` (nested)

Channel-specific delivery shape. The dispatcher hands this verbatim to the channel adapter; the adapter validates its own keys. Shape per channel (v1):

| channel | required keys                | optional keys                         |
| ------- | ---------------------------- | ------------------------------------- |
| slack   | `slack_channel` (string)     | `tags` (string[] — mention list)      |
| email   | `to` (string[])              | `cc` (string[]), `from` (string)      |
| desktop | (none — fires from open tab) | `urgency` (`low`/`normal`/`critical`) |

```yaml
delivery:
  slack_channel: '#eng-updates'
  tags: ['@john-manager']
```

### `rate_limit:` (nested)

Per-rule override over the global daily cap (default 100). Set `cap_per_day: null` (the default) to inherit the global cap.

```yaml
rate_limit:
  cap_per_day: 25             # per-day soft cap; events beyond log action: 'suppressed-rate-limit'
```

## Lifecycle

| stage            | what it means                                                      |
| ---------------- | ------------------------------------------------------------------ |
| `enabled: true`  | Rule is live — the dispatcher matches incoming events against it   |
| `enabled: false` | Rule is parked — kept as documentation but the dispatcher skips it |

There are no terminal states — disabling a rule preserves historical attribution in `events.db`, deleting the entry breaks `source: 'rule:<id>'` traceability. Prefer disabling over deleting.

## When to use

- Wiring a new lifecycle event into a notification channel (e.g. "fail PRs should ping Slack #oncall")
- Adjusting an existing rule's filter, recipient list, or rate-limit override
- Documenting a deliberately-disabled rule the team agreed not to fire (with `enabled: false` + rationale in `## Notes`)

## When NOT to use

- For ad-hoc one-off pings — those belong in a runbook with a direct adapter call, not in the per-event matrix.
- To configure the dispatch engine's global defaults (the daily cap, render-cache size, retry policy) — those live in app config, not per-rule entries.
- To represent a channel adapter's auth or token — credentials belong in `.env`, not in the vault.

## Body sections

```markdown
# <title>

## Purpose
One paragraph: what this rule notifies about, who it's for, why it exists.

## Notes
Tuning history, false-positive incidents, decisions about filters or rate-limit overrides.
```

The body is intentionally lean — channel- and filter-shape commentary lives in this contract entry, not duplicated as boilerplate in every rule.

## Composition

```
events.db                                  ← source of truth for lifecycle activity
   │  (afterInsert hook)
   ▼
dispatch engine                            ← matches each event against active notification-config entries
   │
   ├─ notification-config(rule-A) → ChannelAdapter(slack)   → outbound event: source='rule:rule-A'
   ├─ notification-config(rule-B) → ChannelAdapter(email)   → outbound event: source='rule:rule-B'
   └─ notification-config(rule-C) → ChannelAdapter(desktop) → outbound event: source='rule:rule-C'
```

Every outbound notification writes a `kind: notification` row back into `events.db` carrying `source: 'rule:<id>'`, which is what makes per-rule rate-limit queries and audit hooks (`notification-rate-limit-exceeded`, `notification-delivery-failed`) work. See [[automation-and-notifications-notification-config]] § Findings § Dispatch model for the full pipeline.

## Outputs / artifacts produced

| artifact                  | location                                            | when                                                 |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Notification-config entry | `vault/wiki/<domain>/notification-config/<id>.md`   | Created via the settings UI (or hand-authored)       |
| Outbound dispatch events  | `.claude/state/events.db` rows `kind: notification` | Written by the dispatch engine on each send/suppress |

## Example

```markdown
---
id: rule-change-merged-slack-eng
type: notification-config
domain: development
created: 2026-05-27T18:00:00Z
updated: 2026-05-27T18:00:00Z
tags: [slack, change-merged]
source: manual
private: false
title: 'change.merged → Slack #eng-updates'
event_type: change.merged
channel: slack
enabled: true
filter:
  project: null
  domain: development
  severity: null
delivery:
  slack_channel: '#eng-updates'
  tags: ['@john-manager']
rate_limit:
  cap_per_day: null
---

# change.merged → Slack #eng-updates

## Purpose
Notify the engineering channel whenever a development-domain change merges. Used to give the team passive awareness of in-flight code work without requiring everyone to keep the dashboard open.

## Notes
- 2026-05-27: initial rule. cap_per_day left null pending the rate-limiter change landing.
```

## Related

- [[automation-and-notifications-notification-config]] — the research report this archetype was locked from (rule schema, dispatch model, rate limiting, render caching)
- [[archetype-runbook]] — for ad-hoc / scheduled procedures; scheduled summaries emit synthetic events that this archetype's rules then notify on
- [[archetype-change]] — the lifecycle events most rules will match against (`change.*` event_types)
- [[standard-event-store]] — events.db schema the dispatcher reads from and writes back to
