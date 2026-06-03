---
id: notification-dashboard-status-report
type: reference
domain: meta
created: 2026-06-01T15:30:00Z
updated: 2026-06-01T15:30:00Z
tags: [template, notification, dispatch, status-report]
source: vault/wiki/development/change/status-report-slack-template.md
private: false
title: Notification template — status report generated
url: internal://template/notification-dashboard-status-report
kind: template
last_verified: 2026-06-01
---

# Notification template — status report generated

Renders when `dashboard.status-report` fires (`meta-status-report` skill generated a kickoff/status/wrap-up report for a project). Overrides `notification-default.md` for this event_type.

The skill stuffs the report's TL;DR + Progress summary + Blockers + Next sections into `event.args` so this template can render them inline without re-reading the file. The dispatcher's renderer flattens `args` into top-level template vars — so `args.tldr` is referenced as `{{tldr}}` here, not `{{args.tldr}}`. Each section is pre-flattened to a single line (newlines stripped, bullets become `·`-separated) so it slots cleanly into Slack/email body text.

`{{delivery_tags}}` comes from the rule's `delivery.tags` array — space-joined string of `@user` mentions (e.g. `@nico @sarah`). Empty when no tags configured.

## title

📋 Status report — {{title}}

## body

_Period:_ {{period_local}}

_TL;DR_
{{tldr}}

_Progress_
{{progress_summary}}

_Blockers / risks_
{{blockers}}

_Next_
{{next}}

CC: {{delivery_tags}}

## link.report

file://{{report_path}}

## link.project

http://localhost:5173/projects/{{project}}
