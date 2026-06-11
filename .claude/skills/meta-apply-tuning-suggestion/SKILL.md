---
name: meta-apply-tuning-suggestion
description: 'Phase 4 of the Overseer arc — converts an audit''s `tuning_suggestions[i]` into a concrete proposed edit to the target skill''s SKILL.md. Two modes: `propose` (default) writes a unified diff + rationale to vault/output/meta/tuning-proposals/ without modifying anything; `apply` requires a decision-entry that explicitly cites the audit + suggestion_index in its `implements_tuning_suggestions` block, then applies the edit. The decision-entry gate is the design discipline: skill changes are not auto-applied from suggestion text alone — they must pass through a human-authored decision artifact first.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: meta
tags: [overseer, self-improvement, skill-tuning, distribution]
inputs:
  audit:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Audit id whose tuning_suggestions[] contains the suggestion to materialize. Must reference a real lifecycle-audit at vault/wiki/meta/lifecycle-audit/audit-<id>.md.'
  suggestion_index:
    type: integer
    required: true
    description: '0-indexed position in the audit''s tuning_suggestions[] array. Use the index shown in the dashboard or count manually from the audit frontmatter.'
  mode:
    type: string
    required: false
    default: 'propose'
    enum: ['propose', 'apply']
    description: '`propose` writes the proposed edit to vault/output/meta/tuning-proposals/ as a unified diff + rationale (read-only with respect to target skill). `apply` modifies the target SKILL.md in place — requires `decision_entry_path` so the change is anchored to a human-authored decision.'
  decision_entry_path:
    type: string
    required: false
    description: 'Required when `mode: apply`. Path to a decision-archetype entry whose frontmatter `implements_tuning_suggestions` block cites `{audit_id, suggestion_index}` matching this invocation. Decision entry must exist on disk and parse cleanly.'
outputs:
  - kind: file
    path: vault/output/meta/tuning-proposals/<audit>-<suggestion_index>.diff
  - kind: file
    path: vault/output/meta/tuning-proposals/<audit>-<suggestion_index>.rationale.md
  - kind: file
    path: .claude/skills/<target-skill>/SKILL.md
    when: mode=apply
  - kind: file
    path: vault/wiki/development/change/<derived-slug>.md
    when: mode=propose AND the target is non-skill (resolved via scripts/tuning-targets.mjs) — scaffolded via dev-add-change
  - kind: event
    path: '.claude/state/events.db (kind: meta, action: tuning-suggestion-propose | tuning-suggestion-apply, audit_id: <audit>, files_touched: [<diff-path>, <rationale-path>, <skill-path-if-apply>])'
spawns: [dev-add-change]
---

# meta-apply-tuning-suggestion

## Purpose

Bridge the gap between Overseer signal and shipped skill changes. The Overseer emits `tuning_suggestions[]` per audit. Each suggestion is the Overseer's hypothesis: "this skill should change in this way." Aggregated across audits (the dashboard's "Top recurring tuning suggestions" panel), recurring patterns become candidates for real skill edits.

This skill is the materialization step:

- **`propose` mode**: reads one suggestion, produces a concrete unified diff against the target SKILL.md plus a rationale citing the audit. Does NOT modify any skill file. Output lands in `vault/output/meta/tuning-proposals/`.
- **`apply` mode**: requires a decision-archetype entry that explicitly cites this audit + suggestion_index in its `implements_tuning_suggestions` block. Only then applies the edit. The decision-entry gate forces a human-authored rationale to exist before any auto-edit.

The design discipline is deliberate: **suggestion text is not enough authorization to change skill behavior.** Even high-confidence Overseer suggestions can be wrong; even when right, the implementation may need adjustment from what the suggestion text proposes verbatim. The decision artifact is the place where human judgment (which suggestion to act on, what scope, what target wording) lives. This skill is the mechanical applicator, not the judge.

## When to use

- **From the dashboard's "Propose edit" button** on a tuning-suggestion row (Overseer Overview → Top recurring suggestions, OR audit detail → Tuning suggestions). The button dispatches `mode: propose` and surfaces the resulting diff in a modal.
- **From the CLI for one-off review** — `/os apply tuning suggestion audit=<id> suggestion_index=<n>`. Produces a diff for the user to read; same as the dashboard's propose path.
- **In `apply` mode** only after the user has authored a decision entry (typically via the dashboard's "Promote to decision" button, which scaffolds the entry pre-filled with the suggestion's evidence).

