---
id: standard-scheduled-jobs
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [standard, scheduling, heartbeat]
source: seed
private: false
title: Scheduled jobs (heartbeat) standard
url: internal://standard/scheduled-jobs
kind: doc
last_verified: 2026-05-20
---

# Scheduled jobs (heartbeat) standard

## What this covers

How the OS fires actions on a schedule without a human prompt — the "heartbeat" pattern that lets the agent behave proactively (morning briefs, hygiene checks, periodic syncs).

## The shape

A scheduled job is just a `runbook` archetype entry with two optional fields populated:

```yaml
schedule: "0 9 * * *"   # standard 5-field cron, machine local time
prompt: "/os brief"     # intent fed to `claude -p` when due
```

A third optional field scopes the schedule to a project:

```yaml
project: feature-search-revamp   # entity id of a project (type: project)
```

When `project` is set, the scheduler tick **only fires this schedule when the named project's `status == active`**. Paused/completed projects auto-pause their scheduled work without any manual disable. Schedules without `project:` are global and always fire when due. See [[standard-project-workflow]] for the full pattern.

Everything else is normal runbook frontmatter (`title`, `trigger`, `owner`, etc.). The body's **Steps** section documents what the prompt should accomplish — readable, reviewable, the same as any manual runbook.

## Mechanics

The runner is `scripts/scheduler-tick.mjs` — a pure-Node script with no npm dependencies, invoked every 60 seconds by a launchd LaunchAgent (`com.agentic-os.scheduler`).

On each tick:

1. Walk `vault/wiki/**/*.md`, parse frontmatter, filter for `type: runbook` with both `schedule` and `prompt` fields.
2. For each candidate, evaluate the cron against `new Date()` (local time).
3. Dedupe by minute via `.claude/state/schedule-runs.json` (the same minute can only fire once even if the script is invoked multiple times).
4. For each due job, spawn `claude -p "<prompt>" --permission-mode bypassPermissions` and capture stdout/stderr.
5. Append a JSON line to `vault/raw/scheduled-runs.jsonl`:
   ```json
   {"ts":"...","id":"runbook-morning-brief","schedule":"0 9 * * *","prompt":"/os brief","exit":0,"duration_ms":4231,"stdout_preview":"…","stderr":""}
   ```

## Cron syntax

Standard 5-field cron (minute, hour, day-of-month, month, day-of-week). Day-of-week 0–6, Sunday = 0. Supported in each field:

| form    | meaning                       |
| ------- | ----------------------------- |
| `*`     | any value                     |
| `N`     | exact value                   |
| `N-M`   | range                         |
| `*/N`   | step starting from min        |
| `A,B,C` | list (any of the above forms) |

Cron quirk implemented per POSIX: if both day-of-month and day-of-week are restricted, the job runs on the **OR** of the two (not AND).

Not supported: `@daily`, `@hourly`, `L`, `W`, second-precision, year fields. Add them later if needed.

## Manual run

From the dashboard **Schedules** view: click **Run now** on any schedule. The same `claude -p` invocation runs (bypassing the cron-due check) and is logged to `scheduled-runs.jsonl` with an additional `"manual": true` field.

From the CLI: `node scripts/scheduler-tick.mjs --run-id <id>`.

To dry-run the tick (list due jobs without firing): `node scripts/scheduler-tick.mjs --dry-run`.

To list all schedules + their next-run times: `node scripts/scheduler-tick.mjs --list`.

## Installing the scheduler

macOS only in v1:

```bash
./scripts/install-scheduler.sh
```

The script renders `_templates/launchagent.plist.tmpl` with absolute paths, writes it to `~/Library/LaunchAgents/com.agentic-os.scheduler.plist`, and `launchctl load`s it. Idempotent — re-running unloads + reloads.

To uninstall:

```bash
launchctl unload ~/Library/LaunchAgents/com.agentic-os.scheduler.plist
rm ~/Library/LaunchAgents/com.agentic-os.scheduler.plist
```

Linux/Windows: cron / systemd / Task Scheduler wrappers around the same tick script are deferred to a later version.

## Failure handling

