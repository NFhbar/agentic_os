---
id: notification-dashboard-mark-pr-ready
type: reference
domain: meta
created: 2026-06-02T19:30:00Z
updated: 2026-06-02T19:30:00Z
tags: [template, notification, dispatch, change, pr, ready-for-human]
source: vault/wiki/development/change/notification-templates-mark-pr-ready-and-close-change.md
private: false
title: Notification template — PR ready for human review
url: internal://template/notification-dashboard-mark-pr-ready
kind: template
last_verified: 2026-06-02
---

# Notification template — PR ready for human review

Renders when `dashboard.mark-pr-ready` fires (dev-mark-pr-ready flipped `pr_review_status: pending → ready-for-human` on the change). Overrides `notification-default.md` for this event_type. Args carry `change`, `source` (e.g. `change-automation` when the orchestrator auto-fired it, otherwise the dashboard button), and `override` — the renderer flattens these into top-level template vars.

## title

✓ Ready for human — {{change_id}}

## body

Project: {{project}} · Domain: {{domain}}
PR review signed off and waiting on a human to merge on GitHub.
{{description}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr_review

http://localhost:5173/changes/{{change_id}}/pr-review
