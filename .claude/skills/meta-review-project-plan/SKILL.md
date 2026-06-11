---
name: meta-review-project-plan
description: 'Peer-review a project plan produced by research-write (formerly the meta-research-project alias). Read-only: walks the plan + cited repos + project body, produces a structured verdict (approve | request-changes | reject) with concerns. Writes review to vault/output/<domain>/project-plans/.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: meta
tags: [project, plan, review, peer-review, orchestration]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Project id (slug). Must match an existing `type: project` entry with `plan_path` set and the plan file present on disk.'
outputs:
  - kind: file
    path: vault/output/{{input.domain}}/project-plans/{{input.project}}-plan-review.md
  - kind: frontmatter
    path: vault/wiki/{{input.domain}}/project/{{input.project}}.md
    fields: [review_path, reviewed_at, review_status, updated]
spawns: []
---

# meta-review-project-plan

## Purpose

Act as a peer reviewer for a project plan produced by [[research-write]]. Read the plan, the project body, and the repo state for any repo cited in the plan — then produce a structured verdict (approve / request-changes / reject) with specific concerns.

**Read-only operation.** This skill MUST NOT edit code, MUST NOT create branches, MUST NOT run tests, MUST NOT mutate the plan file. It reads + writes one artifact (the review document) + updates a small set of frontmatter fields on the project entry. Nothing else. Same separation principle as [[dev-review-change]] — the writer skills (research, revise, scaffold) CAN mutate; the reviewer CANNOT. If something feels like it should be acted on, that's evidence FOR a `request-changes` verdict (because revise should do it), not evidence to do it directly.

## Procedure

### Step 1: Validate

1. Validate `inputs.project` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the project entry at `vault/wiki/*/project/<project>.md`. Reject with `project "<id>" not found` if missing or `type != project`.
3. Extract `domain` from project frontmatter.
4. Verify `plan_path` is set AND the file exists at that path. Reject with `no plan to review — run /os research project <id> first` if not.
5. Verify `plan_status: drafted` AND `review_status` is one of:
   - `pending` — the standard path. Both a first review after research AND a re-review after revise land here, because [[meta-revise-project-plan]] resets `review_status: pending`.
   - `request-changes` — the second-opinion path. The user can re-run review on an unrevised plan to confirm or update the prior verdict without going through revise. This is a niche-but-valid use case (e.g. a different reviewer wants a second look at the same plan). It IS deliberate, not a typo.
     Any other state is rejected with `plan review is currently <state> — nothing to review`.

### Step 2: Read the plan

1. Read `plan_path` in full. Parse the structured sections per the template in [[research-write]]:
   - `## Intent (from research prompt)`
   - `## Proposed changes` (numbered)
   - `## Proposed schedules`
   - `## Reporting cadence`
   - `## Reporting touchpoints`
   - `## Materials summary`
   - `## Risks + open questions`
   - `## Revision N notes` (only on revise passes; if present, capture the prior findings the revision was responding to)
2. Read the project entry body for context (the `## Why`, `## Approach`, and any other narrative the user authored).

### Step 3: Read the prior review (continuity)

