---
id: notification-dashboard-change-automation-enable
type: reference
domain: meta
created: 2026-06-02T04:30:00Z
updated: 2026-06-02T04:30:00Z
tags: [template, notification, dispatch, change, automation]
source: vault/wiki/development/change/notification-templates-automation-events.md
private: false
title: Notification template — automation enabled on a change
url: internal://template/notification-dashboard-change-automation-enable
kind: template
last_verified: 2026-06-02
---

# Notification template — change automation enabled

Renders when `dashboard.change-automation-enable` fires (a user toggled automation on for a specific change). Useful as an audit signal — "Nico just opted change X into automation" — for teams where multiple operators share an OS instance. Args carry `change`, `iteration_cap`. Per [[standard-automation-loop]], enabling alone doesn't dispatch; the orchestrator only acts after Start.

## title

🤖 Automation enabled — {{change_id}}

## body

Project: {{project}}
Iteration cap: {{iteration_cap}}
Automation will run the EXECUTE → OPEN-PR → PR-REVIEW loop once Start is clicked.
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}
