---
name: ops-health-review
description: Run a recurring health review against a review-protocol — KPI vs its contract, failures classified against the taxonomy, fixes verified, monitor readiness assessed, 24-72h forecast. Read-only; writes a dated verdict report.
user-invocable: true
recommended_effort: high
version: 1
domain: ops
tags: [ops, health-review, read-only]
inputs:
  protocol:
    type: string
    required: true
    description: 'Protocol entry id (the slug under vault/wiki/ops/review-protocol/).'
  window_days:
    type: number
    required: false
    description: Override the protocol's kpi.window_days for this run only. Recorded on the report; comparisons across differing windows are flagged, not silently made.
  notes:
    type: string
    required: false
    description: 'Free-form context for this run — an incident to look at, a suspicion to check. Folded into the report''s Observations.'
outputs:
  - kind: report
    path: '<protocol.reports_dir>/YYYY-MM-DD.md'
  - kind: frontmatter
    path: vault/wiki/ops/review-protocol/{{input.protocol}}.md
spawns: []
---

# ops-health-review

## Purpose

Execute one review-protocol end to end and land a dated report with a verdict of `healthy`, `watch`, or `action-needed`. The protocol supplies every judgment threshold; this skill supplies the procedure. Two runs against the same protocol and the same data must reach the same verdict — that reproducibility is the whole reason the contract is written down separately from the review.

**This skill is read-only against every system it touches. GET / SELECT / inspect only.** No writes, no state transitions, no configuration changes, no replays, retries, backfills, or cache invalidations. It never creates, edits, enables, disables, silences, or deletes a monitor — monitor readiness is assessed and _recommended_; publication is a human act. The only files it writes are its own report and the two stamp fields on the protocol entry.

## Inputs

`protocol` is the entry id. `window_days` overrides the protocol's window for this run only and is recorded on the report so a later comparison across mismatched windows is visible rather than assumed. `notes` carries free-form context into the report's Observations.

## Headless behavior

Scheduled, unattended runs are the normal case; every step below is designed to complete without a human. The one gate is step 9's same-day collision.

## Procedure

1. **Preflight.** Read `vault/wiki/ops/review-protocol/<protocol>.md`. Unreadable, missing, or wrong `type:` → stop with a clear error; there is no contract to execute. Parse `kpi`, `verify_tickets`, `monitors`, `reports_dir`, `scan_minutes` from frontmatter and the eight body sections. A `kpi` that parsed as empty when the raw line is non-empty means the field was reformatted into a block — report that specifically, because a line-oriented reader would have dropped it in silence.
2. **Reach the sources.** Try each source in `## Sources` read-only. **An unreachable source is a recorded gap, not a failure.** Record what could not be reached and what that source was authoritative for, then continue. Every downstream step that depended on it is marked degraded in the report; the verdict's confidence drops, the run does not abort. A review that says which eye was shut beats a review that never opened either.
3. **Deployed-code check.** For each `verify_tickets` entry, establish from read-only evidence whether the fix is actually live in the environment under review, using the protocol's Fix verification checks. A ticket that shipped but is not deployed makes every later "did it work" question meaningless — resolve deployment first and say so.
4. **Queue / metric snapshot.** Run the protocol's Metric queries over the window. Capture the supporting counts (depth, throughput, error volume, whatever the protocol names) alongside the KPI inputs. Note anything the protocol flagged as expensive and honour its Safety rails.
5. **Compute the KPI against its contract.** Apply `kpi.formula` exactly as written. Then grade:
   - past `guardrail` → `action-needed`, regardless of trend
   - meets `target` and not past `guardrail` → `healthy`
   - between `baseline` and `target`, or moving the wrong way against `baseline` → `watch`
   - `baseline` / `target` / `guardrail` null → report the value, verdict `watch`, and state plainly that there is no contract to grade against yet. Do not invent the missing numbers to produce a grade.
