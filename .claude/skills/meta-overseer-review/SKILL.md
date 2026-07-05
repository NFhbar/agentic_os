---
name: meta-overseer-review
description: 'Audit a completed change lifecycle. Reads the change + plan + plan-review + every PR-review pass + events.db attribution; applies the 3-dimension rubric (correctness / completeness / efficiency) per skill that ran; emits a structured lifecycle-audit entry with scores, categorical tags, and concrete skill-tuning suggestions. The Overseer is how the OS observes itself — aggregated audits drive the self-improvement loop.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: meta
tags: [audit, overseer, self-improvement, quality-measurement, lifecycle]
inputs:
  change:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Change id to audit. Must reference a real change entry in `vault/wiki/<domain>/change/<change>.md` AND that change must be in a terminal status (`merged` or `abandoned`). Auditing in-flight changes is rejected — the rubric assumes the lifecycle is complete.'
  rubric_version:
    type: string
    required: false
    default: 'v1.0'
    description: 'Pin the rubric version. Defaults to the current version (`v1.0`). Useful for re-auditing a change against an older rubric to preserve cross-time comparability.'
  force:
    type: boolean
    required: false
    default: false
    description: 'Override the opt-in check (project frontmatter `audit:` block). Use only when manually auditing a change in a project that hasn''t enabled auditing globally — e.g., a one-off retrospective. Recorded in the event for audit-trail clarity.'
outputs:
  - kind: file
    path: vault/wiki/meta/lifecycle-audit/audit-{{input.change}}.md
  - kind: event
    path: '.claude/state/events.db (kind: meta, action: lifecycle-audit, change_id: <change>, files_touched: [vault/wiki/meta/lifecycle-audit/audit-<change>.md])'
spawns: []
model: claude-fable-5
---

# meta-overseer-review

## Purpose

Produce a structured judgment of one completed change's lifecycle. Reads the full lifecycle (plan + review + execute + PR-review passes + address-comments cycles + close), applies the three-dimension rubric from [[archetype-lifecycle-audit]], and writes a `lifecycle-audit` entry that captures: per-skill scores, categorical pattern tags, and concrete tuning suggestions for skill improvements.

The Overseer is the **observation layer of the self-improvement loop**. Individual audits are per-instance signal. Aggregated across many audits (the Phase-1c dashboard surface), they answer questions like:

- _"Does `dev-pr-review`'s pass-1 completeness improve after I tune the SKILL.md?"_
- _"What % of `dev-write-change` EXECUTE outputs get bug-fixed within 30 days?"_
- _"Which skills consistently produce `missed-issue` tags in this project?"_

Producing audits is cheap (one LLM call per merged change, typically $1-3). Acting on aggregated audits is where the value lives.

## When to use

- **Auto-dispatched on `change-automation-complete`** — when the owning project has `audit: { enabled: true, mode: on-complete }` in frontmatter (default mode for opted-in projects).
- **Auto-dispatched at sample rate** — when project has `audit: { enabled: true, mode: sampled, sample_rate: N }`. Cost-controlled mode for high-volume projects.
- **Manual dispatch** — for retrospective analysis of legacy changes, re-auditing after a rubric update, or auditing a one-off change in a non-opted-in project (with `force: true`).

## When NOT to use

- **In-flight changes** — the rubric assumes terminal state. Reject if change is `planning`, `in-progress`, or `in-review`.
- **Changes with no plan + review + PR-review chain** — auditing a one-commit hot-fix that bypassed the lifecycle produces low-information audits. The skill won't refuse, but the resulting audit will mostly be `n/a` per skill.
- **Re-auditing within 24h of a prior audit** — treat audits as single-shot per change in v1; multi-revision audits are a v2+ concern. The skill warns and exits if a recent audit exists (override via `force: true`).

## Pre-conditions

- The change entry at `vault/wiki/<domain>/change/<change>.md` exists and parses
- The change's `status` is `merged` or `abandoned`
- The owning project's frontmatter has `audit.enabled: true` OR `force: true` is set
- `.claude/state/events.db` is readable (the skill cites cost/duration attribution)

