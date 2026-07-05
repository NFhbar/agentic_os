---
name: research-review
description: 'Peer-review a research-report entry. Read-only: re-walks materials, parses the report, runs a structured checklist, writes a verdict (approve | request-changes | reject) and flips review_status. Mirrors meta-review-project-plan one altitude up the research lifecycle.'
user-invocable: true
recommended_effort: xhigh
version: 1
domain: research
tags: [research, review, peer-review, lifecycle, report]
inputs:
  report_id:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Research-report id (slug). Must match an existing entry of `type: research-report` with `review_status: pending` or `request-changes` (the latter lets a reviewer take a second look at an unrevised report).'
outputs:
  - kind: file
    path: vault/output/research/reports/{{input.report_id}}-review.md
  - kind: frontmatter
    path: vault/wiki/research/research-report/{{input.report_id}}.md
    fields: [status, review_status, review_path, reviewed_at, updated]
spawns: []
model: claude-fable-5
---

# research-review

## Purpose

Act as a peer reviewer for a research-report produced by [[research-write]] (or rewritten by [[research-revise]] / [[research-update]]). Read the report, the materials it was synthesized from, and the owning project — then produce a structured verdict (approve / request-changes / reject) with specific concerns.

**Read-only operation.** This skill MUST NOT edit the report body, MUST NOT mutate `recommended_changes`, MUST NOT scaffold downstream changes. It reads + writes one artifact (the review document) + updates a small set of frontmatter fields on the report entry. Same separation principle as [[meta-review-project-plan]] and [[dev-review-change]] — writers can mutate, reviewers cannot. If something feels like it should be acted on, that's evidence FOR a `request-changes` verdict (because [[research-revise]] should do it), not evidence to act directly.

The two-step `status` transition (`reviewed` → `approved`) is deliberate: this skill writes `status: reviewed` on the `approved` verdict; the explicit `reviewed → approved` flip is a separate human action before [[meta-scaffold-project-plan]] can consume `recommended_changes`. See [[archetype-research-report]] § Status enum + § Lifecycle.

## Procedure

### Step 1: Validate

1. Validate `inputs.report_id` matches `^[a-z0-9][a-z0-9-]*$`. Reject if not.
2. Locate the report entry at `vault/wiki/research/research-report/<report_id>.md`. Reject with `report "<id>" not found` if missing or `type != research-report`.
3. Extract: `title`, `project`, `status`, `materials_path`, `report_revision` (default `1`), `review_status`, `review_path`, `recommended_changes`.
4. Verify `review_status` is one of:
   - `pending` — the standard path. Both a first review after `research-write` AND a re-review after `research-revise` land here (revise resets `review_status: pending`).
   - `request-changes` — the second-opinion path. A reviewer can re-run on an unrevised report to confirm or update the prior verdict without going through revise. Niche but valid.
     Any other state is rejected with `report review_status is currently <state> — nothing to review`.
5. Locate the owning project at `vault/wiki/*/project/<project>.md`. Read its body for context (the `## Why`, `## Approach`, the research framing). Warn but don't reject if missing — a report can outlive a project rename; the review can still proceed.

### Step 2: Read the report

1. Read the report file in full. Parse the body sections per [[archetype-research-report]] § Body sections:
   - `# <title>`
   - `> User intent:` blockquote (if present — preserved from the optional `notes` input on `research-write`)
   - `## Why`
   - `## Findings` (with optional `### <subtopic>` H3 subsections)
   - `## Recommended changes` (matched against the frontmatter `recommended_changes` array)
   - `## Notes`
   - `## Update N` sections (if any — present on reports that have been through [[research-update]])
2. Verify the body-vs-frontmatter mirror for `recommended_changes`: each `- [ ]` bullet in `## Recommended changes` should correspond to an entry in the frontmatter array (same `summary`, same `domain`, same `size`). Drift is a concern the reviewer must surface.
3. Read `notes_log` from the frontmatter (parsed as JSON array). Build two lists:
   - **Unconsidered notes** — entries where `considered_by` is empty. These are guidance the user added that no skill run has folded in yet; you MUST address each one in the checklist below (or explicitly explain why you can't if a `blocker` note isn't applicable).
   - **Previously considered notes** — entries where `considered_by` has entries. Read for context but don't double-address.

   Severity weights: `info` = take into account; `warn` = strongly consider; `blocker` = must address or explain why you can't (and what would unblock).

### Step 3: Read the prior review (continuity)

