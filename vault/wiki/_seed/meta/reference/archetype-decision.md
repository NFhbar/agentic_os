---
id: archetype-decision
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [archetype, memory]
source: manual
private: false
title: Decision archetype
url: internal://archetype/decision
kind: doc
last_verified: 2026-05-19
---

# Decision archetype

## What it is

A captured choice with context, alternatives considered, and rationale. The point of writing it down is for future-you to understand _why_ a current shape exists — and to avoid relitigating already-settled questions.

## Required frontmatter (in addition to shared)

| field          | type   | notes                                                          |
| -------------- | ------ | -------------------------------------------------------------- |
| `title`        | string | imperative or declarative; e.g. "Use Fastify for app backends" |
| `status`       | enum   | `proposed`, `accepted`, `deprecated`, or `superseded`          |
| `alternatives` | array  | list of options that were rejected (free-form strings)         |
| `supersedes`   | string | optional; ID of an older decision this replaces                |

## Optional frontmatter

| field                           | type   | notes                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implements_tuning_suggestions` | array  | optional; list of `{audit_id, suggestion_index}` pairs naming lifecycle-audit `tuning_suggestions[]` entries this decision authorizes acting on. Used by [[meta-apply-tuning-suggestion]] as the gate for `apply` mode — skill changes are not auto-applied from suggestion text alone, they require a decision entry citing the suggestion explicitly. See Phase 4 of the Overseer arc.    |
| `target_metric`                 | object | optional; declares what observable signal this decision expects to move once applied. Filled in at acceptance time. The mechanism that closes the Overseer loop: after a skill change ships, qualifying audits measure whether the named metric tracked toward `target`. See "Validation" below for shape + lifecycle.                                                                      |
| `validation_result`             | enum   | optional; `pending` (default after acceptance — not enough qualifying audits yet), `validated` (post-acceptance audits confirm the metric moved as expected), `regressed` (no movement or wrong direction), `inconclusive` (signal ambiguous, manual judgment). Orthogonal to `status` — `status: accepted, validation_result: regressed` means "still in code, but evidence says revisit." |
| `validation_observations`       | array  | optional; running log of qualifying post-acceptance audits and their observed metric values, appended as audits accumulate. Each entry: `{audit_id, observed_at, qualifies, metric_value, notes}`. Append-only audit trail behind the `validation_result` verdict.                                                                                                                          |

## Validation

A decision that implements a tuning suggestion is a **hypothesis**: "if we ship this skill change, the named metric will move in the named direction." Validation is the post-acceptance measurement that confirms or refutes the hypothesis.

### Target metric shapes

`target_metric` is one structured object declaring what to measure. Three supported types in v1:

```yaml
# Type 1 — tag frequency decrease
target_metric:
  type: tag_frequency_decrease
  name: fix-introduces-defect-at-boundary    # an audit_tags value
  baseline: 3                                # observed rate in pre-acceptance audits
  target: 0                                  # zero recurrences expected
  scope: changes-with-address-comments-cycle # narrow filter for which audits qualify
  window_audits: 5                           # min qualifying audits before declaring validation/regression

# Type 2 — per-skill score increase
target_metric:
  type: skill_score_increase
  name: dev-write-change.efficiency          # <skill>.<dimension>
  baseline: 3.0
  target: 4.0
  scope: all-audits
  window_audits: 8

# Type 3 — pattern absence
target_metric:
  type: pattern_absence
  name: parent-change-set-and-review-misses-invariant
  baseline: 1                                # the original occurrence
  target: 0                                  # do not recur
  scope: changes-with-parent-change-set
  window_audits: 5
```

### Qualifying audits

An audit _qualifies_ for a decision's validation when:

1. Its `overseer_completed_at` is strictly **after** the decision's `accepted_at` (or `updated` when `status` flipped to `accepted`).
2. Its lifecycle ran the skill the decision modified (i.e. `target_skill` appears in the audit's `per_skill_findings[].skill`).
3. The decision's `target_metric.scope` filter matches the audit (e.g., `changes-with-parent-change-set` requires the audited change's frontmatter to have `parent_change` populated).

### Lifecycle

```
proposed → accepted → (apply runs, skill ships)
                         ↓
                       validation_result: pending
                         ↓
                       qualifying audits accumulate
                         ↓
              ┌──────────┴──────────┐
              ↓                     ↓
        validated              regressed
              ↓                     ↓
        (keep)                (deprecate or supersede)
