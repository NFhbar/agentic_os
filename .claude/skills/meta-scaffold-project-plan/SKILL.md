---
name: meta-scaffold-project-plan
description: 'Terminal phase of project orchestration. Gated on plan_status=approved. Auto-sorts inputs.items into canonical dispatch order (changes → schedules → reporting-cadence → touchpoints), then dispatches dev-add-change / meta-add-schedule / direct frontmatter edits to materialize the approved plan.'
user-invocable: true
version: 1
domain: meta
tags: [project, plan, scaffold, orchestration]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Project id (slug). Must match an existing `type: project` entry with `plan_status: approved`.'
  items:
    type: array
    required: true
    description: 'Explicit list of plan-step ids to scaffold (e.g. ["change-1","change-2","schedule-1","reporting-cadence","touchpoint-1"]). Empty array is a no-op (idempotent stop, no frontmatter mutation). Each id must resolve to a step in the plan; unknown ids cause a hard reject before any dispatch begins.'
outputs:
  - kind: frontmatter
    path: vault/wiki/{{input.domain}}/project/{{input.project}}.md
    fields: [plan_status, updated]
  - kind: file
    path: vault/wiki/{{input.domain}}/change/<...>.md
    description: 'One change entry per scaffolded change step (created by dev-add-change). Each carries derived_from_plan + plan_step + plan_revision_at_scaffold extra frontmatter.'
  - kind: file
    path: vault/wiki/{{input.domain}}/runbook/<...>.md
    description: 'One runbook entry per scaffolded schedule step (created by meta-add-schedule). Each carries project: <project-id> so the scheduler tick gates on project status.'
spawns: [dev-add-change, meta-add-schedule]
---

# meta-scaffold-project-plan

## Purpose

Materialize an approved project plan into concrete OS artifacts — change entries, runbook entries (schedules), reporting-cadence frontmatter, and reporting-touchpoint markers. This is the **terminal phase** of the project-orchestration lifecycle: research → review → (revise+re-review)\* → approve → **scaffold**.

The skill is **gated on `plan_status: approved`**. Any other state is rejected — the review verdict is load-bearing because scaffolding creates real wiki entries that downstream skills will pick up, and uncritically materializing an unreviewed plan defeats the entire orchestration loop.

