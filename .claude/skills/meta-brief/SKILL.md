---
name: meta-brief
description: 'Session brief — pending items, in-flight work (projects + changes), scheduler health, recent activity. Persists dated + latest snapshots to vault/output/meta/brief/.'
user-invocable: true
version: 3
domain: meta
tags: [brief, session]
inputs: {}
outputs:
  - kind: text
    description: Compact status block printed inline
  - kind: file
    path: vault/output/meta/brief/{{date}}.md
  - kind: file
    path: vault/output/meta/brief/latest.md
---

# meta-brief

## Purpose

At session start (or on demand), print a compact summary of OS state so the user can pick up cold:

- pending raw items awaiting curation
- in-flight code work (changes by status, reviews awaiting attention)
- active projects with deadlines + recent activity
- scheduler health (next fire, last-24h failures)
- router miss rate + recent OS evolution

Cheap to run — pure file reads + manifest queries, no API calls.

## Procedure

1. Check `.claude/state/installed-at`. If missing or this is the first run, print a welcome banner instead of a brief and stop.
2. Read `vault/.index/manifest.json`. If missing, skip the manifest-based stats with `index not yet built`.
3. Read `.claude/state/pending-curation.txt`. Count lines. If non-empty, find the age of the oldest entry (mtime of the referenced raw file).

3b. Read `.claude/state/curation-needs-review.json` — the needs-review sidecar written by [[meta-curate]]'s headless `park` policy (a JSON object keyed by raw path, each value `{ reason, at }`). If it exists and has entries, count them and pick the oldest by its `at` timestamp; capture that entry's **age** (`now - at`) and its `reason`. Non-fatal if the file is missing or empty — just skip the parked line.

4. Read the last ~500 lines of `vault/raw/router-log.jsonl`. Filter to last 7 days. Compute miss rate = entries with `confidence: miss` / total.
5. Find the last entry in `vault/raw/dashboard-actions.jsonl` with `action: launch` to determine when the dashboard was last opened.

5b. Gather scheduler data (feeds the `## Scheduler` section):

- **Schedules + next fire**: run `node scripts/scheduler-tick.mjs --list` — it prints every schedule with its next run. ("Enabled" means a `type: runbook` wiki entry with both `schedule:` and `prompt:` frontmatter set — there is no `enabled` field; the manifest does not carry `schedule`/`prompt`, so the wiki files / the `--list` output are the source, not the manifest.)
- **Last-24h outcomes**: read `vault/raw/scheduled-runs.jsonl` (last 24h window) and count fired / skipped / failed. Every entry has an `outcome` field:
  - `outcome: 'fired'` — the scheduler ran the runbook's prompt (counts as `ran`)
  - `outcome: 'skipped'` — precondition not met (e.g. zero in-review changes to monitor); counts as healthy, NOT a failure. Common for high-frequency runbooks like `runbook-pr-ci-monitor` during quiet periods.
  - `outcome: 'spawn-error'` — claude CLI couldn't be spawned (counts as failed)
  - `exit: <non-zero>` on a fired entry — runbook ran but errored (counts as failed)

  Older entries without `outcome` predate the field (pre-2026-05-24); treat them as `fired` for backwards compat.

- **Last-fire detection**: "last fired" means "most recent entry of any outcome" — don't filter out skips when computing freshness. A runbook that's skipped 150 times in a row is still healthy; the problem you're looking for is "no entries at all in the last 2× the cron interval".

