---
name: meta-status-report
description: Generate a status report for a project — synthesizes recent commits, decisions, scheduler activity, and milestone progress into structured markdown
user-invocable: true
version: 1
domain: meta
tags: [project, report, status]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Project id (slug). Must match an existing `type: project` wiki entry.'
  since:
    type: string
    required: false
    description: 'ISO date to start the report window (YYYY-MM-DD). Defaults to the project''s reporting.last_sent, or 7 days ago if never sent.'
  report_type:
    type: string
    required: false
    enum: [kickoff, status, wrap-up]
    default: status
    description: |
      STRICT ENUM: `kickoff`, `status`, or `wrap-up` — controls the report's
      framing and which sections are emphasized.

      - `kickoff` — forward-looking. Captures intent, plan, expected milestones,
        deadline. Use when a project starts; the activity section is typically empty
        or sparse, so the report leans on intent + plan.
      - `status` (default) — running update. Backward-looking window of activity
        (commits, decisions, change roll-up, scheduler runs) plus forward-looking
        Next + Blockers. Use for periodic updates.
      - `wrap-up` — retrospective. Project is terminal or about to be. Emphasizes
        what shipped, what was abandoned, lessons learned, and links to artifacts
        (merged PRs, final status, total cost/time). Use before `meta-close-project`
        as the closing artifact.
outputs:
  - kind: file
    path: vault/output/{{input.domain}}/status-reports/{{input.project}}-{{input.report_type}}-{{timestamp}}.md
spawns: []
---

# meta-status-report

## Purpose

Walk a project's recent activity and produce a structured markdown status update. The report writes to `vault/output/<domain>/status-reports/<project-id>-<report-type>-<YYYY-MM-DDTHHMMSS-TZ>.md` — clipboard-target reporting means the user copies the file content to their tool of choice (Notion, Linear, Slack, email). Each run produces a NEW file; multiple reports per day are preserved as separate snapshots so the user can see how the project state evolved over time.

Updates the project entry's `reporting.last_sent` and `reporting.next_due` so the next report covers a clean window.

## Procedure

1. Read the project entry at `vault/wiki/<domain>/project/<project>.md`. If missing, reject with: "project `<project>` not found — verify the id."
2. Parse its frontmatter. Extract:
   - `domain`, `title`, `status`, `lifecycle_stage`, `deadline`
   - `repos` (array of entity ids; may be empty for non-code projects)
   - `milestones` (array of `{date, label, status}`)
   - `reporting.cadence`, `reporting.last_sent`, `reporting.target`
3. Determine the **report window**:
   - Start: `inputs.since` if provided, else `reporting.last_sent`, else 7 days ago (ISO format)
   - End: now (ISO timestamp)
