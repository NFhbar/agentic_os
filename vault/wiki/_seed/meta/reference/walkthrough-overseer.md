---
id: walkthrough-overseer
type: reference
domain: meta
created: 2026-06-05T16:30:00Z
updated: 2026-06-05T16:30:00Z
tags: [walkthrough, tutorial, overseer, self-improvement, getting-started]
source: seed
private: false
title: "Walkthrough — the Overseer (self-improvement loop)"
url: internal://walkthrough/overseer
kind: walkthrough
last_verified: 2026-06-05
---

# Walkthrough — the Overseer (self-improvement loop)

The **Overseer** is how the OS observes and improves itself. It's not a single skill — it's a loop that turns lifecycle telemetry into measured skill changes. This walkthrough is the one place to learn the whole flow end-to-end.

## TL;DR

After a code change completes its lifecycle (PLAN → REVIEW → EXECUTE → PR-REVIEW → ADDRESS-COMMENTS → MERGE), the Overseer audits how well each skill did using a 3-dimension rubric. Audits accumulate; recurring patterns surface in the dashboard; you act on them (or dismiss them) through structured decision entries; the resulting skill changes get **validated by future audits**. The whole system is opt-in per project and lives at `vault/wiki/meta/lifecycle-audit/` + the dashboard's Overseer app.

## The loop

```
┌─────────────────────────────────────────────────────────────────┐
│  ① change lifecycle completes (merged or abandoned)             │
│                          ↓                                       │
│  ② meta-overseer-review audits the lifecycle                    │
│       per-skill rubric scores (correctness/completeness/efficiency)
│       audit_tags (categorical patterns)                          │
│       tuning_suggestions[] (Overseer's hypotheses)               │
│                          ↓                                       │
│  ③ dashboard surfaces patterns                                  │
│       Overseer app → Overview → top recurring suggestions       │
│       audit detail → suggestion-level actions                   │
│                          ↓                                       │
│  ④ user acts on suggestions                                     │
│       Propose edit (read-only diff preview)                     │
│       Promote to decision (scaffold decision-archetype entry)   │
│       Dismiss (with rationale)                                   │
│                          ↓                                       │
│  ⑤ decision authored + accepted                                 │
│       target_metric declares what should move                   │
│       implements_tuning_suggestions cites audit + index         │
│                          ↓                                       │
│  ⑥ meta-apply-tuning-suggestion modifies the target SKILL.md   │
│       gated on decision entry existing                          │
│                          ↓                                       │
│  ⑦ skill change ships; future lifecycles run modified skill    │
│                          ↓                                       │
│  ⑧ future audits validate                                       │
│       target_metric measured across qualifying audits           │
│       validation_result flips: pending → validated | regressed  │
│                          ↓                                       │
│  ⑨ meta-audit-followups (scheduled) updates Correctness scores  │
│       forward-link adjustments based on subsequent changes      │
└─────────────────────────────────────────────────────────────────┘
```

Steps ②, ⑥, ⑨ are skill dispatches. ③ and ④ are dashboard work. ⑤ and the validation in ⑧ are human-authored. ⑦ is git.

## Goal of this walkthrough

After reading + following this, you can:

- Enable Overseer on a project
- Produce your first audit
- Read it confidently
- Take action on a tuning suggestion via the dashboard
- Author a decision entry that gates the skill edit
- Apply the change and start the validation cycle

## Prerequisites

- OS installed + dashboard running (`/os dashboard`)
- At least one completed change in a project's history (status `merged` or `abandoned`)
- Familiarity with the [[archetype-change]] lifecycle

---

## Phase 1 — Setup (one-time per project)

The Overseer is **opt-in per project**. Existing projects don't auto-fire audits — you opt them in deliberately.

### Enable on-complete auditing

Edit the project entry frontmatter (`vault/wiki/<domain>/project/<slug>.md`):

```yaml
audit:
  enabled: true
  mode: on-complete       # default — audits fire when change-automation-complete event lands
```

Alternative modes:

- `mode: sampled` + `sample_rate: N` — only 1-in-N changes get audited (cost-controlled for high-volume projects)
- `mode: manual` — you trigger each audit by hand; nothing fires automatically

The default `on-complete` is the canonical experience.

### (Optional) Schedule the forward-link sweep

Phase 3 of the Overseer arc retroactively adjusts audit Correctness scores when subsequent changes touch the same files. The skill exists (`meta-audit-followups`) but only fires when scheduled. Recommended once you have ≥5 audits accumulating:

```
/os add schedule meta-audit-followups
```

