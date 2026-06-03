---
id: notification-dashboard-pr-review
type: reference
domain: meta
created: 2026-05-30T17:50:00Z
updated: 2026-05-30T17:50:00Z
tags: [template, notification, dispatch, change, pr]
source: vault/wiki/development/change/per-event-templates-batch-3.md
private: false
title: Notification template — PR review run
url: internal://template/notification-dashboard-pr-review
kind: template
last_verified: 2026-05-30
---

# Notification template — PR review run

Renders when `dashboard.pr-review` fires (dev-pr-review walked the PR and produced a structured verdict). Overrides `notification-default.md` for this event_type. Distinct from `dashboard.pr-review-publish` (already templated): this is the LOCAL review run; publish posts to GitHub.

## title

🔎 PR reviewed: {{change_id}}

## body

Project: {{project}}
{{description}}
Verdict written to vault/output. Next: publish to GitHub via `/os publish pr review {{change_id}}` (or address findings locally first).

## link.change

http://localhost:5173/changes/{{change_id}}

## link.review

http://localhost:5173/changes/{{change_id}}/pr-review
