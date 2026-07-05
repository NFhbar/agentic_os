---
name: meta-reopen-project
description: "Reopen a previously-completed project — vault-only frontmatter flip from `status: completed` back to `status: active` (and lifecycle_stage to `active`, clearing `completed_at`). Used when a post-Complete gap surfaces and the project needs to absorb additional work before re-closing."
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [project, lifecycle, vault-only]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Project id (must reference an existing project entity in `vault/wiki/<domain>/project/<id>.md`)
outputs:
  - kind: frontmatter
    path: vault/wiki/<domain>/project/<project>.md
    fields: [status, lifecycle_stage, completed_at, updated]
---

# meta-reopen-project

## Purpose

Inverse of the project's `Complete` action. The OS's project lifecycle terminates at `status: completed`; this skill un-completes a project by flipping the frontmatter back to `active`. The dashboard exposes the same operation via the **Reopen** button on the project's status banner (see `POST /api/projects/:id/reopen`); this skill is the CLI dispatch path so the OS works without the dashboard server.

Gated on `status === 'completed'` — refuses on already-active / unknown projects to avoid surprising state flips.

## Procedure

1. **Locate the project entry** by walking `vault/wiki/*/project/*.md` for a file whose frontmatter `id` matches `inputs.project` and `type` is `project`. Reject with `project "<id>" not found` if nothing matches.

2. **Validate current state**. Parse the file's frontmatter:
   - If `status !== 'completed'`: reject with `project "<id>" has status: <current> — nothing to reopen (only completed projects can be reopened)`. Hard fail; print the current status so the user can debug.

3. **Surgical frontmatter rewrite**. Compute `now` = ISO 8601 UTC. Edit the file in place:
   - `status: completed` → `status: active`
   - `lifecycle_stage: archived` → `lifecycle_stage: active` (preserve if already different; `active` is the archetype enum's in-flight value — `in-progress` belongs to the change status enum and trips the `project-lifecycle-stage-enum` audit finding)
   - Remove the `completed_at:` line entirely (cleared, not nulled, per the existing pattern at `POST /api/projects/:id/reopen`)
   - Bump `updated:` to `now`

   Use the `Edit` tool with anchored line replacements — DO NOT round-trip through `yaml.dump()` (would distort other frontmatter fields per `standard-wiki-format`). Mirror the surgical edit pattern in `domains/meta/app/server/frontmatter-rewrite.ts::rewriteFrontmatter` + `removeFrontmatterFields`.

4. **Record audit event** via the canonical wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action project-reopen \
     --skill meta-reopen-project \
     --args '{"project":"<project-id>"}' \
     --files-touched '["<relative path to project file>"]' \
     --exit-status 0
   ```

   `--action project-reopen` mirrors the value the dashboard endpoint uses, so the dispatch event for both paths shows up identically in Insights / Replay.

5. **Print summary**:

   ```
   ✓ Reopened project <id>
     status:           completed → active
     lifecycle_stage:  archived → active
     completed_at:     cleared
     updated:          <now>

     next: navigate to /projects/<id> in the dashboard, or scaffold additional
           changes via `/os add change project:<id>`
   ```

## Outputs

- Frontmatter updates on `vault/wiki/<domain>/project/<project>.md`: `status`, `lifecycle_stage`, `updated` written; `completed_at` removed
- One audit event with action `project-reopen` (parallel to the dashboard endpoint's recording)

## Errors

- `project "<id>" not found` — id doesn't match any project entry
- `project "<id>" has status: <current> — nothing to reopen` — already active, paused, cancelled, or in another non-terminal state. The OS only treats `completed → active` as a valid reopen.

## Design notes

- This skill duplicates the file-edit logic of `POST /api/projects/:id/reopen` (in `domains/meta/app/server/routes/projects.ts`). Per OS principle "apps are optional UI over the same files," both paths exist intentionally — the dashboard is the fast UI path; this skill is the CLI/headless path. Drift risk acknowledged; a future `scripts/vault-ops/` shared module would consolidate them.

## See also

- [[archetype-project]] — status enum + lifecycle_stage values
- [[meta-add-project]] — the scaffolder that creates project entries in the first place
- `POST /api/projects/:id/reopen` — the parallel dashboard endpoint
