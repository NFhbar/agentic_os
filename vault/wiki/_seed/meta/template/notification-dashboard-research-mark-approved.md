---
id: notification-dashboard-research-mark-approved
type: reference
domain: meta
created: 2026-05-30T01:06:38Z
updated: 2026-05-30T01:06:38Z
tags: [template, notification, dispatch, research-report]
source: vault/wiki/development/change/notification-per-event-templates.md
private: false
title: Notification template — research approved
url: internal://template/notification-dashboard-research-mark-approved
kind: template
last_verified: 2026-05-30
---

# Notification template — research approved

Renders when `dashboard.research-mark-approved` fires (a request-changes review_status is overridden to approved). Overrides `notification-default.md` for this event_type.

## title

✓ Research approved: {{report_id}}

## body

Project: {{project}}
{{description}}

## link.report

http://localhost:5173/research/{{report_id}}

## link.scaffold

http://localhost:5173/projects/{{project}}/plan
