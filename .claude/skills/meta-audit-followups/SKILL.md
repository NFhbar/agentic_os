---
name: meta-audit-followups
description: 'Phase 3 of the Overseer arc — the forward-link aggregator. Scans provisional lifecycle-audits, finds subsequent changes that touched the same files, classifies each follow-up (fix / refactor / feat-extension / feat-rewrite / test / docs), and appends followup_signals[] entries that retroactively adjust the audit''s Correctness score. Promotes audits from provisional → final once the 90-day forward-look window closes. Designed to run as a daily scheduled job; safe to invoke manually for one-offs.'
user-invocable: true
version: 1
domain: meta
tags: [audit, overseer, self-improvement, forward-link, scheduled]
inputs:
  audit:
    type: string
    required: false
    description: 'Audit id to process. If omitted, the skill scans ALL provisional audits with at least 1 day since merge (the batch path used by the scheduled runbook). Pass a specific id for one-off processing or debugging.'
  window_days:
    type: integer
    required: false
    default: 90
    description: 'Forward-look window in days. Audits whose audited change merged more than this many days ago are eligible for promotion `provisional → final`. Default 90.'
  dry_run:
    type: boolean
    required: false
    default: false
    description: 'Compute proposed signal updates without writing them. Useful for previewing what the next scheduled run would do.'
outputs:
  - kind: file
    path: vault/wiki/meta/lifecycle-audit/audit-<id>.md
  - kind: event
    path: '.claude/state/events.db (kind: meta, action: audit-followups, audit_id: <id>, files_touched: [<audit-path>])'
spawns: []
---

# meta-audit-followups

## Purpose

The Overseer (`meta-overseer-review`) produces a **provisional** judgment at merge time. But the most important Correctness signal — _did the change actually hold up?_ — can only be observed by watching what happens to the same files over the following weeks. A change that looked clean at merge but spawns three bug-fix follow-ups within 30 days was _not_ correct. A change that nobody had to revisit in 90 days probably _was_.

This skill is the loop that converts that forward-look observation into structured signal. It:

1. Identifies follow-up changes that touched the same files as a provisional audit's `files_touched`.
2. Classifies each follow-up by type (`fix` / `refactor` / `feat-extension` / `feat-rewrite` / `test` / `docs`).
3. Computes a Correctness signal adjustment per follow-up using the rules in [[archetype-lifecycle-audit]] § "Followup signals".
4. Appends entries to the audit's `followup_signals[]` array (append-only — never rewrites history).
5. Adjusts the audit's aggregate `scores.correctness` field, bounded to ±2 cumulative.
6. Promotes `audit_status: provisional → final` once `window_days` has elapsed since the audited change's merge AND no new follow-ups landed in the trailing 30 days.

Aggregated across many audits, this is what answers _"are skill X's outputs durable?"_ — the metric the user can't get from a merge-time snapshot alone.

## When to use

- **Daily scheduled job** — the canonical path. A runbook at `vault/wiki/meta/runbook/runbook-audit-followups.md` schedules this skill with no `audit:` arg, so it sweeps every provisional audit. Skipped audits (already-final, audited <1 day ago, no `files_touched`) are no-ops.
- **One-off audit replay** — pass a specific `audit:` id to reprocess one audit, e.g., after manually editing its `files_touched` field or to debug classification on a known case.
- **Pre-flight preview** — pass `dry_run: true` to see what the next sweep would change without mutating any audit file.

## When NOT to use

- **For audits with `audit_status: final`** — the skill silently skips final audits. The verdict is locked; the loop's purpose is to converge on `final`, not revisit it.
- **For audits whose `audited_at` is less than 1 day ago** — gives the lifecycle a beat to settle. Same-day follow-ups are rare and usually noise.
- **As a replacement for `meta-overseer-review`** — this skill never produces a new audit; it only appends signal to existing ones.

## Pre-conditions

- The audit entry exists at `vault/wiki/meta/lifecycle-audit/audit-<id>.md` (single audit mode) OR at least one such entry exists (batch mode).
- The audit's `files_touched` field is non-empty. (Audits with empty `files_touched` are skipped with a warning — the Overseer should have populated it; the follow-up signal can't be computed without it.)
- The vault manifest at `vault/.index/manifest.json` is readable. (Falls back to a walk of `vault/wiki/**/change/*.md` if missing, with a warning.)

## Procedure

1. **Validate inputs.**
   - If `audit` is provided, validate it matches `^[a-z0-9][a-z0-9-]*$`. Otherwise reject with `audit must match ^[a-z0-9][a-z0-9-]*$`.
   - If `window_days` is provided, validate it's an integer ≥ 1.
   - If `dry_run` is set, treat all `Write` / `Edit` operations as logged-only (print the proposed change instead of applying).