Configure it as a daily cron (e.g. `0 3 * * *`). Without scheduling, audits stay forever-`provisional` — workable but you miss the retroactive signal.

That's the entire setup. The rest of the loop is interactive.

---

## Phase 2 — Producing audits

### Automatic (the canonical path)

Once a project is opted in (`audit.enabled: true`, `mode: on-complete`), `meta-overseer-review` fires automatically when `change-automation-complete` lands for any change in that project. The audit takes ~3 minutes and costs ~$1-3 per lifecycle.

You don't have to do anything — the audit lands at `vault/wiki/meta/lifecycle-audit/audit-<change-id>.md` and shows up in the dashboard's Overseer app within seconds.

### Manual (for retrospectives or one-offs)

To audit a specific historical change OR one in a non-opted-in project:

```
/os audit lifecycle <change-id> force=true
```

The `force: true` bypasses the project opt-in check. Use it when:

- The project hasn't enabled auditing yet but you want a one-off audit (e.g., a particularly interesting lifecycle)
- The change merged before opt-in was enabled
- You want to re-audit after a rubric update

### When NOT to audit

- **In-flight changes** (status not `merged` or `abandoned`) — the rubric assumes terminal state and will refuse
- **Trivial changes with no plan/review/PR-review chain** — produces low-information audits where most skills score `n/a`
- **Within 24h of a prior audit on the same change** — debounced; override with `force: true` if intentional

---

## Phase 3 — Reading an audit

Audits live at `vault/wiki/meta/lifecycle-audit/audit-<change-id>.md`. The dashboard renders them under **Overseer → Audits → click the row**.

### The 3-dimension rubric

Each skill that ran in the lifecycle gets scored on three dimensions, 1-5 each:

| Dimension        | Question                                | Anchored levels                                                          |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| **Correctness**  | Did the work product do what was asked? | 5 = shipped clean, no regressions; 1 = rolled back / fundamentally wrong |
| **Completeness** | Did the skill cover its responsibility? | 5 = nothing material missed; 1 = produced fundamentally incomplete work  |
| **Efficiency**   | Was there waste / churn?                | 5 = clean single-pass; 1 = significant thrashing requiring human rescue  |

Mean across all per-skill scores gives the `verdict_overall`: `good` (≥4.0), `mixed` (2.5-4.0), `poor` (<2.5).

See [[archetype-lifecycle-audit]] § "The rubric" for the full anchored levels.

### Tag vocabulary

`audit_tags[]` carries categorical patterns. 17 tags with three polarities:

- **Negative** — `missed-issue`, `scope-creep`, `incomplete-plan`, `redundant-review-pass`, `test-gap`, `documentation-gap`, `nit-heavy`, `severity-miscalibration`, `premature-abstraction`, `address-comments-incomplete`
- **Positive** — `well-scoped`, `clean-convergence`, `caught-edge-case`, `good-decomposition`, `extensible-design`
- **Neutral** — `cost-anomaly`, `model-uncertainty`

Aggregated across audits, recurring tags are the diagnostic. A `dev-pr-review` skill that produces `missed-issue` in 30% of audits has a real coverage gap.

### Tuning suggestions

`tuning_suggestions[]` is the Overseer's structured recommendations. Each has:

- `skill` — the target (or a free-form non-skill name like "observability — runner")
- `suggestion` — concrete prose describing the change
- `confidence` — `low` / `medium` / `high`
- `evidence_summary` — what the Overseer cited
- `target_change` — explicit prose naming where in the SKILL.md the change goes

The dashboard's **Overseer → Overview → Top recurring tuning suggestions** panel groups suggestions across audits by skill + suggestion-text similarity. Patterns that appear 2+ times are candidates for action.

### Body sections

The audit body's prose narrative breaks down the structured fields:

- **Summary** — 2-3 sentence verdict
- **Lifecycle trace** — chronological narrative of what skills ran in what order with what outcomes
- **Per-skill assessment** — paragraph per skill elaborating on scores + tags
- **Patterns observed** — categorical patterns the Overseer noticed (usually 1-3)
- **Tuning suggestions** — prose elaboration of the structured array
- **Cost + duration** — table of per-skill spend
- **Open questions** — things the Overseer is uncertain about

The Open questions section is honest-by-design — the Overseer flags single-instance evidence, attribution gaps, and ambiguous scope. Read this for calibration on how seriously to take each finding.

---

## Phase 4 — Acting on suggestions

Each tuning suggestion in the audit detail view has three action buttons: **Propose edit**, **Promote to decision**, **Dismiss**. Choose based on the suggestion's evidence + your judgment.

### When to choose which