## Procedure

1. **Validate inputs.**
   - `change` is required and matches `^[a-z0-9][a-z0-9-]*$`. Otherwise reject.
   - Locate the change at `vault/wiki/<domain>/change/<change>.md`. If not found, reject with `change "<value>" not found — searched vault/wiki/*/change/`.
   - Parse the change's frontmatter. If `status` is not `merged` or `abandoned`, reject with `change "<value>" is in-flight (status: <s>) — Overseer requires terminal state. Re-run after merge or abandonment.`

2. **Check opt-in.** Resolve the change's `project` field → load that project entry from `vault/wiki/<domain>/project/<project>.md`. Read its frontmatter `audit:` block.
   - If `audit.enabled: true` OR `force: true` → proceed.
   - If `audit.enabled` is unset or `false` AND `force: false` → reject with `project "<id>" has not opted into auditing. Set audit.enabled: true on the project frontmatter, OR re-run with force: true for a one-off audit.`
   - If `force: true` was set, note it in the audit's `notes` field for trail.

3. **Check for recent audit.** If `vault/wiki/meta/lifecycle-audit/audit-<change>.md` exists AND was modified within the last 24h AND `force: false` → reject with `audit for change "<value>" already exists (created <relative>). Re-run with force: true to overwrite.`

4. **Load lifecycle artifacts.** Read the following (skip gracefully when missing):
   - **Change entry** — full frontmatter + body (already loaded)
   - **Plan file** — `vault/output/<domain>/changes/<change>-plan.md` (from `change.plan_path`)
   - **Plan review** — `vault/output/<domain>/changes/<change>-review.md` (from `change.review_path`)
   - **PR-review entry** — full content of `change.pr_review_path` (typically `vault/wiki/development/pr-review/pr-review-<owner>-<repo>-<n>.md`), including ALL passes + comments + statuses + prior links
   - **Events.db rows for this change** — query: `SELECT ts, action, skill, exit_status, duration_ms, cost_usd FROM events WHERE change_id = '<change>' ORDER BY ts ASC`
   - **Git diff (if accessible)** — `git -C <repo.local_path> diff <merge-base>..<merged-sha>` — the actual code that shipped. Skip if `repo.local_path` is unset or git is unavailable.
   - **Repo conventions** — `vault/wiki/development/repo-knowledge/repo-knowledge-<owner>-<repo>.md` if present. Provides repo-specific judgment context.

5. **Compute structural fields.**
   - `audited_change_id` = `change`
   - `audited_change_path` = the change entry's path
   - `project` = change's `project` field
   - `audit_status` = `provisional` (default for new audits)
   - `overseer_model` = current model name (e.g., `claude-opus-4-7`)
   - `overseer_dispatched_at` = ISO timestamp at procedure start
   - `rubric_version` = input value (defaults `v1.0`)
   - `files_touched` = files modified by the change. Derive from:
     - The plan's `## Files modified` section (preferred — explicit list)
     - OR `git -C <repo> log --name-only <merge-base>..<merged-sha>` (fallback — implicit from git history)
     - Deduplicated, sorted, relative to repo root.

6. **Apply the rubric.** This is the LLM-judgment step. The skill universe is OPEN: enumerate it from the evidence, not from a fixed list. `SELECT DISTINCT skill FROM events WHERE change_id = '<change>'` plus any skill visibly attested in the artifacts (e.g. a plan-review file proves `dev-review-change` ran even if its event row is missing). Score EVERY skill observed — `dev-*`, `meta-*`, `research-*`, and the router (`os`) alike. A skill being outside the dev change-lifecycle is not an exemption; if it dispatched within this lifecycle, it gets a findings entry. For EACH observed skill:
   - Score the skill on **Correctness** (1-5), **Completeness** (1-5), **Efficiency** (1-5) using the anchored levels in [[archetype-lifecycle-audit]] § "The rubric — three dimensions, 1-5 scale".
   - Identify which **tags** from the canonical vocabulary apply (see [[archetype-lifecycle-audit]] § "Tag vocabulary").
   - Write 2-3 sentences of `notes` elaborating on the scores + tags with specific evidence from the artifacts.
   - Record `evidence_paths` — the specific file paths the judgment cites.

   Phase conventions for the common dev lifecycle skills (these are EXAMPLES of multi-phase shapes, not the universe):
   - `dev-write-change` — phases: `plan`, `execute`, `address-comments` (one entry per phase)
   - `dev-pr-review` — one entry per pass; phase: `pass-1`, `pass-2`, etc.
   - Single-phase skills (`dev-review-change`, `dev-revise-plan`, `dev-open-pr`, `dev-pr-review-publish`, `dev-mark-pr-ready`, `dev-close-change`, and any `meta-*` / `research-*` / `os` dispatch) — one entry each.

