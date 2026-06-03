---
id: notification-dashboard-research-write
type: reference
domain: meta
created: 2026-05-30T04:00:00Z
updated: 2026-05-30T04:00:00Z
tags: [template, notification, dispatch, research-report]
source: vault/wiki/development/change/notification-template-bundle-2.md
private: false
title: Notification template — research-write dispatched
url: internal://template/notification-dashboard-research-write
kind: template
last_verified: 2026-05-30
---

# Notification template — research-write dispatched

Renders when `dashboard.research-write` fires (a research-write skill run is dispatched against a project). Overrides `notification-default.md` for this event_type.

## title

📝 Research drafted: {{report_id}}

## body

Project: {{project}}
{{description}}

## link.report

http://localhost:5173/research/{{report_id}}

## link.project

http://localhost:5173/projects/{{project}}
