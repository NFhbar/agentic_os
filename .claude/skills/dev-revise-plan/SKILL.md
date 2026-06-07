---
name: dev-revise-plan
description: 'Revises an existing change plan to address findings from dev-review-change. Reads plan_path + review_path, rewrites the plan in place, bumps plan_revision. Preserves review_status — the original verdict still stands for the prior plan revision; user can manually re-run dev-review-change for a fresh verdict if desired.'
user-invocable: true
version: 1
domain: development
tags: [change, plan, revise, review]
inputs:
  change:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Change id whose plan to revise. The change entry must have both plan_path and review_path set (i.e. PLAN + REVIEW phases have both run).'
outputs:
  - kind: file
    path: vault/output/{{input.domain}}/changes/{{input.change}}-plan.md
spawns: []
---

# dev-revise-plan

## Purpose

Fold the findings from a `dev-review-change` verdict back into the plan, so subsequent EXECUTE consumes a plan that already addresses the reviewer's nits, concerns, and suggested changes.

This is the symmetric counterpart of `dev-write-change`'s ADDRESS-COMMENTS phase (which folds PR review comments back into the code). Here we fold plan-review findings back into the **plan**, before EXECUTE has even run.

**The verdict from the prior review is preserved.** This skill does NOT touch `review_status`, `review_path`, or `reviewed_at` — the original verdict still describes the prior plan revision. If you want a fresh verdict against the revised plan, manually re-run `/os review-change <change>` after this skill completes.

## Procedure

### Step 1: Validate

1. Read the change entry at `vault/wiki/<domain>/change/<change>.md`. Parse via js-yaml so nested fields are real values. Reject if missing or `type != change`.
2. Verify `status == "planning"`. Reject otherwise — once a change is `in-progress` / `in-review` / `merged` / `abandoned`, the plan is downstream of working code and rewriting it is no longer well-defined. Hint: `change has already advanced past planning (status=<X>). To revise the plan now, you'd need to discard the in-progress branch first.`
3. Verify `plan_path` is set and the file exists. Reject with: `no plan to revise — run /os write-change <change> first.`
4. Verify `review_path` is set and the file exists. Reject with: `no review findings to apply — run /os review-change <change> first.`
5. Extract `domain`, `repo`, `branch`, `plan_revision` (default 1 if unset).

### Step 2: Read inputs

