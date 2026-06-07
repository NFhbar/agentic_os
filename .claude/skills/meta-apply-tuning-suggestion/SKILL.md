---
name: meta-apply-tuning-suggestion
description: 'Phase 4 of the Overseer arc — converts an audit''s `tuning_suggestions[i]` into a concrete proposed edit to the target skill''s SKILL.md. Two modes: `propose` (default) writes a unified diff + rationale to vault/output/meta/tuning-proposals/ without modifying anything; `apply` requires a decision-entry that explicitly cites the audit + suggestion_index in its `implements_tuning_suggestions` block, then applies the edit. The decision-entry gate is the design discipline: skill changes are not auto-applied from suggestion text alone — they must pass through a human-authored decision artifact first.'
user-invocable: true
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
  - kind: event
    path: '.claude/state/events.db (kind: meta, action: tuning-suggestion-propose | tuning-suggestion-apply, audit_id: <audit>, files_touched: [<diff-path>, <rationale-path>, <skill-path-if-apply>])'
spawns: []
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

- **Suggestions targeting non-skills** — some suggestions are about the orchestrator, observability tooling, or other systems that don't have a `.claude/skills/<name>/SKILL.md`. The skill detects this and falls back to "no clear skill target" — the proposal output names the target prose from the suggestion's `target_change` field but does not synthesize a diff. The user routes via decision entry to whatever change is appropriate.
- **Replacement for design judgment** — this skill produces a proposed edit faithful to the suggestion text. Whether the edit is _the right edit_ is a design question that lives in the decision entry, not here.
- **Across multiple audits at once** — this skill handles one suggestion at a time. A future `meta-aggregate-audit-suggestions` skill might batch related suggestions across audits into a single proposal; defer until needed.

## Pre-conditions

- The audit at `vault/wiki/meta/lifecycle-audit/audit-<audit>.md` exists and parses (frontmatter has `tuning_suggestions[]`).
- `suggestion_index` is a valid 0-based index into that array.
- For `apply` mode: the decision entry exists at `decision_entry_path`, has `type: decision`, and its frontmatter includes an `implements_tuning_suggestions` block containing `{audit_id: <audit>, suggestion_index: <suggestion_index>}`.
- The target skill (derived from `tuning_suggestions[i].skill`) resolves to a real directory at `.claude/skills/<skill>/SKILL.md` — OR the suggestion's `target_change` prose explicitly names a different file path.

## Procedure

1. **Validate inputs.**
   - `audit` matches `^[a-z0-9][a-z0-9-]*$`. Otherwise reject.
   - `suggestion_index` is a non-negative integer. Otherwise reject.
   - `mode` is `propose` or `apply`. Default `propose`.
   - If `mode: apply` AND `decision_entry_path` is not provided → reject with `apply mode requires decision_entry_path — see meta-apply-tuning-suggestion procedure §5`.

2. **Load the audit.** Read `vault/wiki/meta/lifecycle-audit/audit-<audit>.md`. If missing, reject with `audit "<id>" not found at vault/wiki/meta/lifecycle-audit/audit-<id>.md`.

3. **Resolve the suggestion.** Parse the audit's frontmatter. Read `tuning_suggestions[suggestion_index]`. If index out of bounds, reject with `audit "<id>" has N suggestions; suggestion_index <i> is out of range`.

   Extract fields:
   - `skill` — the named target skill (may be free-form prose like `"meta — automation orchestrator"` for non-skill targets)
   - `suggestion` — the prose describing what to change
   - `confidence` — `low` | `medium` | `high`
   - `evidence_summary` — what evidence the Overseer cited
   - `target_change` — explicit prose naming where in the SKILL.md the change should land

4. **Resolve the target file path.**
   - Try `.claude/skills/<skill>/SKILL.md` directly (after sanitizing `skill` — lowercasing, replacing spaces/dashes with the canonical form).
   - If not found, read the `target_change` prose for an explicit file path mention.
   - If still no resolved path → flag as **non-skill target**. The propose output will record the suggestion but the diff section will be marked `# no automated diff possible — target requires human routing via decision entry`. Continue to step 5 (still produces a rationale file, just no diff).

