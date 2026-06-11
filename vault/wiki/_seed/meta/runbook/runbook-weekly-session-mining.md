---
id: runbook-weekly-session-mining
type: runbook
domain: meta
created: 2026-06-11T21:10:00Z
updated: 2026-06-11T21:10:00Z
tags: [runbook, mining, automation, scheduled]
source: manual
private: false
title: Weekly session-mining — automation candidates report
schedule: "30 8 * * 1"
prompt: "/os mine sessions"
---

# Weekly session-mining — automation candidates report

Fires `meta-mine-sessions` every Monday at 08:30: clusters the last 28 days
of session-transcript turns (tool/file digests included) and writes a ranked
automation-candidates report to `vault/output/meta/automation-candidates/`.

This is Bet 2 of the Fable review on a cadence: the OS's improvement loop
only saw dispatched work while the operator's interactive sessions — the
densest evidence of what to automate next — went unread. The weekly report
keeps that evidence in front of the operator with spend attached.

No precondition — interactive turns accumulate in any active week, and a
quiet week produces a cheap, honest "nothing new" report.

## Manual run

`/os mine sessions` — or the Schedules app's Run now button.