1. If `review_path` is set AND the file exists, read it. This is a re-review — preserve continuity by referencing prior findings, but produce a FRESH verdict against the current report revision (don't echo the prior verdict).
2. On first review, skip this step.

### Step 4: Re-walk the materials (no cap)

The reviewer's job is to catch what the writer missed — including materials that landed but weren't synthesized. Re-walk `materials_path` in full.

1. Resolve `materials_path` from the report frontmatter. If unset (legacy or hand-authored report), warn and skip the walk — proceed with checklist on the report body alone.
2. Walk the directory using the same FIFO-by-mtime + chunked-PDF pattern as [[research-write]] Step 2. **No `material_limit` cap applied** — the reviewer reads what's on disk now, mirroring the [[meta-revise-project-plan]] Step 4 precedent. The cap is a `research-write`-time concept only.
3. If the per-report directory is empty AND `vault/raw/project-research/<project>/` (the project-level fallback) contains files, walk there instead — the original `research-write` may have used the fallback layout, and the reviewer should see the same materials.
4. Build a mental list of materials that exist on disk vs materials surfaced in the report's `## Findings` section. The gap (present on disk, unaddressed in Findings) is a thoroughness concern.

### Step 5: Run the checklist

Walk the categories below. Note specific findings.

**Thoroughness**

- Did the report cover the right material? Are there obvious gaps (materials present on disk but unaddressed in `## Findings`)?
- Does each material surfaced in the report match the materials on disk (no fabrication)?
- Is `## Findings` deep enough for the question, or skimming the surface?

**Internal consistency**

- Do the findings support the recommendations? Each `recommended_changes` entry should have a traceable line in `## Findings` that motivates it.
- Does the frontmatter `recommended_changes` array mirror the `## Recommended changes` body bullets (same `summary`, same `domain`, same `size`)? Drift between the two surfaces is a concern.
- Do the `## Notes` open questions cohere with the findings (not contradicting them, not orphaned from the body)?

**Recommended-change sanity**

- Are recommendations appropriately sized (`small | medium | large`)? A `large` rec that's really 3 changes wedged together is a split-candidate concern.
- Is each recommendation in the right domain (`development` for code, other domains as warranted)? Cross-domain recs should be justified in `## Findings`.
- Is the set collectively coherent? Do the recommendations imply a single concerted direction, or do they pull against each other without justification?
- Are there findings that imply a recommendation but none was written (missed opportunity)?

**Scope discipline**

- Does the report stay within the project's stated scope (the project entry's `## Why` + `## Approach`)?
- Does the report drift into adjacent investigations that should be their own reports under the same project?

**Material grounding** (continuity check on update passes)