```
                  ┌─ Single instance, low confidence → Dismiss (with rationale)
                  │
                  ├─ Want to see what the edit looks like before committing → Propose edit
   Suggestion ────┤
                  ├─ Ready to ship — evidence strong → Promote to decision → fill in → Apply
                  │
                  └─ Recurring across multiple audits (N=2+) → Promote to decision (high priority)
```

### "Propose edit" — preview the diff

Click → spawns `meta-apply-tuning-suggestion` in `propose` mode → writes a unified diff to `vault/output/meta/tuning-proposals/<audit>-<i>.diff` plus a `.rationale.md` companion → modal shows the diff for review.

**Important: propose is read-only.** No skill files change. The diff is a preview. Use this to sanity-check that the Overseer's suggestion maps to a reasonable concrete edit before promoting to decision.

For **non-skill targets** (suggestions about the orchestrator, observability tooling, etc.), no diff is produced — only the rationale, which explicitly explains why the suggestion needs human routing rather than a SKILL.md edit. The status badge will say **"ⓘ propose ran — non-skill target"** instead of **"✎ proposal written"**.

### "Promote to decision" — scaffold the decision entry

Click → server scaffolds a new entry at `vault/wiki/meta/decision/decision-<slug>.md` with:

- Frontmatter pre-filled (`implements_tuning_suggestions`, `target_metric` stub, `validation_result: pending`)
- Body with the audit's Context section pre-populated
- Stub sections for Options / Decision / Rationale / Consequences / Validation
- The exact `/os apply tuning suggestion ...` command at the bottom

**Then you do the human-judgment work**: fill in why this is worth shipping (rationale), what alternatives you rejected, what metric you expect to move (the `target_metric` block).

### "Dismiss" — with rationale

Click → textarea opens for the dismissal rationale → entry appended to `.claude/state/dismissed-action-items.jsonl`. The suggestion's text stays in the audit data, but the dashboard's badge shows "✕ dismissed" with the rationale on hover.

**Dismissals are normal.** Single-instance suggestions, low-confidence findings, suggestions that have already been shipped (and rediscovered retroactively), suggestions where the design surface is too wide for one fix — all valid reasons to dismiss. Write the rationale so future-you (or a teammate looking at the same finding) understands why you didn't act.

### The hybrid warning

When a suggestion is `confidence: low` AND only `1×` in the corpus, the dashboard shows:

> ⚠ single-instance, low confidence — consider waiting for corroboration

This isn't a block — you can still promote — but it's a nudge to wait for a second instance before shipping a skill change based on weak evidence. The Overseer can be wrong about single observations.

---

## Phase 5 — The decision-then-apply gate

The decision entry is **the gate** for any auto-edit to a SKILL.md. This is deliberate: skill changes are not auto-applied from suggestion text alone. The decision entry forces human-authored intent to exist before any mechanical apply.

### Fill in the decision

The scaffolded entry has stub sections. Walk through them:

1. **Title** — replace the truncated auto-title with something human-readable (e.g., `dev-write-change address-comments — post-fix boundary check`)
2. **Options considered** — list rejected alternatives (e.g., "status quo", "wider scope than suggested", "narrower scope chosen")
3. **Decision** — what specifically changes in the skill, in your words
4. **Rationale** — why this is worth shipping. Cite evidence strength (recurrence count + confidence), leverage (mechanical vs judgment-call), and reversibility
5. **Consequences** — which skill(s) change, what metric should move, what failure modes to watch for
6. **`target_metric` block in frontmatter** — declare what the structured measurement is

#### target_metric shapes

Three types in v1:

```yaml
# Type 1 — a tag should stop appearing
target_metric:
  type: tag_frequency_decrease
  name: fix-introduces-defect-at-boundary    # an audit_tags value
  baseline: 3                                 # observed before fix
  target: 0                                   # expected after fix
  scope: changes-with-address-comments-cycle  # which audits qualify
  window_audits: 5                            # min audits before validation declared

# Type 2 — a per-skill dimension should improve
target_metric:
  type: skill_score_increase
  name: dev-write-change.efficiency
  baseline: 3.0
  target: 4.0
  scope: all-audits
  window_audits: 8

# Type 3 — a specific pattern should not recur
target_metric:
  type: pattern_absence
  name: parent-change-set-and-review-misses-invariant
  baseline: 1
  target: 0
  scope: changes-with-parent-change-set
  window_audits: 5
```

Pick the type that matches what your fix actually moves. Be honest — over-claiming makes validation harder.

### Flip status to accepted

When the decision body is filled in:

```yaml
status: accepted
```

This is the explicit consent. Before this flip, `apply` mode would refuse.

### Run the apply

