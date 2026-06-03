---
id: notification-dashboard-review-change
type: reference
domain: meta
created: 2026-05-30T04:00:00Z
updated: 2026-05-30T04:00:00Z
tags: [template, notification, dispatch, change]
source: vault/wiki/development/change/notification-template-bundle-2.md
private: false
title: Notification template — change reviewed
url: internal://template/notification-dashboard-review-change
kind: template
last_verified: 2026-05-30
---

# Notification template — change reviewed

Renders when `dashboard.review-change` fires (dev-review-change produced a verdict: approve / request-changes / reject / overridden / not-required). Overrides `notification-default.md` for this event_type.

## title

🔍 Plan reviewed: {{change_id}}

## body

Project: {{project}}
{{description}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.review

http://localhost:5173/changes/{{change_id}}/review
