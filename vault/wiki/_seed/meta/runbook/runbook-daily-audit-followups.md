---
id: runbook-daily-audit-followups
type: runbook
domain: meta
created: 2026-06-11T19:50:00Z
updated: 2026-06-11T19:50:00Z
tags: [runbook, overseer, self-improvement, scheduled]
source: manual
private: false
title: Daily audit-followups + decision-validation sweep
schedule: "0 7 * * *"
prompt: "/os audit followups"
precondition_query: "type=lifecycle-audit audit_status=provisional || type=decision validation_result=pending"
precondition_min: 1
---

# Daily audit-followups + decision-validation sweep

Fires `meta-audit-followups` every morning at 07:00 local — Phase 3 of the
Overseer arc. The skill (a) scans provisional lifecycle-audits for
subsequent changes touching the same files and appends `followup_signals[]`,
promoting audits to `final` when their forward-look window closes, and (b)
sweeps decisions with `validation_result: pending`, appending exposure
observations and flipping the result when the validation window closes
(see `archetype-decision` § Validation).

The skill shipped in 0.3.0 "designed to run as a daily scheduled job" but
was never scheduled — the Fable review (Finding 3.1) found Phase 3 had
never executed and every promoted decision stuck at `pending` behind
audit-count thresholds that could never be reached. This runbook plus the
wall-time + qualifying-runs re-denomination is the fix.

The precondition uses the `||` OR-group grammar: the tick only spawns
Claude when at least one provisional audit OR pending validation exists,
so quiet periods cost nothing.

## Manual run

`/os audit followups` — or the Schedules app's Run now button.
