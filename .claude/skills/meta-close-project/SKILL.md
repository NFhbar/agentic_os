---
name: meta-close-project
description: "Close a project — complete or abandon it behind an owned-work disposition gate. Enumerates the project's open work (non-terminal changes, unmerged report recommendations, unconsidered notes) and refuses to close while any item lacks a disposition (abandon-with-rationale / transfer / block). On close: writes the terminal status + stamp + lifecycle_stage, applies every disposition, records the full list on one event. Idempotent when already terminal. Dashboard Complete/Abandon dispatch it via the AI bridge."
user-invocable: true
recommended_effort: medium
version: 1
domain: meta
tags: [project, lifecycle, disposition, vault-only]
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Project id (must reference an existing project entity in `vault/wiki/<domain>/project/<id>.md`)
  mode:
    type: string
    required: true
    description: '`complete` (terminal state → `status: completed` + `completed_at`) or `abandon` (terminal state → `status: cancelled` + `cancelled_at`). Both stamp `lifecycle_stage: archived`.'
  rationale:
    type: string
    required: false
    description: Blanket rationale applied to any `abandon` disposition that lacks its own per-item rationale. Required (per-item or blanket) for every abandonment — a missing rationale downgrades that item to `block`.
  dispositions:
    type: array
    required: false
    description: >-
      Per-item instructions, each `{item, action, rationale?, to?}`. `item` refs are `change:<id>`,
      `report-rec:<report-id>#<index>`, or `note:<report-id>#<ts>`. `action` ∈ `{abandon, transfer, block}`.
      `transfer` (changes only) carries `to: <project-id>` and moves the change's ownership. Items with no
      matching disposition fall back to `disposition_default`.
  disposition_default:
    type: string
    required: false
    default: block
    description: '`abandon` | `block`. Fallback disposition for open items without an explicit instruction. `block` (default) makes closure refusal-first; `abandon` (paired with `rationale`) closes everything.'
outputs:
  - kind: frontmatter
    path: vault/wiki/<domain>/project/<project>.md
    fields: [status, lifecycle_stage, completed_at, cancelled_at, updated]
  - kind: frontmatter
    path: 'vault/wiki/<domain>/change/<owned-change>.md (per abandoned/transferred change)'
    fields: [status, abandoned_at, abandoned_reason, project, updated]
spawns: []
---

# meta-close-project

## Purpose

Terminate a project — **complete** (work shipped) or **abandon** (work dropped) — behind an
owned-work disposition gate. Project closure used to be a bare frontmatter flip: the dashboard's
Complete action set `status: completed` and nothing else, `status: cancelled` had no affordance at
all, and neither path dispositioned the project's open work. Pausing/closing a project left its
approved-report recommendations and DRAFT-bodied changes flooding the action items — dangling work
outliving its project.

This skill closes that gap the same way the OS enforces the invariant one level down (PR comments
must reach `acted-on | dismissed` before merge): **a terminal state requires every owned open item
to be explicitly resolved, not orphaned.** The dashboard exposes the operation via the **Complete**
and **Abandon** buttons on the project status banner (they dispatch this skill through the AI
bridge); this is also the CLI/headless path so the OS works without the dashboard server.

Inverse: [[meta-reopen-project]] (`completed | cancelled → active`).

## Procedure

### 1. Locate + validate

1. Walk `vault/wiki/*/project/*.md` for a file whose frontmatter `type` is `project` and `id`
   equals `inputs.project`. Reject with `project "<id>" not found` if nothing matches. Parse
   frontmatter via js-yaml so nested fields are real values.
2. Reject unknown `mode`: `mode must be "complete" or "abandon" (got "<x>")`.

### 2. Idempotent terminal stop

If the project's `status` is already `completed` or `cancelled`, print
`↻ project already terminal (status: <x>) — nothing to close` and exit 0. Do **not** mutate the
entry; still record the event with `outcome: no-op` (step 7) so the dispatch is auditable.

