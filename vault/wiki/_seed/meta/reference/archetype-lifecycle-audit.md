---
id: archetype-lifecycle-audit
type: reference
domain: meta
created: 2026-06-03T18:30:00Z
updated: 2026-06-03T18:30:00Z
tags: [archetype, audit, overseer, self-improvement, quality-measurement]
source: seed
private: false
title: Archetype — lifecycle-audit (the Overseer's structured judgment)
url: internal://archetype/lifecycle-audit
kind: reference
last_verified: 2026-06-03
---

# Archetype — lifecycle-audit

## What it is

A **lifecycle-audit** entry is the Overseer's structured judgment of one completed change's lifecycle. It captures: an LLM-derived assessment of how well each skill in the lifecycle performed, scored against an opinionated rubric; categorical tags naming recurring patterns; and concrete tuning suggestions for skill improvements.

Audits are the **per-instance signal** that fuels the self-improvement loop. Aggregated across many changes, they answer questions like: _"Is `dev-pr-review`'s pass-1 thoroughness improving over the last 30 days?"_ or _"Does `dev-write-change` EXECUTE consistently produce code that gets fixed within two weeks?"_

The OS produces one audit per merged-or-abandoned change (when auditing is enabled for the owning project). Audits are append-only: the rubric snapshot at audit time is preserved; forward-look signals (the Phase-3 retroactive scoring loop) append to the audit but don't rewrite earlier verdicts.

## When the Overseer runs

| Mode          | Trigger                                                                 | Use case                                                                             |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `on-complete` | Auto-fires when `change-automation-complete` event lands for the change | Default for projects with sufficient throughput; produces the canonical audit stream |
| `sampled`     | Auto-fires for 1-in-N completed changes (N configurable)                | Cost-controlled mode for high-volume projects                                        |
| `manual`      | User dispatches `/os audit lifecycle <change-id>` from the dashboard    | Retrospective analysis; auditing legacy changes; re-auditing after rubric updates    |

Auditing is **opt-in per project** via the project's frontmatter `audit:` block. Default off — existing projects don't suddenly get audits firing on their next merge.

## Required frontmatter (in addition to shared)

| field                    | type   | notes                                                                     |
| ------------------------ | ------ | ------------------------------------------------------------------------- |
| `title`                  | string | Short, scannable (e.g., `"Audit — mull-serve-http-json-query"`)           |
| `audited_change_id`      | string | The change this audit assesses                                            |
| `audited_change_path`    | string | Full path to the change entry (resolves `audited_change_id`)              |
| `project`                | string | Owning project id (inherited from the audited change)                     |
| `audit_status`           | enum   | `pending`, `provisional`, `final` (see Status enum below)                 |
| `overseer_model`         | string | Model name + version that produced the audit (e.g., `claude-opus-4-7`)    |
| `overseer_dispatched_at` | string | ISO timestamp — when the Overseer skill started                           |
| `overseer_completed_at`  | string | ISO timestamp — when the audit entry was written                          |
| `rubric_version`         | string | Version of the rubric used (e.g., `v1.0`). Pins cross-time comparability. |

## Status enum

| value         | meaning                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`     | Overseer dispatched but hasn't completed yet (e.g., still mid-LLM call). Body may be empty.                                                                            |
| `provisional` | Audit complete; scores reflect merge-time judgment only. Default state after Overseer finishes. Forward-look signals (Phase 3) may revise Correctness later.           |
| `final`       | Audit verdict locked. User explicitly overrode or sealed the audit after enough forward-look time has passed (e.g., 90 days post-merge). Scores no longer auto-adjust. |

The `provisional → final` transition is a deliberate human action OR an automatic transition after the Phase-3 forward-look window closes. Most audits live as `provisional` indefinitely.

## Optional frontmatter

| field                | type    | notes                                                                                                                                                                                                                       |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict_overall`    | enum    | `good`, `mixed`, `poor`. Derived from per-skill scores but stored for fast filtering. See "Verdict derivation" below.                                                                                                       |
| `scores`             | object  | Per-dimension aggregate scores. See "Scores" below.                                                                                                                                                                         |
| `per_skill_findings` | array   | One entry per skill that ran in the lifecycle. See "Per-skill findings" below.                                                                                                                                              |
| `audit_tags`         | array   | Categorical pattern tags from the canonical vocabulary. See "Tag vocabulary" below. (Named `audit_tags` rather than `tags` to avoid clashing with the wiki-standard `tags` field that classifies entries for vault search.) |
| `tuning_suggestions` | array   | Concrete recommendations for skill SKILL.md changes. See "Tuning suggestions" below.                                                                                                                                        |
| `red_flags`          | array   | Free-form prose for things that surprised the Overseer (don't fit a tag). Aggregable as text.                                                                                                                               |
| `files_touched`      | array   | Files modified by the audited change (for Phase 3 forward-link analysis). Derived from the change's plan + execute artifacts.                                                                                               |
| `followup_signals`   | array   | (Phase 3) Forward-look entries appended when later changes touch the same files. See "Followup signals" below.                                                                                                              |
| `human_override`     | object  | (Optional) Set when a human disagrees with the Overseer's verdict. See "Human override" below.                                                                                                                              |
| `audit_cost_usd`     | number  | The cost of running the Overseer for this audit. Tracked for cost-vs-value analysis.                                                                                                                                        |
| `audit_duration_ms`  | integer | Wall-time of the Overseer skill dispatch.                                                                                                                                                                                   |

## The rubric — three dimensions, 1-5 scale

Each dimension is scored **per skill** that ran in the lifecycle (not just one overall score). This is the keystone of the diagnostic value — the scoring decomposes blame and credit.

### 1. Correctness — _did the work product do what was asked?_

| Score | Anchor                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5** | Shipped, no regressions, no follow-up needed. Work product correctly addresses the change's intent.                                                     |
| **4** | Shipped with minor caught-before-merge follow-ups (small nits addressed during review, small fixes pre-merge).                                          |
| **3** | Shipped but obvious issues missed by review/execute that became apparent later (next PR review found something this one should have, edge case missed). |
| **2** | Shipped with material bugs requiring a follow-up fix change within 14 days.                                                                             |
| **1** | Didn't ship / had to be rolled back / fundamentally wrong approach.                                                                                     |

**Phase 3 forward-look adjusts Correctness retroactively** when subsequent changes touching the same files surface as bug fixes. A 5 can decay to a 3 if two bug-fix changes land within 30 days; a 4 can rise to a 5 if no follow-up activity happens in 90 days.

### 2. Completeness — _per-skill coverage of responsibility_

| Score | Anchor                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| **5** | Nothing material missed. Review caught all real issues; execute covered planned scope; plan named every required step.            |
| **4** | Minor gaps — small nits missed in review; small TODOs left in execute; plan slightly underspecified non-critical paths.           |
| **3** | Moderate gaps — a real issue missed and caught downstream; execute scope-crept by one step; plan missed an obvious required test. |
| **2** | Significant gaps — review missed substantive issues; execute missed planned scope; plan was substantially incomplete.             |
| **1** | Major gaps — skill produced fundamentally incomplete work; the human had to redo most of it.                                      |

### 3. Efficiency — _no wasted work, minimal churn_

| Score | Anchor                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| **5** | Clean single-pass-where-possible flow. No revisions, no address-comments cycles unless genuinely needed.                  |
| **4** | 1-2 expected iterations (one revise after review; one address-comments cycle). Each iteration produced meaningful change. |
| **3** | More iterations than necessary — 3+ review passes when 1-2 should have sufficed; redundant work between passes.           |
| **2** | Clear waste cycles (no-op address-comments runs; redundant review of unchanged code; orphan-death retries).               |
| **1** | Significant thrashing — many iterations producing little progress; loops that needed human intervention to escape.        |

## Tag vocabulary

Tags are categorical patterns the Overseer can attach to an audit. The vocabulary is fixed but growable — adding a new tag is a vault edit + documentation update (no code change). Each tag carries a polarity: negative (something went wrong worth flagging), positive (something went well worth recognizing), or neutral (informational).

| Tag                           | Polarity | Meaning                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `missed-issue`                | negative | Reviewer didn't catch something a later pass or downstream skill found                                       |
| `scope-creep`                 | negative | Execute exceeded plan in ways the plan didn't authorize                                                      |
| `incomplete-plan`             | negative | Plan missed an obviously needed step (e.g., didn't mention test updates for a behavior change)               |
| `redundant-review-pass`       | negative | Review ran but found nothing new compared to prior pass                                                      |
| `address-comments-incomplete` | negative | Some accepted comments not acted on by the address run                                                       |
| `nit-heavy`                   | negative | Reviewer found only style nits, no substantive issues — possible reviewer over-reach                         |
| `severity-miscalibration`     | negative | Comments marked as blockers were actually nits, OR vice versa                                                |
| `test-gap`                    | negative | Code shipped without tests where the convention demanded them                                                |
| `documentation-gap`           | negative | Public surface added without docs update                                                                     |
| `premature-abstraction`       | negative | Code introduces abstractions ahead of repeated use justifying them                                           |
| `well-scoped`                 | positive | Plan, execute, review all aligned cleanly with no scope drift                                                |
| `clean-convergence`           | positive | Lifecycle reached terminal state in minimal passes with substantive feedback per pass                        |
| `caught-edge-case`            | positive | Reviewer or writer surfaced a subtle case that would have shipped without their attention                    |
| `good-decomposition`          | positive | Plan broke the work into clean stages execute could follow without judgment calls                            |
| `extensible-design`           | positive | Code structure supports likely future changes (recognizable at audit time)                                   |
| `cost-anomaly`                | neutral  | Spend on this lifecycle was significantly above or below the project's median — worth examining              |
| `model-uncertainty`           | neutral  | Overseer flagged its own assessment as low-confidence (e.g., couldn't determine if a flagged issue was real) |

Tags are append-only across an audit's lifetime — adding tags via human override is fine; removing them isn't (preserve audit history).

## Per-skill findings

The `per_skill_findings` array contains one entry per skill that ran in the audited lifecycle. Skills that produced no output (no-op runs) are still listed with their scores.

```yaml
per_skill_findings:
  - skill: dev-write-change
    phase: plan          # plan | execute | address-comments
    scores:
      correctness: 4
      completeness: 5
      efficiency: 5
    tags: [well-scoped, good-decomposition]
    notes: |
      Plan correctly identified every touched file, named the required tests,
      flagged the pre-existing convention violation as out of scope. Execute
      followed the plan exactly without scope creep.
    evidence_paths:    # Files the Overseer cites in its judgment
      - vault/output/development/changes/<id>-plan.md
      - vault/wiki/development/change/<id>.md

  - skill: dev-pr-review
    phase: pass-1
    scores:
      correctness: 3
      completeness: 3
      efficiency: 4
    tags: [missed-issue, severity-miscalibration]
    notes: |
      Pass 1 found the pagination bug correctly but didn't flag the LIKE escape
      issue until pass 3, even though the diff was straightforward SQL string
      building. Severity calibration was off: marked the pagination fix as
      "concern" when it was a blocker (would have caused silent data loss).
    evidence_paths:
      - vault/wiki/development/pr-review/<review-id>.md
```

The phases enumerate what variants of a skill ran (e.g., dev-write-change runs PLAN then EXECUTE then potentially address-comments — each gets its own findings entry).

## Verdict derivation

The `verdict_overall` field is computed from per-skill scores:

```
mean_per_skill = avg(correctness, completeness, efficiency) for each skill
overall_mean = avg(mean_per_skill) across all skills

verdict_overall:
  ≥ 4.0  → good
  2.5–4.0 → mixed
  < 2.5  → poor
```

The threshold values are deliberate but adjustable in future rubric versions. Treat them as v1.0 calibration.

## Tuning suggestions

The `tuning_suggestions` array contains concrete, actionable recommendations for skill SKILL.md changes. Each suggestion is the Overseer's hypothesis about a skill improvement; aggregated across audits, recurring suggestions become candidate skill-tuning work.

```yaml
tuning_suggestions:
  - skill: dev-pr-review
    suggestion: |
      Add explicit prompt instruction to check SQL string-building code
      paths for escape issues. This pattern was missed on pass 1 of this
      review and would have shipped silently. Add a "When reviewing
      SQL-adjacent code, explicitly check for parameter escape, query
      injection, and LIKE wildcard handling" line to the focus areas.
    confidence: medium       # low | medium | high
    evidence_summary: |
      Pass 1 reviewed `internal/store/sqlite.go` (containing the bug) but
      raised no SQL-correctness comments. Pass 3 found the issue.
    target_change: |
      Insert under "## Focus areas — code review" in dev-pr-review SKILL.md,
      between the existing logic + security bullets.
```

`confidence` tells aggregation surfaces how to weight the suggestion. Low-confidence suggestions need more corroborating audits before triggering a real skill change.

## Followup signals (Phase 3)

The `followup_signals` array is appended by `meta-audit-followups` (the Phase-3 scheduled skill) when later changes touch the same files. The skill classifies each follow-up by type and records what it implies about the audited change.

```yaml
followup_signals:
  - followup_change_id: fix-pagination-edge-case-on-empty-result
    followup_type: fix              # fix | refactor | feat-extension | feat-rewrite | test | docs
    followup_merged_at: 2026-06-15T...
    days_after_audited_merge: 12
    overlap_severity: high           # low | medium | high — line-level overlap with audited diff
    correctness_signal: -1           # Adjustment to audited change's Correctness score
    notes: |
      Followup fixed a bug in the cursor pagination logic the audited
      change introduced. High overlap (modified the same conditional
      branch). Audited change's Correctness adjusted from 5 to 4.

  - followup_change_id: add-pagination-iteration-test
    followup_type: test
    followup_merged_at: 2026-06-20T...
    days_after_audited_merge: 17
    overlap_severity: medium
    correctness_signal: -0.5         # Test gap was identifiable at review time
    notes: |
      Followup added tests for the cursor pagination path the audited
      change shipped. Suggests the original change shipped with insufficient
      test coverage — small Completeness ding (already noted in audit).
```

Signal aggregation is bounded: maximum cumulative Correctness adjustment is ±2 (preserves rubric scale). The 90-day rolling window for active signal applies.

## Human override

Audits can be human-overridden when the Overseer's judgment doesn't match observed reality. Overrides become calibration examples for future Overseer prompts.

```yaml
human_override:
  ts: 2026-06-04T10:00:00Z
  reviewer: <username>
  overridden_field: scores.dev-pr-review.correctness
  original_value: 3
  new_value: 4
  rationale: |
    Overseer flagged pass-1 reviewer for missing the LIKE escape issue,
    but on re-reading the diff, the escape was actually correct as written
    — the apparent issue was a misreading of the surrounding code. Reviewer
    was right; Overseer was wrong.
```

Multiple overrides allowed (append-only). The latest override wins for derived `verdict_overall` computation. Original Overseer values remain queryable for "how often does the human override the Overseer?" calibration.

## Body sections

The audit entry's body provides narrative context the structured fields can't capture.

```markdown
## Summary
<2-3 sentences: overall verdict + the single most important pattern>

## Lifecycle trace
<chronological narrative: what skills ran, in what order, with what outcomes>

## Per-skill assessment
<for each skill, ~1 paragraph elaborating on the structured scores + tags>

## Patterns observed
<categorical patterns the Overseer noticed — usually 1-3 patterns>

## Tuning suggestions
<elaboration of the structured tuning_suggestions array, with evidence>

## Cost + duration
<the Overseer's view of cost-effectiveness for this lifecycle>

## Open questions
<things the Overseer is uncertain about or wants future audits to track>
```

## Path convention

Audit entries live at:

```
vault/wiki/meta/lifecycle-audit/audit-<change-id>.md
```

One audit per change. Re-running the Overseer on the same change appends a new audit-entry-revision (the prior audit becomes an attachment, not the canonical record). For v1, treat audits as single-shot; multi-revision audits are a v2+ concern.

## Composition with the rest of the system

| Upstream (consumed by Overseer)                                 | Downstream (consumes audits)                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The change entry                                                | The Overseer dashboard surface (list, detail, by-skill views)                                                |
| The plan file (`vault/output/development/changes/<id>-plan.md`) | Project Pulse v2 (verdict distribution, top tuning suggestions)                                              |
| The plan-review file                                            | `meta-audit-followups` (Phase 3 — reads audit's `files_touched` to find follow-up changes)                   |
| The pr-review entry + all passes                                | Future `meta-aggregate-audits` (synthesizes patterns across many audits into decision-entry recommendations) |
| events.db rows for cost/duration attribution                    | Skill-tuning humans (read tuning_suggestions to decide what skill changes to ship)                           |

## Example

```markdown
---
id: audit-mull-serve-http-json-query-api-over-events-with-block-range
type: lifecycle-audit
domain: meta
created: 2026-06-04T09:30:00Z
updated: 2026-06-04T09:30:00Z
tags: [audit, overseer]
source: meta-overseer-review
private: false
title: 'Audit — mull-serve HTTP/JSON query API'
audited_change_id: mull-serve-http-json-query-api-over-events-with-block-range
audited_change_path: vault/wiki/development/change/mull-serve-http-json-query-api-over-events-with-block-range.md
project: mull-version-2
audit_status: provisional
overseer_model: claude-opus-4-7
overseer_dispatched_at: 2026-06-04T09:25:12Z
overseer_completed_at: 2026-06-04T09:30:45Z
rubric_version: v1.0
verdict_overall: mixed
scores: {"correctness": 3.5, "completeness": 3.7, "efficiency": 3.0}
per_skill_findings: [...]
audit_tags: [missed-issue, redundant-review-pass, well-scoped]
tuning_suggestions: [...]
files_touched: ["internal/store/sqlite.go", "internal/serve/server.go", "cmd/serve.go", "README.md"]
audit_cost_usd: 1.43
audit_duration_ms: 184320
---

# Audit — mull-serve HTTP/JSON query API

## Summary
Mixed lifecycle. Plan + execute were clean (good decomposition, no scope creep);
PR review was inefficient (3 passes finding the same issues, with the LIKE
escape bug only caught on pass 3 when it should have been pass 1).

## Lifecycle trace
PLAN → REVIEW(approve+nits) → REVISE → REVIEW(approve+execute-time nits) →
EXECUTE → open-PR → PR-REVIEW(pass-1, 1 blocker + 4 suggestions) →
ADDRESS-COMMENTS → PR-REVIEW(pass-2, no new findings) →
PR-REVIEW(pass-3, surfaced LIKE escape) → ADDRESS-COMMENTS →
PR-REVIEW(pass-4, sign-off) → mark-ready → merge → close-change.

## Per-skill assessment
... (etc)
```

## See also

- [[meta-overseer-review]] — the skill that produces these entries (one per audited change)
- [[decision-distribution-v1-architecture]] — the context for why the OS measures itself
- [[archetype-change]] — the input archetype (audits assess changes)
- [[archetype-pr-review]] — the input archetype (audits read pass-by-pass review data)
- [[archetype-decision]] — what aggregated tuning_suggestions eventually become (when a pattern is strong enough to justify a skill change)
