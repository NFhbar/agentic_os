---
name: meta-eval-skill-edit
description: 'Replay-eval a proposed SKILL.md edit before it reaches the decision gate. v1 is scoped to dev-pr-review: re-runs the stored prompts of 1-3 historical review passes against repo state PINNED to what each pass originally saw (scripts/eval-skill-edit.mjs reconstructs head + historic merge-base from git), with the EDITED skill travelling inline in the replay prompt — the on-disk SKILL.md is never touched. An LLM judge then compares old vs new passes on the audit rubric dimensions and emits better/same/worse + rationale. Closes the Finding 3.3 gap: skill edits previously shipped with zero regression check while lifecycle audits arrived at ~1/week, sample size ~4.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: meta
tags: [overseer, self-improvement, skill-tuning, eval, replay]
inputs:
  proposal_diff:
    type: string
    required: true
    description: 'Path to a unified diff against the target SKILL.md — normally a propose-mode artifact at vault/output/meta/tuning-proposals/<audit>-<i>.diff. The diff is applied to a TEMP copy; the installed skill is never modified.'
  skill:
    type: string
    required: false
    default: 'dev-pr-review'
    description: 'The skill the diff targets. v1 accepts only dev-pr-review (the most-tuned skill; its lifecycle leaves the richest replay substrate — stored prompts, pr-review entries, surviving branches). Reject anything else.'
  samples:
    type: integer
    required: false
    default: 2
    description: 'How many historical passes to replay (1-3). Each replay is a full headless dev-pr-review run — budget roughly the original pass cost (~$2-3 on opus) per sample.'
  model:
    type: string
    required: false
    description: 'Model override for the replays. Default: each candidate replays on its original run''s model — a mismatched model confounds the skill-edit comparison, so only override for cheap mechanical smoke tests, never for verdicts you intend to cite in a decision entry.'
outputs:
  - kind: file
    path: vault/output/meta/tuning-evals/<proposal-basename>-eval.md
  - kind: file
    path: vault/output/meta/tuning-evals/replay-<ts>.jsonl (one per sample)
  - kind: event
    path: '.claude/state/events.db (kind: meta, action: skill-edit-eval, files_touched: [<report>, <replay jsonls>])'
spawns: []
---

# meta-eval-skill-edit

## Purpose

Answer "did this skill edit make the skill better or worse?" in minutes instead of weeks. The OS persists everything a replay eval needs — exact dispatch prompts in the runs table, the full review record in pr-review entries, and git history pinning each pass's repo state. This skill replays historical passes with the edited skill inlined, then judges old vs new output on the lifecycle-audit rubric dimensions.

The verdict is **evidence for the decision gate, not a replacement for it**. [[meta-apply-tuning-suggestion]] apply-mode still requires a decision entry; this skill's report is what a well-formed decision entry cites.

Replay non-determinism is accepted by design: the judge scores _relative_ quality (better / same / worse), not exact match. Non-determinism degrades precision, not usefulness, at this sample size.

## When to use

- **After propose mode, before promoting to a decision** — the propose report's `next:` line points here. Run it on the `.diff` artifact, attach the eval report path to the decision entry.
- **Re-evaluating a hand-written skill edit** — generate a diff first (`git diff -- .claude/skills/dev-pr-review/SKILL.md > /tmp/edit.diff` from a dirty tree, then `git stash` while evaluating, or diff two copies).

## When NOT to use

- **Skills other than dev-pr-review** — v1 hard-rejects. The replay contract (pinned diff, single-artifact output, no-side-effect override) is review-specific; widening to other skills means designing their replay contracts first.
- **As a merge gate in CI** — replays cost real dollars per run and need the operator's repos on disk. This is an operator tool.
- **When no replayable candidates exist** — the harness reports why each candidate was skipped (no local repo, no reconstructable pin); fix the substrate or accept audit-latency feedback instead.

## Pre-conditions

- `proposal_diff` exists and applies cleanly to the CURRENT installed SKILL.md (a stale diff against an older skill version must be regenerated — propose mode is cheap).
- `.claude/state/events.db` runs table has `state='done'` rows for the target skill.
- The reviewed repos' entities carry a `local_path` that exists on disk with the relevant git history.

## Procedure

1. **Validate inputs.**
   - `skill` must be `dev-pr-review`. Otherwise reject with `v1 evaluates dev-pr-review only — widening requires a replay contract for "<skill>" (see When NOT to use)`.
   - `proposal_diff` must exist. Otherwise reject with `proposal diff not found at <path>`.
   - `samples` clamped to 1-3 (default 2).

2. **Build the patched skill in a temp tree.** The installed skill file is NEVER modified.

   ```bash
   T=$(mktemp -d /tmp/skill-eval-XXXXXX)
   mkdir -p "$T/.claude/skills/dev-pr-review"
   cp .claude/skills/dev-pr-review/SKILL.md "$T/.claude/skills/dev-pr-review/SKILL.md"
   (cd "$T" && patch -p1 < <absolute-path-to-proposal_diff>)
   ```

   If `patch` rejects hunks → reject with `proposal diff does not apply cleanly to the current SKILL.md — regenerate it via meta-apply-tuning-suggestion propose mode`.