## When NOT to use

- **`apply` mode on non-skill targets** — `apply` edits SKILL.md files only. Suggestions whose target resolves to the orchestrator, the router vocabulary, or an OS script (via `scripts/tuning-targets.mjs`) are implemented through the change lifecycle that `propose` mode scaffolds (plan → review → execute), not by this skill's apply path. Only suggestions that resolve to NO target at all — not a skill, not a map entry — fall back to "no clear target": rationale-only output, human routes via decision entry (and considers extending the map).
- **Replacement for design judgment** — this skill produces a proposed edit faithful to the suggestion text. Whether the edit is _the right edit_ is a design question that lives in the decision entry, not here.
- **Across multiple audits at once** — this skill handles one suggestion at a time. A future `meta-aggregate-audit-suggestions` skill might batch related suggestions across audits into a single proposal; defer until needed.

## Pre-conditions

- The audit at `vault/wiki/meta/lifecycle-audit/audit-<audit>.md` exists and parses (frontmatter has `tuning_suggestions[]`).
- `suggestion_index` is a valid 0-based index into that array.
- For `apply` mode: the decision entry exists at `decision_entry_path`, has `type: decision`, and its frontmatter includes an `implements_tuning_suggestions` block containing `{audit_id: <audit>, suggestion_index: <suggestion_index>}`.
- The target (derived from `tuning_suggestions[i].skill` + `target_kind`) resolves to a real directory at `.claude/skills/<skill>/SKILL.md`, OR to a path-map entry in `scripts/tuning-targets.mjs`, OR the suggestion's `target_change` prose explicitly names a file path.

## Procedure

1. **Validate inputs.**
   - `audit` matches `^[a-z0-9][a-z0-9-]*$`. Otherwise reject.
   - `suggestion_index` is a non-negative integer. Otherwise reject.
   - `mode` is `propose` or `apply`. Default `propose`.
   - If `mode: apply` AND `decision_entry_path` is not provided → reject with `apply mode requires decision_entry_path — see meta-apply-tuning-suggestion procedure §5`.

2. **Load the audit.** Read `vault/wiki/meta/lifecycle-audit/audit-<audit>.md`. If missing, reject with `audit "<id>" not found at vault/wiki/meta/lifecycle-audit/audit-<id>.md`.

3. **Resolve the suggestion.** Parse the audit's frontmatter. Read `tuning_suggestions[suggestion_index]`. If index out of bounds, reject with `audit "<id>" has N suggestions; suggestion_index <i> is out of range`.

   Extract fields:
   - `skill` — the named target: a skill id, or a canonical id from `scripts/tuning-targets.mjs` for non-skill targets (older audits may carry free-form prose like `"meta — automation orchestrator"`)
   - `target_kind` — `skill` | `orchestrator` | `route` | `script`. Absent (pre-target_kind audits) → treat as `skill`
   - `suggestion` — the prose describing what to change
   - `confidence` — `low` | `medium` | `high`
   - `evidence_summary` — what evidence the Overseer cited
   - `target_change` — explicit prose naming where in the target file the change should land

4. **Resolve the target.** One of three outcomes: **skill target** (a SKILL.md path), **non-skill target** (repo path(s) from the map), or **unroutable**.
   - If `target_kind` is `skill` or absent: try `.claude/skills/<skill>/SKILL.md` directly (after sanitizing `skill` — lowercasing, replacing spaces/dashes with the canonical form). Found → skill target.
   - If that misses, OR `target_kind` is `orchestrator` / `route` / `script`: run `node scripts/tuning-targets.mjs "<skill>"`. The resolver matches canonical ids, aliases, and historical free-prose names by substring. A match prints the map entry as JSON (`id`, `kind`, `paths`, `summary`, `change_defaults`) → non-skill target.
   - If the map misses too, read the `target_change` prose for an explicit file path mention. A path that exists on disk → treat as a non-skill target with that single path (note in the rationale that the map should gain an entry for it).
   - Still nothing → **unroutable**. The propose output records the suggestion but the rationale is marked `# no routable target — requires human routing via decision entry; consider extending scripts/tuning-targets.mjs`. Continue (still produces a rationale file; no diff, no scaffold).