Per-item opt-in is the convention: `inputs.items` is an explicit list of plan-step ids. The user (or the dashboard's Plan tab confirm dialog) picks which steps to scaffold. Items not in the list are left for a future scaffold call.

## Procedure

### Step 1: Validate

1. Validate `inputs.project` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the project entry at `vault/wiki/*/project/<project>.md`. Reject with `project "<id>" not found` if missing or `type != project`.
3. Extract `domain` from project frontmatter.
4. Verify `plan_path` is set AND the file exists. Reject with `no plan to scaffold — run /os research project <id> first` if not.
5. Verify `plan_status == "approved"`. Reject any other state with: `cannot scaffold — plan_status is <state>, expected approved`.
6. If `inputs.items` is an empty array: idempotent stop. Print `↻ No items selected — nothing to scaffold.` Do NOT mutate any frontmatter. Done.

### Step 2: Parse the plan into a step map

1. Read the plan file in full.
2. Walk the structured sections and build an in-memory map keyed by stable step ids derived from `<section-kind>-<ordinal>`:
   - For each numbered entry under `## Proposed changes` → `change-1`, `change-2`, …
   - For each numbered entry under `## Proposed schedules` → `schedule-1`, `schedule-2`, …
   - `## Reporting cadence` → `reporting-cadence` (single entry; not numbered)
   - For each numbered entry under `## Reporting touchpoints` → `touchpoint-1`, `touchpoint-2`, …
3. Each map entry carries `{id, kind: change|schedule|reporting-cadence|touchpoint, ordinal: <N>, payload: <parsed row>}`. The payload's shape depends on `kind`:
   - **change**: `{name, title, type, size, why, depends_on}`
   - **schedule**: `{name, cron, prompt, purpose}`
   - **reporting-cadence**: `{cadence, target}`
   - **touchpoint**: `{label, fires_after, report_type}` — `fires_after` is the change ordinal text the touchpoint references; resolve to a change slug via the matching `change-<ordinal>` step in the map.

### Step 3: Resolve inputs.items

1. For each id in `inputs.items`: confirm it resolves to a step in the map.
2. If ANY id is unknown: hard reject before any dispatch begins. Print the list of unknown ids + the full set of known ids. Partial scaffolds are confusing — fail fast.

### Step 4: Canonical dispatch sort

Sort `inputs.items` into canonical dispatch order BEFORE dispatch begins:

1. All `change-*` items first, in plan ordinal order (ascending).
2. All `schedule-*` items next, in plan ordinal order.
3. `reporting-cadence` next (if present).
4. All `touchpoint-*` items last, in plan ordinal order.

Rationale: touchpoints write `on_merge_report: <type>` to an existing change entry's frontmatter, which requires the change to already exist. Canonical sort + the in-plan ordinal order for changes guarantees this dependency is satisfied without forcing the user to construct a dependency-aware ordering for `inputs.items`.

Both the user's original `inputs.items` order AND the canonical dispatch order are recorded in the print summary (Step 7) and the audit event (Step 8) so the audit trail is honest about what executed.

### Step 5: Dispatch in canonical order

For each selected item, dispatch according to `kind`. Capture per-item outcomes (target id + success/failure) for the Step 7 summary.

#### change step

1. Invoke `dev-add-change` with:
   - `name`: from `payload.name`
   - `title`: from `payload.title`
   - `domain`: from `project.domain`
   - `repo`: `project.repos[0]` for v1. If the plan ever carries a per-step `repo:` field in a future revision, that field takes precedence. (Multi-repo composition is an explicit v2 concern — see the plan template’s Out-of-scope notes.)
   - `type`: from `payload.type`
   - `size`: from `payload.size`
   - `description`: from `payload.why` (the "Why" line for the step)
   - `project`: `<project-id>` (composes the change into the project; satisfies the manifest's backlink resolution)
2. After `dev-add-change` succeeds, surgically Edit three EXTRA frontmatter fields onto the created change entry (use the Edit tool against the new file's frontmatter):
   - `derived_from_plan: <plan_path>`
   - `plan_step: <ordinal>` (the integer N from `change-<N>`)
   - `plan_revision_at_scaffold: <project.plan_revision>` (the project's current plan_revision at scaffold time)
3. Record the created file path for the audit event's `files-touched`.

#### schedule step

1. Invoke `meta-add-schedule` with:
   - `name`: from `payload.name`
   - `title`: derived from `payload.name` (humanize the slug if no explicit title)
   - `domain`: from `project.domain`
   - `schedule`: from `payload.cron`
   - `prompt`: from `payload.prompt`
   - `project`: `<project-id>` (the scheduler tick will gate firing on project `status: active`)
2. Record the created runbook path for the audit event.

#### reporting-cadence

1. Directly Edit the project entry's frontmatter:
   - `reporting.cadence: <payload.cadence>`
   - `reporting.target: <payload.target>`
2. **Leave `reporting.target_ref`, `reporting.last_sent`, `reporting.next_due` UNTOUCHED** on this dispatch. Those fields are owned by the future `meta-status-report` skill (last_sent stamps after each send; next_due derived from cadence at send time; target_ref populated only when a non-clipboard target is wired). If any of those three fields are absent from the project frontmatter pre-scaffold, leave them absent — do NOT seed `null` values. Per [[archetype-project]] the audit's `project-reporting-shape` check tolerates absence; injecting `null`s creates a half-populated shape the dashboard renderer treats as "configured but empty", which is a worse failure mode than absence.

#### touchpoint

1. Resolve `payload.fires_after` (the change ordinal text) to the corresponding `change-<N>` step in the map → resolve that to the created change entry's slug (either created earlier in this same scaffold run, or pre-existing from a prior scaffold).
2. If the target change entry does NOT exist on disk: this is a partial-failure (Step 6). Surface a clear reason in the per-item outcome (e.g. `target change <slug> not found — touchpoint cannot attach`).
3. Edit the target change entry's frontmatter to add: `on_merge_report: <payload.report_type>`.

### Step 6: Partial-failure semantics

If ANY sub-dispatch in Step 5 fails mid-loop:

1. **Stop dispatch immediately.** No further items processed.
2. **Do NOT auto-rollback** the already-succeeded items — leaving them on disk is correct (the user can decide whether to keep or manually delete them; rolling back automatically risks deleting work that the user wanted).
3. **Do NOT mutate `plan_status`** — leave it at `approved` so a retry remains valid.
4. Surface a structured per-item outcome block in the print summary, listing EVERY entry in the canonical dispatch order:
   ```
   ✓ change-1     → dev-add-change ok        (created vault/wiki/development/change/<slug>.md)
   ✓ change-2     → dev-add-change ok        (created vault/wiki/development/change/<slug>.md)
   ✗ schedule-1   → meta-add-schedule FAILED (<reason from sub-skill>)
   · reporting-cadence → skipped (prior failure)
   · touchpoint-1 → skipped (prior failure)
   ```
5. Print the explicit retry hint:
   ```
   next: retry with /os scaffold project plan <id> --items=<comma-list> after fixing the failure cause.
         Drop the ✓ items from the list — re-dispatching dev-add-change against an
         already-created change slug will re-fail with "change <name> already exists"
         (per .claude/skills/dev-add-change/SKILL.md procedure step 5).
   ```
6. Record the audit event with the partial-success state (Step 8) so the dashboard can render the same per-item table without the user having to scroll back.
7. Skip Step 7's success path. Stop after the partial-failure summary.

(Auto-skip-on-retry — scanning for already-created artifacts and skipping them on retry instead of re-failing — is explicitly a v2 concern. The explicit per-item summary + retry hint is sufficient for v1 because the user/UI can construct the retry-items set deterministically from the printed table.)

### Step 7: Success path — mark scaffolded + summary

When ALL selected items dispatched successfully:

1. Edit the project entry's frontmatter:
   - `plan_status: scaffolded`
   - `updated: <ISO 8601 UTC now>`
2. Print summary:

   ```
   ✓ Scaffolded project plan for <project.title>
     project:            <id>
     plan revision:      <N>
     items scaffolded:   <count>
     input order:        [<inputs.items, verbatim>]
     dispatch order:     [<canonical sorted order>]

     <per-item outcome block, all ✓>

     next: /os write-change <first-scaffolded-change-slug>   (begin executing the project's first change)
   ```

### Step 8: Audit log

Record one event listing every scaffolded item (per-item outcomes included so a partial-failure run is still auditable from a single event):

```bash
node scripts/record-dashboard-action.mjs \
  --action project-plan-scaffold \
  --skill meta-scaffold-project-plan \
  --args '{"project":"<id>","scaffolded_count":<N>,"input_order":[...],"dispatch_order":[...],"items":[{"id":"change-1","kind":"change","target":"<slug>","outcome":"ok"},...]}' \
  --files-touched '[<every file created or edited, as JSON array>]'
```

When the run was a partial-failure (Step 6), the same audit event runs (with the per-item outcomes reflecting the failure) and `--exit-status` is set to a non-zero value so the dashboard's Insights view surfaces the partial-success state.

## Outputs

- One change entry per scaffolded `change-*` item (created by `dev-add-change`, with `derived_from_plan` + `plan_step` + `plan_revision_at_scaffold` extra fields)
- One runbook entry per scaffolded `schedule-*` item (created by `meta-add-schedule`, with `project: <id>` for status-gated firing)
- Project frontmatter `reporting.cadence` + `reporting.target` updated when `reporting-cadence` was scaffolded
- Target change entry's frontmatter gets `on_merge_report: <type>` added when a `touchpoint-*` was scaffolded
- Project frontmatter `plan_status: scaffolded` + `updated` stamped on full success (NOT changed on partial-failure)
- Audit log line (single event, regardless of success or partial-failure)

## Errors

- `inputs.project` slug invalid → reject with the regex
- Project not found / not `type: project` → reject with id
- `plan_path` not set or file missing → instruct user to run `/os research project <id>` first
- `plan_status != "approved"` → reject with the actual state
- `inputs.items` is empty → idempotent stop (no error)
- Any id in `inputs.items` does not resolve to a step in the plan → hard reject before dispatch begins (lists unknown ids + known ids)
- Sub-dispatch failure mid-loop → partial-failure path per Step 6 (stops immediately, leaves succeeded items on disk, `plan_status` stays at `approved`)
- Touchpoint targets a change that does not exist on disk → partial-failure per Step 6 with a specific reason

## See also

- [[standard-project-workflow]] — full plan-lifecycle state machine
- [[archetype-project]] — project archetype + `plan_status` enum
- [[research-write]] — produces the plan this skill materializes (formerly via the deleted `meta-research-project` alias)
- [[meta-review-project-plan]] — the review gate that flips `plan_status: approved`
- [[meta-revise-project-plan]] — the loop that re-runs when a revised plan needs re-review
- [[dev-add-change]] — sub-scaffolder dispatched for each `change-*` item
- [[meta-add-schedule]] — sub-scaffolder dispatched for each `schedule-*` item
