# Type variants — `meta-status-report`

Read this at procedure step 8, alongside [output-template.md](output-template.md).
The skeleton in that file is the `status` shape (the default). This file says how
`kickoff` and `wrap-up` bend it, and how the timeframe frontmatter is computed for
each of the three.

## Composition per `inputs.report_type`

- **`kickoff`** — drop the "Code activity / Commits / Owned decisions" sections (project
  hasn't produced work yet). Add:
  - `## Intent` — one paragraph from the project body's `## Why` or `## Approach` if present.
  - `## Plan` — the project's stated approach + initial scope.
  - `## Milestones` — same as default, but lean forward (every milestone is pending).
  - `## Stakeholders` — list from frontmatter if present.
  - Drop `## Blockers / risks` (premature). Replace `## Next` with `## First steps`
    (concrete actions for week 1).
- **`status`** — the default skeleton. No changes.
- **`wrap-up`** — drop forward-looking sections (`Next`, `Milestones` only as
  retrospective). Add:
  - `## Outcome` — what the project actually delivered. List merged changes with PR URLs.
    Note abandoned changes with reasons.
  - `## Total cost` — pull from `events.db` directly: total billable cost + wall-time
    across every event tagged to this project or its owned changes. Same query as the
    quantitative rollup in procedure step 6a; emit even if zero.
  - `## What worked` and `## What didn't` — short bulleted retrospective. Lift from
    project body's `## Notes` if substantive, else mark `(none captured)`.
  - `## Follow-ups` — open nits, deferred comments, and any backlog the project surfaced.
  - Drop `## Blockers / risks` (terminal — nothing to block).

The required `## Quantitative rollup` section (procedure step 6a) renders in every type.

## Timeframe per `report_type`

The `timeframe_start` / `timeframe_end` frontmatter fields tell the dashboard's Reports
tab what date-range each file actually summarizes (drives the "Covers Apr 1 – Apr 7"
badge). Compute per variant:

- **`kickoff`** — `timeframe_start` = project's `created` field; `timeframe_end` = now.
  The whole project history is in scope (which is short for kickoff).
- **`status`** — `timeframe_start` = `reporting.last_sent` if set, else project's
  `created`; `timeframe_end` = now. Default "since last sent" semantics.
- **`wrap-up`** — `timeframe_start` = project's `created`; `timeframe_end` = now.
  Whole-project retrospective.

If `reporting.last_sent` is null on a `status` run, fall back to `created`. All values
written as ISO 8601 UTC.