6. **Classify failures.** Run the protocol's Log queries and sort every failure into the taxonomy, honouring each class's stated cautions. **Never force a failure into the nearest class** — anything that does not match lands in `unclassified` with a verbatim excerpt (redacted per the Safety rails). A growing `unclassified` count is a finding about the taxonomy and belongs in the report as one. An empty log result where the protocol expects volume is a gap, not health.
7. **Verify fixes per ticket.** For each deployed ticket from step 3, look for the observable signal the protocol names. Report `confirmed`, `not-yet-observable` (with what would make it observable and when), or `contradicted` (with the evidence). A ticket with no observable signal defined is reported as unverifiable — do not substitute a proxy.
8. **Monitor readiness.** For each `monitors` entry, evaluate its `gate` against what this review measured and the reports before it. Emit `ready` (gate met — recommend a human publish it), `not-ready` (naming which part of the gate is unmet and what would close it), or `insufficient-history`. **Never publish, create, enable, or modify a monitor** — recommend only. A monitor published before its gate trains its audience to ignore it, and an ignored monitor is worse than none.
9. **Forecast 24–72h.** Project forward using the protocol's Forecast heuristics: what extrapolates, what does not, known cyclicality. State the horizon and the assumptions. Where the heuristics say to withhold, withhold — an explicit "not forecastable this run, because …" is a legitimate output.
10. **Write the report.** Read `references/report-template.md` from this skill's directory now and follow it exactly for frontmatter and section order. Filename `YYYY-MM-DD.md` under the protocol's `reports_dir`. If that filename already exists, AskUserQuestion whether to overwrite or write a same-day sibling. `Headless: default(sibling)` — write `YYYY-MM-DD-2.md` (then `-3`, …), never overwrite a prior report, and record the auto-decision in the run report. Prior reports are the time series; overwriting one destroys evidence.
11. **Stamp the protocol.** Edit only `last_reviewed` (this run's ISO timestamp), `last_verdict` (the verdict), and `updated`. Touch nothing else in the entry — the contract is not the review's to revise. When the review concluded the contract itself should change, that goes in the report's Recommendations for a human to act on.
12. **Record the audit event:**

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action health-review \
      --skill ops-health-review \
      --args '{"protocol":"<protocol>","verdict":"<verdict>","kpi_value":<value_or_null>,"gaps":<n>}' \
      --files-touched '["<reports_dir>/<file>","vault/wiki/ops/review-protocol/<protocol>.md"]'
    ```

13. **Report:**

    ```
    ✓ Health review — <protocol> → <verdict>
      kpi:       <name> = <value> (target <target>, guardrail <guardrail>)
      failures:  <n> classified, <n> unclassified
      tickets:   <n> confirmed, <n> pending, <n> contradicted
      monitors:  <n> ready to publish (recommendation only — nothing was published)
      gaps:      <n> unreachable source(s)
      report:    <reports_dir>/<file>
    ```

## Outputs

- Dated report in the protocol's `reports_dir`, with structured frontmatter carrying at minimum `verdict`, the KPI value, and the counts. Verdict and KPI are read from frontmatter by every consumer and never scraped from prose — a number pulled out of a sentence is a number nobody can be held to.
- `last_reviewed` / `last_verdict` / `updated` stamped on the protocol entry. Nothing else on it changes.
- One `health-review` audit event.

**Nothing else is written anywhere.** No monitored system is modified by this skill under any circumstance, including when a fix looks obvious and the remediation would be one call. Remediation is a separate change, dispatched by a human who read the report.

## Errors

- Protocol missing / unreadable / wrong type → stop with the path and the reason. Nothing partial is written
- `kpi` parsed empty from a non-empty line → report the block-form reformatting explicitly; it is the silent-drop failure mode the single-line contract exists to prevent
- Every source unreachable → still write the report, verdict `watch`, gaps enumerated, KPI null. A review that reached nothing must say so in the record rather than leave a blank week
- Queries exceed `scan_minutes` → stop querying, report what was covered and what was skipped, and flag the protocol as over-scoped. A truncated review that admits truncation is honest; one that hides it is not
- Report filename collision → `Headless: default(sibling)` per step 10; never overwrite
- Protocol edit fails after the report was written → report is still valid; surface the un-stamped protocol so a human can stamp it

## See also

- [[archetype-review-protocol]] — the contract this skill executes
- [[ops-add-protocol]] — scaffolds the protocol
- [[standard-skill-format]] — the skill contract, including the headless-gate policy vocabulary
