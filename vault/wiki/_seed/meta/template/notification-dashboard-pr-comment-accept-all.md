---
id: notification-dashboard-pr-comment-accept-all
type: reference
domain: meta
created: 2026-06-02T04:30:00Z
updated: 2026-06-02T04:30:00Z
tags: [template, notification, dispatch, change, pr-review, comments]
source: vault/wiki/development/change/notification-templates-automation-events.md
private: false
title: Notification template — bulk-accepted inline review comments
url: internal://template/notification-dashboard-pr-comment-accept-all
kind: template
last_verified: 2026-06-02
---

# Notification template — pr-review comments bulk-accepted

Renders when `dashboard.pr-comment-accept-all` fires (a user clicked "Accept all" on a PR-review pass's inline comments, queueing them for the next `dev-write-change` address-comments run). Marks the human's intent to fold the reviewer's findings into code. Args carry `change`, `accepted_count`.

## title

✓ Accepted {{accepted_count}} review comment(s) — {{change_id}}

## body

Project: {{project}}
{{accepted_count}} inline comment(s) marked accepted on the PR. Next: dispatch dev-write-change in address-comments mode (or let automation pick it up).
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr_review

http://localhost:5173/changes/{{change_id}}/pr-review
