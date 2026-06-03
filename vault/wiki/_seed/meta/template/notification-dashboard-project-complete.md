---
id: notification-dashboard-project-complete
type: reference
domain: meta
created: 2026-05-30T01:06:38Z
updated: 2026-05-30T01:06:38Z
tags: [template, notification, dispatch, project]
source: vault/wiki/development/change/notification-per-event-templates.md
private: false
title: Notification template — project complete
url: internal://template/notification-dashboard-project-complete
kind: template
last_verified: 2026-05-30
---

# Notification template — project complete

Renders when `dashboard.project-complete` fires (a project is marked complete from its detail page). Overrides `notification-default.md` for this event_type.

## title

🎯 Project complete: {{project}}

## body

{{description}}

## link.dashboard

http://localhost:5173/projects/{{project}}

## link.reports

http://localhost:5173/projects/{{project}}/reports
