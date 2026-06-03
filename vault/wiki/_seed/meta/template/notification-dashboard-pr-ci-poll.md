---
id: notification-dashboard-pr-ci-poll
type: reference
domain: meta
created: 2026-06-01T19:30:00Z
updated: 2026-06-01T19:30:00Z
tags: [template, notification, dispatch, change, ci, pr]
source: vault/wiki/development/change/notification-templates-housekeeping-batch.md
private: false
title: Notification template — CI snapshot fetched
url: internal://template/notification-dashboard-pr-ci-poll
kind: template
last_verified: 2026-06-01
---

# Notification template — CI snapshot fetched

Renders when `dashboard.pr-ci-poll` fires (the dashboard sync polled GitHub for PR CI state and recorded the result). Overrides `notification-default.md` for this event_type. Event carries `change_id` + a `description` listing any frontmatter transitions (e.g. `ci_state: running → pass`). When the poll produced no transitions, description reads `no changes (frontmatter already current)`.

**Noise note.** This event fires on every dashboard CI sync — for a change with a long-running PR, that's many no-op polls. Consider rate-limiting subscriptions on this rule (`rate_limit: {per_change_per_24h: 3}`) or filtering rules to fire only when the description contains a state arrow (`→`).

## title

🤖 CI update — {{change_id}}

## body

Project: {{project}}
{{description}}
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}
