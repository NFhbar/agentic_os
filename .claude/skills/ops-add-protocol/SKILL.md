---
name: ops-add-protocol
description: Scaffold a review-protocol entry — the written contract for a recurring health review of one system (sources, queries, KPI, failure taxonomy, monitor gates). Unmeasured baselines stay null.
user-invocable: true
recommended_effort: medium
version: 1
domain: ops
tags: [scaffold, ops, health-review]
inputs:
  slug:
    type: string
    required: true
    pattern: '^[a-z][a-z0-9-]*$'
    description: 'Entry id / filename (lowercase kebab-case). Convention: review-protocol-<system>.'
  title:
    type: string
    required: true
    description: 'Human-readable name of the review, e.g. ''Ingest pipeline health''.'
  target:
    type: string
    required: true
    description: 'The system under review. An entity id when one exists, otherwise a stable plain-text name.'
  owner:
    type: string
    required: true
    description: 'Who answers for this system — an entity id or a team name. The addressee of every action-needed verdict.'
  scan_minutes:
    type: number
    required: false
    default: 20
    description: Minute budget for one review. A protocol whose queries cannot finish inside it is over-scoped.
  kpi_name:
    type: string
    required: true
    description: 'Short label for the health number, cited verbatim by every report.'
  kpi_formula:
    type: string
    required: true
    description: 'Free-form. How the number is computed, precisely enough that two reviews produce the same value from the same data.'
  kpi_window_days:
    type: number
    required: false
    default: 7
    description: Measurement window in days. Changing it later invalidates comparison against earlier reports.
  sources:
    type: array
    required: true
    description: 'One per line. Where the review looks and what each source is authoritative for. Flag any that need credentials.'
  metric_queries:
    type: array
    required: false
    description: 'One per line. Named read-only queries behind the KPI and its supporting counts.'
  log_queries:
    type: array
    required: false
    description: 'One per line. Named read-only searches that surface failures for classification.'
  failure_classes:
    type: array
    required: false
    description: 'One per line. Known failure classes to seed the taxonomy with. An unclassified bucket is always added.'
  verify_tickets:
    type: array
    required: false
    description: 'One per line. Identifiers of shipped fixes still under verification.'
  monitors:
    type: array
    required: false
    description: 'One per line, as ''<id> | <what it would watch> | <gate that must hold before publication>''.'
outputs:
  - kind: wiki-entry
    path: vault/wiki/ops/review-protocol/{{input.slug}}.md
  - kind: folder
    path: vault/output/ops/health-reviews/{{input.slug}}/
spawns: []
---

# ops-add-protocol

## Purpose

Scaffold a `review-protocol` entry — the written contract [[ops-health-review]] executes on every run. One entry per reviewed system: sources, queries, the KPI definition, the failure taxonomy, the fixes under verification, and the gate each candidate monitor must clear before a human is asked to publish it.

**Vault-only and read-only.** This skill writes one markdown file and creates one output directory. It does not contact the system under review, run its queries, or measure anything — it records what a future review will read. Nothing in this domain mutates a monitored system.

**Honest nulls.** `baseline`, `target`, and `guardrail` are written as `null` unless the user supplied a measured value with its measurement. Never derive them from the formula, never infer them from what "usually" looks healthy, never round a guess into place. An invented number looks authoritative, silently becomes the thing later reviews compare against, and leaves nothing in the record marking it as a guess.

## Inputs

`slug`, `title`, `target`, `owner`, and `kpi_name` / `kpi_formula` are required — a protocol without them cannot be executed. Everything else is optional and lands as seeded body content or an empty structured field; sections with nothing to seed keep their TODO prompt so the gap is visible rather than absent.

List-shaped inputs (`sources`, `metric_queries`, `log_queries`, `failure_classes`, `verify_tickets`, `monitors`) arrive as free text, one item per line. `monitors` lines use `<id> | <name> | <gate>`; a line missing its gate is a validation error, not a monitor with an empty gate.

## Procedure

1. Validate `slug` against `^[a-z][a-z0-9-]*$`. Reject if invalid.
2. Verify `vault/wiki/ops/review-protocol/<slug>.md` does not exist. If it does, AskUserQuestion whether to overwrite. `Headless: refuse` — print `⊘ Protocol <slug> already exists — not overwriting in a headless run` and stop with no side effects. Overwriting a protocol silently rewrites the contract every prior report was graded against.
3. Read `_templates/wiki-entry/review-protocol.md.tmpl`.
4. Substitute the frontmatter placeholders:
   - `{{slug}}` → `inputs.slug`
   - `{{domain}}` → `ops`
   - `{{datetime}}` → current ISO 8601 UTC timestamp (both `created` and `updated`)
   - `{{source}}` → `ops-add-protocol`
   - `{{title}}` / `{{target}}` / `{{owner}}` / `{{scan_minutes}}` → the matching inputs (`scan_minutes` defaults to 20)
   - `{{kpi_name}}` / `{{kpi_formula}}` → the matching inputs; `{{kpi_window_days}}` defaults to 7
