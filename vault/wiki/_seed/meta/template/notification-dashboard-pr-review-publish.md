---
id: notification-dashboard-pr-review-publish
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [template, notification, dispatch, change, pr, publish]
source: manual
private: false
title: Notification template — PR review published to GitHub
url: internal://template/notification-dashboard-pr-review-publish
kind: template
last_verified: 2026-08-20
---

# Notification template — PR review published to GitHub

Renders when `dashboard.pr-review-publish` fires (dev-pr-review-publish posted a pass's accepted comments to GitHub as one review). Distinct from `dashboard.pr-review` (the LOCAL review run that produced the verdict) — this is the outbound half, the point where the OS's findings become visible to other humans. Args carry `review`, `pr`, `pass`, `event`, `published_count`, `skipped_count`, `github_review_id`, `dry_run`.

## title

📤 Review published — {{change_id}}

## body

Project: {{project}}
{{published_count}} comment(s) posted as a {{event}} review on pass {{pass}} of {{review}} ({{skipped_count}} skipped, dry run: {{dry_run}}).
Next: the PR's reviewers see the findings; pull their replies back with `/os pull pr comments {{change_id}}`.
{{delivery_tags}}

## link.pr

{{pr}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr_review

http://localhost:5173/changes/{{change_id}}/pr-review