1. Read the plan file at `plan_path` in full.
2. Read the review file at `review_path` in full. Parse:
   - **Verdict** — `approve` / `request-changes` / `rejected` (from the review's header)
   - **Concerns section** — `blocker`, `concern`, `nit` items (each with a description and resolution hint)
   - **Suggested changes section** — numbered list of concrete revisions to the plan (only present for `request-changes` verdicts)
3. **Refusal gate: nothing to address.** If the review has zero items in BOTH Concerns and Suggested changes, refuse:

   ```
   ✗ Nothing to revise — the review has no concerns or suggested changes.

   review:    <review_path>
   verdict:   <verdict>

   If you wanted to regenerate the plan with different inputs, use:
     /os write-change <change> --force_replan=true
   ```

   Then stop.

### Step 3: Read context

Re-read the same context that PLAN read originally, so the revised plan stays grounded in the actual repo state:

1. Read the repo entity at `vault/wiki/<domain>/entity/<repo>.md`. Extract `local_path`, `default_branch`, `current_branch`, `build_command`, `test_command`, `language`, conventions. The plan's file references must remain valid against `default_branch` (where EXECUTE will branch from).
2. If `vault/wiki/development/repo-knowledge/repo-knowledge-<owner>-<repo>.md` exists, read it as authoritative supplement to the entity's Conventions section.
3. Resolve `read_path` (the cache for this repo) the same way PLAN did:
   - First choice: `.claude/state/pr-review-cache/<owner>/<repo>/` (the read-only cache; populated by [[dev-cache-pr-review-repo]]).
   - Fallback: `local_path` (the user's writable clone). Use ONLY if the cache is missing; do NOT spawn `dev-cache-pr-review-repo` from here — that's PLAN's job, not REVISE's. If neither exists, refuse with: `no readable repo source — run /os write-change <change> first.`
4. Re-walk files referenced in the plan + any new files implied by the review findings. Use Read/Grep/Glob only — this skill is read-only against the repo (same as PLAN).

### Step 4: Compose the revised plan

Produce a NEW plan that:

1. Keeps the SAME structure as the PLAN template ([[dev-write-change]] § "Plan template"):
   - Intent
   - Approach (numbered steps)
   - Files I will modify
   - Files I will create
   - Files I will NOT touch
   - Tests
   - Risk
   - Out-of-scope concerns surfaced
2. Addresses every Concerns item (blockers + concerns + nits) by either:
   - Incorporating the suggested resolution into the relevant section, or
   - Explicitly noting in the section why the finding does not apply (e.g. `// nit acknowledged — kept as-is because <reason>`). Don't silently drop findings; the audit trail is the point.
3. Addresses every Suggested changes item the same way — incorporated or explicitly justified.
4. Appends a new section at the END of the body titled `## Revision <N> notes`, where `<N>` is `(prior plan_revision || 1) + 1`. List each finding the revision addressed, in the form:

   ```
   - [from review rev 1] <one-line summary of finding> — <how this revision addresses it>
   ```

   This is the auditable diff between revisions. Future readers (and the next dev-review-change pass, if run) will look here.

5. **Emit a `findings_absorbed` self-report as frontmatter on the revised plan file.** After composing the plan body, classify the revise into one of three states based on how comprehensively it addressed the prior review:
   - `full` — every prior-review finding was addressed (acted on OR explicitly justified-as-not-fixable in the revise notes)
   - `partial` — some findings addressed, others deferred to a follow-up
   - `none` — no findings were addressable (e.g. they were misframed; the revise pushed back rather than absorbing)

   Emit the classification as YAML frontmatter at the TOP of the revised plan file:

   ```yaml
   ---
   findings_absorbed: full | partial | none
   findings_absorbed_note: "<one sentence justifying the classification, e.g. 'all 5 plan-review concerns addressed inline; cursor-coupling fix is in §3'>"
   ---
   ```

   Append a one-line cross-reference at the bottom of the `## Revision <N> notes` section so a human-only reader notices the structured field:

   ```
   Findings absorption: **<full | partial | none>** — see `findings_absorbed` in frontmatter.
   ```

   The classification is the model's own honest judgment about the revise it just produced. The Overseer audits it later for honesty — over-claiming `full` when the next review still finds prior concerns will show up as a calibration signal in subsequent audits.

### Step 5: Write outputs

1. **Overwrite the plan file** at `plan_path` with the revised content. Same filename — git history covers the per-revision diff.
2. **Update the change entry's frontmatter** (via Edit tool):
   - `plan_revision: <N+1>` (where N is the prior value, defaulting to 1 if unset — so first revision becomes 2)
   - `plan_revised_at: <ISO 8601 UTC now>`
   - `plan_revised_from_review: <review_path>`
   - `plan_generated_at: <ISO 8601 UTC now>` (the revised plan IS the most recent generation; keep this field semantically "most recent plan write")
   - `updated: <ISO 8601 UTC now>`
   - **DO NOT touch** `review_status`, `review_path`, `reviewed_at`. The prior verdict still describes the prior plan revision — the user can manually re-run dev-review-change for a fresh verdict.

### Step 6: Audit log + summary

Record the revision event via the dual-write wrapper:

```bash
node scripts/record-dashboard-action.mjs \
  --action revise-plan \
  --skill dev-revise-plan \
  --args '{"change":"<id>","plan_revision":<N+1>,"findings_addressed":<count>}' \
  --files-touched '["<plan_path>","<change_entry>"]'
```

Print:

```
✓ Plan revised for <title>
  revision:           <N+1>
  findings addressed: <count>
  plan:               vault/output/<domain>/changes/<change>-plan.md
  review_status:      <prior verdict — unchanged>   (was: <prior verdict>)
  next:               /os write-change <change>      (execute the revised plan)
                      /os review-change <change>     (optional — re-review the revised plan)
```

## Outputs

- Plan markdown at `vault/output/<domain>/changes/<change>-plan.md` (overwrites prior revision)
- Change entry frontmatter: `plan_revision`, `plan_revised_at`, `plan_revised_from_review`, `plan_generated_at`, `updated` set/bumped
- Audit log line

## Errors

- Change not found / not `type=change` → reject with id
- Status past planning (`in-progress` / `in-review` / `merged` / `abandoned`) → reject; plan is downstream of code at that point
- No `plan_path` → instruct user to run `/os write-change <change>` first
- No `review_path` → instruct user to run `/os review-change <change>` first
- Review has no concerns and no suggested changes → refuse with the message in Step 2
- Plan or review file missing on disk (path exists in frontmatter but file is gone) → instruct user to regenerate via the appropriate skill

## What this skill must NOT do

- Touch any code in `repos/<repo>/` — same read-only constraint as PLAN
- Create branches, run tests, run builds
- Modify `review_status`, `review_path`, `reviewed_at` (those describe the prior review, not this revision)
- Modify any field on the change entry beyond the five listed in Step 5

If you need different semantics (e.g. a re-plan from scratch), use `/os write-change <change> --force_replan=true` instead.

## See also

- [[dev-write-change]] — PLAN/EXECUTE/ADDRESS-COMMENTS phases. This skill sits between PLAN+REVIEW and EXECUTE.
- [[dev-review-change]] — produces the review this skill consumes.
- [[archetype-change]] — `plan_revision`, `plan_revised_at`, `plan_revised_from_review` field definitions.
- [[standard-change-workflow]] — full state machine + how the revise loop fits in.
