---
domain: ops
version: 1
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
---

# Ops — recurring operational health reviews

## Purpose

Ops turns "check whether the running system is still healthy" into a governed OS object. Each reviewed system gets one `review-protocol` entry that states — once, in writing — what to look at, what "healthy" means numerically, how failures are classified, and what must be true before a new alert is allowed to exist. A health review then executes that contract and lands a dated report with a verdict.

The domain exists because operational review is the workload most prone to silent drift: run by hand, it re-decides the thresholds every time, forgets last week's failure classes, and quietly re-scopes what counts as a problem. Writing the contract down first makes each review comparable to the previous one, schedulable without a human, and auditable after the fact.

Ops **observes**. It never operates.

## Safety defaults (load-bearing)

These are contracts, not preferences. Every skill, route, and app surface in this domain inherits them.

- **Read-only against every monitored system.** GET / SELECT / inspect only. No writes, no state transitions, no configuration changes, no replays, no retries, no backfills, no cache invalidations.
- **No monitor mutation.** A review may report that a monitor is _ready to be published_ against its declared gate; it may never create, edit, enable, disable, silence, or delete one. Publication is a human act, always.
- **No PII in reports.** Identifiers, payload bodies, user-supplied strings, and contact details never reach a report. Aggregate counts, rates, ids that are already opaque, and redacted excerpts only.
- **Unreachable is a gap, not a failure.** A source the review could not reach is recorded as a named gap in the report and factored into the verdict's confidence. A partial review that says so is worth more than a run that aborts.
- **Nulls stay null.** An unmeasured baseline or target is written as `null` with a "measure first" note. A plausible-looking invented number is worse than an admitted absence, because it silently becomes the thing later reviews compare against.

## Entities

- `review-protocol` — one per reviewed system: sources, queries, KPI contract, failure taxonomy, verification checks, monitor gates, forecast heuristics, safety rails
- `note` — observations that surface between reviews and belong on the next one
- `entity` — the systems under review (kind: `system`), their owners (kind: `person`)
- `decision` — threshold changes, taxonomy revisions, and other protocol edits worth their rationale

## Skills

- `ops-add-protocol` — scaffold a `review-protocol` entry from structured inputs (sources, queries, tickets, KPI definition). Leaves unmeasured `baseline` / `target` as `null` with a measure-first note rather than inventing numbers. Backs the dashboard's New-protocol screen.
- `ops-health-review` — execute a protocol end to end: preflight → deployed-code check → queue/metric snapshot → KPI against its contract → log classification against the taxonomy → per-ticket fix verification → monitor readiness against published gates → 24–72h forecast. Writes a dated report and stamps `last_reviewed` / `last_verdict` on the protocol. Read-only throughout; recommends monitors, never publishes them.

Additional ops skills can be added via `meta-add-skill --domain ops` as the surface grows.

## Apps

- `ops` — dashboard module at `/ops`. Grouped collapsible table (one group per protocol, rows are its reports with verdict + KPI badges), a dedicated New-protocol screen at `/ops/new`, and a per-protocol Run-review dispatch. Read-only over `/api/ops`; runs go through the shared runs API.

## Sub-domains

(none yet)

## Conventions

- Wiki entries: `vault/wiki/ops/<archetype>/<slug>.md` — protocols land at `vault/wiki/ops/review-protocol/<slug>.md`
- Outputs: `vault/output/ops/<kind>/<slug>.md`; reports land under the protocol's own `reports_dir`, one dated file per review
- Report filenames are date-led (`YYYY-MM-DD.md`, or `YYYY-MM-DD-<n>.md` for a second review the same day) so newest-first ordering is a filename sort
- Skill prefix: `ops-*`
- Structured protocol frontmatter (`kpi`, `verify_tickets`, `monitors`) is written as **single-line JSON**. This is a parser contract: the flat frontmatter readers that back the audit, the index rebuild, and the ops routes drop multi-line YAML structures silently, so a multi-line block does not fail loudly — it disappears.
- One protocol per reviewed system. Two systems that share a dashboard still get two protocols; a shared KPI that means different things in each is the failure this rule prevents.

## Cross-domain links

- A review that concludes code must change belongs in `development/` — write the finding into the report, then scaffold a `change` and link the report from it
- Protocol edits that move a threshold, retire a failure class, or loosen a monitor gate deserve a `decision` entry here; the protocol body links to it so the next review can see why the contract reads the way it does
- Sustained investigation of a systemic failure class graduates to `research/` — the report is evidence, not the analysis

## How a protocol earns its thresholds

A protocol is allowed to start honest and incomplete:

1. **Scaffold** with sources, queries, and a KPI _formula_ — `baseline` and `target` null, `guardrail` null.
2. **Review once** to establish the measurement. The first report's KPI value is the observation, and its verdict is necessarily `watch` — there is nothing to compare against yet.
3. **Set the contract** by hand once two or three reviews agree on what normal looks like. Record the reasoning in a `decision` entry.
4. **Reviews become gradeable** from that point: `healthy` / `watch` / `action-needed` now mean something specific, and the verdict history is a real time series.

Skipping to step 3 by guessing the numbers is the anti-pattern the null-baseline rule exists to block.