4. **Find related activity** — read `vault/.index/manifest.json`. Separate into two buckets:
   - **Owned** — entries where `project == <project-id>` (the entry's frontmatter ownership field) AND `updated >= start`. These are this project's accumulated work product. Top billing.
   - **Referenced** — entries where `backlinks` includes the project's id but `project` does NOT equal this project (i.e. only a body wikilink, no ownership claim). AND `updated >= start`. Supplementary context.
     Group each bucket by type (decision, note, runbook, change, …).

4a. **Compute change rollup** — from the owned bucket, isolate `type: change` entries (the manifest now carries their `status`, `review_status`, `pr_url`). Build a per-status tally for ALL owned changes (not just in-window): `planning`, `in-progress`, `in-review`, `merged`, `abandoned`. Separately, identify **merged-this-window** (status=merged AND `updated >= start`) and **opened-this-window** (status=in-review with pr_url set AND `updated >= start`). These power the "Code activity" section in the report. 5. **For each repo in `repos`** — read the repo entity at `vault/wiki/<domain>/entity/<repo>.md` to get `local_path` and `current_branch`. Then `cd` to that path and run:

- `git log --since "<start>" --pretty=format:"%h %s" <current_branch>` — recent commits, one line each
- `git status --porcelain` — to note any in-progress work
- Skip silently if the repo path is missing.
  The resulting commits get grouped by repo in the report (one sub-section per repo if more than one).

6.  **Find scheduler activity** — read `vault/raw/scheduled-runs.jsonl`, filter to entries with `project == <project-id>` AND `ts >= start`. Count successes/failures, list scheduler ids fired.
    6a. **Compute quantitative rollup** — query `.claude/state/events.db` for every event tagged to this project AND its owned changes. Build: - **total_cost_usd**: sum of `cost_usd` across `action = 'ai-prompt'` events. - **total_wall_time_ms**: sum of `duration_ms` across `action = 'ai-prompt'` events. - **ai_prompt_runs**: count of `action = 'ai-prompt'` events. - **runs_by_skill**: `{ <skill>: { count, cost_usd, duration_ms } }` map. - **changes_terminal**: `merged` + `abandoned` counts from the manifest roll-up (already loaded in step 4). - **failed_runs**: count of `action = 'ai-prompt'` events where `exit_status != 0`.

        SQL sketch:
        ```sql
        SELECT skill, COUNT(*) AS n, SUM(cost_usd) AS cost, SUM(duration_ms) AS dur,
               SUM(CASE WHEN exit_status != 0 THEN 1 ELSE 0 END) AS failures
        FROM events
        WHERE action = 'ai-prompt'
          AND (project = '<project-id>' OR change_id IN (<owned change ids>))
        GROUP BY skill;
        ```

        Surface this block in the report so future-you (and any cross-project comparison) has real numbers to point at. **Required section** — emit even when totals are zero (with a "no recorded runs in window" note).

7.  **Milestone summary** — from the project entry's `milestones` array: count `done` vs `pending`, surface the next pending milestone with its date.
8.  **Compose the markdown report**. Structure:

    ```markdown
    ---
    report_type: <kickoff|status|wrap-up>
    timeframe_start: <start date as ISO 8601, e.g. 2026-05-23T00:00:00Z>
    timeframe_end: <today as ISO 8601, e.g. 2026-05-30T00:00:00Z>
    ---

    # Status report — <title>

    **Period:** <local-formatted start> → <local-formatted end>  (e.g. `Jun 1, 2026 9:46 PM PDT → Jun 1, 2026 9:55 PM PDT`)
    **Status:** <status> · **Lifecycle:** <lifecycle_stage>
    **Deadline:** <deadline> (<relative — "in 3 weeks" or "overdue by 2 days">)
    **Repos:** <comma-list of repo ids, or "(none)">

    ## TL;DR
    <1-2 sentence headline. Synthesize: what moved, what's blocking, what's next>

    ## Progress

    ### Changes
    Continuous lifecycle tracking. Show EVERY non-terminal change (status NOT in `{merged, abandoned}`) AND any change whose `merged_at` or `abandoned_at` falls within this report's window. Once a change appears in any report, it keeps reappearing until it terminates — the reader can follow each unit of work from scaffold to merge across the report stream.

    Aggregate one-liner first:
    - <N> owned change(s) total: <planning> planning · <in_progress> in-progress · <in_review> in-review · <merged> merged · <abandoned> abandoned

    Then one block per tracked change, ordered by `created` ascending (matches the orchestrator's dispatch order — readers see the lifecycle of change 1, 2, 3 …):

    ```

    - **[[<change-id>]]** — <title>
      Status: <status> · Step: <current step>
      Since last report: <bulleted list of transitions in this window>
      PR: <pr_url or "(no PR yet)">

    ```

    **Current step** — derived from the change's frontmatter, not stored explicitly. Map (most-progressed wins):
    - `status: merged` → `Merged` (terminal)
    - `status: abandoned` → `Abandoned` (terminal)
    - `pr_review_status: ready-for-human` → `Awaiting human merge`
    - `pr_review_status: needs-changes` → `Review wants changes`
    - `pr_review_status: approved` → `Approved — triage review comments, then Mark ready`
    - `pr_review_path` set AND `pr_review_status: pending` → `In PR review (verdict pending)`
    - `status: in-review` AND `pr_url` set → `PR open, review pending`
    - `status: in-progress` → `Code written, awaiting PR`
    - `review_status: approved` AND no `pr_url` → `Plan approved, ready to execute`
    - `review_status: request-changes` → `Plan needs revision`
    - `plan_path` set AND `review_status: pending` → `Plan written, awaiting review`
    - `plan_path` not set → `Planning (no plan yet)`

    **Since last report** — list any frontmatter timestamp that falls within the report window (`timeframe_start` ≤ ts ≤ `timeframe_end`). Each becomes a one-line transition:
    - `plan_generated_at` in window → "Plan written <relative>"
    - `reviewed_at` in window → "Plan reviewed: <review_status> <relative>"
    - `plan_revised_at` in window → "Plan revised to revision <plan_revision> <relative>"
    - `pr_reviewed_at` in window → "PR reviewed (pass <pr_review_passes>) <relative>"
    - `pr_ready_at` in window → "Marked ready for human <relative>"
    - `merged_at` in window → "**Merged** <relative>"
    - `abandoned_at` in window → "**Abandoned** — <abandoned_reason> <relative>"

    If no transitions fell in this window for a non-terminal change, write `Since last report: (no change)`.

    (Omit the "### Changes" section entirely only when zero changes have ever been scaffolded.)

    ### Commits — <repo-id> (<N>)
    - <hash> <subject>
    - ...
    (repeat per repo; or "No commits in this window." if all repos empty.
    If only one repo, drop the per-repo sub-header — flatten to one Commits section.)

    ### Owned decisions
    - [[<id>]] <title> (<date>)
    - ... (entries with project: <this-id> in frontmatter — the project's work product)
    (or "No new decisions captured under this project.")

    ### Other owned work
    - [[<id>]] <title> (<type> · <date>)
    - ... (owned non-decision entries: notes, scheduled runbooks created, etc.)

    ### References (supplementary)
    Only include if useful context — entries that link to this project via body wikilinks
    but aren't owned. Keep terse: 1 line per item, 3-5 max.
    - [[<id>]] <title> (<type>) — <one-line reason if obvious>

    ## Milestones
    - <X> of <Y> done. Next: **<label>** by <date>.
    - (or "No milestones declared.")

    ## Scheduler activity
    - <N> runs fired (<S> successful, <F> failed).
    - Failures: <list ids> (or "No failures.")
    - (or "No scheduler activity in this window.")

    ## Quantitative rollup
    - **Cost:** $<total_cost_usd to 2 dp> across <ai_prompt_runs> billable run(s)
    - **Wall-time:** <minutes>m (sum of skill durations; excludes idle gaps)
    - **Failed runs:** <failed_runs> (or "None — every run exited 0")
    - **By skill** (top 5 by cost):
      - `<skill>`: <count> run(s) · $<cost> · <minutes>m
      - ...
    - (or "No recorded runs in this window." when totals are zero)

    ## Blockers / risks
    <1-3 bullets. Inferred from failed scheduler runs, uncommitted work, missed milestones, or "(none surfaced — review independently)">

    ## Next
    <2-3 bullets. The pending milestone, any obvious next action from recent decisions, what reporting cadence says is due>

    ---
    Generated <date> by meta-status-report. Copy to your status-update channel.
    ```

8a. **Vary the composition by `inputs.report_type`.** The skeleton above is the `status` template (the default). Adjust:

- **`kickoff`** — drop the "Code activity / Commits / Owned decisions" sections (project hasn't produced work yet). Add:
  - `## Intent` — one paragraph from the project body's `## Why` or `## Approach` if present.
  - `## Plan` — the project's stated approach + initial scope.
  - `## Milestones` — same as default, but lean forward (every milestone is pending).
  - `## Stakeholders` — list from frontmatter if present.
  - Drop `## Blockers / risks` (premature). Replace `## Next` with `## First steps` (concrete actions for week 1).
- **`status`** — the default skeleton above. No changes.
- **`wrap-up`** — drop forward-looking sections (`Next`, `Milestones` only as retrospective). Add:
  - `## Outcome` — what the project actually delivered. List merged changes with PR URLs. Note abandoned changes with reasons.
  - `## Total cost` — pull from `events.db` directly: total billable cost + wall-time across every event tagged to this project or its owned changes. See the Quantitative rollup query in step 6a; emit even if zero.
  - `## What worked` and `## What didn't` — short bulleted retrospective. Lift from project body's `## Notes` if substantive, else mark `(none captured)`.
  - `## Follow-ups` — open nits, deferred comments, and any backlog the project surfaced.
  - Drop `## Blockers / risks` (terminal — nothing to block).

The required `## Quantitative rollup` section (step 6a) renders in every report type.

8b. **Timeframe per report_type.** The `timeframe_start` / `timeframe_end` frontmatter fields tell the dashboard's Reports tab what date-range each report actually summarizes (drives the "Covers Apr 1 – Apr 7" badge). Compute per variant:

- **`kickoff`** — `timeframe_start` = project's `created` field; `timeframe_end` = now. The whole project history is in scope (which is short for kickoff).
- **`status`** — `timeframe_start` = `reporting.last_sent` if set, else project's `created`; `timeframe_end` = now. Default "since last sent" semantics.
- **`wrap-up`** — `timeframe_start` = project's `created`; `timeframe_end` = now. Whole-project retrospective.

If `reporting.last_sent` is null on a `status` report, fall back to `created`. All values written as ISO 8601 UTC.

**Timestamp formatting in BODY content.** Every timestamp that appears in the markdown body (the `**Period:**` line, commit times, scheduler runs, "generated X ago," etc.) must be formatted in the **user's local timezone** with a TZ abbreviation — the status report is copied verbatim to Slack / Notion / Linear and the recipients expect local time, not UTC. Pattern:

- Frontmatter (`timeframe_start`, `timeframe_end`, `created`, `updated`, `reporting.last_sent`, `reporting.next_due`): stay ISO 8601 UTC. Those are data fields parsed by downstream tools.
- Body text: convert each ISO timestamp to local-readable form via `date -j -f '%Y-%m-%dT%H:%M:%SZ' '<iso>' '+%b %-d, %Y %-I:%M %p %Z'` (macOS) → produces `Jun 1, 2026 9:46 PM PDT`. The Period line specifically should read `**Period:** Jun 1, 2026 9:46 PM PDT → Jun 1, 2026 9:55 PM PDT` (or a shorter form like `2026-06-01 9:46 PM PDT` if that fits the surrounding layout better).

9.  **Write the file** to `vault/output/<domain>/status-reports/<project-id>-<report-type>-<YYYY-MM-DDTHHMMSS-TZ>.md` where the timestamp is the moment of generation in **local time** + a TZ suffix (e.g. `2026-06-01T214731-PDT`, `2026-12-15T093030-PST`). No separators inside the time component; TZ separated by single hyphen. `<report-type>` is the resolved input value — `kickoff`, `status`, or `wrap-up`. Get the TZ abbreviation via `date '+%Z'`. Create the directory if it doesn't exist. Each run produces a NEW file; multiple status reports per project per day are preserved as separate snapshots (the reporting UI sorts newest-first, so the most recent run is what the user sees by default).

10. **Update the project entry's frontmatter** via Edit tool:
    - `reporting.last_sent`: now (ISO 8601 UTC)
    - `reporting.next_due`: based on `reporting.cadence`:
      - `daily` → tomorrow's date (YYYY-MM-DD)
      - `weekly` → today + 7 days
      - `none` → leave unchanged or set null
    - `updated`: now (ISO)

11. **Audit log** — record via the dual-write wrapper. Stuff the report's TL;DR + key sections into `--args` so notification templates can render a meaningful Slack/email message without re-reading the file. The dispatcher passes `args` to the template engine as `event.args` for Mustache interpolation.

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action status-report \
      --skill meta-status-report \
      --args '{
        "project":"<id>",
        "report_type":"<kickoff|status|wrap-up>",
        "title":"<project title>",
        "tldr":"<the ## TL;DR section as a single line — strip newlines>",
        "progress_summary":"<one-line summary of the Changes block — e.g. \"2 of 6 merged · 1 in PR review · 3 in planning\">",
        "blockers":"<the ## Blockers / risks section as a single line, semicolon-separated bullets>",
        "next":"<the ## Next section as a single line, semicolon-separated bullets>",
        "report_path":"<full vault/output/... path>",
        "period_local":"<the **Period:** line value, e.g. \"Jun 1, 2026 7:55 AM PDT → Jun 1, 2026 8:55 AM PDT\">"
      }' \
      --files-touched '["<report path>","vault/wiki/<domain>/project/<project>.md"]'
    ```

    Keep each field a single line — Mustache templates render directly into Slack/email text. Strip embedded newlines from the source sections; replace bullet markers with `· ` separators so the values stay readable when concatenated.

12. **Confirm to user** with a 5-line summary:
    ```
    ✓ <Report-type capitalized> report generated for <title>
      type:     <kickoff|status|wrap-up>
      period:   <start> → <today>
      file:     vault/output/<domain>/status-reports/<id>-<type>-<date>.md
      summary:  <N commits, M decisions, K scheduler runs>
      next:     reporting.next_due = <date>
    ```

## Outputs

- New markdown file at `vault/output/<domain>/status-reports/<project-id>-<report-type>-<YYYY-MM-DD>.md`. `<report-type>` is one of `kickoff`, `status`, `wrap-up`.
- Updated `reporting.last_sent` and `reporting.next_due` on the project entry
- Audit log line

## Errors

- Project not found → reject with the id and suggest verifying via `/os list projects` (or browsing Vault → wiki/<domain>/project/)
- Project status is `completed`/`cancelled` → warn but proceed (sometimes you want a final report)
- Any repo entity in `repos` is missing → continue with the rest; surface a one-line note in the report for each missing one
- Manifest missing or stale → continue with what's parseable; surface a note that backlinks may be incomplete and suggest running the rebuild hook

## Design notes

- The skill writes **markdown only** — no MCP, no webhooks. v1 ships clipboard-target reporting. Future: MCP integrations to Notion/Linear/Slack would consume the same generated file (or skip file write and post directly).
- The report is **synthesized**, not just a log dump. Use the LLM's understanding of the activity to write the TL;DR and Blockers/risks sections — these are the hand-curation parts that justify spending a `claude -p` invocation on this.
- **Idempotent per day**: regenerating the report on the same day overwrites that day's file. Want history? It's there — yesterday's file still exists.

## See also

- [[standard-project-workflow]] — the project workflow standard
- [[archetype-project]] — the project archetype + reporting field shape
- [[meta-add-project]] — scaffolds projects this skill operates on
- [[standard-log-formats]] — `scheduled-runs.jsonl` shape (includes project field for filtering)
