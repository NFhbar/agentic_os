---
id: runbook-pr-ci-monitor
type: runbook
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [schedule, ci, pr, lifecycle, github]
source: seed
private: false
title: PR CI monitor — poll open PRs, update change frontmatter on completion
trigger: Every 15 minutes
owner: meta-domain
schedule: '*/15 * * * *'
precondition_query: 'type=change status=in-review pr_url=set ci_state=null|running'
precondition_min: 1
prompt: 'Poll open PRs to keep the wiki manifest current. (1) Read vault/.index/manifest.json. Filter STRICTLY: type=change AND status=in-review AND pr_url set AND (ci_state IS NULL OR ci_state == ''running''). Do NOT poll changes whose ci_state is already ''pass'' or ''fail'' — they''re terminal for this run; manual re-poll via the dashboard PR tab Refresh button is the path when CI was re-triggered after a push. Do NOT touch changes with status: merged or abandoned. If 0 candidates after filter, report ''Triage clean'' and stop immediately without calling MCPs. Cap to 20 per cycle. (2) For each candidate: call the github MCP''s get_pull_request with { owner, repo, pull_number } parsed from pr_url (stop on auth error and report — user needs to refresh mcps/github/.env). Call list_pull_request_checks for the same args. Compute aggregate ci_state: in_progress|queued > 0 → ''running''; failure > 0 → ''fail''; total === 0 → ''none''; else → ''pass'' (mirrors dev-open-pr). Detect merge: pr.merged === true. (3) Update the wiki entry frontmatter via Edit tool only when something changed (idempotent): ci_state to new aggregate; ci_completed_at to now (ISO) when transitioning running → pass/fail/none; if pr.merged true also set status: merged, merged_at: pr.merged_at, updated: now; if anything changed bump updated to now. (4) Log each updated change via: node scripts/record-dashboard-action.mjs --action pr-ci-poll --skill runbook-pr-ci-monitor --args ''{"change":"<id>","ci_state":"<state>","merged":<bool>}'' --files-touched ''["vault/wiki/<domain>/change/<id>.md"]'' --exit-status 0. The shared event-attribution helper tags change_id from args.change. (5) Compose a short report (under 150 words): N checked, M updated; per updated change one line [[id]] — transition (e.g. ''ci: running → pass'' or ''merged via PR #N''). End with ''Triage clean'' if nothing updated else ''See dashboard Activity tab''. Keep response terse — runs every 15 minutes; verbose output bloats vault/raw/scheduled-runs.jsonl.'
---

# PR CI monitor

## Trigger

Every 15 minutes (`*/15 * * * *`), fired by the scheduler tick.

## Owner

[[meta-domain]]

## Why this exists

`dev-open-pr` captures one CI snapshot at the moment the PR opens. CI then runs for many minutes (sometimes hours). Without a poller, the wiki manifest stays frozen at "running" even when CI has long since passed or failed.

The dashboard's "Pull request" tab does live fetches per-click, but that only updates when a human looks. The lifecycle stepper, the brief, status reports, the change-triage runbook — all read from the manifest. They need a poller keeping the manifest fresh in the background.