### 3. Enumerate owned open work

Parse each candidate's frontmatter via js-yaml (the manifest / backlinks are an acceptable index for
finding candidates, but read the file to get authoritative field values). Build the open-work list
across three kinds:

- **Changes** — entries with `type: change`, `project == <id>`, and `status ∉ {merged, abandoned}`
  (i.e. `planning`, `in-progress`, `in-review`). Each is `change:<change-id>`.
- **Report recommendations** — research-reports with `type: research-report`, `project == <id>`, in
  the **approved family** (`status: approved | updated`). Within each, `recommended_changes` rows
  with `status: proposed`, plus `status: scaffolded` rows whose linked change (`id` field of the
  row) is **not** merged. Each is `report-rec:<report-id>#<index>`. **Candidate covered rows:** a
  `scaffolded` row whose linked change (matched by the **row's `id`**) already appears in the change
  list above is a _candidate_ covered row — but whether it is actually covered depends on that
  change's resolved disposition, decided in step 4. Only an **abandoned** covering change flips the
  row (step 5's abandon writeback); a **transferred** covering change performs no row edit and would
  strand the scaffolded-unmerged row on the archived project. So do **not** mark the row covered here
  — carry it forward as a candidate and re-evaluate it in step 4 once the covering change's
  disposition is known.
- **Pending notes** — `notes_log` items with an empty `considered_by` array on **any** report under
  the project (regardless of report status). Each is `note:<report-id>#<ts>`.

**Two non-items** (documented so the reader knows they were considered, not missed):

- Project-scoped runbooks need no disposition — the scheduler only fires runbooks for
  `status: active` projects (see [[archetype-project]] § Lifecycle vs. status), so a closed project
  silences its scheduled work automatically.
- Reports themselves are knowledge, not open work — only their unconsumed `recommended_changes` rows
  and unconsidered `notes_log` items gate closure.

### 4. Disposition gate

Resolve each open item against `inputs.dispositions` (matched by `item` ref), falling back to
`inputs.disposition_default`. Resolution rules:

- **`abandon`** requires a rationale — the per-item `rationale`, else `inputs.rationale`. A missing
  rationale downgrades the item to `block` with reason `no rationale`.
- **`transfer`** is valid only for **changes**, and only to an **existing non-terminal** project
  (`status ∉ {completed, cancelled}`) that is **not the project being closed** (`to != inputs.project`).
  The closing project is still non-terminal at gate time, so a self-transfer would validate, leave the
  change's `project:` effectively unchanged, and strand it under the just-cancelled project — silently
  defeating the gate. Otherwise the item downgrades to `block` with the specific reason (`transfer
target not a change` / `transfer target is the closing project` / `transfer target <p> not found` /
  `transfer target <p> is terminal`).
- **`block`** (explicit or as a downgrade) means the item is undispositioned.

**Candidate covered rows (from step 3).** Resolve each candidate covered row against its covering
change's now-known disposition: if the covering change resolved to **`abandon`**, the row is
**covered** — it needs no instruction and does not gate (step 5's abandon writeback flips it). If the
covering change resolved to **`transfer`** or **`block`** (anything that won't flip the row), the row
is **not** covered — treat it as an ordinary `report-rec` open item that needs its own disposition and
gates closure like any other.

**In-flight run guard (changes).** Before allowing any change's disposition to proceed, query the runs
table for a non-terminal run tied to it:

```sql
SELECT id FROM runs WHERE change_id = '<change-id>' AND state IN ('queued', 'running');
```

(the runs table lives in `.claude/state/events.db`.) If any row returns, downgrade the change to
`block` with reason `in-flight automation run (<run-id>)` — abandoning or transferring a change whose
orchestrator run is mid-flight would strand that run. This closes the CLI/headless gap the dashboard's
project-scoped `dispatching` disable cannot see: orchestrator runs are tagged by `change_id`, not
`project`, so the banner's disable never covers them and the headless path has no guard at all.

**If any item resolves to `block` → refuse before touching anything.** The first line is a
park-friendly summary that reads well as a `skill-refused:` park reason (see
[[standard-automation-loop]] § Pause reasons):

```
✗ close-project refused — <N> undispositioned open item(s) on <project>: <c> change(s), <r> recommendation(s), <n> note(s)
```

Follow it with the itemized list — each line `- <ref> · <one-line description> · <current status> · <block reason>` — and re-run guidance showing the `dispositions` / `disposition_default` / `rationale` shape. Record the event with `outcome: refused` (step 7) and exit 0. The refusal is **mutation-free** — no frontmatter is touched when the gate fails.

### 5. Apply dispositions

Reached only when zero items block. For each item, apply its resolved disposition:

- **change → `abandon`**: mirror the **change-entry-side** field set of `POST
/api/changes/:id/abandon` (`domains/meta/app/server/routes/changes.ts`) — `status: abandoned`,
  `abandoned_at: <now>`, `abandoned_reason: "<rationale>"` (embed-quote-safe: replace any `"` in the
  rationale with `'`), `updated: <now>`, and append a `## Abandoned` body section naming the reason.
  If an open report row is **covered** by this change, also flip that row — key the flip off the
  **coverage linkage** (the report row whose `id` equals this change's id, the same linkage step 3
  used to establish coverage), **not** the change's `derived_from_report` / `recommendation_index`
  fields: a hand-linked row can carry the row→change `id` without the reverse pointer (or vice versa),
  and keying off the change side would leave the covered row stranded. Flip it with the
  **single-line-safe writeback below, NOT the route's multi-line-YAML regex** (that regex silently
  no-ops on canonical single-line entries — the exact bug surfaced as out-of-scope concern #2 in this
  change's plan).
- **change → `transfer`**: rewrite `project: <target>` and bump `updated: <now>`. The change leaves
  this project's ownership; no other edits. It is **not** counted as abandoned.
- **report row → `abandon`** (uncovered `proposed` / `scaffolded` rows): flip the row's `status →
abandoned` and add `abandoned_reason`. **Single-line caveat (load-bearing):** `recommended_changes`
  MUST stay a **one-line JSON array** (see [[archetype-research-report]] § Frontmatter caveats —
  anchored `^field:` replacers elsewhere corrupt multi-line values). Read the current value, mutate
  the target row in memory, and replace the **entire** `recommended_changes:` value with the
  canonical single-line JSON form via one exact-string `Edit`. This handles legacy multi-line YAML
  shapes safely (the whole value is replaced, not patched in place).
- **note → `abandon`**: append a `considered_by` entry `{skill: meta-close-project, ts: <now>}` to
  the note's `notes_log` row (notes are append-only and immutable — the closure _is_ the
  consideration). `notes_log` carries the same single-line caveat: whole-value single-line-JSON
  replacement, never an in-place anchored patch.

A `transfer`ed or covered item is not an abandonment. Only `abandon` dispositions require rationale.

### 6. Close the project

Surgical anchored-line frontmatter edits on the project entry (never a `yaml.dump()` round-trip —
mirror [[meta-reopen-project]] and `domains/meta/app/server/frontmatter-rewrite.ts::rewriteFrontmatter`;
insert-before-`---` when a field is missing). Compute `now` = ISO 8601 UTC:

- `mode: complete` → `status: completed`, `completed_at: <now>`
- `mode: abandon` → `status: cancelled`, `cancelled_at: <now>`
- both → `lifecycle_stage: archived`, `updated: <now>`

### 7. Record the event

```bash
node scripts/record-dashboard-action.mjs \
  --action project-close \
  --skill meta-close-project \
  --args '{"project":"<id>","mode":"<mode>","outcome":"closed|refused|no-op","dispositions":[{"item":"<ref>","action":"<action>","rationale":"<...>"}],"counts":{"changes":<c>,"rows":<r>,"notes":<n>}}' \
  --files-touched '[<every file edited, as JSON array>]' \
  --exit-status 0
```

The full disposition list travels on the event so the abandon-all blast radius is auditable from the
events log alone. On the refusal / no-op paths the event still records (`outcome: refused | no-op`)
with the itemized open work in `args`.

### 8. Print summary

On close:

```
✓ Closed project <id> (mode: <mode>)
  status:           <prev> → <completed | cancelled>
  <completed_at | cancelled_at>:  <now>
  lifecycle_stage:  → archived
  dispositioned:    <c> change(s) [<a> abandoned, <t> transferred], <r> report row(s), <n> note(s)
  next:             reopen via `/os reopen project <id>` if a gap surfaces;
                    generate a wrap-up report before archiving if you haven't.
```

The refusal summary prints at step 4; the idempotent no-op prints at step 2.

## Outputs

- Project entry frontmatter: `status`, `lifecycle_stage`, `updated`, and one of `completed_at` /
  `cancelled_at` stamped (close paths only).
- Per abandoned change: `status: abandoned` + `abandoned_at` + `abandoned_reason` + `## Abandoned`
  body section; per transferred change: rewritten `project`. Source report rows flipped for
  research-derived abandonments.
- Per abandoned report row: `status: abandoned` + `abandoned_reason` (single-line-safe writeback).
- Per abandoned note: appended `considered_by` entry.
- One audit event with action `project-close` carrying the full disposition list.

## Errors

- `project "<id>" not found` — id matches no project entry.
- `mode must be "complete" or "abandon"` — unknown mode.
- `↻ project already terminal (status: <x>)` — idempotent no-op stop (exit 0).
- `✗ close-project refused — <N> undispositioned open item(s)` — the disposition gate fired;
  mutation-free, exit 0, first line reads as a `skill-refused:` park reason.
- **In-flight automation guard:** the disposition gate (step 4) hard-blocks any change with a
  `queued`/`running` run in the runs table, refusing with the run id rather than stranding it — this
  covers the orchestrator (`change_id`-tagged) and CLI/headless dispatches the dashboard's
  project-scoped `dispatching` disable can't see. The operator clears the block by letting the run
  finish (or cancelling it) before re-closing.
- **Vault-only abandonment caveat:** abandoning an `in-review` change leaves its GitHub PR/branch
  dangling — exact parity with the per-change abandon route. The refusal itemization surfaces
  in-review items before the operator opts into abandon-all.

## Design notes

- This skill duplicates the closure file-edit logic that the dashboard route path expresses; per the
  OS principle "apps are optional UI over the same files," both paths exist intentionally. The
  removed `POST /api/projects/:id/complete` was a bare flip that only gated on in-flight changes — the
  disposition gate here is a strict superset (it also catches open recommendations and notes the old
  gate never checked). A future `scripts/vault-ops/` shared module would consolidate this skill, the
  reopen skill, and the per-change abandon route.
- Refusal-first by default (`disposition_default: block`): closing surfaces open work rather than
  silently archiving it. The dashboard's Abandon path opts into `disposition_default: abandon` with an
  operator-supplied `rationale` so a deliberate abandon-all closes cleanly (zero dangling queue items).

## See also

- [[meta-reopen-project]] — the inverse (`completed | cancelled → active`)
- [[archetype-project]] — status enum + `completed_at` / `cancelled_at` stamps + the Closure contract
- [[archetype-research-report]] — `recommended_changes` / `notes_log` single-line frontmatter caveat
- [[standard-automation-loop]] — the `skill-refused:` park-reason vocabulary the refusal matches
- [[meta-add-project]] — the scaffolder that creates the project entries this skill closes
- `POST /api/changes/:id/abandon` — the per-change abandon route whose change-entry field set this skill mirrors