5. Build the structured frontmatter fields. **Each must occupy exactly one line** — this is a parser contract, not formatting: line-oriented frontmatter readers drop multi-line structures silently, so a block-form field does not fail, it vanishes.
   - `kpi` — `{"name": …, "formula": …, "baseline": null, "target": null, "window_days": <n>, "guardrail": null}`. `baseline` / `target` / `guardrail` stay `null` (see step 6 for the exception).
   - `verify_tickets` — JSON array of the ticket identifiers, or `[]`.
   - `monitors` — JSON array of `{"id": …, "name": …, "gate": …}`, or `[]`. Parse each input line on `|`; a line with fewer than three parts is a validation error naming the offending line.
   - `reports_dir` — `vault/output/ops/health-reviews/<slug>`.
   - `last_reviewed` / `last_verdict` — `null`. This protocol has never been reviewed.
6. **Measured values only.** If — and only if — the user supplied a baseline, target, or guardrail together with how it was measured, write that number instead of `null` and record the measurement in the body's Metric queries section. Otherwise leave `null` and add this line under `## Metric queries`:
   `> Baseline / target / guardrail are unset — measure first. Run two or three reviews, then set them by hand and record the reasoning in a decision entry.`
   Do not soften this into a suggestion, and do not fill the field to make the entry look complete.
7. Seed the body sections from the optional inputs, one bullet per input line: `sources` → `## Sources`, `metric_queries` → `## Metric queries`, `log_queries` → `## Log queries`, `failure_classes` → `## Failure-class taxonomy`, `verify_tickets` → `## Fix verification checks` (one subsection per ticket, each with an explicit "how to tell it is deployed" and "what signal proves it worked" prompt), `monitors` → `## Monitor publication gates` (one subsection per monitor, quoting its gate verbatim).
   Always append an `unclassified` class to the taxonomy with the note that a class which does not exist yet must surface as unclassified rather than be forced into the nearest match. Leave every unseeded section's TODO prompt in place.
8. Write the rendered content to `vault/wiki/ops/review-protocol/<slug>.md`.
9. Create the reports directory: `mkdir -p vault/output/ops/health-reviews/<slug>`.
10. Record the audit event via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action add-protocol \
      --skill ops-add-protocol \
      --args '{"slug":"<slug>","target":"<target>","kpi_measured":<true_or_false>}' \
      --files-touched '["vault/wiki/ops/review-protocol/<slug>.md"]'
    ```

11. Print the report:

    ```
    ✓ Scaffolded review protocol `<slug>`
      entry:    vault/wiki/ops/review-protocol/<slug>.md
      reports:  vault/output/ops/health-reviews/<slug>/
      kpi:      <kpi_name> — baseline/target/guardrail unset (measure first)
      next:     fill the TODO sections, then run `/ops-health-review <slug>` to take the first measurement
    ```

    When baselines were supplied and measured, say so on the `kpi:` line instead — never report a contract as set when it is null.

## Outputs

- New `vault/wiki/ops/review-protocol/<slug>.md` with single-line-JSON `kpi` / `verify_tickets` / `monitors`
- New empty `vault/output/ops/health-reviews/<slug>/` for the reports the reviews will write
- One `add-protocol` audit event

## Errors

- Invalid `slug` → reject with the pattern and a corrected suggestion
- Protocol already exists → ask before overwriting. `Headless: refuse` — never overwrite a protocol in a headless run (`⊘ Protocol <slug> already exists`), stop with no side effects
- A `monitors` line with no gate → reject naming the line. A monitor without a publication gate is the thing the field exists to prevent
- Missing template → the OS templates are broken; report and stop rather than hand-rolling the entry
- User supplies a baseline with no measurement behind it → write `null` and say so in the report. This is not a failure; it is the contract

## See also

- [[archetype-review-protocol]] — the frontmatter contract this skill produces
- [[ops-health-review]] — the consumer; executes the protocol and stamps its verdict back
- [[archetype-decision]] — where the reasoning for setting a baseline or target belongs
