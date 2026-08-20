---
id: archetype-review-protocol
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [archetype, memory, ops, health-review]
source: seed
private: false
title: Review protocol archetype
url: internal://archetype/review-protocol
kind: doc
last_verified: 2026-08-20
---

# Review protocol archetype

## What it is

A **review-protocol** entry is the written contract for one recurring health review of one system. It answers, before any review runs, the questions a reviewer would otherwise re-answer (differently) every time:

- Which sources are authoritative, and how are they read?
- What single number defines health, computed how, against which baseline, target, and guardrail?
- Which failure classes exist, and how are they told apart?
- Which shipped fixes are still under verification, and what evidence would prove each one worked?
- Which monitors are candidates, and what must be true before a human is asked to publish one?

Scaffolded by [[ops-add-protocol]]; executed by [[ops-health-review]], which writes a dated report into the protocol's `reports_dir` and stamps `last_reviewed` / `last_verdict` back onto the entry.

The protocol is the stable object; the reports are the time series it produces. That split is the point — when the contract changes, the change is visible as an edit to one file, and every prior report remains interpretable against the contract that produced it.

## Required frontmatter (in addition to shared)

| field            | type    | notes                                                                                                                                                                        |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`          | string  | Human-readable name of the review, e.g. `"Ingest pipeline health"`                                                                                                           |
| `target`         | string  | The system under review. An `entity` id when one exists (`kind: system`), otherwise a stable plain-text name                                                                 |
| `owner`          | string  | Who answers for this system. An `entity` id (`kind: person`) or a team name. The addressee of every `action-needed` verdict                                                  |
| `scan_minutes`   | integer | Budget for one review, in minutes. A protocol whose queries cannot finish inside it is over-scoped — split it rather than letting reviews silently truncate                  |
| `kpi`            | object  | **Single-line JSON.** `{name, formula, baseline, target, window_days, guardrail}` — the health contract. See below                                                           |
| `verify_tickets` | array   | **Single-line JSON array.** Identifiers of shipped fixes still under verification. Each gets a per-ticket check in the report until it graduates out                         |
| `monitors`       | array   | **Single-line JSON array** of `{id, name, gate}`. `gate` states what must be true before that monitor may be published. Reviews evaluate gates and recommend — never publish |
| `reports_dir`    | string  | Repo-relative directory the dated reports land in, e.g. `vault/output/ops/health-reviews/<slug>`                                                                             |
| `last_reviewed`  | string  | ISO timestamp of the most recent completed review. `null` before the first one                                                                                               |
| `last_verdict`   | enum    | `healthy` \| `watch` \| `action-needed` — the most recent review's verdict. `null` before the first one                                                                      |

### The `kpi` contract

| key           | type           | notes                                                                                                                  |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`        | string         | Short label the reports cite verbatim                                                                                  |
| `formula`     | string         | How the number is computed, stated precisely enough that two reviews produce the same value from the same data         |
| `baseline`    | number \| null | What normal measured as. `null` until measured                                                                         |
| `target`      | number \| null | What good looks like. `null` until agreed                                                                              |
| `window_days` | integer        | Measurement window. Changing it invalidates comparison against earlier reports — treat as a contract edit, not a tweak |
| `guardrail`   | number \| null | The value past which the verdict is `action-needed` regardless of trend. `null` until agreed                           |

**Honest nulls.** `baseline`, `target`, and `guardrail` stay `null` with a measure-first note until real observations exist. An invented number is worse than an absent one: it looks authoritative, silently becomes the thing later reviews compare against, and nothing in the record marks it as a guess. A review against a null contract is still useful — it reports the value and returns `watch`, because there is nothing to grade against yet.

### `monitors[]` shape

| key    | type   | notes                                                                                                                                        |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`   | string | Stable identifier the reports and the eventual published monitor share                                                                       |
| `name` | string | What it would watch, in one line                                                                                                             |
| `gate` | string | The condition that must hold before publication is even proposed — typically a false-positive bound observed over a stated number of reviews |

The gate exists because a monitor published early trains its audience to ignore it, and an ignored monitor is worse than no monitor. Writing the gate down at proposal time is what stops "it seems fine now" from being the deciding argument later.

## Single-line JSON is a parser contract

`kpi`, `verify_tickets`, and `monitors` MUST each occupy a single line, however long that line becomes.

This is not formatting preference. Line-oriented frontmatter readers — the ones that walk `key: value` pairs rather than running a YAML parse — **drop multi-line structures silently**. They do not error, do not warn, and do not leave a trace. A protocol whose `kpi` was reformatted into a nested block does not fail loudly; it simply starts reporting as though it had no KPI at all, and the reports keep rendering with an empty badge. The failure is invisible exactly where invisibility is most expensive.

The single-line form is also what keeps these fields legible to a skill reading the entry as raw text rather than as parsed frontmatter — the value sits on one line next to its key, which is the only shape a text reader can reliably associate.

```yaml
# good — one line, parses everywhere
kpi: {"name": "ingest success rate", "formula": "succeeded / (succeeded + failed) over window", "baseline": null, "target": null, "window_days": 7, "guardrail": null}

# bad — vanishes from line-oriented readers with no error
kpi:
  name: ingest success rate
  formula: succeeded / (succeeded + failed) over window