6. From the manifest, find entries with `type: project` and `status: active`. The manifest does NOT carry `deadline` or `lifecycle_stage` (they're not in the index builder's lifted fields) — so for each matching entry, read its file (the manifest `path` field) and extract title, deadline (and overdue flag), lifecycle_stage from the frontmatter. List up to 5; if more exist, mention count.
7. From the manifest, find entries with `type: change` and bucket them:
   - **in-progress** — agent is editing. Count + list ids.
   - **in-review** — PR open, awaiting merge. Count + list ids with `pr_url` if set.
   - **planning + review_status: pending + plan_path set** — review awaiting. THIS IS THE MOST ACTIONABLE: a plan is sitting waiting for `/os review-change`. Surface prominently.
   - **planning + review_status: request-changes** — reviewer pushed back, awaiting re-plan or override. Surface.
   - **stale** — using the entry's `updated` field, flag any non-terminal change (`status` ∈ planning / in-progress / in-review) older than the following thresholds (in calendar days from now):
     - `planning` + `review_status: pending` + no `plan_path` for >3 days → drafting stalled
     - `planning` + plan_path set + `review_status: pending` for >2 days → review overdue
     - `in-progress` for >7 days → execution stalled
     - `in-review` for >14 days → PR is sitting
       Compute `now - parseDate(updated)`. Skip entries with `status: merged` or `abandoned`. List up to 5 stale entries with id, status, and how-many-days-stale; if more exist, mention count.
8. Find recent OS evolution: in the last 7 days, entries from `dashboard-actions.jsonl` with `action` in `add-domain|add-skill|add-app|add-archetype|add-project|add-change|evolve|write-change-plan|review-change`.
9. Compose the brief as markdown with the structure below. Print it to stdout AND persist it (next step).

   ```markdown
   # Session brief — <YYYY-MM-DD HH:MM local>

   ## Pending
   - <N> raw items awaiting curation (oldest: <X days>)
   - <R> parked for review (oldest: <X days> — <reason>)
   - <P> change(s) with plans awaiting review:
     - [[<change-id>]] — <title> (run /os review-change <id>)
   - <Q> change(s) flagged "request-changes":
     - [[<change-id>]] — <title> (re-plan or override)

   ## In flight
   - <N> changes in-progress:
     - [[<change-id>]] — <title> · branch <branch>
   - <M> changes in-review (PR open):
     - [[<change-id>]] — <title> · <pr_url or "(no URL captured)">

   ## Stale changes
   - [[<change-id>]] — <title> · <status> · stalled <X days> (run /os write-change | review-change | open-pr <id>)
   - … (up to 5; if more: "and <N> more")
   (Omit this section entirely when no stale entries.)

   ## Active projects
   - [[<project-id>]] — <title> · <lifecycle_stage> · deadline <date> (overdue / in X days)
   - … (up to 5)
   - If more: "and <N> more"

   ## Scheduler
   - <N> schedules enabled · next fire: <id> at <time>
   - Last 24h: <fired> fired, <skipped> skipped, <failed> failed
   - (If any failed: list ids)

   ## Recent OS activity (last 7d)
   - <N> dashboard actions (<X> successful, <Y> failed)
   - Router miss rate: <P>%
   - OS evolution: <N> changes (<list distinct action types>)

   ## Suggested next actions
   - <1-3 bullets — derived from above. Prioritize: pending reviews > failed scheduler > overdue projects > curation queue. Concrete commands when applicable (e.g. "/os review-change <id>").>
   ```

   Keep it under ~40 lines total. Sections may be omitted when empty (e.g. no in-flight changes → skip the "In flight" section entirely).

10. Persist the brief:
    - Write the full markdown to `vault/output/meta/brief/<YYYY-MM-DD>.md` (today's date, local time). If the file already exists for today, overwrite it.
    - Mirror to `vault/output/meta/brief/latest.md` (same content) so the dashboard always knows where to look.
    - Create `vault/output/meta/brief/` if it does not exist.

## Outputs

- Markdown brief printed to stdout (for CLI users and Claude Code sessions).
- `vault/output/meta/brief/<YYYY-MM-DD>.md` — date-stamped snapshot; history accumulates.
- `vault/output/meta/brief/latest.md` — always points at the most recent brief; the dashboard's Overview reads this.

## Errors

- Any missing file is non-fatal — just skip that line. The brief is best-effort.
