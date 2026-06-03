---
id: notification-dashboard-research-revise
type: reference
domain: meta
created: 2026-05-30T04:00:00Z
updated: 2026-05-30T04:00:00Z
tags: [template, notification, dispatch, research-report]
source: vault/wiki/development/change/notification-template-bundle-2.md
private: false
title: Notification template — research-revise dispatched
url: internal://template/notification-dashboard-research-revise
kind: template
last_verified: 2026-05-30
---

# Notification template — research-revise dispatched

Renders when `dashboard.research-revise` fires (a research-revise skill run is dispatched to fold review findings + notes into a new report revision). Overrides `notification-default.md` for this event_type.

## title

♻️ Research revised: {{report_id}}

## body

Project: {{project}}
{{description}}

## link.report

http://localhost:5173/research/{{report_id}}

## link.notes

http://localhost:5173/research/{{report_id}}/notes