At the bottom of the decision body, copy the pre-rendered command:

```
/os apply tuning suggestion audit=<audit-id> suggestion_index=<n> mode=apply decision_entry_path=vault/wiki/meta/decision/<decision-id>.md
```

Run it in a fresh Claude session OR (per the bootstrap convention) just edit the SKILL.md directly using the propose diff as a reference. The skill validates the gate (decision exists, type is decision, `implements_tuning_suggestions` cites this audit+index) and applies the edit to the target SKILL.md.

### Verify + commit

```bash
git diff .claude/skills/<target-skill>/SKILL.md
# Confirm the edit landed where the proposal said
git add .claude/skills/<target-skill>/SKILL.md
git commit
```

Note: the SKILL.md is **tracked** (ships to all OS installs). The decision entry is **per-install** (vault is gitignored). The skill change propagates via git; the decision archive stays in your local vault as the durable record of why.

---

## Phase 6 — Validation

The fix is shipped. Now the loop closes by observation.

### Qualifying audits

A future audit _qualifies_ for validating a decision when:

1. Its `overseer_completed_at` is **after** the decision's `accepted_at`
2. The audited lifecycle ran the modified skill (the skill appears in `per_skill_findings`)
3. The decision's `target_metric.scope` filter matches the audit (e.g., `changes-with-parent-change-set` requires `parent_change` to be set on the audited change's frontmatter)

### Tracking validation

For each qualifying audit, manually append an observation to the decision's `validation_observations[]`:

```yaml
validation_observations:
  - audit_id: audit-foo-bar-baz
    observed_at: 2026-06-12T10:00:00Z
    qualifies: true
    metric_value: 0           # for tag_frequency types: the count observed
    notes: "lifecycle had address-comments cycle but no boundary-defect tag"
```

When you've accumulated `window_audits` qualifying observations:

- **All show the target metric moved as expected** → flip `validation_result: pending → validated`. Decision is empirically proven; the fix worked.
- **Multiple show no movement (or wrong direction)** → flip `validation_result: pending → regressed`. Decide whether to refine the SKILL.md addition or revert it (deprecate the decision, ship a counter-change).
- **Ambiguous signal** → flip to `inconclusive`. Human judgment required.

The dashboard surfacing of this is deferred to Phase 4.1 of the Overseer arc — for now, validation is a manual reading + frontmatter update. The structured data shape makes future automation cheap.

### What "validated" gives you

- Empirical evidence the OS is improving. After N decisions have flipped to `validated`, you have a measured track record.
- Per-decision calibration of the Overseer's `confidence` field. If `high` confidence suggestions validate at the same rate as `medium`, the calibration is off — feed back into rubric tuning.
- A reversible log. A `validated` decision can later regress; a `regressed` one can be re-confirmed by a follow-up. The decision archetype isn't write-once.

---

## Operational notes

### Cost expectations

| Operation                                | Typical cost | Notes                                 |
| ---------------------------------------- | ------------ | ------------------------------------- |
| One audit (`meta-overseer-review`)       | $1-3         | ~3-5 min wall time                    |
| Propose edit                             | $0.10-0.50   | Quick LLM call to synthesize the diff |
| Promote to decision                      | $0           | Pure vault scaffold; no AI            |
| Dismiss                                  | $0           | JSONL append                          |
| Apply                                    | $0.20-1      | Surgical Edit on the target SKILL.md  |
| Forward-link sweep (per audit processed) | $0.05-0.20   | Reads events.db + change frontmatter  |

A team doing 20 changes/month with audits on all of them is looking at ~$30-60/month in Overseer telemetry. The value is the skill-tuning ROI — at $5 saved per shipped suggestion that validates, breakeven is ~10 validated decisions.

### Dismissal patterns — what's normal

Expect to dismiss **60-80% of single-instance suggestions**. The Overseer surfaces hypotheses; the human filters for what's worth shipping. High dismissal rate is the system working, not the Overseer failing. Look for:

- "Single-instance — wait for corroboration"
- "Already shipped as task #N"
- "Different fix surface (orchestrator / observability / runbook), not a skill change"
- "Design space too wide for one fix; needs investigation first"

Save the rationales — they're the institutional record of "why we didn't take that path."

### When to dismiss vs when to promote

| Signal                               | Dismiss                              | Promote                                     |
| ------------------------------------ | ------------------------------------ | ------------------------------------------- |
| N=1, low confidence                  | ✓                                    | (wait)                                      |
| N=1, high confidence, mechanical fix | (consider)                           | ✓                                           |
| N=2+, any confidence, clear scope    |                                      | ✓                                           |
| Non-skill target                     |                                      | (route via decision, no apply)              |
| Already shipped                      | ✓ (with rationale)                   |                                             |
| Design space too wide                | ✓ (revisit with investigation later) |                                             |
| Conflicts with existing decision     |                                      | (cite the conflict, deprecate or supersede) |

