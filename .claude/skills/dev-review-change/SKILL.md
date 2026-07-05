---
name: dev-review-change
description: 'Peer-reviews a plan produced by dev-write-change. Read-only: walks the plan + repo + repo conventions, runs a structured checklist, writes a verdict (approve / request-changes / reject) plus concerns.'
user-invocable: true
recommended_effort: max
version: 1
domain: development
tags: [change, review, peer-review]
inputs:
  change:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Change id whose plan to review. The change entry must have plan_path set (i.e. dev-write-change PLAN phase has run).'
outputs:
  - kind: file
    path: vault/output/{{input.domain}}/changes/{{input.change}}-review.md
spawns: []
model: claude-fable-5
effort: max
wall_time_cap_minutes: 60
---

# dev-review-change

## Purpose

Act as a peer reviewer for a plan produced by `dev-write-change`. Read the plan, the change entry, and the repo state — then produce a structured verdict (approve / request-changes / reject) with specific concerns.

**Read-only operation.** This skill must NOT edit code, NOT create branches, NOT run tests. It reads + writes one artifact (the review document) + updates one frontmatter field (`review_status`) on the change entry. Nothing else. The separation is the point — the writer agent CAN edit code; the reviewer agent CANNOT. If something feels like it should be acted on, that's evidence FOR a `request-changes` verdict (because the writer should do it), not evidence to do it directly.

## Procedure

### Step 1: Validate

1. Read the change entry at `vault/wiki/<domain>/change/<change>.md`. Reject if missing or `type != change`.
2. Verify `plan_path` is set + the plan file exists at that path. If not: `plan missing — run dev-write-change <id> first`.
3. Verify `review_status == "pending"` (or `request-changes` for re-review after a re-plan). If `approved`/`rejected`/`overridden`/`not-required`: `review already complete (review_status=<X>). To re-review, set review_status: pending on the change entry first.`
4. Read the repo entity at `vault/wiki/<domain>/entity/<repo>.md`. Extract: `local_path`, `current_branch`, `default_branch`, `build_command`, `test_command`, `language`, conventions from the body.

### Step 2: Read the plan

1. Read `plan_path` in full. Parse the structured sections:
   - Intent
   - Approach (numbered steps)
   - Files I will modify
   - Files I will create
   - Files I will NOT touch
   - Tests
   - Risk
   - Out-of-scope concerns surfaced

### Step 3: Read the standards + inspect the repo

**Universal standards** — Read both before reviewing:

- `vault/wiki/_seed/development/reference/standard-code-quality.md` (code shape, deps, BC, security, tests, comments)
- `vault/wiki/_seed/development/reference/standard-git-hygiene.md` (branch + commit + PR conventions)

