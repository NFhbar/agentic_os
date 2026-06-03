---
id: notification-dashboard-research-review
type: reference
domain: meta
created: 2026-05-30T04:00:00Z
updated: 2026-05-30T04:00:00Z
tags: [template, notification, dispatch, research-report]
source: vault/wiki/development/change/notification-template-bundle-2.md
private: false
title: Notification template — research-review dispatched
url: internal://template/notification-dashboard-research-review
kind: template
last_verified: 2026-05-30
---

# Notification template — research-review dispatched

Renders when `dashboard.research-review` fires (a research-review skill run is dispatched against a report). Overrides `notification-default.md` for this event_type.

## title

🔍 Research reviewed: {{report_id}}

## body

Project: {{project}}
{{description}}

## link.review

http://localhost:5173/research/{{report_id}}/reviews

## link.report

http://localhost:5173/research/{{report_id}}
