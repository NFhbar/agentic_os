---
name: meta-revise-project-plan
description: 'Folds findings from a meta-review-project-plan verdict back into the project plan in place. Rewrites the plan, bumps plan_revision, resets review_status to pending so the revised plan goes back through review. Does NOT touch review_path / reviewed_at — those describe the prior verdict.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: meta
tags: [project, plan, revise, review, orchestration]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Project id (slug). Must match an existing `type: project` entry with both `plan_path` and `review_path` set + both files present on disk.'
outputs:
  - kind: file
    path: vault/output/{{input.domain}}/project-plans/{{input.project}}-plan.md
  - kind: frontmatter
    path: vault/wiki/{{input.domain}}/project/{{input.project}}.md
    fields: [plan_revision, plan_revised_at, plan_revised_from_review, plan_generated_at, review_status, updated]
spawns: []
model: claude-fable-5
---

# meta-revise-project-plan

## Purpose

Fold the findings from a [[meta-review-project-plan]] verdict back into the project plan, so the next review pass sees a plan that already addresses the reviewer's concerns and suggested changes.

This is the symmetric counterpart of [[dev-revise-plan]] one altitude up: where `dev-revise-plan` rewrites a single change's plan to address change-review findings, this skill rewrites a project's plan to address project-review findings.

**The verdict from the prior review is preserved on disk** — this skill does NOT touch `review_path` or `reviewed_at`. Those describe the PRIOR plan revision's review; the audit trail across revisions is the point. `review_status` IS reset to `pending` because the new plan revision needs a fresh review pass before scaffold can proceed (`plan_status` stays `drafted`).

## Procedure

### Step 1: Validate

1. Validate `inputs.project` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the project entry at `vault/wiki/*/project/<project>.md`. Reject with `project "<id>" not found` if missing or `type != project`.
3. Extract `domain` from project frontmatter.
4. Verify `plan_path` is set AND the file exists. Reject with `no plan to revise — run /os research project <id> first`.
5. Verify `review_path` is set AND the file exists. Reject with `no review findings to apply — run /os review project plan <id> first`.
6. Extract `plan_revision` (default `1` if unset — legacy entries).

### Step 2: Read inputs

1. Read the plan file at `plan_path` in full.
2. Read the review file at `review_path` in full. Parse:
   - **Verdict** from the header (`approve` | `request-changes` | `reject`)
   - **Concerns section** — `blocker` / `concern` / `nit` items, each with description + suggested resolution
   - **Suggested changes section** — numbered list of concrete revisions (only present on `request-changes` verdicts)

### Step 3: Refusal gate — nothing to revise

If the review has ZERO items in BOTH `## Concerns` AND `## Suggested changes`, refuse:

```
✗ Nothing to revise — the review has no concerns or suggested changes.

review:    <review_path>
verdict:   <verdict>

If you wanted to regenerate the plan with different inputs, use:
  /os research project <project>   (re-runs research, bumps plan_revision)
```

Then stop.

### Step 4: Re-read context

The revised plan stays grounded in the same context the original research ingested. Re-read what's available:

1. Re-walk the drop zone at `vault/raw/project-research/<project-id>/` using the same FIFO-by-mtime + chunked-PDF pattern documented in [[research-write]] § PDF handling. Truncation rules from `material_limit` do NOT apply here — the revise pass reads what's on disk now, no cap (this skill is a refinement, not a fresh research pass).
2. Read the project entry body for current narrative (`## Why`, `## Approach`).
3. Read the entity entries for each repo in `project.repos[]` to capture any convention drift since the original plan.

### Step 5: Compose the revised plan

Produce a NEW plan that:

1. Keeps the SAME structure as the original plan template (authored by [[research-write]], formerly the `meta-research-project` alias):
   - `# Plan — <project.title>` (header with bumped `**Revision:** <N+1>`)
   - `## Intent (from research prompt)`
   - `## Proposed changes`
   - `## Proposed schedules`
   - `## Reporting cadence`
   - `## Reporting touchpoints`
   - `## Materials summary`
   - `## Risks + open questions`