5. **For `apply` mode, validate the decision entry gate.**
   - If step 4 resolved a **non-skill target** → reject with `non-skill target (<map-id>) — implementation flows through the change lifecycle; run mode=propose to scaffold the change, then /os write change <slug>`. Apply mode edits SKILL.md files only.
   - Read the file at `decision_entry_path`. If missing → reject with `decision entry not found at <path>`.
   - Parse frontmatter. If `type` is not `decision` → reject with `<path> is not a decision-archetype entry`.
   - Read `implements_tuning_suggestions[]`. If absent or empty → reject with `decision entry does not cite any tuning suggestions — see archetype-decision § implements_tuning_suggestions`.
   - Search for `{audit_id: <audit>, suggestion_index: <suggestion_index>}` in the array. If not found → reject with `decision entry does not cite audit=<audit> suggestion_index=<i>`.
   - If all checks pass, proceed to step 7 (skip 6).

6. **For `propose` mode with a skill target, generate the proposed edit.**
   - Read the current target SKILL.md.
   - Reason about where in the file the suggestion's `target_change` prose points. Common shapes:
     - `"Insert under '## Section name'"` → find that section, insert text after the heading or at a sensible spot within
     - `"Add a bullet to <list>"` → find the bulleted list, append a bullet
     - `"Modify procedure step N"` → find the numbered step, propose a replacement or addition
   - Synthesize the concrete text addition/modification that captures the suggestion's intent. Be faithful to the suggestion's wording — the human review is what catches misinterpretations.
   - Produce a unified diff (standard `diff -u` format) showing the change.

6a. **For `propose` mode with a non-skill target, scaffold a change instead of a diff.** TypeScript/script/route edits are not applied by this skill — they get a change entry so the implementation flows through the full lifecycle (plan → review → execute), which IS the review gate for code. Steps:

- Verify the OS repo entity exists: `vault/wiki/<change_defaults.domain>/entity/<change_defaults.repo>.md` with `kind: repo` (values from the map's `change_defaults`, normally `development` / `agentic-os`). If missing on this install → skip the scaffold, note it in the rationale (`repo entity <id> not found — scaffold skipped; ingest the OS repo first`), and continue to step 8.
- **Idempotency probe**: search `vault/wiki/<domain>/change/` for an entry whose frontmatter has `derived_from_audit: <audit>` AND `suggestion_index: <i>` (e.g. `grep -l "derived_from_audit: <audit>"` then check indices). If one exists → do NOT scaffold again; record its slug for the report and continue to step 8.
- Derive `name`: slugify the suggestion's first sentence — lowercase, non-`[a-z0-9]` runs → `-`, trim hyphens, word-aware truncate at 60 chars. On collision with an existing change file, suffix `-1`, `-2`, ….
- Dispatch `dev-add-change` with:
  - `name`: the derived slug
  - `title`: the suggestion's first sentence verbatim (do NOT truncate — the slug carries the length constraint, the title is prose)
  - `domain`: `change_defaults.domain`, `repo`: `change_defaults.repo`
  - `type`: `feat` (default) or `fix` if the suggestion describes correcting broken behavior
  - `size`: `small` (most tuning edits) — `medium` if the suggestion spans multiple mapped files
  - `description`: the full suggestion prose + ` — derived from lifecycle-audit [[audit-<audit>]] tuning suggestion #<i> (target: <map-id>)`
  - `project`: search `vault/wiki/*/project/*.md` for an active project whose `repos` includes `change_defaults.repo`; exactly one match → use it, else omit
- Surgical post-create edit on the new change entry (mirrors `derived_from_report` wiring in [[research-scaffold-recommendations]]): add `derived_from_audit: <audit>`, `suggestion_index: <i>`, `tuning_target: <map-id>` immediately before the closing `---`, and set `scope:` to the map entry's `paths` joined with `, ` so the change names its files up front.

7. **For `apply` mode, perform the edit.**
   - Re-execute the same reasoning as step 6 to determine the edit location.
   - Use the `Edit` tool to apply the change to the target SKILL.md. Surgical: change only the part the diff covers.
   - This is the only step that mutates a skill file. Idempotency: if the file already contains the proposed text (e.g., a prior apply ran), the Edit will fail (the `old_string` won't match the current state); treat that as success-after-prior-apply and continue.

7a. **Stamp the decision entry's `applied_at` field.** After the SKILL.md edit succeeds (or completes as success-after-prior-apply per step 7's idempotency note), surgically edit the decision entry at `decision_entry_path` to record when apply ran. This is what powers the dashboard's "✓ applied" state — without it, Decisions panels can't distinguish "accepted, ready to apply" from "accepted, apply already done."

- If the frontmatter already has an `applied_at:` line → replace its value with the current ISO timestamp.
- If absent → insert a new line `applied_at: <ISO>` immediately after the `validation_result:` line (or, if that's also absent, immediately before the closing `---`).

Use the Edit tool for the surgical change. Two patterns:

```bash
# If applied_at exists (replace_all=false; the line is unique within frontmatter):
old_string: "applied_at: <prior-iso>"
new_string: "applied_at: <new-iso>"

# If applied_at is absent — insert after validation_result:
old_string: "validation_result: <value>"
new_string: "validation_result: <value>\napplied_at: <new-iso>"
```

Skip this step gracefully if the decision entry is unreadable or has no frontmatter — log a one-line warning but do not fail the apply (the SKILL.md edit already landed; the stamp is a downstream UX nicety, not load-bearing).

8. **Write the proposal artifacts** (both modes — apply mode still writes them as audit trail):
   - `vault/output/meta/tuning-proposals/<audit>-<suggestion_index>.rationale.md` — **always written.** A one-page rationale with:
     - Suggestion summary (target name, `target_kind`, confidence, evidence summary)
     - Evidence audit(s) — for v1 always just the source audit; future versions may aggregate
     - The target file(s) + section — for non-skill targets, the map entry's resolved `paths`
     - The diff body inline (skill targets), OR the scaffolded change id + resolved paths (non-skill targets), OR the unroutable-target prose
     - For `apply` mode: a section noting which decision entry authorized the apply
   - `vault/output/meta/tuning-proposals/<audit>-<suggestion_index>.diff` — **only written when a real unified diff was synthesized** (skill targets). For non-skill and unroutable targets, DO NOT write a `.diff` file — the rationale (plus the scaffolded change, when one was created) carries the routing. Writing a `.diff` file whose body is "no automated diff possible" is misleading — the file extension claims a diff exists when none does. The dashboard's status logic distinguishes "proposal with real diff" from "rationale-only" based on which files exist.
   - Create `vault/output/meta/tuning-proposals/` if missing.

9. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action tuning-suggestion-<mode> \
     --skill meta-apply-tuning-suggestion \
     --args '{"audit":"<audit>","suggestion_index":<n>,"mode":"<mode>","target_skill":"<skill>","target_kind":"<kind>","scaffolded_change":"<slug-or-null>","decision_entry_path":"<path-or-null>"}' \
     --files-touched '[<list-of-output-paths>]' \
     --exit-status 0
   ```

   In `apply` mode, files-touched includes the modified target SKILL.md path. When step 6a scaffolded a change, files-touched includes the new change entry path and `scaffolded_change` carries its slug.

10. **Report to the user** with a tight summary:

    Propose mode, skill target:

    ```
    ✓ tuning-suggestion proposed — <audit> #<i>
      target:     .claude/skills/<skill>/SKILL.md
      confidence: <confidence>
      diff:       vault/output/meta/tuning-proposals/<audit>-<i>.diff
      rationale:  vault/output/meta/tuning-proposals/<audit>-<i>.rationale.md
      next:       review the diff; if it captures intent, scaffold a decision via /os promote tuning suggestion (or the dashboard's "Promote to decision" button), then re-run with mode=apply + decision_entry_path
    ```

    Propose mode, non-skill target:

    ```
    ✓ tuning-suggestion proposed — <audit> #<i>
      target:     <map-id> (<kind>) → <paths, comma-joined>
      confidence: <confidence>
      change:     vault/wiki/<domain>/change/<slug>.md (scaffolded — or: already existed / skipped: <reason>)
      rationale:  vault/output/meta/tuning-proposals/<audit>-<i>.rationale.md
      next:       /os write change <slug>   (the change lifecycle is the review gate for code edits)
    ```

    Apply mode:

    ```
    ✓ tuning-suggestion applied — <audit> #<i>
      target:     .claude/skills/<skill>/SKILL.md (modified)
      decision:   <decision_entry_path>
      next:       commit the SKILL.md change; the Overseer audits next-round lifecycles to validate the metric moved
    ```

## What this skill must NOT do

- **Write `[[wikilink]]` syntax for audit or decision IDs into the SKILL.md body.** When `apply` mode adds rationale prose to a team-tracked `.claude/skills/<name>/SKILL.md` file citing the originating audit + decision, the IDs MUST be formatted as backtick code spans (` `audit-<id>` `, ` `decision-<id>` `), NOT as wikilinks (`[[audit-<id>]]`, `[[decision-<id>]]`). The targets live in `vault/wiki/meta/lifecycle-audit/` and `vault/wiki/meta/decision/` — both gitignored per-install paths. When skill files ship to other teams via git pull, wikilinks to those IDs become dangling and fire `Dangling wikilink` audit warnings on every other install. Add a parenthetical note like _"(per-install — these references are intentionally NOT wikilinks because the targets live in gitignored audit/decision paths)"_ once per rationale block so the reader (model or human) understands why the format differs from elsewhere in the file. Rule of thumb: anything under `vault/wiki/meta/lifecycle-audit/` or `vault/wiki/meta/decision/` (NOT `_seed/`) is per-install; reference by backtick code span, never wikilink.
- **Apply an edit without a decision entry.** Hard gate. The decision entry is the durable, distributable record of "we chose to change this skill in this way for this reason." Bypassing it removes the audit trail that makes the loop credible.
- **Synthesize evidence the Overseer didn't produce.** The rationale file cites only what's in the named audit's `tuning_suggestions[i]` and `per_skill_findings`. If the user wants stronger evidence, they aggregate it in the decision entry.
- **Auto-promote suggestions to decisions.** Promotion is a separate user action (the dashboard's "Promote to decision" button, or scaffold a decision entry by hand). This skill stays narrow: take one suggestion, propose one edit.
- **Modify multiple files in `apply` mode.** A suggestion targets one skill. Cross-cutting suggestions (e.g., `parent_change`-aware planning touches dev-write-change + dev-review-change + dev-write-change EXECUTE) should be modeled as multiple suggestions OR as a single decision entry that lists multiple `implements_tuning_suggestions` and dispatches multiple apply runs.
- **Run on `final` audits.** Final audits are immutable verdicts; their suggestions are historical and should not auto-materialize without an explicit user authoring an override. The skill warns but does not refuse — the decision entry gate is enough discipline.

## Errors

- `audit must match ^[a-z0-9][a-z0-9-]*$` — invalid input.
- `audit "<id>" not found at vault/wiki/meta/lifecycle-audit/audit-<id>.md` — audit doesn't exist.
- `audit "<id>" has N suggestions; suggestion_index <i> is out of range` — invalid index.
- `apply mode requires decision_entry_path` — missing arg in apply mode.
- `decision entry not found at <path>` — invalid path in apply mode.
- `<path> is not a decision-archetype entry` — wrong file type.
- `decision entry does not cite any tuning suggestions` — decision missing the gate field.
- `decision entry does not cite audit=<audit> suggestion_index=<i>` — decision exists but doesn't authorize this specific suggestion.
- `non-skill target (<map-id>) — implementation flows through the change lifecycle; run mode=propose to scaffold the change, then /os write change <slug>` — apply mode invoked on an orchestrator/route/script target.

## See also

- [[meta-overseer-review]] — produces the audits this skill consumes
- [[meta-audit-followups]] — Phase 3 sibling that updates audit signals over time
- `scripts/tuning-targets.mjs` — the target_kind vocabulary + path map that routes non-skill suggestions (audited by `tuning-target-path-missing`)
- [[dev-add-change]] — the scaffolder step 6a dispatches for non-skill targets
- [[archetype-lifecycle-audit]] — the input data shape (`tuning_suggestions[]`)
- [[archetype-decision]] — the gating artifact for `apply` mode (`implements_tuning_suggestions` block)
- `vault/output/meta/tuning-proposals/` — where proposal diffs + rationales accumulate (per-install, in `vault/output/` which is conventionally gitignored)
