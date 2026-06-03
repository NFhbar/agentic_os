---
id: notification-dashboard-notification-rule-test-send
type: reference
domain: meta
created: 2026-06-01T19:30:00Z
updated: 2026-06-01T19:30:00Z
tags: [template, notification, dispatch, self-test]
source: vault/wiki/development/change/notification-templates-housekeeping-batch.md
private: false
title: Notification template — rule test-send
url: internal://template/notification-dashboard-notification-rule-test-send
kind: template
last_verified: 2026-06-01
---

# Notification template — rule test-send

Renders when `dashboard.notification-rule-test-send` fires (a user clicked the Rule Editor's **Test send** button to verify a rule end-to-end). Overrides `notification-default.md` for this event_type. Event source carries `id` (the rule under test) and `channel` (slack | email | desktop). Useful for confirming that channel adapters, env auth, and template rendering all work without waiting on a real lifecycle event.

**Avoid loops.** Subscribing to this event in a rule that itself uses the same channel as the rule under test will fire on every test-send, including the one you just sent. Filter or rate-limit accordingly.

## title

🧪 Notification test-send fired

## body

A user verified a notification rule end-to-end via the Rule Editor's Test send button.
{{description}}
{{delivery_tags}}

## link.notifications

http://localhost:5173/notifications/rules
