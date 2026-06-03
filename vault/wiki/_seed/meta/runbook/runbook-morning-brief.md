---
id: runbook-morning-brief
type: runbook
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [schedule, brief]
source: seed
private: false
title: Morning brief
trigger: Every day at 09:00 local time
owner: meta-domain
schedule: "0 9 * * *"
prompt: "/os brief"
---

# Morning brief

## Trigger

Every day at 09:00 local time, fired by the scheduler tick.

## Owner

[[meta-domain]]

## Prerequisites

- The `claude` CLI must be on the PATH at tick time (launchd inherits PATH from the plist's `EnvironmentVariables`).
- The `os` router skill is installed (it is — ships with the OS).

## Steps

When fired, the scheduler invokes `claude -p "/os brief"`, which:

1. Dispatches to the `meta-brief` skill (per `OS.md` intent vocabulary).
2. `meta-brief` reads recent router-log + dashboard-actions entries, summarizes overnight changes, and surfaces pending curation items.
3. Output is captured in `vault/raw/scheduled-runs.jsonl` (and visible from the Schedules view's "Last output").

## Verification

- The Schedules view shows the most recent run with `exit 0` and a sensible duration (<30s typical).
- The `stdout_preview` in the run-log contains the brief summary.

## Rollback

Disable the schedule by removing both `schedule:` and `prompt:` from the frontmatter (the file remains as a regular runbook). To delete entirely: remove this file from `vault/wiki/_seed/meta/runbook/`.

## Notes

- Adjust the time by editing `schedule` (5-field cron, machine local time).
- This is a seed runbook (`source: seed`) — you can safely edit it; it won't be overwritten by `install.sh`.