2. **Resolve the audit set.**
   - **Single mode** (`audit` provided): load `vault/wiki/meta/lifecycle-audit/audit-<audit>.md`. If not found, reject with `audit "<id>" not found at vault/wiki/meta/lifecycle-audit/audit-<id>.md`.
   - **Batch mode** (`audit` omitted): walk `vault/wiki/meta/lifecycle-audit/*.md`. Parse each frontmatter; keep entries where `type: lifecycle-audit` AND `audit_status: provisional` AND `overseer_completed_at` is at least 24h old AND `files_touched` is non-empty. This is the working set.

3. **For each audit in the working set, do the per-audit work** (steps 4-10):

4. **Resolve the audited change's merge timestamp.** From the audit's `audited_change_path`, read the change entry frontmatter. Pull `merged_at`. If `merged_at` is null/missing AND the change `status: merged`, fall back to the change entry's `updated` field. If still null, skip this audit with a warning: `audit <id>: cannot compute window — audited change has no merged_at`.

5. **Build the candidate follow-up set.** Find all changes that:
   - Have `merged_at` strictly **after** the audited change's `merged_at`
   - Have `status: merged` (skip `abandoned`)
   - Share a repo (same `repo` field) with the audited change
   - Have at least one file in their effective file set that intersects the audit's `files_touched`

   The "effective file set" for a candidate change comes from:
   - Its plan file's `## Files modified` section (preferred — explicit), OR
   - The plan file's frontmatter `files_touched` if present, OR
   - The change entry's `files_touched` if present, OR
   - A `git -C <repo.local_path> log --name-only <merge-base>..<merged-sha>` fallback (only if `repo.local_path` is set and git is accessible)

   If no file source is available for a candidate, skip it with a debug note (don't fail the whole audit). Candidates without file-overlap evidence are not follow-ups by this skill's definition.

6. **Filter out already-recorded follow-ups.** Skip candidates whose `change_id` already appears in the audit's `followup_signals[].followup_change_id`. The skill is idempotent — re-running it should not duplicate signal.

7. **Classify each new follow-up.** For each remaining candidate, classify it as one of:

   | type             | meaning                                                                                                    |
   | ---------------- | ---------------------------------------------------------------------------------------------------------- |
   | `fix`            | Bug fix — restores intended behavior the audited change should have produced. Strongest negative signal.   |
   | `refactor`       | Restructuring without behavior change. Slightly negative — suggests audited code wasn't well-shaped.       |
   | `feat-extension` | Builds on the audited change additively. Neutral or slight positive — design was extensible.               |
   | `feat-rewrite`   | Replaces the audited change's approach materially. Negative — original approach didn't hold up.            |
   | `test`           | Adds tests for code the audited change shipped. Slight negative — test gap shipped that audit should flag. |
   | `docs`           | Documentation update for the audited surface. Neutral.                                                     |

   Classify using:
   - **The candidate's `title`** — strong signal (`fix-...`, `refactor-...`, etc. titles are typically self-labeling)
   - **The candidate's `kind`** field if present (`fix`, `feature`, etc.)
   - **The candidate's body** — read for terms like "bug fix", "regression", "broke", "refactor", "extracted", "added test"
   - **The candidate's diff** — if accessible, look at the actual change pattern (small targeted fix vs broad rewrite vs test additions)

   Classification is an LLM judgment call when the structural signals are ambiguous; lean conservative (prefer `feat-extension` over `feat-rewrite` when unclear — false-positive negative signal is more harmful than false-negative).

8. **Compute the Correctness signal per follow-up.** Use the rules from [[archetype-lifecycle-audit]] § "Followup signals":

   | type             | overlap=high | overlap=medium | overlap=low |
   | ---------------- | ------------ | -------------- | ----------- |
   | `fix`            | -1.0         | -0.5           | -0.25       |
   | `refactor`       | -0.5         | -0.25          | 0           |
   | `feat-extension` | +0.25        | 0              | 0           |
   | `feat-rewrite`   | -1.0         | -0.5           | -0.25       |
   | `test`           | -0.5         | -0.25          | 0           |
   | `docs`           | 0            | 0              | 0           |

   `overlap` is the cardinality intersection / cardinality(audit.files_touched):
   - high: >50% of audit's files touched by the follow-up
   - medium: 10-50%
   - low: <10% (but >0)

   Also compute `days_after_audited_merge` = (followup.merged_at - audited.merged_at) in days, integer.

9. **Append to `followup_signals[]`.** Each new follow-up becomes an entry:

   ```yaml
   followup_signals:
     - followup_change_id: <change-id>
       followup_type: <type>
       followup_merged_at: <iso>
       days_after_audited_merge: <int>
       overlap_severity: <low|medium|high>
       correctness_signal: <float, ±0.25 increments>
       notes: |
         <1-2 sentences explaining the classification + which files overlapped>
   ```

   The array is append-only — never reorder or remove existing entries even if a previous entry's classification turns out to have been wrong (humans can fix via `human_override`, not the skill).

10. **Recompute `scores.correctness` from signals.** Take the audit's existing per-skill Correctness mean. Sum all `followup_signals[].correctness_signal`. Clamp the cumulative adjustment to **±2.0** to preserve the 1-5 rubric scale. The final `scores.correctness` = base + clamped_adjustment, clamped to [1.0, 5.0]. Update the audit's `scores.correctness` field. Do NOT touch `completeness` or `efficiency` — they are merge-time-only by rubric design.

    Also recompute `verdict_overall` from the updated mean of (correctness, completeness, efficiency) per the formula in [[archetype-lifecycle-audit]] § "Verdict derivation". If `verdict_overall` flipped (good→mixed, mixed→poor, etc.), include that in the report.

11. **Apply window-close promotion.** Check whether to promote `provisional → final`:
    - `days_since_audited_merge ≥ window_days` AND
    - No follow-ups in the trailing 30 days (i.e., `max(followup_signals[].days_after_audited_merge) < days_since_audited_merge - 30`)

    If both conditions hold, set `audit_status: final`. Append a one-line entry to the body's `## Open questions` section noting the promotion timestamp.

12. **Write the audit entry back.** Surgical edit via Edit tool — preserve the audit body and all unchanged frontmatter fields. The fields that may change are: `followup_signals` (append), `scores.correctness` (recompute), `verdict_overall` (recompute), `audit_status` (promotion), `updated` (current timestamp).

    If `dry_run: true`, skip the write and instead print:

    ```
    [dry-run] would update <audit-id>:
      append followup_signals[<n new>]
      scores.correctness: <old> → <new>
      verdict_overall: <old> → <new>
      audit_status: <unchanged or promoted>
    ```

13. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action audit-followups \
      --skill meta-audit-followups \
      --args '{"audit":"<id>","window_days":<N>,"dry_run":<bool>,"new_signals":<count>,"correctness_delta":<float>,"promoted_to_final":<bool>}' \
      --files-touched '["vault/wiki/meta/lifecycle-audit/audit-<id>.md"]' \
      --exit-status 0
    ```

    In batch mode, record one event **per audit processed** (not one event for the whole batch). The aggregate signal is recoverable from event rollups.

14. **Report to the user.**

    Single-audit mode:

    ```
    ✓ audit-followups — <audit-id>
      new signals:        <N>
      correctness:        <old> → <new>
      verdict:            <old> → <new> (or unchanged)
      status:             <unchanged or promoted to final>
      next-eligible:      <iso> (when next sweep should re-process)
    ```

    Batch mode:

    ```
    ✓ audit-followups — swept <N> provisional audits
      updated:            <M> with new follow-up signals
      promoted to final:  <P>
      no changes:         <N-M-P> (no new follow-ups since last sweep)
      total signals added: <S>
      next sweep:         24h
    ```

## What this skill must NOT do

- **Rewrite existing `followup_signals[]` entries.** Append-only. Past classifications stand; humans correct via `human_override`.
- **Adjust `completeness` or `efficiency` scores.** These dimensions reflect merge-time judgment that doesn't decay with forward-look. Only `correctness` is mutable.
- **Promote an audit to `final` prematurely.** Both window-close AND quiet-trailing-30d must hold. Premature promotion locks the verdict before the forward-look has actually settled.
- **Create new audits.** If a change has no audit, this skill doesn't audit it — that's `meta-overseer-review`'s job.
- **Touch the source repos.** Read-only with respect to all code under `repo.local_path`. Only audit files are written.
- **Run on `final` audits.** Skipped silently. The verdict is locked.

## Errors

- `audit must match ^[a-z0-9][a-z0-9-]*$` — invalid input to single-audit mode.
- `audit "<id>" not found at vault/wiki/meta/lifecycle-audit/audit-<id>.md` — invalid audit id.
- `audit <id>: cannot compute window — audited change has no merged_at` — skipped per-audit (batch continues).
- `audit <id>: files_touched is empty — skipping` — skipped per-audit (warning only; batch continues).
- `vault manifest unavailable — falling back to file walk` — degraded but functional. Logged as warning.

## See also

- [[archetype-lifecycle-audit]] — the data shape this skill mutates (`followup_signals[]`, `scores.correctness`, `audit_status`)
- [[meta-overseer-review]] — the upstream skill that produces the audits this one updates
- [[standard-scheduled-jobs]] — how this skill becomes a daily sweep via a runbook entry
- [[archetype-change]] — the input archetype the skill scans for follow-up candidates
- [[archetype-runbook]] — where the scheduling lives