7. **Identify tuning suggestions.** For each tag with negative polarity OR score ≤ 3, produce a `tuning_suggestions[]` entry with:
   - `skill` — the tuning target's name. For skill targets: the skill id. For non-skill targets: a CANONICAL id from the path map — run `node scripts/tuning-targets.mjs` to list them (e.g. `automation-orchestrator`, `router-vocabulary`, `dispatch-helper`). Free-prose names like "meta — automation orchestrator" are not routable; if the surface you want to name has no map entry, pick the closest one or note in the suggestion prose that the map needs a new entry.
   - `target_kind` — `skill` when the tunable surface is a SKILL.md (the default; may be omitted). `orchestrator` / `route` / `script` when the evidence points at app-layer TypeScript, the router vocabulary table, or an OS script. Use the kind recorded in the map entry.
   - `suggestion` — concrete prose describing the change
   - `confidence` — `low` / `medium` / `high` based on how clearly the evidence supports the suggestion (single-instance = low; pattern within this one lifecycle = medium; clear systemic issue = high)
   - `evidence_summary` — 1-2 sentence summary of what triggered the suggestion
   - `target_change` — where the change should land: a specific SKILL.md section for skill targets, or the specific function/section within the mapped file(s) for non-skill targets

8. **Compute aggregate fields.**
   - `scores` (object) — for each dimension, compute the mean across all `per_skill_findings`. Round to one decimal.
   - `verdict_overall` — derive from `scores` per the formula in [[archetype-lifecycle-audit]] § "Verdict derivation":
     - mean of `correctness + completeness + efficiency` ≥ 4.0 → `good`
     - 2.5-4.0 → `mixed`
     - < 2.5 → `poor`
   - `audit_tags` (top-level array) — flatten the union of tags from all `per_skill_findings` entries. Deduplicate. **MUST be emitted under the key `audit_tags`, not `tags`**, to avoid clashing with the wiki-standard `tags: [audit, overseer]` field (YAML rejects duplicate keys, the audit would parse-fail and become invisible to the dashboard).

9. **Compose the audit entry body.** Mustache-style render against the archetype's body sections:

   ```markdown
   ## Summary
   <2-3 sentences: overall verdict + the single most important pattern observed>

   ## Lifecycle trace
   <chronological narrative: each skill dispatch with brief outcome, drawn from events.db ordering>

   ## Per-skill assessment
   <for each entry in per_skill_findings, ~1 paragraph elaborating on scores + tags + evidence>

   ## Patterns observed
   <1-3 categorical patterns the Overseer noticed — references the tags + groups them>

   ## Tuning suggestions
   <prose elaboration of tuning_suggestions[] with evidence — one paragraph per suggestion>

   ## Cost + duration
   <total cost + total wall-clock + breakdown by skill, derived from events.db>

   ## Open questions
   <any uncertainty the Overseer wants to flag — informs the `model-uncertainty` tag if applicable>
   ```