These are the floor every plan must meet. Repo-specific overrides (in the entity entry's `## Conventions` section) take precedence where they conflict, but the standards' protections (security, BC, tests required, etc.) are baseline.

**Resolve the read path first** — review against the same repo state PLAN saw, not whatever branch the user's clone happens to be on (the plan was composed from the `default_branch` snapshot; `local_path` may be on a different feature branch or dirty). Same resolution as [[dev-revise-plan]]: first choice `.claude/state/pr-review-cache/<owner>/<repo>/` (do NOT spawn the cache skill — freshening is PLAN's job; use what's there), fall back to `local_path`, and refuse with `no readable repo source — neither the pr-review cache nor local_path exists` when neither is available. All reads in this step and step 4 use `read_path`.

**Repo inspection** — For each file listed under "Files I will modify": read the current content. For each file listed under "Files I will create": read the directory it'll live in to confirm the placement matches conventions.

Read:

- Repo's style configs (`biome.json` / `.prettierrc` / `pyproject.toml [tool.ruff]` / `.editorconfig`)
- A few existing test files to see how the repo writes tests
- Any architectural docs in the repo (README, CONTRIBUTING, ADR/decisions dirs)
- The `CONTRIBUTING.md` if present (PR conventions)
- The repo entity's `## Conventions` section (overrides)

Stay read-only. Use Read/Grep/Glob.

### Step 4: Run the checklist

Walk the categories below. Note specific findings.

**Scope discipline**

- Does the plan stay within the change entry's stated scope?
- Does "Files I will NOT touch" cover all tempting-but-out-of-scope adjacents?
- Any "while I'm in there" creep in the Approach section?

**Repo convention alignment**

- Code style: will the planned edits respect the configured formatter?
- Test framework: are planned tests using the actual framework the repo uses (vitest vs jest vs pytest etc)?
- File placement: are new files going where similar existing files live?
- Naming conventions: do new symbols follow the repo's naming patterns?

**Risk** (per [[standard-code-quality]] § 3, § 4)

- Auth boundaries / data migrations / public API touched?
- Breaking changes implied? Justified per `standard-code-quality` § 3 (consumers identified, migration path, additive alternative considered)?
- Security: any disabled checks (`--no-verify`, `--insecure`, eval on untrusted), unparameterized SQL, secrets at risk?
- Backward compatibility considered?
- Any "Risk" item in the plan that the user actually understated?

**Test coverage** (per [[standard-code-quality]] § 5)

- New code paths have planned tests?
- Tests use the actual framework the repo uses (read existing tests to verify)?
- Edge cases enumerated (or trivially complete)?
- Test count appropriate for change size? (small change should have a few tests; large change should have many)
- Any existing tests likely to break that the plan didn't surface?

**Existing code respect** (per [[standard-code-quality]] § 1, § 7)

- Does the plan reuse existing utilities / hooks / patterns?
- Anything being reinvented that already exists in the repo? Search before deciding — use Grep generously.
- New dependencies introduced? Justified in plan's § Risk per `standard-code-quality` § 2?

**Git hygiene** (per [[standard-git-hygiene]])

- Branch name follows the repo's convention (entity-overridden) or the standard's `<prefix>/<slug>` shape?
- Commit plan reasonable — one logical change per commit, not a 50-file mega-commit?
- If the repo uses conventional commits, does the plan's commit shape match (`feat:` / `fix:` / `chore:` etc.)?

### Step 5: Compose verdict

Pick ONE:

- **approve** — plan is sound, no blockers, minor nits at most
- **request-changes** — substantive concerns; writer should address before executing
- **reject** — fundamental issue; the change as planned shouldn't proceed at all (e.g., wrong approach entirely, scope catastrophically off, would break critical systems)

Threshold guidance:

- Use **approve** generously when concerns are nit-level. Don't gate on style preferences.
- Use **request-changes** when at least one concern is `concern` or `blocker` severity.
- Use **reject** sparingly — only when the right path forward is "throw out this plan and start over".

### Step 6: Write the review

Write to `vault/output/<domain>/changes/<change>-review.md`. Use this exact structure:

```markdown
# Review — <title>

**Reviewed:** <ISO>
**Plan:** <plan_path>
**Verdict:** approve | request-changes | reject

## TL;DR

<one sentence: what's good, what's concerning, what's blocking>

## Checklist

### Scope discipline
- [x] / [ ] Plan stays within change entry's stated scope
- [x] / [ ] "Files I will NOT touch" correctly excluded
<notes if relevant>

### Repo convention alignment
- [x] / [ ] Code style matches repo's configured formatter
- [x] / [ ] Test framework correct
- [x] / [ ] File placement follows conventions
- [x] / [ ] Naming conventions respected
<notes>

### Risk
- [x] / [ ] No touches to auth / data migrations / security (or justified)
- [x] / [ ] No breaking API changes (or justified)
- [x] / [ ] Backward compatibility considered
<notes>

### Test coverage
- [x] / [ ] New code has planned tests
- [x] / [ ] Edge cases enumerated
- [x] / [ ] Test count appropriate for change size
<notes>

### Existing code respect
- [x] / [ ] Reuses existing utilities / patterns
- [x] / [ ] Doesn't reinvent existing functionality
<notes>

## Concerns

(skip section if verdict is approve and there are no concerns)

- **blocker** — <what + why it blocks + suggested resolution>
- **concern** — <what + why it concerns + suggested resolution>
- **nit** — <what>

## Suggested changes

(only if verdict is request-changes — concrete revisions for the writer to make in the re-plan)

1. <specific change to the plan>
2. <specific change>
```

### Step 7: Update the change entry

Edit the change entry's frontmatter:

- `review_status`: `approved` | `request-changes` | `rejected` (match your verdict)
- `review_path`: `vault/output/<domain>/changes/<change>-review.md`
- `reviewed_at`: ISO 8601 UTC now
- `updated`: ISO 8601 UTC now

### Step 8: Audit log + summary

Record the review event via the dual-write wrapper:

```bash
node scripts/record-dashboard-action.mjs \
  --action review-change \
  --skill dev-review-change \
  --args '{"change":"<id>","verdict":"<verdict>"}' \
  --files-touched '["<review_path>","<change_entry>"]'
```

Print:

```
<✓ if approve, ⚠ if request-changes, ✗ if reject> Review complete for <title>
  verdict:   <verdict>
  blockers:  <N>
  concerns:  <N>
  nits:      <N>
  review:    vault/output/<domain>/changes/<change>-review.md
  next:      <appropriate next-step text — see below>
```

`next:` text per verdict:

- `approve` → `/os write-change <change>` (executes the plan)
- `request-changes` → `/os write-change <change> --force_replan=true` (or override / abandon)
- `reject` → `edit change entry, set status: abandoned` (this skill writes the verdict; the user decides whether to set status — when they do, run the abandon-cleanup step below)

### Abandon cleanup (only when status becomes `abandoned`)

When the user explicitly sets `status: abandoned` on the change entry — typically after a `reject` verdict or an `overridden` review that didn't pan out — perform this cleanup to keep `vault/output/` from accumulating orphan artifacts:

1. Compute the archive bucket: `vault/output/<domain>/changes/.archived/<YYYY-MM-DD>/`. Create the directory if missing.
2. Move (don't copy) the plan file from `plan_path` into the bucket if it exists. Preserve the filename.
3. Move the review file from `review_path` into the bucket if it exists.
4. Update the change entry's frontmatter:
   - `plan_path: vault/output/<domain>/changes/.archived/<YYYY-MM-DD>/<slug>-plan.md` (or null if you'd rather drop the reference)
   - `review_path: vault/output/<domain>/changes/.archived/<YYYY-MM-DD>/<slug>-review.md`
   - Leave the rest of the frontmatter alone (status, review_status, etc.)
5. Append a brief note to the change body under `## Abandoned` documenting the date + reason, so the trail is preserved even when the artifacts move.

This step is **idempotent** — if the artifacts are already in `.archived/`, skip. Never delete; the abandoned trail may be useful as precedent for future changes.

## Outputs

- Review markdown at `vault/output/<domain>/changes/<change>-review.md`
- Change entry frontmatter: `review_status`, `review_path`, `reviewed_at`, `updated` set
- Audit log line
- (When status transitions to `abandoned`) plan + review files moved to `vault/output/<domain>/changes/.archived/<date>/`

## Errors

- Change not found → reject with id
- `plan_path` not set on change entry → instruct user to run `/os write-change <id>` first
- Plan file missing → instruct user to re-run write-change
- Already reviewed (`review_status` already terminal) → instruct user to reset to `pending` first

## What this skill must NOT do

- Edit code in `repos/<repo>/`
- Create branches
- Run tests
- Mutate the plan file (the plan is the writer's artifact, not the reviewer's)
- Modify any frontmatter beyond the four review-gate fields on the target change entry

If you're tempted to act on a concern directly, that's an `approve` (the concern is moot) or `request-changes` (the writer should address it). The reviewer NEVER acts on the code itself.

## See also

- [[standard-change-workflow]] — review state machine + override path
- [[dev-write-change]] — produces the plan this skill reviews + consumes the verdict
- [[archetype-change]] — change archetype + review-gate fields
- [[dev-pr-review]] — reviews actual PRs (post-execute); orthogonal to this skill (which reviews PLANS, pre-execute)
