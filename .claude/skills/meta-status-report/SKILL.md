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

## Inputs

- `project` (required) — project id (slug); must match an existing `type: project` wiki entry.
- `since` (optional) — ISO date (YYYY-MM-DD) that starts the window; defaults to `reporting.last_sent`, else 7 days ago.
- `report_type` (optional) — `kickoff` | `status` (default) | `wrap-up`. Controls framing; the frontmatter enum above describes each.

## Reference files

Bulk material lives in `references/` next to this file. Read each one with the Read tool at the step named below — never compose these from memory:

- `references/rollup-query.md` (step 6a) — rollup fields + the `events.db` query.
- `references/output-template.md` (step 8) — the markdown skeleton, Changes-section rules, current-step + since-last-report derivation maps, body timestamp formatting, and the step-12 confirmation summary.
- `references/type-variants.md` (step 8) — per-`report_type` section adjustments + the `timeframe_start` / `timeframe_end` rules.
- `references/audit-log-args.md` (step 11) — the `record-dashboard-action.mjs` invocation + its single-line args contract.

## Procedure

1. Read the project entry at `vault/wiki/<domain>/project/<project>.md`. If missing, reject with: "project `<project>` not found — verify the id."
2. Parse its frontmatter. Extract `domain`, `title`, `status`, `lifecycle_stage`, `deadline`; `repos` (array of entity ids; may be empty for non-code projects); `milestones` (array of `{date, label, status}`); `reporting.cadence`, `reporting.last_sent`, `reporting.target`.
3. Determine the **report window** — start: `inputs.since` if provided, else `reporting.last_sent`, else 7 days ago (ISO format). End: now (ISO timestamp).
4. **Find related activity** — read `vault/.index/manifest.json`. Separate into two buckets:
   - **Owned** — entries where `project == <project-id>` (the entry's frontmatter ownership field) AND `updated >= start`. These are this project's accumulated work product. Top billing.
   - **Referenced** — entries where `backlinks` includes the project's id but `project` does NOT equal this project (i.e. only a body wikilink, no ownership claim) AND `updated >= start`. Supplementary context.

   Group each bucket by type (decision, note, runbook, change, …).

   **4a. Compute change rollup** — from the owned bucket, isolate `type: change` entries (the manifest carries their `status`, `review_status`, `pr_url`). Build a per-status tally for ALL owned changes (not just in-window): `planning`, `in-progress`, `in-review`, `merged`, `abandoned`. Separately, identify **merged-this-window** (status=merged AND `updated >= start`) and **opened-this-window** (status=in-review with pr_url set AND `updated >= start`). These power the "Code activity" section.

5. **For each repo in `repos`** — read the repo entity at `vault/wiki/<domain>/entity/<repo>.md` to get `local_path` and `current_branch`. Then `cd` to that path and run:
   - `git log --since "<start>" --pretty=format:"%h %s" <current_branch>` — recent commits, one line each
   - `git status --porcelain` — to note any in-progress work

   Skip silently if the repo path is missing. The resulting commits get grouped by repo (one sub-section per repo if more than one).

6. **Find scheduler activity** — read `vault/raw/scheduled-runs.jsonl`, filter to entries with `project == <project-id>` AND `ts >= start`. Count successes/failures, list scheduler ids fired.

   **6a. Compute quantitative rollup** — read `references/rollup-query.md` for the field list and the `events.db` query, and compute every field it names. **Required section** — emit even when totals are zero (with a "no recorded runs in window" note), in every `report_type`.

7. **Milestone summary** — from the project entry's `milestones` array: count `done` vs `pending`, surface the next pending milestone with its date.
8. **Compose the markdown report.** Read `references/output-template.md` for the skeleton, the Changes-section rules, and the derivation maps; then read `references/type-variants.md` for the `inputs.report_type` adjustments and the `timeframe_start` / `timeframe_end` values. Compose from those two files — their section order, wording, and block formats are the contract the reporting UI parses.
9. **Write the file** to `vault/output/<domain>/status-reports/<project-id>-<report-type>-<YYYY-MM-DDTHHMMSS-TZ>.md` where the timestamp is the moment of generation in **local time** + a TZ suffix (e.g. `2026-06-01T214731-PDT`, `2026-12-15T093030-PST`). No separators inside the time component; TZ separated by single hyphen. `<report-type>` is the resolved input value — `kickoff`, `status`, or `wrap-up`. Get the TZ abbreviation via `date '+%Z'`. Create the directory if it doesn't exist. Each run produces a NEW file; multiple status reports per project per day are preserved as separate snapshots (the reporting UI sorts newest-first, so the most recent run is what the user sees by default).
10. **Update the project entry's frontmatter** via Edit tool:
    - `reporting.last_sent`: now (ISO 8601 UTC)
    - `reporting.next_due`: based on `reporting.cadence` — `daily` → tomorrow's date (YYYY-MM-DD); `weekly` → today + 7 days; `none` → leave unchanged or set null
    - `updated`: now (ISO)
11. **Audit log** — read `references/audit-log-args.md` and run the `record-dashboard-action.mjs` command it specifies, filling every arg from the report just written.
12. **Confirm to user** with the 5-line summary block in `references/output-template.md` § Confirmation summary.

## Outputs

- New markdown file at `vault/output/<domain>/status-reports/<project-id>-<report-type>-<YYYY-MM-DD>.md`. `<report-type>` is one of `kickoff`, `status`, `wrap-up`.
- Updated `reporting.last_sent` and `reporting.next_due` on the project entry
- Audit log line

## Errors

- Project not found → reject with the id and suggest verifying via `/os list projects` (or browsing Vault → wiki/<domain>/project/)
- Project status is `completed`/`cancelled` → warn but proceed (sometimes you want a final report)
- Any repo entity in `repos` is missing → continue with the rest; surface a one-line note in the report for each missing one
- Manifest missing or stale → continue with what's parseable; surface a note that backlinks may be incomplete and suggest running the rebuild hook
- A `references/` file is missing or unreadable → stop rather than improvise the skeleton from memory; the report's structure is a downstream contract

## Design notes

- The skill writes **markdown only** — no MCP, no webhooks. v1 ships clipboard-target reporting. Future: MCP integrations to Notion/Linear/Slack would consume the same generated file (or skip file write and post directly).
- The report is **synthesized**, not just a log dump. Use the LLM's understanding of the activity to write the TL;DR and Blockers/risks sections — these are the hand-curation parts that justify spending a `claude -p` invocation on this.
- History is the file series: every run adds a snapshot, nothing overwrites, so the stream of files is the project's narrative.

## See also

- [[standard-compact-skill]] — the SKILL.md + `references/` split this skill carries
- [[standard-project-workflow]] — the project workflow standard
- [[archetype-project]] — the project archetype + reporting field shape
- [[meta-add-project]] — scaffolds projects this skill operates on
- [[standard-log-formats]] — `scheduled-runs.jsonl` shape (includes project field for filtering)
