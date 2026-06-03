---
id: notification-dashboard-add-change
type: reference
domain: meta
created: 2026-05-30T17:50:00Z
updated: 2026-05-30T17:50:00Z
tags: [template, notification, dispatch, change]
source: vault/wiki/development/change/per-event-templates-batch-3.md
private: false
title: Notification template — change scaffolded
url: internal://template/notification-dashboard-add-change
kind: template
last_verified: 2026-05-30
---

# Notification template — change scaffolded

Renders when `dashboard.add-change` fires (a change entry is scaffolded via dev-add-change). Overrides `notification-default.md` for this event_type.

## title

✨ Change scaffolded: {{change_id}}

## body

Project: {{project}}
{{description}}
Planning state begins. Next: `/os write-change {{change_id}}`.

## link.change

http://localhost:5173/changes/{{change_id}}

## link.project

http://localhost:5173/projects/{{project}}
