---
id: notification-dashboard-change-automation-advance
type: reference
domain: meta
created: 2026-06-02T04:30:00Z
updated: 2026-06-02T04:30:00Z
tags: [template, notification, dispatch, change, automation, step]
source: vault/wiki/development/change/notification-templates-automation-events.md
private: false
title: Notification template — automation advanced to next step
url: internal://template/notification-dashboard-change-automation-advance
kind: template
last_verified: 2026-06-02
---

# Notification template — change automation advanced

Renders when `dashboard.change-automation-advance` fires (orchestrator dispatched the next step in the loop). The orchestrator emits this on every step transition: `execute → open-pr → pr-review → address-comments → pr-review → …`. High-volume event; subscribe only when you want minute-by-minute visibility into automation progress.

Args carry `change`, `step` (the canonical step name from [[standard-automation-loop]]), `iteration_count`, `run_id`. The renderer flattens these into top-level template vars.

**Noise note.** This event fires multiple times per change (one per step). For projects with several automated changes in parallel, expect a steady stream of Slack pings. Consider a per-change-per-24h rate limit if you subscribe.

## title

⚙️ Automation step — {{change_id}} → {{step}}

## body

Project: {{project}}
Iteration: {{iteration_count}}
Run: {{run_id}}
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.automation

http://localhost:5173/changes/{{change_id}}/automation