- If the report has `## Update N` sections, do those updates faithfully reflect new material since the prior revision?
- Are superseded recommendations marked `status: abandoned` in the frontmatter array (per [[research-update]]'s contract), or did the update silently drop them?

### Step 6: Compose the verdict

Pick ONE:

- **approve** — report is sound, recommendations are well-grounded, no blockers. Minor nits at most.
- **request-changes** — substantive concerns; revise should address before downstream consumption.
- **reject** — fundamental issue; this report as written shouldn't proceed (materials misread, recommendations contradict findings, scope catastrophically off).

Threshold guidance:

- Use **approve** generously when concerns are nit-level. Don't gate on style preferences.
- Use **request-changes** when at least one concern is `concern` or `blocker` severity.
- Use **reject** sparingly — only when the right path forward is "re-run [[research-write]] with fresh context" rather than fold review findings into the existing body.

### Step 7: Write the review

Write to `vault/output/research/reports/<report_id>-review.md`. Create `vault/output/research/reports/` if missing. Use this EXACT structure:

```markdown
# Review — <title>

**Reviewed:** <ISO 8601 UTC now>
**Report:** vault/wiki/research/research-report/<report_id>.md
**Report revision:** <N>
**Verdict:** approve | request-changes | reject

## TL;DR

<one sentence: what's good, what's concerning, what's blocking>

## Checklist

### Thoroughness
- [x] / [ ] Materials present on disk are addressed in Findings
- [x] / [ ] No fabricated materials (every cited source is real)
- [x] / [ ] Findings depth proportionate to the question
<notes if relevant>

### Internal consistency
- [x] / [ ] Each recommendation traces back to a finding
- [x] / [ ] Body bullets mirror frontmatter `recommended_changes`
- [x] / [ ] Notes cohere with findings (no contradictions, no orphans)
<notes>

### Recommended-change sanity
- [x] / [ ] Sizes (small / medium / large) appropriate
- [x] / [ ] Each rec in the right domain
- [x] / [ ] Set is collectively coherent
- [x] / [ ] No findings imply an unwritten recommendation
<notes>

### Scope discipline
- [x] / [ ] Report stays within project's stated scope
- [x] / [ ] No drift into adjacent investigations
<notes>

### Material grounding (update passes only)
- [x] / [ ] `## Update N` sections reflect new material faithfully
- [x] / [ ] Superseded recs marked `status: abandoned` (not silently dropped)
<notes>

## Concerns

(skip section if verdict is approve and there are no concerns)

- **blocker** — <what + why it blocks + suggested resolution>
- **concern** — <what + why it concerns + suggested resolution>
- **nit** — <what>

## Suggested changes

(only if verdict is request-changes — concrete revisions for research-revise to apply)

1. <specific change to the report>
2. <specific change>
```

### Step 8: Update report frontmatter

Edit the report entry's frontmatter via the Edit tool:

- `review_path: vault/output/research/reports/<report_id>-review.md`
- `reviewed_at: <ISO 8601 UTC now>`
- `updated: <ISO 8601 UTC now>`
- For each unconsidered note from Step 2.3 that you DID address in the checklist, append a `considered_by` entry: `{ skill: "research-review", ts: "<ISO 8601 UTC now>" }`. Notes you couldn't address (because they don't apply to this run's scope) get an entry too, with the explanation captured in your verdict's `## Concerns` or `## Suggested changes` section. Surgical `replaceField` on the `notes_log` line — single-line JSON, same pattern as `recommended_changes`. Per [[archetype-research-report]] § `notes_log` item shape, append; never mutate existing fields.
- `review_status` + `status` per the verdict:
  - On `approve` → `review_status: approved`, `status: reviewed`. (The `reviewed → approved` flip is a separate human action — manual frontmatter edit today, or a future `research-approve` skill. [[meta-scaffold-project-plan]] consumes `recommended_changes` only from `status: approved` reports.)
  - On `request-changes` → `review_status: request-changes`, `status: request-changes`.
  - On `reject` → `review_status: rejected`, `status: draft` (unchanged from prior, preserved for the user to choose: re-write from scratch or abandon). No terminal `rejected` status enum value exists on research-report (matches [[meta-review-project-plan]]'s reject-path treatment).

### Step 9: Audit log

```bash
node scripts/record-dashboard-action.mjs \
  --action research-review \
  --skill research-review \
  --args '{"report_id":"<id>","verdict":"<verdict>","blockers":<B>,"concerns":<C>,"nits":<Nt>}' \
  --files-touched '["vault/output/research/reports/<report_id>-review.md","vault/wiki/research/research-report/<report_id>.md"]'
```

### Step 10: Print summary

```
<✓ if approve, ⚠ if request-changes, ✗ if reject> Reviewed research-report for <title>
  report:    <report_id>
  verdict:   <verdict>
  revision:  <N>
  blockers:  <B>
  concerns:  <C>
  nits:      <Nt>
  review:    vault/output/research/reports/<report_id>-review.md
  next:      <appropriate next-step text — see below>
```

`next:` text per verdict:

- `approve` → `status is now 'reviewed'. Edit frontmatter to status: approved when ready to let meta-scaffold-project-plan consume recommended_changes.`
- `request-changes` → `/os research revise <report_id>` (fold these findings into the report, then re-review)
- `reject` → `review verdict was REJECT — choose one: (a) /os research write <project> <report_topic> with a fresh prompt to re-author from scratch (delete the old report first), or (b) leave the report as 'draft' if you want to abandon the investigation. The status field will remain at 'draft'.`

## Outputs

- Review markdown at `vault/output/research/reports/<report_id>-review.md`
- Report entry frontmatter: `review_path`, `reviewed_at`, `updated`, `review_status`, `status` updated per verdict
- Audit log line

## Errors

- `inputs.report_id` slug invalid → reject with the regex
- Report not found / not `type: research-report` → reject with id
- `review_status` is anything other than `pending` or `request-changes` → reject with the actual state
- `materials_path` unreadable → warn and proceed with checklist on the report body alone (don't hard-fail; missing materials don't invalidate the report's existing content)

## What this skill must NOT do

- Edit the report body (the report is the writer's artifact, not the reviewer's)
- Mutate `recommended_changes` or any other report frontmatter beyond `review_path`, `reviewed_at`, `review_status`, `status`, `updated`
- Scaffold downstream changes from `recommended_changes`
- Touch the owning project entry's `research_paths` array

If you're tempted to act on a concern directly, that's an `approve` (the concern is moot) or `request-changes` (revise should address it). The reviewer NEVER acts on the report or the materials directly.

## See also

- [[archetype-research-report]] — research-report archetype contract + status enum + review-gate fields
- [[research-write]] — produces the report this skill reviews
- [[research-revise]] — consumes this skill's verdict + folds findings into the report
- [[research-update]] — delta-driven rewrite that may reset `review_status: pending` and re-trigger this skill
- [[meta-review-project-plan]] — project-tier analog; this skill mirrors its read-only constraint
- [[dev-review-change]] — change-tier analog; same write/review separation
- [[meta-scaffold-project-plan]] — terminal phase; consumes `recommended_changes` only from `status: approved` reports
