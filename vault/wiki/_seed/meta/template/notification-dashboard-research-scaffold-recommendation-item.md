---
id: notification-dashboard-research-scaffold-recommendation-item
type: reference
domain: meta
created: 2026-05-30T17:50:00Z
updated: 2026-05-30T17:50:00Z
tags: [template, notification, dispatch, research-report]
source: vault/wiki/development/change/per-event-templates-batch-3.md
private: false
title: Notification template — single recommendation scaffolded as a change
url: internal://template/notification-dashboard-research-scaffold-recommendation-item
kind: template
last_verified: 2026-05-30
---

# Notification template — single recommendation scaffolded

Renders when `dashboard.research-scaffold-recommendation-item` fires (a single `recommended_changes[i]` is materialized as a change entry by research-scaffold-recommendations). Overrides `notification-default.md` for this event_type. Distinct from `dashboard.research-scaffold-recommendations` (the bulk-scaffold dispatcher event): this fires per item.

## title

🌱 Recommendation scaffolded → {{change_id}}

## body

Project: {{project}} · From report: {{report_id}}
{{description}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.report

http://localhost:5173/research/{{report_id}}
