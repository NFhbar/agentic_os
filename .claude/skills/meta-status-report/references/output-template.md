# Output template — `meta-status-report`

Read this at procedure step 8, immediately before composing the body.
It carries the `status` skeleton (the default shape) plus the derivation maps
the Changes section depends on. Per-type deviations live in
[type-variants.md](type-variants.md) — read that one too before writing.

## Skeleton

```markdown
---
report_type: <kickoff|status|wrap-up>
timeframe_start: <start date as ISO 8601, e.g. 2026-05-23T00:00:00Z>
timeframe_end: <today as ISO 8601, e.g. 2026-05-30T00:00:00Z>
---

# Status report — <title>

**Period:** <local-formatted start> → <local-formatted end> (e.g. `Jun 1, 2026 9:46 PM PDT → Jun 1, 2026 9:55 PM PDT`)
**Status:** <status> · **Lifecycle:** <lifecycle_stage>
**Deadline:** <deadline> (<relative — "in 3 weeks" or "overdue by 2 days">)
**Repos:** <comma-list of repo ids, or "(none)">

## TL;DR

<1-2 sentence headline. Synthesize: what moved, what's blocking, what's next>

## Progress

### Changes

<aggregate one-liner, then one block per tracked change — see "Changes section" below>

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

## Changes section

Continuous lifecycle tracking. Show EVERY non-terminal change (status NOT in
`{merged, abandoned}`) AND any change whose `merged_at` or `abandoned_at` falls within
this window. Once a change appears in any report, it keeps reappearing until it
terminates — the reader can follow each unit of work from scaffold to merge across the
report stream.

Aggregate one-liner first:

- <N> owned change(s) total: <planning> planning · <in_progress> in-progress · <in_review> in-review · <merged> merged · <abandoned> abandoned

Then one block per tracked change, ordered by `created` ascending (matches the
orchestrator's dispatch order — readers see the lifecycle of change 1, 2, 3 …):

```
- **[[<change-id>]]** — <title>
  Status: <status> · Step: <current step>
  Since last report: <bulleted list of transitions in this window>
  PR: <pr_url or "(no PR yet)">
```

Omit the "### Changes" section entirely only when zero changes have ever been scaffolded.

### Current step — derivation map

Derived from the change's frontmatter, not stored explicitly. Map (most-progressed wins):

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

### Since last report — transition map

List any frontmatter timestamp that falls within the window
(`timeframe_start` ≤ ts ≤ `timeframe_end`). Each becomes a one-line transition:

- `plan_generated_at` in window → "Plan written <relative>"
- `reviewed_at` in window → "Plan reviewed: <review_status> <relative>"
- `plan_revised_at` in window → "Plan revised to revision <plan_revision> <relative>"
- `pr_reviewed_at` in window → "PR reviewed (pass <pr_review_passes>) <relative>"
- `pr_ready_at` in window → "Marked ready for human <relative>"
- `merged_at` in window → "**Merged** <relative>"
- `abandoned_at` in window → "**Abandoned** — <abandoned_reason> <relative>"

If no transitions fell in this window for a non-terminal change, write
`Since last report: (no change)`.

## Confirmation summary

Procedure step 12 prints this 5-line summary to the user:

```
✓ <Report-type capitalized> report generated for <title>
  type:     <kickoff|status|wrap-up>
  period:   <start> → <today>
  file:     vault/output/<domain>/status-reports/<id>-<type>-<date>.md
  summary:  <N commits, M decisions, K scheduler runs>
  next:     reporting.next_due = <date>
```

## Timestamp formatting in BODY content

Every timestamp that appears in the markdown body (the `**Period:**` line, commit times,
scheduler runs, "generated X ago," etc.) must be formatted in the **user's local
timezone** with a TZ abbreviation — the file is copied verbatim to Slack / Notion /
Linear and the recipients expect local time, not UTC. Pattern:

- Frontmatter (`timeframe_start`, `timeframe_end`, `created`, `updated`,
  `reporting.last_sent`, `reporting.next_due`): stay ISO 8601 UTC. Those are data fields
  parsed by downstream tools.
- Body text: convert each ISO timestamp to local-readable form via
  `date -j -f '%Y-%m-%dT%H:%M:%SZ' '<iso>' '+%b %-d, %Y %-I:%M %p %Z'` (macOS) → produces
  `Jun 1, 2026 9:46 PM PDT`. The Period line specifically should read
  `**Period:** Jun 1, 2026 9:46 PM PDT → Jun 1, 2026 9:55 PM PDT` (or a shorter form like
  `2026-06-01 9:46 PM PDT` if that fits the surrounding layout better).