A failed run shows up in the Schedules view with `✗ exit N` and the stderr snippet. The cron continues to fire on its normal schedule — failures don't auto-disable. Disable manually by clearing the `schedule:` and `prompt:` fields (which downgrades the entry back to a regular runbook), or delete the entry.

## Preconditions

Some runbooks only have work to do when the vault contains specific entries — for example, [[runbook-pr-ci-monitor]] only matters when there's at least one open PR with `ci_state in (null, running)`. Without a guard, the scheduler would still spawn Claude every 15 minutes, read the manifest, filter everything out, and report "Triage clean". That's a wasted Claude invocation per empty fire.

The optional `precondition_query` + `precondition_min` frontmatter fields tell the scheduler to **peek at the manifest before firing**. If fewer than `precondition_min` entries match, the schedule is silently skipped for that minute and a `schedule-skip` event is recorded (visible in the Activity tab + events.db).

```yaml
schedule: '*/15 * * * *'
precondition_query: 'type=change status=in-review pr_url=set ci_state=null|running'
precondition_min: 1
```

The check runs **per tick** so re-arm is automatic — when a new PR opens and the manifest gains a matching entry, the next tick fires normally with no manual intervention.

### Query grammar

Flat, AND-of-clauses, whitespace-separated. Each clause matches one manifest entry field:

| clause          | meaning                                       |
| --------------- | --------------------------------------------- |
| `field=value`   | Equality (string compare against frontmatter) |
| `field=a\|b\|c` | OR-list; any of the values matches            |
| `field=set`     | Field present + non-empty                     |
| `field=null`    | Field unset / null / empty string             |

The value `null` in an OR-list also matches empty/missing — useful for things like `ci_state=null|running` (either "never polled" or "still running").

**OR-groups:** `||` separates whole clause-groups — an entry matches when it satisfies ANY group, and the match count is the size of the union. Added for `runbook-daily-audit-followups`, which fires when provisional audits OR pending decision validations exist:

```yaml
precondition_query: 'type=lifecycle-audit audit_status=provisional || type=decision validation_result=pending'
```

The manifest lives at `vault/.index/manifest.json` and is built by `.claude/hooks/rebuild-vault-index.mjs` on every wiki write. Available fields are the ones explicitly extracted by the rebuilder — `type`, `domain`, `status`, `pr_url`, `ci_state`, `review_status`, `project`, `repo`, `parent_change`, etc. Plain frontmatter fields not surfaced into the manifest can't be queried; if you need one, extend the rebuilder.

### Edge cases

- **Manifest missing/unreadable** — the tick **fires anyway** with a warning, so the runbook can surface the underlying problem rather than silently stalling forever.
- **Malformed query** — clauses that don't parse are dropped silently. A query of all-malformed clauses matches everything (effectively no filter).
- **`precondition_min` omitted** — defaults to `1` (at least one match required).
- **Manual `--run-id` invocations** — bypass preconditions. Intent is "run anyway".

### When to add a precondition

- The runbook's prompt would no-op when there's no matching data (e.g. polling, triage sweeps, freeze checks).
- The runbook fires often enough (sub-hourly) that empty fires would compound.
- The "matching data" condition is queryable from manifest fields, not from external state (GitHub, calendars, etc.) — those need a different pattern.

If the runbook always has work to do regardless of state (`runbook-morning-brief` always writes a brief; `runbook-weekly-curation-check` always sweeps `vault/raw/`), don't add a precondition.

## Cost discipline

Every fire spawns a Claude invocation. Keep prompts narrow and use specific scopes. The morning-brief seed runs ~daily; the curation-check runs weekly — both inexpensive. Sub-hourly schedules should declare a `precondition_query` (see above) so empty fires stay free. Avoid `* * * * *` (every-minute) prompts unless they do something genuinely cheap or are gated by a precondition.

## Related

- [[archetype-runbook]] — the underlying archetype
- [[standard-log-formats]] — `scheduled-runs.jsonl` shape matches the rest of the audit logs
- [[meta-add-schedule]] — scaffolds new scheduled runbooks (optionally with project scoping)
- [[standard-project-workflow]] — project-scoped firing rules
- `scripts/scheduler-tick.mjs` — the runner
- `scripts/install-scheduler.sh` — the macOS installer
- `_templates/launchagent.plist.tmpl` — the plist template