10. **Write the audit entry.** Use the Write tool to land the file at `vault/wiki/meta/lifecycle-audit/audit-<change>.md`. Create the parent directory if it doesn't exist:

    ```bash
    mkdir -p vault/wiki/meta/lifecycle-audit
    ```

    Frontmatter MUST be emitted with:
    - `recommended_changes` (n/a for this archetype — skip)
    - All structured arrays (`audit_tags`, `per_skill_findings`, `tuning_suggestions`, `files_touched`, `red_flags`) on single lines as JSON for the manifest parser. See [[archetype-research-report]] § "Frontmatter caveats" — the same flat-parser caveat applies.
    - The wiki-standard `tags` field stays `[audit, overseer]` (do NOT merge the audit-pattern vocabulary into it).

11. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action lifecycle-audit \
      --skill meta-overseer-review \
      --args '{"change":"<change>","rubric_version":"<v>","verdict_overall":"<good|mixed|poor>","force":<bool>}' \
      --files-touched '["vault/wiki/meta/lifecycle-audit/audit-<change>.md"]' \
      --exit-status 0
    ```

12. **Stamp the change entry's `audited_at` field.** Optional but useful for the dashboard — flips a frontmatter field on the change so the Changes app can render a "✓ audited" chip:

    ```yaml
    audited_at: 2026-06-04T09:30:45Z
    audit_path: vault/wiki/meta/lifecycle-audit/audit-<change>.md
    ```

    Surgical edit via the Edit tool; insert after `merged_at` (alphabetical-ish; near other terminal-state timestamps).

13. **Report to the user** with a tight summary:

    ```
    ✓ Audited — <change>
      verdict:   <good|mixed|poor>
      scores:    correctness <X>, completeness <Y>, efficiency <Z> (means)
      skills:    <N> assessed
      tags:      <comma-list of top tags>
      suggestions: <N> tuning suggestions emitted
      cost:      $<audit_cost> (this audit)
      audit:     vault/wiki/meta/lifecycle-audit/audit-<change>.md
      next:      browse the audit in the dashboard's Insights → Audits tab, OR drill into per-skill trends
    ```

## What this skill must NOT do

- **Mutate the audited change's code or PR.** Read-only with respect to the source repo. Only the audit entry (and the change frontmatter's `audited_at` stamp) are written.
- **Audit in-flight changes.** The rubric assumes terminal state. Period.
- **Score skills that didn't run.** If `dev-pr-review` never fired for the change (e.g., abandoned before PR open), don't fabricate scores. The `per_skill_findings` array is sparse for skipped skills.
- **Re-audit recent audits.** 24h debounce; override via `force: true`.
- **Auto-trigger skill changes.** Tuning suggestions are emitted; humans (or future skills) decide whether to ship them. The Overseer never edits SKILL.md files directly.
- **Apply human override.** The `human_override` field is set via the dashboard's audit detail view, not by the Overseer. The Overseer's output is the original ground truth; overrides come later.

## Errors

- `change is required and must match ^[a-z0-9][a-z0-9-]*$` — invalid input.
- `change "<value>" not found — searched vault/wiki/*/change/` — change entry doesn't exist.
- `change "<value>" is in-flight (status: <s>) — Overseer requires terminal state` — change hasn't merged or been abandoned yet.
- `project "<id>" has not opted into auditing. Set audit.enabled: true on the project frontmatter, OR re-run with force: true` — opt-in gate.
- `audit for change "<value>" already exists (created <relative>). Re-run with force: true to overwrite.` — debounce.
- `plan file at <path> missing — proceeding without plan-quality assessment` — graceful degradation (warn, don't fail).
- `events.db unavailable — cost/duration attribution will be omitted` — graceful degradation.

## See also

- [[archetype-lifecycle-audit]] — the data shape this skill produces (rubric, tags, frontmatter contract)
- [[decision-distribution-v1-architecture]] — the broader context for why the OS measures itself
- [[archetype-change]] — the input archetype
- [[archetype-pr-review]] — the input archetype (pass-by-pass review data is the richest signal)
- [[standard-event-store]] — events.db schema the skill reads cost/duration attribution from
- `meta-add-skill-to-playbook` / `meta-add-skill-to-router-vocab` — register this skill in the dashboard (one-time, done at scaffold)