1. If `plan_review_path` is set AND the file exists, read it. This is a re-review — preserve continuity by referencing prior findings, but produce a FRESH verdict against the current plan revision (don't echo the prior verdict).
2. On first review, skip this step.

### Step 4: Walk the cited repos

1. Resolve the cited repos: every entry in `project.repos[]` becomes a candidate. Filter to the repos actually mentioned in the plan's `## Proposed changes` section (use the prose context; the plan structure has no per-change `repo:` field in v1).
2. For each candidate repo: read its entity entry at `vault/wiki/<domain>/entity/<repo>.md`. Extract `local_path`, `default_branch`, `build_command`, `test_command`, `language`, and the entity body's `## Conventions` section.
3. Walk the repo subtree using Read / Grep / Glob — read-only. The walk's purpose is to sanity-check the plan's claims (the proposed changes look feasible against the actual repo state; sequencing is sensible; risks haven't been understated).
4. Strategy mirrors [[dev-review-change]] Step 3: prefer the OS-managed read cache at `.claude/state/pr-review-cache/<owner>/<repo>/` when present and fresh (within 5 minutes); fall back to `local_path` otherwise.

Stay read-only throughout.

### Step 5: Run the checklist

Walk the categories below. Note specific findings.

**Scope discipline**

- Does the plan stay within the project's stated scope (the `## Why` + `## Approach` in the project body)?
- Are the proposed changes a coherent slice of the project, or does the plan creep into adjacent areas?
- Does any proposed change feel like 2 changes wedged into one row?

**Sequencing**

- Do the `## Proposed changes` numbered steps reflect actual dependencies (depends-on lines correct + no cycles)?
- Do `## Reporting touchpoints` reference change ordinals that exist in `## Proposed changes`?
- Does the proposed schedule cadence interact sensibly with the change sequence (e.g. a daily report on a 5-change project is too noisy)?

**Risk** (per [[standard-code-quality]] § 3, § 4)

- Are the listed risks reasonable for the change set, or are there obvious gaps (auth, data migrations, breaking changes, secrets)?
- Are any proposed changes flagged as `large` that should be split?
- Does the plan's `## Risks + open questions` understate the actual risk profile?

**Repo convention alignment** (when the plan touches a real repo)

- Do the proposed change names + types match the repo's existing convention (per its entity `## Conventions` section)?
- Are file references in the prose plausible (i.e. the cited paths actually exist on disk)?

**Reporting + schedules**

- Is the reporting cadence proportionate to the project size (none / weekly / monthly)?
- Is the reporting target a v1-supported value (`clipboard` is the only fully-wired path per [[archetype-project]] § Reporting object shape)?
- Are the proposed schedules cron-parseable + scoped to plausible cadences?

**Material grounding**

- Does the `## Materials summary` reflect actual material content (not generic boilerplate)?
- If the plan is a revise pass, does `## Revision N notes` actually map to prior findings?

### Step 6: Compose the verdict

Pick ONE:

- **approve** — plan is sound, no blockers, minor nits at most
- **request-changes** — substantive concerns; revise should address before scaffold
- **reject** — fundamental issue; this plan as written shouldn't proceed at all (wrong approach entirely, scope catastrophically off, would commit the project to an unsound trajectory)

Threshold guidance:

- Use **approve** generously when concerns are nit-level. Don't gate on style preferences.
- Use **request-changes** when at least one concern is `concern` or `blocker` severity.
- Use **reject** sparingly — only when the right path forward is "throw out this plan and start over via /os research project <id> with a revised prompt".

### Step 7: Write the review

Write to `vault/output/<domain>/project-plans/<project-id>-plan-review.md`. Use this EXACT structure:

```markdown
# Review — <project.title>

**Reviewed:** <ISO 8601 UTC now>
**Plan:** <plan_path>
**Plan revision:** <N>
**Verdict:** approve | request-changes | reject

## TL;DR

<one sentence: what's good, what's concerning, what's blocking>

## Checklist

### Scope discipline
- [x] / [ ] Plan stays within project's stated scope
- [x] / [ ] Proposed changes are a coherent slice
- [x] / [ ] No change-row hides multiple changes
<notes if relevant>

### Sequencing
- [x] / [ ] Depends-on lines reflect actual dependencies
- [x] / [ ] Touchpoints reference existing change ordinals
- [x] / [ ] Schedule cadence proportionate to change count
<notes>

### Risk
- [x] / [ ] Risks reasonable for change set
- [x] / [ ] No `large`-size change should be split
- [x] / [ ] Risks section is not understated
<notes>

### Repo convention alignment
- [x] / [ ] Change names + types match repo convention
- [x] / [ ] Cited paths exist on disk
<notes>

### Reporting + schedules
- [x] / [ ] Cadence proportionate to project size
- [x] / [ ] Reporting target is v1-supported
- [x] / [ ] Schedules cron-parseable + sensible cadence
<notes>

### Material grounding
- [x] / [ ] Materials summary reflects actual content
- [x] / [ ] Revision N notes map to prior findings (revise passes only)
<notes>

## Concerns

(skip section if verdict is approve and there are no concerns)

- **blocker** — <what + why it blocks + suggested resolution>
- **concern** — <what + why it concerns + suggested resolution>
- **nit** — <what>

## Suggested changes

(only if verdict is request-changes — concrete revisions for meta-revise-project-plan to apply)

1. <specific change to the plan>
2. <specific change>
```

### Step 8: Update project frontmatter

Edit the project entry's frontmatter:

- `review_path: vault/output/<domain>/project-plans/<project-id>-plan-review.md`
- `reviewed_at: <ISO 8601 UTC now>`
- `updated: <ISO 8601 UTC now>`
- `review_status` (the shared enum — see standard-review-state; `plan_status` stays `drafted`):
  - On `approve` verdict → `review_status: approved`
  - On `request-changes` verdict → `review_status: request-changes`
  - On `reject` verdict → `review_status: rejected` (the shared enum has a real terminal for this — the old project dialect did not). The rationale lives in `review_path`; the Step 9 summary’s `next:` line surfaces both recovery paths so the operator is not blind.

### Step 9: Audit log + summary

Record the review event via the dual-write wrapper:

```bash
node scripts/record-dashboard-action.mjs \
  --action project-plan-review \
  --skill meta-review-project-plan \
  --args '{"project":"<id>","verdict":"<verdict>","blockers":<B>,"concerns":<C>,"nits":<N>}' \
  --files-touched '["<plan_review_path>","<project_entry>"]'
```

Print:

```
<✓ if approve, ⚠ if request-changes, ✗ if reject> Reviewed plan for <project.title>
  project:   <id>
  verdict:   <verdict>
  revision:  <N>
  blockers:  <B>
  concerns:  <C>
  nits:      <N>
  review:    vault/output/<domain>/project-plans/<project-id>-plan-review.md
  next:      <appropriate next-step text — see below>
```

`next:` text per verdict:

- `approve` → `/os scaffold project plan <id> --items=<comma-list>` (review the plan + pick items, then scaffold)
- `request-changes` → `/os revise project plan <id>` (fold these findings into the plan, then re-review)
- `reject` → `review verdict was REJECT — choose one: (a) /os research project <id> with a revised prompt to re-research from scratch, or (b) manually edit project frontmatter plan_status to pending/abandoned if you want to abandon the plan. The plan_status field will otherwise remain at its prior value, and the rejection lives only in plan_review_path.`

## Outputs

- Review markdown at `vault/output/<domain>/project-plans/<project-id>-plan-review.md`
- Project entry frontmatter: `review_path`, `reviewed_at`, `updated` set; `review_status` flipped per verdict (`plan_status` stays `drafted`)
- Audit log line

## Errors

- `inputs.project` slug invalid → reject with the regex
- Project not found / not `type: project` → reject with id
- `plan_path` not set → instruct user to run `/os research project <id>` first
- Plan file missing on disk → instruct user to re-run research
- `plan_status` is not `drafted`, or `review_status` is anything other than `pending` / `request-changes` → reject with the actual state

## What this skill must NOT do

- Edit code in any repo
- Create branches, run tests, run builds
- Mutate the plan file (the plan is the writer's artifact, not the reviewer's)
- Modify any project frontmatter beyond `review_path`, `reviewed_at`, `review_status`, `updated`

If you're tempted to act on a concern directly, that's an `approve` (the concern is moot) or `request-changes` (revise should address it). The reviewer NEVER acts on the plan or the repo itself.

## See also

- [[standard-project-workflow]] — full plan-lifecycle state machine + review-gate fields
- [[archetype-project]] — project archetype + the `plan_status` lifecycle and shared `review_status` enums
- [[research-write]] — produces the plan this skill reviews (formerly via the deleted `meta-research-project` alias)
- [[meta-revise-project-plan]] — consumes this skill's verdict + folds findings into the plan
- [[meta-scaffold-project-plan]] — terminal phase, only fires after `review_status: approved`
- [[dev-review-change]] — the change-side analogue; this skill mirrors its read-only constraint
