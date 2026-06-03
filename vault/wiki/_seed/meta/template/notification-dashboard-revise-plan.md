---
id: notification-dashboard-revise-plan
type: reference
domain: meta
created: 2026-05-30T17:50:00Z
updated: 2026-05-30T17:50:00Z
tags: [template, notification, dispatch, change]
source: vault/wiki/development/change/per-event-templates-batch-3.md
private: false
title: Notification template — plan revised after review
url: internal://template/notification-dashboard-revise-plan
kind: template
last_verified: 2026-05-30
---

# Notification template — plan revised after review

Renders when `dashboard.revise-plan` fires (dev-revise-plan folds review findings back into a change's plan). Overrides `notification-default.md` for this event_type.

## title

↻ Plan revised: {{change_id}}

## body

Project: {{project}}
{{description}}
Ready for re-review.

## link.change

http://localhost:5173/changes/{{change_id}}

## link.review

http://localhost:5173/changes/{{change_id}}/review
