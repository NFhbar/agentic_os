---
name: dev-mark-pr-ready
description: 'Mark an OS-authored PR ready for human review/merge. Vault-only — flips pr_review_status to ready-for-human on the change entry and stamps pr_ready_at. No GitHub side-effects.'
user-invocable: true
recommended_effort: medium
version: 1
domain: development
tags: [change, pr-review, lifecycle]
inputs:
  change:
    type: string
    required: true
    description: 'Change id (the slug, e.g. `add-license`). The skill resolves the entry path via the vault manifest.'
  override:
    type: boolean
    required: false
    default: false
    description: 'Bypass the strict gate. When true, skips the requirement that `pr_review_status` be `pending` or `approved` — lets the user mark ready despite a `needs-changes` status, a missing review, or untriaged (`status: new`) comments on the latest review pass. Recorded in the event with `override: true` for audit. Use sparingly; the normal flow expects a clean, fully-triaged review first.'
outputs:
  - kind: file
    path: vault/wiki/{{domain}}/change/{{input.change}}.md
spawns: []
---

# dev-mark-pr-ready

## Purpose

Signal that the user has accepted the OS's review of its own PR and is sending it to a human for the final pass. This is the user-initiated gate between **review passed** and **handed off to a human**.

Vault-only by design — no GitHub calls, no PR mutations. The user reviews and merges the PR on GitHub themselves; this skill just records the decision in the change entry so the dashboard's lifecycle stepper can show "Ready for human" as done.

This skill is the symmetric counterpart of [[dev-pr-review]]:

- `dev-pr-review` writes `pr_review_status: pending`, `approved`, or `needs-changes` based on the model's verdict
- `dev-mark-pr-ready` (this skill) writes `pr_review_status: ready-for-human` based on the **user's** verdict (a button click in the dashboard or a CLI invocation)

Only one direction is supported — there's no `dev-unmark-pr-ready`. If a later commit warrants more review, run `dev-pr-review` again (it will bump `pr_review_status` based on the new pass) or hand-edit the change entry.

## Procedure