This runbook does that, **with one persistent scheduler** rather than per-PR ephemeral schedules (which would churn the manifest creating + deleting runbook files per PR — see decision-github-mcp-custom-not-hosted's pattern).

### Auto-stop on conclusive CI

The filter is **strict**: only polls changes whose `ci_state` is `null` or `'running'`. Once a change reaches `pass` or `fail`, the runbook drops it — no more automatic polling.

**Why strict?** Defensive re-polling (catching CI re-triggered by a push to the same branch) is an LLM cycle per fire per PR. At ~$0.34/fire × 96 fires/day × N open PRs, the cost compounds quickly even when nothing changes. The right place for "I just pushed new commits, re-check" is **manual** — click Refresh on the dashboard's Pull request tab. That fetches GitHub live AND writes back to frontmatter via `POST /api/changes/:id/pr/sync`, logging an event same as the runbook would. User-initiated, free of background cost.

The trade-off: if you don't click Refresh after a force-push that re-runs CI, the OS won't notice the re-run. The PR tab shows live state every time you look, so the divergence is visible — just not auto-corrected.

### Two-layer auto-stop

The strict in-prompt filter handles the **per-change** auto-stop (don't poll a change whose CI is conclusive). It does NOT handle the **schedule-level** auto-stop — without help, the scheduler would still spawn Claude every 15 min to read the manifest, filter everything out, and report "Triage clean".

That outer empty-fire is what the `precondition_query` + `precondition_min` frontmatter fields prevent. The scheduler tick evaluates the query against the manifest **before spawning Claude**; if zero entries match, the schedule is silently skipped for that minute (a `schedule-skip` event is recorded for visibility). When a new PR opens and the manifest gains a matching entry, the next tick fires normally — re-arm is automatic, no state to manage.

See [[standard-scheduled-jobs]] § Preconditions for the full grammar.

## Prerequisites

- `vault/.index/manifest.json` exists and is fresh (auto-rebuilds via the index hook; manual rebuild via `node .claude/hooks/rebuild-vault-index.mjs`).
- The manifest carries `status`, `pr_url`, `ci_state` on every change entry (see [[archetype-change]] — these are auto-extracted by `rebuild-vault-index.mjs`).
- `github` MCP configured + PAT in `mcps/github/.env` (the runbook's prompt calls MCP tools).

## What it updates

For each in-review change with a stale or running CI state, the runbook potentially writes back to the change entry's frontmatter:

| field             | when written                                   |
| ----------------- | ---------------------------------------------- |
| `ci_state`        | every poll (no-op if unchanged)                |
| `ci_completed_at` | when transitioning `running → pass/fail/none`  |
| `merged_at`       | when `pr.merged === true` (first detection)    |
| `status`          | `in-review → merged` when `pr.merged === true` |
| `updated`         | when any of the above actually changed         |

## Event logging

Each updated change produces one event row tagged with `change_id` via `record-dashboard-action.mjs`. The action is `pr-ci-poll`; args carry `change_id`, `ci_state`, `merged`. The shared event-attribution helper handles tagging — see [[standard-event-store]] § Event attribution.

Manual syncs from the dashboard's Pull request tab Refresh button use the same action name (`pr-ci-poll`) but with `source: dashboard-sync` in args, so the Activity tab can distinguish scheduler-driven polls from human-initiated ones if needed.

Per-run summaries from the scheduler tick also land in `vault/raw/scheduled-runs.jsonl` (the JSONL audit trail) and the corresponding events.db row.

## Verification

After ~15 minutes you should see:

- `vault/raw/scheduled-runs.jsonl` — a `runbook-pr-ci-monitor` entry
- `.claude/state/events.db` — scheduler-fire row + per-change `pr-ci-poll` rows (if any updates)
- Affected change entries' frontmatter — updated `ci_state` / `merged_at` / `status` / `updated`
- The Changes app's lifecycle stepper — advances when CI completes or PR merges

## Tuning

The schedule (`*/15 * * * *`) is conservative — 96 fires/day. Tighter cadence trades GitHub API budget for faster signal:

- `*/5 * * * *` (every 5 min): catches CI completion in ≤5 min wall-time; 288 fires/day; ~30 API calls/hour at ~20 in-flight PRs. Still well under GitHub's 5000/hr authenticated limit.
- `0,30 * * * *` (every 30 min): leaner, signal lags by up to 30 min.

The 20-PR cap in step 1 protects against runaway API use if many PRs land. Increase if you routinely have >20 in-flight.

## When to disable

If you stop using the OS to track PRs (e.g. all dev work moves out of `change` entries), delete this runbook from `vault/wiki/_seed/meta/runbook/` or set `schedule: ''` to keep the docs but stop firing. The `runbook-skill-coverage` audit will flag the removal so you don't accidentally orphan it.

## Related

- [[archetype-change]] — PR lifecycle fields the runbook manages
- [[standard-change-workflow]] — full state machine + skill chain
- [[standard-event-store]] § Event attribution — how events get `change_id`-tagged
- [[dev-open-pr]] — the skill that creates the PR + writes the first snapshot
- [[meta-brief]] — daily reader of the CI states this runbook maintains
- [[runbook-weekly-change-triage]] — parallel cadence, broader stale-change checks