```

Same rule for `verify_tickets: []` and `monitors: []` — empty arrays stay `[]` on the key's own line.

## Body sections

The body is the operative part: a review reads it and executes it. Sections are fixed so a reviewer knows where to look, and so a protocol edit is a diff in one known place.

| section                       | what it holds                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sources**                   | Every place the review looks, how to reach it read-only, and what it is authoritative for. Sources needing credentials are flagged so a miss reads as a gap |
| **Metric queries**            | Named read-only queries behind the KPI and its supporting counts, with their windows                                                                        |
| **Log queries**               | Named read-only searches that surface failures for classification, with expected volume so an empty result reads as suspicious rather than as health        |
| **Failure-class taxonomy**    | The closed set of classes, what distinguishes neighbours, and cautions from past misclassifications. An `unclassified` bucket is mandatory                  |
| **Fix verification checks**   | Per `verify_tickets` entry: what shipped, how to confirm it is deployed, and what observable signal proves it worked                                        |
| **Monitor publication gates** | Per `monitors` entry: what it would watch and the condition that must hold before publication is proposed                                                   |
| **Forecast heuristics**       | What extrapolates over 24–72h and what does not; known cyclicality; when to withhold a forecast instead of guessing                                         |
| **Safety rails**              | Protocol-specific limits on top of the domain read-only default: expensive queries, fields to redact, things a review must refuse outright                  |

## Lifecycle

| stage      | what it means                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| scaffolded | Entry exists; sources and queries drafted; `kpi.baseline` / `target` / `guardrail` null; `last_reviewed` null                      |
| measuring  | One or more reviews have run and recorded KPI values. Verdicts are necessarily `watch` — there is no contract to grade against yet |
| contracted | Baseline, target, and guardrail set by hand from the observed values, with the reasoning captured in a `decision` entry            |
| graded     | Reviews now return meaningful `healthy` / `watch` / `action-needed`, and the verdict history is a real time series                 |

Promotion from measuring to contracted is deliberately manual. It is the one step where a human decides what "good" means, and the record should show that a person decided it.

## When to use

- A system gets checked on a recurring cadence and the check keeps being re-derived from memory
- Multiple people (or multiple runs) should reach the same verdict from the same data
- Fixes ship and someone needs to confirm, later and from evidence, that they actually worked
- Alert candidates keep being proposed and the decision to publish keeps being made informally

## When NOT to use

- **A one-off investigation** — that is a `note`, or research if it runs long. A protocol implies recurrence
- **A repeatable procedure with no verdict** — that is [[archetype-runbook]]. Protocols exist to grade a system; runbooks exist to perform a task
- **A system you intend to change during the review** — the read-only contract is absolute here. Remediation is a `change`, dispatched separately, after the report says why
- **Two systems that merely share a dashboard** — one protocol per system; a KPI that means different things in each is the failure the rule prevents

## Outputs / artifacts produced

| artifact     | location                                         | when                                                            |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------- |
| Protocol     | `vault/wiki/ops/review-protocol/<slug>.md`       | Created once by [[ops-add-protocol]]; edited deliberately after |
| Dated report | `<reports_dir>/YYYY-MM-DD.md`                    | One per review run by [[ops-health-review]]                     |
| Stamp        | `last_reviewed` / `last_verdict` on the protocol | Written at the end of every successful review                   |

Report frontmatter carries at minimum `verdict`, the KPI value, and the counts — parsed structurally by the dashboard. Verdict and KPI are read from frontmatter and never from the prose body: a number scraped out of a sentence is a number nobody can be held to.

## Example

```markdown
---
id: review-protocol-ingest-pipeline
type: review-protocol
domain: ops
created: 2026-08-20T09:00:00Z
updated: 2026-08-27T09:14:02Z
tags: [ops, health-review]
source: ops-add-protocol
private: false
title: 'Ingest pipeline health'
target: system-ingest-pipeline
owner: platform-team
scan_minutes: 20
kpi: {"name": "ingest success rate", "formula": "succeeded / (succeeded + failed) over window", "baseline": 0.982, "target": 0.995, "window_days": 7, "guardrail": 0.95}
verify_tickets: ["ING-418", "ING-431"]
monitors: [{"id": "ingest-retry-storm", "name": "Retry rate above 3x baseline for 15m", "gate": "zero false positives across three consecutive weekly reviews"}]
reports_dir: vault/output/ops/health-reviews/ingest-pipeline
last_reviewed: 2026-08-27T09:14:02Z
last_verdict: watch
---

# Ingest pipeline health

## Sources
- Metrics dashboard — authoritative for throughput + success rate. Read-only view; no credentials needed.
- Structured logs — authoritative for failure classification. Retention 14 days, so windows past 14d are a recorded gap.
- Deploy history — authoritative for whether a fix under verification is actually live.

## Metric queries
- `success-rate` — succeeded / (succeeded + failed), 7d window.
- `queue-depth` — max and p95 depth per hour, 24h window.

...
```

## Related

- [[ops-add-protocol]] — scaffolds this archetype from structured inputs
- [[ops-health-review]] — executes the protocol and produces the dated reports
- [[archetype-runbook]] — the neighbour: repeatable procedure without a verdict
- [[archetype-decision]] — where threshold and taxonomy changes get their rationale
- [[archetype-note]] — where between-review observations live until the next review folds them in