```

`status` stays `accepted` throughout — until you decide to deprecate/supersede in response to a regression.

### Who validates

For v1 (light): the human reads the audits post-acceptance and updates `validation_result` + appends to `validation_observations[]` manually. The structured shape makes this trackable; the dashboard surfaces the count of qualifying audits per decision so you know when the window is satisfied.

A future `meta-validate-decision` skill can automate the count + the verdict by reading audits + the decision's `target_metric` + applying the comparison. Deferred until enough decisions are in flight to make automation worthwhile.

## When to use

Capture a decision when:

- The rationale is non-obvious from the resulting state
- You expect the question to come up again
- It commits future work in a particular direction

Don't capture trivial choices ("named the variable foo") or things that are self-evident from code.

## Example

```markdown
---
id: use-fastify
type: decision
domain: development
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [stack, backend]
source: conversation/session-abc123
private: false
title: Use Fastify for app backends
status: accepted
alternatives: ["Express (more popular)", "Hono (lighter)", "Raw http.Server"]
---

# Use Fastify for app backends

## Context

Apps need a backend for fs access and the AI bridge. Want TypeScript-native, fast, low-ceremony.

## Options considered

- Express — most familiar but feels slow, plain JS-y
- Fastify — TS-native, fast, schema-aware
- Hono — lighter but smaller ecosystem
- Raw http — too much boilerplate at scale

## Decision

Fastify.

## Rationale

TS-native plugins + schema validation reduce boilerplate. Speed isn't critical
locally but matters if we ever go remote. Mature enough to trust.

## Consequences

All scaffolded apps inherit this. Replacing later would mean rewriting
server/routes/\* and possibly auth middleware.
```

## Example — implementing a tuning suggestion (Overseer Phase 4)

```markdown
---
id: dev-write-change-parent-change-context-propagation
type: decision
domain: meta
created: 2026-06-04T15:00:00Z
updated: 2026-06-04T15:00:00Z
tags: [skill-tuning, overseer]
source: dashboard/overseer-promote
private: false
title: dev-write-change PLAN and EXECUTE consume parent_change context
status: accepted
alternatives: ["leave parent_change unused (status quo)", "make parent_change required (would break legacy changes)"]
implements_tuning_suggestions:
  - audit_id: audit-abi-decoding-via-codegen-typed-event-structs-and-per-event
    suggestion_index: 1
target_metric:
  type: pattern_absence
  name: parent-change-set-and-review-misses-invariant
  baseline: 1
  target: 0
  scope: changes-with-parent-change-set
  window_audits: 5
validation_result: pending
validation_observations: []
---

# dev-write-change PLAN and EXECUTE consume parent_change context

## Context
Overseer audit on abi-codegen found pass-3 caught a reorg/sink correctness gap
that was predictable from the change's `parent_change` frontmatter alone (it
named the reorg-handler change). Plan, plan-review, and execute all silently
passed. Cost of the miss when caught at pass-3: ~$5.

## Decision
dev-write-change PLAN reads the change frontmatter; if `parent_change` is set,
enumerates the predecessor's load-bearing invariants and verifies the new
surface extends them.

## Rationale
Single-instance evidence but high leverage: mechanical (read a field), works
at multiple skill layers, and the miss was a correctness bug (not efficiency).
Promoted to decision because the evidence quality outweighs the recurrence
count — the failure mode is the kind that compounds (every subsequent change
with a `parent_change` set is a candidate to repeat the miss).
```

## Related

[[archetype-project]] (decisions often emerge from projects), [[standard-wiki-format]], [[meta-apply-tuning-suggestion]] (uses `implements_tuning_suggestions` to gate `apply` mode)