2. Addresses every Concerns item (blockers + concerns + nits) by either:
   - Incorporating the suggested resolution into the relevant section, OR
   - Explicitly noting in the section why the finding does not apply (e.g. `// nit acknowledged — kept as-is because <reason>`). Don't silently drop findings; the audit trail is the point.
3. Addresses every Suggested-changes item the same way — incorporated or explicitly justified.
4. Appends a NEW `## Revision <N+1> notes` section at the END of the body, listing each addressed finding in the form:
   ```
   - [from review rev <prior_N>] <one-line summary of finding> — <how this revision addresses it>
   ```
   This is the auditable diff between revisions. Future readers (and the next [[meta-review-project-plan]] pass) will look here.
5. Preserves any prior `## Revision K notes` sections from the existing plan body verbatim (chronological order, oldest first) so the full revision trail is visible in one file.

### Step 6: Write the plan file

1. Overwrite `plan_path` with the revised content. Same filename — the in-body `## Revision N notes` sections + audit log carry per-revision history.

### Step 7: Update project frontmatter

Edit the project entry's frontmatter:

- `plan_revision: <N+1>` (where N is the prior value, defaulting to 1 if unset; first revision becomes 2)
- `plan_revised_at: <ISO 8601 UTC now>`
- `plan_revised_from_review: <review_path>`
- `plan_generated_at: <ISO 8601 UTC now>` (keep this field semantically "most recent plan write")
- `review_status: pending` (forces a re-review of the revised plan — the prior verdict no longer describes the current revision; `plan_status` stays `drafted`)
- `updated: <ISO 8601 UTC now>`
- **DO NOT touch** `review_path` or `reviewed_at`. The prior verdict still describes the prior plan revision on disk; that information stays load-bearing for the audit trail.

### Step 8: Audit log + summary

Record the revision event via the dual-write wrapper:

```bash
node scripts/record-dashboard-action.mjs \
  --action project-plan-revise \
  --skill meta-revise-project-plan \
  --args '{"project":"<id>","plan_revision":<N+1>,"findings_addressed":<count>}' \
  --files-touched '["<plan_path>","<project_entry>"]'
```

Print:

```
✓ Revised project plan for <project.title>
  project:            <id>
  revision:           <N+1>
  findings addressed: <count>   (blockers: <B>, concerns: <C>, nits: <Nt>)
  plan:               vault/output/<domain>/project-plans/<project-id>-plan.md
  review_status:      pending   (re-review required before scaffold)
  next:               /os review project plan <id>   (verify the revised plan clears concerns)
```

## Outputs

- Revised plan markdown at `vault/output/<domain>/project-plans/<project-id>-plan.md` (overwrites prior revision; history preserved via in-body `## Revision N notes` sections)
- Project entry frontmatter: `plan_revision` bumped, `plan_revised_at` + `plan_revised_from_review` + `plan_generated_at` + `updated` set, `review_status: pending`. `review_path` + `reviewed_at` UNCHANGED.
- Audit log line

## Errors

- `inputs.project` slug invalid → reject with the regex
- Project not found / not `type: project` → reject with id
- `plan_path` not set or file missing → instruct user to run `/os research project <id>` first
- `review_path` not set or file missing → instruct user to run `/os review project plan <id>` first
- Review has zero concerns AND zero suggested changes → refuse with the message in Step 3

## What this skill must NOT do

- Edit code in any repo
- Create branches, run tests, run builds
- Modify `review_path`, `reviewed_at` (those describe the prior review, not this revision)
- Modify any project frontmatter beyond the six listed in Step 7

If you need different semantics (e.g. throw out the plan and start fresh), use `/os research project <id>` instead — that re-runs research with a fresh prompt + bumps `plan_revision`.

## See also

- [[standard-project-workflow]] — full plan-lifecycle state machine
- [[archetype-project]] — project archetype + plan-tracking fields
- [[research-write]] — produces the initial plan this skill revises (formerly via the deleted `meta-research-project` alias)
- [[meta-review-project-plan]] — produces the review this skill consumes
- [[meta-scaffold-project-plan]] — terminal phase; only fires after the revised plan re-passes review (`plan_status: approved`)
- [[dev-revise-plan]] — the change-side analogue; this skill mirrors its structural pattern