### Re-auditing

Audits debounce at 24h. To re-audit (e.g., after a rubric update):

```
/os audit lifecycle <change-id> force=true
```

The new audit overwrites the prior file. The history isn't preserved (single-shot per change in v1). Multi-revision audits are a future concern.

---

## Distribution implications

The Overseer is a **per-install** observation layer over **shared** code:

| Lives in                                     | What                                                                              | Distribution                    |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| `.claude/skills/`                            | The skills themselves (overseer-review, audit-followups, apply-tuning-suggestion) | Tracked — ships to all installs |
| `vault/wiki/_seed/meta/reference/`           | Archetype + walkthrough docs                                                      | Tracked — ships to all installs |
| `domains/meta/app/`                          | Dashboard code                                                                    | Tracked — ships to all installs |
| `vault/wiki/meta/lifecycle-audit/`           | Audit entries                                                                     | Gitignored — per-install        |
| `vault/wiki/meta/decision/`                  | Decision entries                                                                  | Gitignored — per-install        |
| `vault/output/meta/tuning-proposals/`        | Propose-mode diffs + rationales                                                   | Gitignored — per-install        |
| `.claude/state/dismissed-action-items.jsonl` | Dismissals                                                                        | Gitignored — per-install        |

Each team's audits + decisions + dismissals are theirs. Skill changes propagate via git when committed.

This means: **decisions cite audits that exist only in your vault**. The wikilinks `[[audit-...]]` in a SKILL.md's rationale section won't resolve on a teammate's install — that's expected and harmless. The skill change ships; the historical justification lives where it was authored.

Teams that want to share decisions can copy specific decision entries into a shared repo, but the design assumes per-install evolution by default.

---

## Common gotchas

1. **"My decision flipped to accepted but the SKILL.md didn't change."** You forgot to run the apply command. Decisions don't auto-trigger apply; the gate is a one-way authorization, not a webhook. Copy the `/os apply tuning suggestion ...` command from the bottom of the decision body.

2. **"The suggestion still shows up after I promoted it to a decision."** Correct behavior in v1. The dashboard surfaces status badges (`✎ proposal written`, `→ decision: <id>`, `✕ dismissed`) but doesn't filter actioned suggestions out of the list. They visibly show progress without disappearing.

3. **"Propose ran but the diff file is empty / says 'no automated diff possible'."** This means the suggestion targets a non-skill (orchestrator, observability, etc.). The propose output's status badge is `ⓘ propose ran — non-skill target`. Route via Promote to decision instead; the decision body is where the human design judgment goes.

4. **"I can't apply this suggestion — it touches multiple SKILL.md files."** The apply skill modifies one target per run. For cross-cutting suggestions (e.g., one that touches PLAN + REVIEW + EXECUTE phases of dev-write-change), either: (a) split into multiple suggestions in a future audit, OR (b) hand-edit the multiple files using the propose diff as guidance, citing the same decision entry in commits.

5. **"My audit shows verdict `good` but the lifecycle had problems."** The verdict is the _mean_ across per-skill scores. A lifecycle where 9 skills scored 5/5/5 and one scored 1/1/1 still averages to ~4.6 (`good`). Read the per-skill findings, not just the verdict.

6. **"No suggestions are recurring — every one is `1×`."** Normal at small corpus sizes (N<10). Top-recurring patterns become statistically meaningful around N=20-30 audits. Until then, suggestions are mostly individual-audit observations.

7. **"My decision's `validation_result` is stuck at `pending` and it's been weeks."** Means no qualifying audits have accumulated. Either the modified skill hasn't run recently, the scope filter is too narrow, or `window_audits` is too high. Check the decision's `target_metric.scope` against your actual audit corpus.

---

## See also

- [[archetype-lifecycle-audit]] — the structured shape audits take (rubric, tags, suggestion shape)
- [[archetype-decision]] — the decision archetype (§ implements_tuning_suggestions, § target_metric, § Validation)
- [[meta-overseer-review]] — the skill that produces audits
- [[meta-audit-followups]] — Phase 3 forward-link aggregator
- [[meta-apply-tuning-suggestion]] — Phase 4 the apply skill (propose + apply modes)
- [[standard-scheduled-jobs]] — how the forward-link sweep gets scheduled
- `domains/meta/app/src/apps/overseer/View.tsx` — the dashboard surface
