---
name: meta-mine-sessions
description: 'Mine session transcripts for automation candidates. Runs scripts/mine-sessions.mjs to cluster interactive turns by normalized intent (with per-turn tool/file digests), then classifies the top clusters — skill candidate / schedule candidate / orchestrator step / inherently manual / dispatched-echo — and writes a ranked report to vault/output/meta/automation-candidates/. The empirical answer to "what should the OS automate next", sourced from what the operator actually does by hand and what it costs.'
user-invocable: true
recommended_effort: high
version: 1
domain: meta
tags: [mining, automation, self-improvement, telemetry, scheduled]
inputs:
  days:
    type: number
    required: false
    default: 28
    description: 'Lookback window in days for the events.db session rows.'
outputs:
  - kind: file
    path: vault/output/meta/automation-candidates/<YYYY-MM-DD>.md
  - kind: file
    path: vault/output/meta/automation-candidates/latest.md
  - kind: event
    path: '.claude/state/events.db (kind: dashboard, action: mine-sessions)'
spawns: []
---

# meta-mine-sessions

## Purpose

Close the interactive blind spot. The OS's improvement machinery only sees
dispatched work; the operator's interactive sessions — where the dense
demonstrations of "what should become a skill" live — were recorded but
never mined (Fable review, Finding 2.2 / Bet 2). This skill turns the
transcript corpus into a ranked list of automation candidates with real
spend attached.

The mechanical half is `scripts/mine-sessions.mjs` (clustering, counting,
digest aggregation). This skill adds the judgment: what each recurring
cluster IS, and what — if anything — the OS should do about it.

## Inputs

- `days` — lookback window (default 28).

## Procedure

1. **Freshness check.** Session telemetry auto-imports on SessionStart, but
   run `node scripts/import-session-usage.mjs --all` first if the newest
   `kind='session'` event is older than 24h.

2. **Run the miner:** `node scripts/mine-sessions.mjs --days <days> --json`.
   Parse the cluster list (sorted by spend).

3. **Classify the top clusters** (every cluster ≥ $5 OR count ≥ 10; cap at
   ~15 rows). One classification each:
   - `skill-candidate` — a recurring freeform workflow a skill could own
     (look at tools_top + files_top to judge shape).
   - `schedule-candidate` — recurring AND time-driven (status checks,
     sweeps).
   - `orchestrator-step` — per-item approval/advance gestures inside an
     existing lifecycle (e.g. "go ahead with #N" between changes) — the
     automation state machine should absorb them.
   - `dispatched-echo` — NOT manual work: headless `claude -p` transcripts
     re-imported as session turns. Report the double-count; the spend
     already exists as kind=dashboard/schedule events.
   - `inherently-manual` — judgment/steering turns automation shouldn't eat
     (incl. approval/continuation freight — note the cache cost).

4. **Write the report** to
   `vault/output/meta/automation-candidates/<YYYY-MM-DD>.md` AND mirror to
   `latest.md`. Sections: header (window, turns, clusters, total session
   spend), a ranked table (cluster / kind / count / $ / classification /
   proposed next step), and a short "Top 3 actions" list. Name ≥3 recurring
   workflows with spend — if the data can't support 3, say so explicitly
   rather than padding.

5. **Record the event:**

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action mine-sessions \
     --skill meta-mine-sessions \
     --args '{"days":<days>,"turns":<n>,"clusters":<n>,"candidates":<n>}' \
     --files-touched '["vault/output/meta/automation-candidates/<date>.md"]' \
     --exit-status 0
   ```

6. **Report to the user** — the Top 3 actions inline, plus the report path.

## Outputs

- Dated report + `latest.md` mirror under
  `vault/output/meta/automation-candidates/`
- One `mine-sessions` event

## Errors

- events.db missing → report and stop (run the importer first).
- Zero session rows in the window → write a stub report saying so; never
  invent clusters.

## See also

- `scripts/mine-sessions.mjs` — the mechanical clusterer this skill drives
- `scripts/import-session-usage.mjs` — produces the digests (`--backfill-digests` for history)
- [[runbook-weekly-session-mining]] — the weekly schedule
- [[meta-audit-followups]] — the sibling sweep on the dispatched side of the loop