5. **For `apply` mode, validate the decision entry gate.**
   - Read the file at `decision_entry_path`. If missing → reject with `decision entry not found at <path>`.
   - Parse frontmatter. If `type` is not `decision` → reject with `<path> is not a decision-archetype entry`.
   - Read `implements_tuning_suggestions[]`. If absent or empty → reject with `decision entry does not cite any tuning suggestions — see archetype-decision § implements_tuning_suggestions`.
   - Search for `{audit_id: <audit>, suggestion_index: <suggestion_index>}` in the array. If not found → reject with `decision entry does not cite audit=<audit> suggestion_index=<i>`.
   - If all checks pass, proceed to step 7 (skip 6).

6. **For `propose` mode, generate the proposed edit.**
   - Read the current target SKILL.md (if a resolved skill target).
   - Reason about where in the file the suggestion's `target_change` prose points. Common shapes:
     - `"Insert under '## Section name'"` → find that section, insert text after the heading or at a sensible spot within
     - `"Add a bullet to <list>"` → find the bulleted list, append a bullet
     - `"Modify procedure step N"` → find the numbered step, propose a replacement or addition
   - Synthesize the concrete text addition/modification that captures the suggestion's intent. Be faithful to the suggestion's wording — the human review is what catches misinterpretations.
   - Produce a unified diff (standard `diff -u` format) showing the change.

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
     - Suggestion summary (skill, confidence, evidence summary)
     - Evidence audit(s) — for v1 always just the source audit; future versions may aggregate
     - The target file + section
     - The diff body inline (when present), OR the non-skill-target decomposition prose
     - For `apply` mode: a section noting which decision entry authorized the apply
   - `vault/output/meta/tuning-proposals/<audit>-<suggestion_index>.diff` — **only written when a real unified diff was synthesized.** For non-skill targets (where step 6 flagged the suggestion as needing human routing), DO NOT write a `.diff` file. The rationale alone carries the explanation. Writing a `.diff` file whose body is "no automated diff possible" is misleading — the file extension claims a diff exists when none does. The dashboard's status logic distinguishes "proposal with real diff" from "rationale-only" based on which files exist.
   - Create `vault/output/meta/tuning-proposals/` if missing.

9. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action tuning-suggestion-<mode> \
     --skill meta-apply-tuning-suggestion \
     --args '{"audit":"<audit>","suggestion_index":<n>,"mode":"<mode>","target_skill":"<skill>","decision_entry_path":"<path-or-null>"}' \
     --files-touched '[<list-of-output-paths>]' \
     --exit-status 0
   ```

   In `apply` mode, files-touched includes the modified target SKILL.md path.

10. **Report to the user** with a tight summary:

    Propose mode:

    ```
    ✓ tuning-suggestion proposed — <audit> #<i>
      target:     .claude/skills/<skill>/SKILL.md (or: non-skill target)
      confidence: <confidence>
      diff:       vault/output/meta/tuning-proposals/<audit>-<i>.diff
      rationale:  vault/output/meta/tuning-proposals/<audit>-<i>.rationale.md
      next:       review the diff; if it captures intent, scaffold a decision via /os promote tuning suggestion (or the dashboard's "Promote to decision" button), then re-run with mode=apply + decision_entry_path
    ```

    Apply mode:

    ```
    ✓ tuning-suggestion applied — <audit> #<i>
      target:     .claude/skills/<skill>/SKILL.md (modified)
      decision:   <decision_entry_path>
      next:       commit the SKILL.md change; the Overseer audits next-round lifecycles to validate the metric moved
    ```

## What this skill must NOT do

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

## See also

- [[meta-overseer-review]] — produces the audits this skill consumes
- [[meta-audit-followups]] — Phase 3 sibling that updates audit signals over time
- [[archetype-lifecycle-audit]] — the input data shape (`tuning_suggestions[]`)
- [[archetype-decision]] — the gating artifact for `apply` mode (`implements_tuning_suggestions` block)
- `vault/output/meta/tuning-proposals/` — where proposal diffs + rationales accumulate (per-install, in `vault/output/` which is conventionally gitignored)
