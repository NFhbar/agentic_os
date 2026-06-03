---
id: runbook-weekly-curation-check
type: runbook
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [schedule, curation, hygiene]
source: seed
private: false
title: Weekly curation health check
trigger: Sunday at 08:00 local time
owner: meta-domain
schedule: "0 8 * * 0"
prompt: "Scan vault/raw/ for files (excluding hidden + .gitkeep + .jsonl logs). Report total count and list anything older than 7 days by relative path. Keep response under 200 words and end with a one-line recommendation: either 'Queue looks healthy' or 'Curation backlog growing — N items stale'."
---

# Weekly curation health check

## Trigger

Sunday at 08:00 local time, fired by the scheduler tick.

## Owner

[[meta-domain]]

## Prerequisites

- `vault/raw/` exists (created by `install.sh`).

## Steps

When fired, the scheduler invokes `claude -p "<prompt>"` (see frontmatter). Claude:

1. Walks `vault/raw/` (skipping hidden files, `.gitkeep`, and `.jsonl` logs which are state).
2. Filters by mtime older than 7 days.
3. Emits a short report listing stale paths and a recommendation.

## Verification

- The Schedules view shows the most recent run with `exit 0`.
- The `stdout_preview` contains either "Queue looks healthy" or a count of stale items.
- If stale items exist, they appear as auto-discovered items in the **Curation** view (the disk-walk picks them up regardless).

## Rollback

Disable by removing the `schedule:` + `prompt:` lines, or delete the file entirely.

## Notes

- The prompt is intentionally narrow so the cost stays low and the output is parseable at a glance.
- Tune the staleness threshold by editing the prompt (change "7 days").
- Tune the time by editing `schedule` — the second-to-last field `0` means Sunday (day-of-week, 0–6).
