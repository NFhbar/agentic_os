---
id: notification-default
type: reference
domain: meta
created: 2026-05-30T00:45:43Z
updated: 2026-05-30T00:45:43Z
tags: [template, notification, dispatch]
source: vault/wiki/development/change/notification-template-renderer.md
private: false
title: Default notification template
url: internal://template/notification-default
kind: template
last_verified: 2026-05-30
---

# Default notification template

The notification dispatcher reads this template at render time. Sections
(`## title`, `## body`, `## link.*`) get Mustache `{{var}}` substitution.
Missing variables substitute to the empty string (Mustache default). For
optional surrounding context, embed the variable inline with prose that reads
cleanly even when the value is empty (e.g. `{{project}} merged` reads as
`merged` when project is null — acceptable; the dispatcher emits the rule
attribution separately).

Available variables (filled from the events.db row + the matched rule):

| variable          | meaning                                        |
| ----------------- | ---------------------------------------------- |
| `{{event_type}}`  | `kind.action` composite (e.g. `change.merged`) |
| `{{kind}}`        | just the event kind                            |
| `{{action}}`      | just the event action                          |
| `{{description}}` | event description (the human-readable summary) |
| `{{status}}`      | event status (`ok` / `error` / etc)            |
| `{{project}}`     | owning project id, if any                      |
| `{{change_id}}`   | owning change id, if any                       |
| `{{report_id}}`   | owning research-report id, if any              |
| `{{domain}}`      | event domain                                   |
| `{{skill}}`       | skill that fired the event, if any             |
| `{{ts}}`          | ISO timestamp                                  |
| `{{rule_id}}`     | matched notification-config id                 |

## title

{{event_type}}

## body

{{description}}

## link.dashboard

http://localhost:5173
