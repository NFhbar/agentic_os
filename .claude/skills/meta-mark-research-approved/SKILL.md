---
name: meta-mark-research-approved
description: "Override a research-report's review verdict — flip `review_status: request-changes` to `approved`. The user-facing escape hatch when the reviewer's verdict conflicts with the user's judgment. Vault-only frontmatter edit; no skill dispatch."
user-invocable: true
version: 1
domain: meta
tags: [research, review-gate, override, vault-only]
inputs:
  report:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: Research-report id (must reference an existing entry in `vault/wiki/research/research-report/<id>.md`)
outputs:
  - kind: frontmatter
    path: vault/wiki/research/research-report/<report>.md
    fields: [review_status, updated]
---

# meta-mark-research-approved

## Purpose

Research-reports go through a peer-review gate (`research-write` → `research-review` → `research-revise` → … → `review_status: approved`). When the reviewer requests changes but the user disagrees with the verdict, this skill flips `review_status: request-changes → approved` as an explicit override. After approval, downstream consumers (`research-scaffold-recommendations`, the Plan tab's research-reports card) can scaffold the report's recommendations.

The dashboard exposes the same operation via the **Mark approved** secondary action on the pre-revise / post-revise banners (see `POST /api/research/:id/approve`); this skill is the CLI dispatch path.

Gated to `review_status === 'request-changes'` only — refuses on `pending` (forces reviewer-first path on fresh reports) and `approved` (no-op). Mirrors the endpoint's contract.

## Procedure

1. **Locate the report** at `vault/wiki/research/research-report/<inputs.report>.md`. Reject with `research-report "<id>" not found` if missing or if `type !== research-report`.

2. **Validate the gate**:
   - If `review_status !== 'request-changes'`: reject with `research-report "<id>" has review_status: <current> — Mark approved is only valid when review_status is 'request-changes' (override the reviewer's verdict). Run /research-review first on a fresh report.` Hard fail.

3. **Surgical frontmatter rewrite**. Compute `now` = ISO 8601 UTC. Edit:
   - `review_status: request-changes` → `review_status: approved`
   - Bump `updated:` to `now`

   Use the surgical `Edit` pattern — DO NOT touch other frontmatter fields (review_path, reviewed_at, report_revision, recommended_changes, notes_log all stay verbatim). The prior verdict still describes the prior revision; that historical anchor is load-bearing for the Reviews tab.

4. **Record audit event**:

   ```bash
   node scripts/record-dashboard-action.mjs \
     --action research-mark-approved \
     --args '{"report":"<report-id>","prior_review_status":"request-changes"}' \
     --files-touched '["<relative path>"]' \
     --exit-status 0
   ```

5. **Print summary**:

   ```
   ✓ Approved research-report <id>
     review_status:    request-changes → approved
     prior reviewed_at: <preserved>     (history intact)
     updated:           <now>

     next: scaffold recommendations via `/os scaffold research recommendations <id>`,
           or open the dashboard's project Plan tab for the per-report card.
   ```

## Outputs

- Frontmatter updates on `vault/wiki/research/research-report/<report>.md`: `review_status` flipped, `updated` bumped
- One audit event with action `research-mark-approved`

## Errors

- `research-report "<id>" not found` — slug doesn't match
- `research-report "<id>" has review_status: <current> — Mark approved is only valid when review_status is 'request-changes'` — wrong gate state

## Design notes

- Mirrors `POST /api/research/:id/approve` in `routes/research.ts`. Both paths intentionally exist (UI fast path + CLI path) per "apps are optional UI over the same files." Drift acknowledged.
- "Override the reviewer's verdict" is the user-facing framing — not a backdoor for skipping review on a fresh report. The `pending` rejection enforces that.

## See also

- [[archetype-research-report]] — `review_status` enum + the review-gate fields it governs
- [[research-review]] — the skill that originally produced the request-changes verdict
- [[research-scaffold-recommendations]] — the downstream consumer that gates on `approved`
- `POST /api/research/:id/approve` — the parallel dashboard endpoint
