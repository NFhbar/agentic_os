---
id: runbook-weekly-health-check
type: runbook
domain: meta
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [schedule, health, audit, hygiene]
source: seed
private: false
title: Weekly OS health check
trigger: Sunday at 08:30 local time (right after the weekly curation check)
owner: meta-domain
schedule: "30 8 * * 0"
prompt: "Run the OS compliance audit and save the results. Procedure: (1) Invoke /os audit (calls scripts/audit.mjs). (2) Capture the full output — errors, warnings, info. (3) Write a dated summary file to vault/output/meta/health-checks/<YYYY-MM-DD>.md with a header showing error/warn/info counts, a 'TL;DR' line, and the verbatim audit output below. Create the directory if needed. (4) If error count > 0, prefix the file with a '⚠ Action needed' callout listing each error's id + path. (5) Append a brief line to vault/raw/dashboard-actions.jsonl: {ts, action: 'weekly-health-check', files_touched: [<output-path>], exit_status: 0}. (6) Report a 3-line summary."
---

# Weekly OS health check

## Trigger

Sunday at 08:30 local time, fired by the scheduler tick (30 minutes after the weekly curation check so they don't overlap).

## Owner

[[meta-domain]]

## Prerequisites

- `scripts/audit.mjs` exists and is executable
- `vault/output/meta/health-checks/` will be created if missing

## Steps

When fired, the scheduler invokes `claude -p "<prompt>"`. Claude:

1. Runs `node scripts/audit.mjs --json` (or the plain text form) to gather current findings
2. Composes a dated summary file with the structure:

   ```markdown
   # OS health check — <YYYY-MM-DD>

   **Errors:** <N>  ·  **Warnings:** <N>  ·  **Info:** <N>

   ## TL;DR
   <one sentence: is the OS healthy? what's the biggest concern?>

   ⚠ Action needed   (only when errors > 0)
   - [check-id] path — message

   ## Full findings

   <verbatim audit output, grouped by severity>
   ```

3. Writes to `vault/output/meta/health-checks/<YYYY-MM-DD>.md`
4. Logs the run to `vault/raw/dashboard-actions.jsonl`

## Verification

- The Schedules view shows the most recent run with `exit 0`
- `vault/output/meta/health-checks/` contains a new dated file
- If errors exist, the file leads with the action-needed callout

## Why this exists

The OS audit is otherwise **pull-based** — you have to remember to run it (or open the dashboard, where the Health card surfaces current findings). This runbook makes it **push-based**: every Sunday, the OS audits itself and produces a dated artifact you can browse historically. Drift becomes visible over time, not just at this moment.

History accumulates in `vault/output/meta/health-checks/` (one file per week). To see how OS health has trended, browse the output tree in the Vault view.

## Rollback

Disable by removing the `schedule:` field (downgrades to a manual runbook). Delete generated output files manually if undesired.

## Notes

- This is a seed runbook (`source: seed`). Edit it freely; it won't be overwritten by `install.sh`.
- The cron `30 8 * * 0` runs Sundays at 8:30am local. Adjust if it conflicts with anything else you've scheduled around that time.
- Pair with `runbook-morning-brief` (daily 9am) and `runbook-weekly-curation-check` (Sunday 8am) for a complete proactive hygiene routine.
