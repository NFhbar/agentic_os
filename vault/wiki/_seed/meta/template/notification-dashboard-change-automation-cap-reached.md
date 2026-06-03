---
id: notification-dashboard-change-automation-cap-reached
type: reference
domain: meta
created: 2026-06-01T23:30:00Z
updated: 2026-06-01T23:30:00Z
tags: [template, notification, dispatch, change, automation, iteration-cap]
source: vault/wiki/development/change/change-automation-phase-5-cap-notification.md
private: false
title: Notification template — automation iteration cap reached
url: internal://template/notification-dashboard-change-automation-cap-reached
kind: template
last_verified: 2026-06-01
---

# Notification template — automation iteration cap reached

Renders when `dashboard.change-automation-cap-reached` fires (the per-change orchestrator hit its `iteration_cap` on the address-comments loop without a clean review pass). The change has been parked — `automation.state.phase: paused, paused_reason: 'iteration-cap-reached: N loops'` — and now needs human intervention. Either: investigate why pr-review keeps surfacing issues, fix the underlying problem, then **Resume** with `reset_iteration: true`; or raise the cap and Resume; or abandon the change.

Args carried in the event payload: `change`, `iteration_count`, `iteration_cap`, `pr_url`, `pr_review_path`, `last_review_concerns_count`. The renderer flattens these into top-level template vars.

## title

🚦 Automation parked — {{change_id}} hit iteration cap ({{iteration_count}}/{{iteration_cap}})

## body

Project: {{project}}
{{iteration_count}} address-comments loops ran without a clean pr-review pass. The most recent review still has {{last_review_concerns_count}} unresolved concern(s).

Next steps:
• Read the latest review verdict and decide if the concerns are tractable
• If yes: fix the underlying issue, then click Resume (with reset_iteration if you want a fresh budget)
• If no: abandon the change OR raise the iteration_cap and Resume to keep iterating
{{delivery_tags}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr

{{pr_url}}

## link.review

http://localhost:5173/changes/{{change_id}}/pr-review
