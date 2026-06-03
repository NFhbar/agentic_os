---
id: notification-dashboard-open-pr
type: reference
domain: meta
created: 2026-06-01T19:30:00Z
updated: 2026-06-01T19:30:00Z
tags: [template, notification, dispatch, change, pr, github]
source: vault/wiki/development/change/notification-templates-housekeeping-batch.md
private: false
title: Notification template — PR opened on GitHub
url: internal://template/notification-dashboard-open-pr
kind: template
last_verified: 2026-06-01
---

# Notification template — PR opened on GitHub

Renders when `dashboard.open-pr` fires (dev-open-pr pushed the branch and opened a PR via the github MCP). Overrides `notification-default.md` for this event_type. Args carry `change`, `pr_number`, `draft`, `ci_state`, `commit_author`, `pr_opener` — the renderer flattens these into top-level template vars.

## title

🚀 PR opened — {{change_id}} (#{{pr_number}})

## body

Project: {{project}}
{{description}}
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr_review

http://localhost:5173/changes/{{change_id}}/pr-review
