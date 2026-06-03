---
id: notification-dashboard-write-change-plan
type: reference
domain: meta
created: 2026-05-30T04:00:00Z
updated: 2026-05-30T04:00:00Z
tags: [template, notification, dispatch, change]
source: vault/wiki/development/change/notification-template-bundle-2.md
private: false
title: Notification template — change plan written
url: internal://template/notification-dashboard-write-change-plan
kind: template
last_verified: 2026-05-30
---

# Notification template — change plan written

Renders when `dashboard.write-change-plan` fires (the PLAN phase of dev-write-change composed a structured plan for a change). Overrides `notification-default.md` for this event_type.

## title

📋 Plan written: {{change_id}}

## body

Project: {{project}}
{{description}}
Ready for review.

## link.change

http://localhost:5173/changes/{{change_id}}

## link.review

http://localhost:5173/changes/{{change_id}}/review
