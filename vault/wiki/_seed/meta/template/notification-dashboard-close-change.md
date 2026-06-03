---
id: notification-dashboard-close-change
type: reference
domain: meta
created: 2026-06-02T19:30:00Z
updated: 2026-06-02T19:30:00Z
tags: [template, notification, dispatch, change, pr, merged]
source: vault/wiki/development/change/notification-templates-mark-pr-ready-and-close-change.md
private: false
title: Notification template — change closed (PR merged on GitHub)
url: internal://template/notification-dashboard-close-change
kind: template
last_verified: 2026-06-02
---

# Notification template — change closed (PR merged on GitHub)

Renders when `dashboard.close-change` fires (dev-close-change verified the PR is merged on GitHub and transitioned the change to `status: merged`). Overrides `notification-default.md` for this event_type. Args carry `change`, `pr` (GitHub PR URL), `override`, `merged_at` (ISO), `github_state`, `github_merged`, `noop` — the renderer flattens these into top-level template vars.

Distinct from `notification-dashboard-change-close-local` — that one fires on vault-only local-merge marking (no GitHub verification); this one fires after the canonical close-change skill confirms the merge on GitHub.

## title

🎉 Closed — {{change_id}} (merged)

## body

Project: {{project}} · Domain: {{domain}}
PR merged on GitHub: {{pr}}
Merged at: {{merged_at}}
{{description}}

## link.change

http://localhost:5173/changes/{{change_id}}

## link.pr

{{pr}}
