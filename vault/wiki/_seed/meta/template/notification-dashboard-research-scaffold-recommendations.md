---
id: notification-dashboard-research-scaffold-recommendations
type: reference
domain: meta
created: 2026-05-30T04:00:00Z
updated: 2026-05-30T04:00:00Z
tags: [template, notification, dispatch, research-report]
source: vault/wiki/development/change/notification-template-bundle-2.md
private: false
title: Notification template — research recommendations scaffolded
url: internal://template/notification-dashboard-research-scaffold-recommendations
kind: template
last_verified: 2026-05-30
---

# Notification template — research recommendations scaffolded

Renders when `dashboard.research-scaffold-recommendations` fires (bulk-scaffold of a report's recommended_changes into change entries). Overrides `notification-default.md` for this event_type.

## title

🌱 Recommendations scaffolded from {{report_id}}

## body

Project: {{project}}
{{description}}

## link.report

http://localhost:5173/research/{{report_id}}

## link.changes

http://localhost:5173/projects/{{project}}/changes
