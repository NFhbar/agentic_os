---
id: notification-dashboard-pr-comment-mutate
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [template, notification, dispatch, change, pr-review, comments]
source: manual
private: false
title: Notification template — single inline review comment triaged
url: internal://template/notification-dashboard-pr-comment-mutate
kind: template
last_verified: 2026-08-20
---

# Notification template — one pr-review comment triaged

Renders when `dashboard.pr-comment-mutate` fires (a user accepted or dismissed ONE inline comment on a PR-review pass, optionally with a rationale note). The per-comment sibling of `notification-dashboard-pr-comment-accept-all.md`, which covers the batch. Args carry `review`, `pass`, `comment`, `action`, `has_note`.

**`{{action}}` is NOT the accept/dismiss verb** — the renderer's reserved event fields win over args of the same name, so `{{action}}` interpolates the event action (`pr-comment-mutate`). Keep this copy verb-neutral; the recorded verb lives in the review entry and the event's args.

## title

✎ Review comment triaged — {{change_id}}

## body

Project: {{project}}
Pass {{pass}} · comment {{comment}} of {{review}} — accept/dismiss recorded on the entry (rationale attached: {{has_note}}).
Accepted comments feed the next dev-write-change address-comments run; dismissed ones close out with their note.
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr_review

http://localhost:5173/changes/{{change_id}}/pr-review