1. **Resolve the change entry path.**

   Read `vault/.index/manifest.json`. Find the entry whose `id === inputs.change` AND whose `type === 'change'`. If multiple match (shouldn't happen — ids are unique), prefer the one under `vault/wiki/development/change/` then alphabetically. If none match, reject:

   ```
   Change `<change>` not found in the vault manifest. Did you mean `/os add-change`?
   ```

2. **Parse the entry's frontmatter** (read the file, split on `---\n`, parse the YAML block).

3. **Validate the gate** — read the change fields, and when `pr_review_path` is set, the linked pr-review entry:

   | check                                    | failure mode                                                                                                                                                                                                                                                                                                                                                                                                                  |
   | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `pr_url` is set                          | reject: `Change \`<change>\` has no pr_url — open a PR first via dev-open-pr.`                                                                                                                                                                                                                                                                                                                                                |
   | `pr_review_status` is set                | reject (unless `override: true`): `Change \`<change>\` has no pr_review_status — run dev-pr-review first.` (`pending`and`approved` are both normal, non-override prior statuses.)                                                                                                                                                                                                                                             |
   | `pr_review_status !== 'needs-changes'`   | reject (unless `override: true`): `Change \`<change>\` has pr_review_status: needs-changes — address comments and re-review first. (Pass override: true to bypass.)`                                                                                                                                                                                                                                                          |
   | no untriaged comments on the latest pass | when `pr_review_path` is set: read the linked pr-review entry, find its highest-N `## Pass N` section, count comments whose header `status:` is `new`. If > 0, reject (unless `override: true`): `Change \`<change>\` has <n> untriaged comment(s) on the latest review pass — Accept or Dismiss each (terminal states: acted-on \| dismissed) before marking ready. (Pass override: true to bypass; recorded in the event.)` |
   | `pr_review_status !== 'ready-for-human'` | **idempotent stop** (not an error): `Change \`<change>\` is already marked ready-for-human (since <pr_ready_at>). Nothing to do.`Skip steps 4–5; still record an event with`noop: true`.                                                                                                                                                                                                                                      |

   Treat `override: true` as a permission slip — it skips the second, third, and fourth checks but is recorded verbatim in the event payload. Reading the linked pr-review entry for the untriaged-comments count is allowed; writing to it remains forbidden (see "What this skill must NOT do").

4. **Compute the writes:**
   - `pr_review_status: ready-for-human`
   - `pr_ready_at: <now>` (ISO 8601 UTC, e.g. `2026-05-23T14:30:00.000Z`)
   - `updated: <now>` (same timestamp — keeps the change's freshness signal aligned with the action)

5. **Apply the writes surgically via the Edit tool** — preserve comments, field order, and unrelated fields. Three cases per field:
   - **Field already present** with a different value → replace its value on the existing line.
   - **Field already present** with the target value → leave it (no-op).
   - **Field missing** → insert it. Place `pr_review_status` and `pr_ready_at` near the other `pr_review_*` fields (immediately after `pr_reviewed_at` if it exists, otherwise after `pr_url`). Place `updated` on its existing line (every change entry has one already).

   Do NOT rewrite the whole frontmatter block — surgical Edit only. If the change entry has no `pr_url` field at all, the validation in step 3 already rejected; we never reach this step in that case.

6. **Record the event** via the dual-write wrapper:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action mark-pr-ready \
     --skill dev-mark-pr-ready \
     --args '{"change":"<change>","pr":"<pr_url>","override":<true|false>,"prior_status":"<prior_pr_review_status>","untriaged_count":<n from the step-3 latest-pass count, 0 when no pr_review_path>,"noop":<true|false>}' \
     --files-touched '<["vault/wiki/<domain>/change/<change>.md"] when step 5 wrote, else []>' \
     --exit-status 0
   ```

   Notes:
   - `prior_status` is the value read in step 3 (`pending`, `approved`, `needs-changes`, `ready-for-human`, or `null`). Captures what state the change was in immediately before the click — useful for audit (who marked ready despite needs-changes?).
   - `noop: true` only when step 3 hit the idempotent-stop branch. In that case `files_touched` is `[]` since nothing was written.
   - The shared event-attribution helper picks up `change_id` from `args.change`, so this event lands on the change's lifecycle timeline automatically.

7. **Confirm to the user** with a tight one-screen report:

   ```
   ✓ Marked ready for human — <change>
     pr:           <pr_url>
     prior status: <prior_pr_review_status>
     now:          ready-for-human
     ready_at:     <ISO timestamp>
     entry:        vault/wiki/<domain>/change/<change>.md
     next:         human reviews + merges on GitHub
   ```

   When step 3 idempotent-stopped, the body changes to:

   ```
   ↻ Already ready — <change> (since <pr_ready_at>)
     No write performed. Re-run dev-pr-review if you want a fresh review pass.
   ```

## Inputs schema notes

- `change`: required. The slug only, NOT a path. The skill resolves the file via the manifest so callers don't need to know the owning domain.
- `override`: optional. Defaults to false. When true, mirrors the GitHub-side workflow where a human can override review state and ship anyway. The override is preserved in the event row so the audit trail captures _who_ ignored the review _when_.

## Outputs

- The change entry's frontmatter mutated in-place: `pr_review_status: ready-for-human`, `pr_ready_at: <ISO>`, `updated: <ISO>`. All other fields preserved verbatim.
- An `events.db` row with `kind: dashboard`, `action: mark-pr-ready`, `skill: dev-mark-pr-ready`, `change_id: <change>`, `files_touched: [<change-path>]`.
- A short report to stdout.

## What this skill must NOT do

- **Call GitHub.** No `gh` CLI, no github MCP, no PR mutations, no draft → ready flips, no labels, no comments. The user owns the GitHub-side workflow. (A future `dev-mark-pr-ready-github` could layer that on top; this skill stays pure.)
- **Write to the linked pr-review entry.** Comment state lives on the pr-review entry's body and is mutated by `dev-pr-review` (or the per-comment dashboard endpoint). Step 3 reads the entry to count untriaged comments, but this skill's writes target the change entry exclusively.
- **Open a new review pass.** Re-running this skill on an already-ready change is a no-op, not a re-review trigger. Use `dev-pr-review` to re-review.
- **Modify `status`.** The change's top-level `status` stays `in-review` (the human hasn't merged yet). It transitions to `merged` later, via a future `dev-close-change` skill (planned in `domains/development/playbook.md` § "Planned for v1.5") or a manual hand-off, when GitHub confirms the merge.

## Errors

- `Change \`<change>\` not found in the vault manifest.`— verify the slug; check`vault/wiki/\_index/manifest.json` for the canonical id.
- `Change \`<change>\` has no pr_url — open a PR first via dev-open-pr.` — chronological precondition; cannot mark ready before a PR exists.
- `Change \`<change>\` has no pr_review_status — run dev-pr-review first.`— pass`override: true` to bypass if you intentionally want to ship without an OS-side review.
- `Change \`<change>\` has pr_review_status: needs-changes — address comments and re-review first.` — same override available, but recorded loudly in the event.
- `Change \`<change>\` has <n> untriaged comment(s) on the latest review pass — Accept or Dismiss each (terminal states: acted-on | dismissed) before marking ready.`— comment disposition is a merge invariant;`override: true` bypasses and is recorded with the count.

## See also

- [[archetype-change]] § "PR review fields" — the data contract for `pr_review_status` and `pr_ready_at`
- [[dev-pr-review]] — the skill that produces the review this skill consumes
- [[dev-open-pr]] — the skill that creates the PR being marked ready
- `dev-close-change` (planned) — the skill that will close out the change once the PR is merged on GitHub. Tracked in `domains/development/playbook.md` § "Planned for v1.5"; not yet implemented.
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 6
