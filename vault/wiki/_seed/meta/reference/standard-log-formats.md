---
id: standard-log-formats
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, logging]
source: manual
private: false
title: Log file formats
url: internal://standard/log-formats
kind: doc
last_verified: 2026-05-19
---

# Log file formats

## What it is

Canonical shape of every log file the OS produces. JSONL (one JSON object per line) is the default — grep-friendly, append-only, easy to parse, easy to render.

## Files

### `vault/raw/router-log.jsonl`

Every `/os <intent>` dispatch.

```json
{
  "ts": "2026-05-19T16:40:00Z",
  "intent": "open dashboard",
  "matched_skill": "meta-dashboard",
  "confidence": "high",
  "fallback": null
}
```

Fields:

- `ts` — ISO 8601 UTC
- `intent` — verbatim user input after `/os`
- `matched_skill` — skill name or `null`
- `confidence` — `"high"`, `"low"`, or `"miss"`
- `fallback` — `"asked-user"` or `null`

### `vault/raw/dashboard-actions.jsonl`

Audit log for every dashboard-initiated action (UI clicks and AI bridge calls).

```json
{
  "ts": "2026-05-19T16:40:00Z",
  "action": "add-domain",
  "args": { "name": "ops" },
  "files_touched": ["domains/ops/playbook.md"],
  "exit_status": 0
}
```

Fields:

- `ts` — ISO 8601 UTC
- `action` — semantic name (`add-domain`, `add-skill`, `add-app`, `launch`, `edit`, `curate`, …)
- `args` — input parameters (object)
- `files_touched` — array of relative paths
- `exit_status` — 0 on success, non-zero on failure
- `prompt` — for AI actions, the verbatim prompt sent to `claude`

### `vault/raw/scheduled-runs.jsonl`

Audit log for every scheduled-job fire. Written by `scripts/scheduler-tick.mjs` when a cron expression matches, and by `POST /api/schedules/run-now` when a user manually fires a schedule from the dashboard.

```json
{
  "ts": "2026-05-20T16:00:00Z",
  "id": "runbook-morning-brief",
  "schedule": "0 9 * * *",
  "prompt": "/os brief",
  "exit": 0,
  "duration_ms": 4231,
  "stdout_preview": "…",
  "stderr": "",
  "manual": false
}
```

Fields:

- `ts` — ISO 8601 UTC of the fire start
- `id` — frontmatter `id` of the source runbook entry
- `schedule` — 5-field cron expression at time of fire
- `prompt` — verbatim prompt sent to `claude -p`
- `exit` — claude exit code (0 on success, non-zero or `null` on failure)
- `duration_ms` — wall time of the spawn
- `stdout_preview` — first 4 KB of stdout (longer output truncated with `…[truncated]`)
- `stderr` — first 2 KB of stderr
- `manual` — `true` when fired from the dashboard's **Run now** button, `false` for scheduler tick (omitted when false in some early logs)
- `project` — entity id of the project this scheduled runbook belongs to (when set via `project:` frontmatter), or `null` for global schedules. Status-report skill filters by this.

### `.claude/state/pending-curation.txt`

Plain text, one relative path per line.

### `.claude/state/installed-at`

Single line, ISO 8601 UTC.

### `.claude/state/app-ports.json`

JSON object mapping app names to port pairs.

```json
{
  "meta-dashboard-app": { "web": 5173, "api": 5174 },
  "development-pr-review-app": { "web": 5175, "api": 5176 }
}
```

## Relationship to the structured event store

Every JSONL append above is also written as a row to `.claude/state/events.db` (the OS's structured event store). The two layers exist in parallel during the events.db rollout: JSONL is the append-only audit trail (grep-friendly, git-history-friendly); events.db is the indexed query surface (analytics, dashboard Insights view, per-skill aggregates).

Write sites use either dedicated dual-write wrappers (`scripts/record-router-event.mjs`, `scripts/record-dashboard-launch.mjs`) or call `recordEvent()` directly from helper-module callers (`scripts/scheduler-tick.mjs`, `domains/meta/app/server/routes/{action,edit}.ts`). The audit's `dual-write-parity` check fires if any write site appends JSONL but forgets `recordEvent`.

Detail: [[standard-event-store]] — schema, vault/telemetry separation, retention.

## Rationale

- JSONL is append-only, parse-incrementally, grep-friendly
- Markdown is for human consumption; logs are for machines (rendered by the dashboard)
- Pending curation and install marker don't need structure — plain text is enough
- App ports separated from logs because they're mutable state, not history

## Related

[[standard-hook-protocol]], [[standard-app-layout]], [[standard-event-store]]
