# Health-review report template

Read this file at step 10 of the procedure — the point where the report is written — not before. Everything above step 10 is measurement; this file is only about how the measurement gets recorded.

Follow the frontmatter contract exactly and keep the section order. Consumers read the verdict, the KPI, and the counts **from frontmatter only** — never from the prose. A number scraped out of a sentence is a number nobody can be held to.

## Frontmatter contract

Every key below is required. Every value sits on **one line** — the same parser contract the protocol's structured fields carry, for the same reason: line-oriented readers drop multi-line structures without erroring.

| key                      | type           | notes                                                                                                  |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| `protocol`               | string         | The protocol entry id this review executed                                                             |
| `reviewed_at`            | string         | ISO 8601 UTC timestamp of the run                                                                      |
| `verdict`                | enum           | `healthy` \| `watch` \| `action-needed` — the graded outcome, nothing else                             |
| `kpi_name`               | string         | Copied from the protocol's `kpi.name`, verbatim                                                        |
| `kpi_value`              | number \| null | The computed value. `null` when it could not be computed — say why in Gaps                             |
| `kpi_baseline`           | number \| null | Copied from the contract as it stood at review time                                                    |
| `kpi_target`             | number \| null | Copied from the contract as it stood at review time                                                    |
| `kpi_guardrail`          | number \| null | Copied from the contract as it stood at review time                                                    |
| `window_days`            | integer        | The window actually used. Differs from the protocol's when overridden for this run                     |
| `window_overridden`      | boolean        | `true` when the run overrode the protocol's window — makes cross-report comparison visibly conditional |
| `failures_total`         | integer        | Failures observed in the window                                                                        |
| `failures_unclassified`  | integer        | Of those, the ones that matched no class. A rising number is a finding about the taxonomy              |
| `tickets_confirmed`      | integer        | Fixes under verification with their signal observed                                                    |
| `tickets_pending`        | integer        | Deployed but not yet observable, plus not-yet-deployed                                                 |
| `tickets_contradicted`   | integer        | Fixes whose evidence points the other way                                                              |
| `monitors_ready`         | integer        | Candidates whose gate is met. A recommendation count — nothing was published                           |
| `gaps`                   | integer        | Sources that could not be reached                                                                      |
| `forecast_horizon_hours` | integer        | `24`, `48`, or `72`. Use `0` when the heuristics said to withhold                                      |

```yaml
---
protocol: review-protocol-ingest-pipeline
reviewed_at: 2026-08-27T09:14:02Z
verdict: watch
kpi_name: ingest success rate
kpi_value: 0.978
kpi_baseline: 0.982
kpi_target: 0.995
kpi_guardrail: 0.95
window_days: 7
window_overridden: false
failures_total: 412
failures_unclassified: 37
tickets_confirmed: 1
tickets_pending: 1
tickets_contradicted: 0
monitors_ready: 0
gaps: 1
forecast_horizon_hours: 48
---
```

## Section order

### `# <protocol title> — <YYYY-MM-DD>`

### `## Verdict`

One paragraph. State the verdict, the one fact that decided it, and — when the contract is still null — that there was nothing to grade against. No hedging adverbs: a `watch` that reads like a `healthy` wastes the grade.

### `## KPI`

The value, the contract it was graded against, and the direction of travel against the previous report. When any of baseline / target / guardrail is null, say `unset — measure first` rather than omitting the row.

### `## Failures`

A table of class → count → share, `unclassified` last and never hidden. Below it, one line per class that moved materially since the previous review. For `unclassified`, include a redacted excerpt per distinct shape — that excerpt is what a future taxonomy revision will be built from.

### `## Fix verification`

One subsection per ticket under verification: deployed yes/no with the evidence, then `confirmed` / `not-yet-observable` / `contradicted` with what was looked for. `not-yet-observable` must name what would make it observable and roughly when.

### `## Monitor readiness`

One line per candidate: `ready` / `not-ready` / `insufficient-history`, quoting the gate verbatim and stating exactly which part of it is met or unmet. `ready` is a recommendation addressed to the owner. **State in the section that nothing was published** — the reader must never have to infer that from silence.

### `## Forecast`

The 24–72h projection, its horizon, and its assumptions. When the heuristics said to withhold, write the withholding and why. A forecast with no stated assumptions is not a forecast.

### `## Gaps`

Every source that could not be reached, what it was authoritative for, and which findings above are consequently degraded. An empty section is written as `None — every source in the protocol was reachable.` so the reader can tell "no gaps" apart from "gaps not checked".

### `## Observations`

Anything true and worth keeping that no section above owns, plus the run's `notes` input folded in. Also the home for auto-decisions the run made (a same-day sibling filename, a truncated query set) — a headless decision is never silent.

### `## Recommendations`

Numbered, each addressed to a person or team, each stating the evidence above that motivates it. Recommendations to change the protocol itself belong here — the review does not edit the contract it was graded by.

## Rules the template does not negotiate

- **Never write a number that was not measured.** `null` and "unset — measure first" are complete answers.
- **Never publish, enable, silence, or edit a monitor.** The Monitor readiness section recommends; a human acts.
- **Never include PII.** Aggregate counts, rates, already-opaque identifiers, and redacted excerpts only. When a redaction removes the thing that made the excerpt useful, drop the excerpt and describe the shape instead.
- **Never overwrite a prior report.** Same-day re-runs get a `-2`, `-3` sibling. The prior reports are the time series.
- **Never soften a gap into a finding.** "Could not reach X" and "X looks fine" are different sentences and only one of them is true.
