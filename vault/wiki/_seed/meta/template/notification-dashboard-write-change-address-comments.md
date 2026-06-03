---
id: notification-dashboard-write-change-address-comments
type: reference
domain: meta
created: 2026-06-01T19:30:00Z
updated: 2026-06-01T19:30:00Z
tags: [template, notification, dispatch, change, pr-review]
source: vault/wiki/development/change/notification-templates-housekeeping-batch.md
private: false
title: Notification template — review comments addressed
url: internal://template/notification-dashboard-write-change-address-comments
kind: template
last_verified: 2026-06-01
---

# Notification template — review comments addressed

Renders when `dashboard.write-change-address-comments` fires (dev-write-change in address-comments mode folded inline PR-review comments into the code + pushed a follow-up commit). Overrides `notification-default.md` for this event_type. Args carry `change`, `pr_review`, `pass`, `addressed_count`, `commit_sha`, `pushed` — the renderer flattens these into top-level template vars.

## title

🛠 Review comments addressed — {{change_id}} (pass {{pass}})

## body

Project: {{project}}
{{addressed_count}} comment(s) folded · commit {{commit_sha}} · pushed {{pushed}}
Re-review when ready: the PR is waiting on the next pass.
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr_review

http://localhost:5173/changes/{{change_id}}/pr-review
