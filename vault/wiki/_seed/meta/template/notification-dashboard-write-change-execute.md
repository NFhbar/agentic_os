---
id: notification-dashboard-write-change-execute
type: reference
domain: meta
created: 2026-05-30T17:50:00Z
updated: 2026-05-30T17:50:00Z
tags: [template, notification, dispatch, change]
source: vault/wiki/development/change/per-event-templates-batch-3.md
private: false
title: Notification template — change EXECUTE ran
url: internal://template/notification-dashboard-write-change-execute
kind: template
last_verified: 2026-05-30
---

# Notification template — change EXECUTE ran

Renders when `dashboard.write-change-execute` fires (the EXECUTE phase of dev-write-change created the branch + made the edits + ran tests). Overrides `notification-default.md` for this event_type.

## title

⚡ Code shipped: {{change_id}}

## body

Project: {{project}}
{{description}}
Status: in-progress (branch created, plan followed). Next: open PR via `/os open pr {{change_id}}`.

## link.change

http://localhost:5173/changes/{{change_id}}

## link.project

http://localhost:5173/projects/{{project}}
