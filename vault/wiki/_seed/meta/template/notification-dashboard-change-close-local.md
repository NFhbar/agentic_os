---
id: notification-dashboard-change-close-local
type: reference
domain: meta
created: 2026-05-30T01:06:38Z
updated: 2026-05-30T01:06:38Z
tags: [template, notification, dispatch, change]
source: vault/wiki/development/change/notification-per-event-templates.md
private: false
title: Notification template — change merged (local)
url: internal://template/notification-dashboard-change-close-local
kind: template
last_verified: 2026-05-30
---

# Notification template — change merged (local)

Renders when `dashboard.change-close-local` fires (vault-only mark-merged-local on a change). Overrides `notification-default.md` for this event_type. See `event-catalog` for the full list of events and `standard-template-syntax` for Mustache placeholder semantics.

## title

✓ Change merged: {{change_id}}

## body

Project: {{project}} · Domain: {{domain}}
{{description}}

## link.dashboard

http://localhost:5173/changes/{{change_id}}

## link.project

http://localhost:5173/projects/{{project}}