3. **List replay candidates.**

   ```bash
   node scripts/eval-skill-edit.mjs list-candidates --limit <samples>
   ```

   Take the `replayable` array (most-recent PRs first; initial passes only — continuations need prior-pass context the replay can't reconstruct). When the proposal originates from a lifecycle-audit (the diff filename carries the audit id), PREFER the candidate whose PR belongs to the audited change — replaying the lifecycle the suggestion was mined from directly tests its hypothesis (run `--limit 3` and pick) — then fill remaining slots most-recent-first as the does-it-hurt-elsewhere control. If empty → stop and print every `skipped` entry's `reason`; nothing to evaluate. If fewer than `samples` → proceed with what exists and note the shortfall in the report.

4. **Replay each candidate** (sequential — each is a multi-minute headless run):

   ```bash
   node scripts/eval-skill-edit.mjs compose-replay --run <run_id> \
     --skill-file "$T/.claude/skills/dev-pr-review/SKILL.md" \
     --out vault/output/meta/tuning-evals/<run_id>-prompt.txt
   node scripts/eval-skill-edit.mjs replay \
     --prompt-file vault/output/meta/tuning-evals/<run_id>-prompt.txt \
     --model <candidate.run_model, unless inputs.model overrides>
   ```

   The replay JSON gives `jsonl_path`, `ok`, `total_cost_usd`, `duration_ms`, `result_text` (the review the edited skill produced). A failed replay (`ok: false`) is recorded as `sample errored` — it does NOT vote, and if ALL samples error the overall verdict is `inconclusive`.

5. **Judge each sample.** This is the LLM-judgment step. Per sample:
   - **Old side**: Read the candidate's `pr_review_path` entry — the `## Pass 1` section's comments and summary (the replayed run produced that pass). When `pin.via` is `squash-only`, note that the pinned diff has later fixes baked in: issues the old pass found may legitimately be absent from the new review — weigh misses accordingly.
   - **New side**: the replay's `result_text`.
   - Compare on the [[archetype-lifecycle-audit]] rubric dimensions, adapted to review output:
     - **Correctness** — are the new findings true? Any hallucinated issues or wrong file:line anchors?
     - **Completeness** — did it catch what the old pass caught? What the old pass MISSED but a later pass found (the front-loading test — e.g. did the edit make pass-1 anticipate what historically took until pass-3)? New true findings?
     - **Efficiency** — focus, signal-to-noise, cost vs the original run's `run_cost_usd`.
   - Emit per-sample verdict `better | same | worse` + 2-4 sentences of rationale citing SPECIFIC comments from both sides.

6. **Aggregate.** Majority across non-errored samples; ties → `same`. Single sample → its verdict, flagged `low-confidence (n=1)`.

7. **Write the eval report** to `vault/output/meta/tuning-evals/<proposal-diff-basename minus .diff>-eval.md`:

   ```markdown
   # Skill-edit eval — <proposal_diff basename>

   - target skill: dev-pr-review
   - proposal: <proposal_diff path>
   - overall verdict: **<better|same|worse|inconclusive>** (<n> samples)
   - total replay cost: $<sum>

   ## Samples

   | run | PR | pin | model | cost | verdict |
   | --- | --- | --- | --- | --- | --- |
   | <run_id> | <pr_url> | <via>, pass-time=<bool> | <model> | $<c> | <v> |

   ## Per-sample judgments

   ### <run_id> — <verdict>
   <rationale citing specific old/new comments>

   ## Caveats

   <replay non-determinism; squash-only pins; model overrides; sample shortfall>
   ```

8. **Record the event:**

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action skill-edit-eval \
     --skill meta-eval-skill-edit \
     --args '{"proposal_diff":"<path>","target_skill":"dev-pr-review","samples":<n>,"verdict":"<overall>"}' \
     --files-touched '[<report>, <replay jsonls>]' \
     --exit-status 0
   ```

9. **Report to the user:**

   ```
   ✓ skill-edit eval — <verdict> (<n> samples, $<cost>)
     proposal: <proposal_diff>
     report:   vault/output/meta/tuning-evals/<basename>-eval.md
     next:     cite the report in the decision entry (promote via /os promote tuning suggestion), or revise the proposal if the verdict is worse
   ```

## What this skill must NOT do

- **Modify the installed SKILL.md.** The patched copy lives in a temp tree; replays read it inline from the prompt.
- **Write to the pr-review entry, the runs table, or GitHub.** Replays are eval artifacts. The replay prompt's preamble overrides every persist/publish step of the replayed skill, and `eval-skill-edit.mjs replay` deliberately creates no runs-table row — a replay row would pollute the duration/cost history that wall caps and audits derive from.
- **Upgrade the verdict into authorization.** `better` does not auto-apply anything; the decision-entry gate in [[meta-apply-tuning-suggestion]] is unchanged.

## Errors

- `v1 evaluates dev-pr-review only — …` — non-dev-pr-review target.
- `proposal diff not found at <path>` — bad input.
- `proposal diff does not apply cleanly to the current SKILL.md — …` — stale diff.
- `no replayable candidates — <reasons per skipped entry>` — substrate missing (no local repo, no reconstructable pin, only continuation runs stored).

## See also

- [[meta-apply-tuning-suggestion]] — produces the `.diff` this skill evaluates; its propose report links here
- [[meta-overseer-review]] — the slow-loop counterpart (audits real lifecycles at ~1/week; this skill is the minutes-scale offline check)
- [[archetype-lifecycle-audit]] — the rubric dimensions the judge applies
- `scripts/eval-skill-edit.mjs` — candidate listing, sha pinning, prompt composition, replay spawning (via the shared dispatch helper)
