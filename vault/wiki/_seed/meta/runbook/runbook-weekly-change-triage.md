---
id: runbook-weekly-change-triage
type: runbook
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [schedule, changes, hygiene, lifecycle]
source: seed
private: false
title: Weekly change triage
trigger: Monday at 09:00 local time
owner: meta-domain
schedule: '0 9 * * 1'
prompt: "Read vault/.index/manifest.json. Find every entry with type: change and bucket by lifecycle freshness. For each non-terminal change (status ∈ planning / in-progress / in-review), compute calendar-day age from the entry's `updated` field. Flag stale: (a) planning + review_status pending + no plan_path for >3 days, (b) planning + plan_path set + review_status pending for >2 days, (c) in-progress for >7 days, (d) in-review for >14 days. Also flag any change with review_status: rejected but status NOT set to abandoned. Compose a short triage report (under 250 words): one line per stale change with [[id]], status, days stale, and the concrete next command (run /os write-change | review-change | open-pr | close-change). End with either 'Triage clean — no stalled changes' or 'N changes need attention'. Write report to vault/output/meta/triage/<YYYY-MM-DD>.md and mirror to vault/output/meta/triage/latest.md."
---

# Weekly change triage

## Trigger

Monday at 09:00 local time, fired by the scheduler tick.

## Owner

[[meta-domain]]

## Why this exists

`/os brief` covers stale changes daily, but a focused weekly pass catches longer-running drift:

- Plans drafted weeks ago and never reviewed
- Reviews approved but never executed
- PRs opened but never merged
- Rejected reviews where status was never updated to `abandoned`

The brief shows everything; this runbook produces a **dedicated triage report** archived per-week so trends are visible across months.

## Prerequisites

- `vault/.index/manifest.json` exists and is fresh (the index hook auto-rebuilds on wiki edits; manual rebuild via `node .claude/hooks/rebuild-vault-index.mjs` if needed).
- The manifest carries `status`, `review_status`, `pr_url`, `updated` on every change entry (lifted from frontmatter — see [[standard-index-schema]]).

## Steps

When fired, the scheduler invokes `claude -p "<prompt>"` (see frontmatter). Claude:

1. Reads the manifest, filters to `type: change`.
2. Computes age per change from `updated`.
3. Applies the staleness thresholds documented in the prompt.
4. Composes the markdown triage report.
5. Writes to `vault/output/meta/triage/<YYYY-MM-DD>.md` + `latest.md`.

## Verification

After it fires Monday morning, you should see:

- `vault/output/meta/triage/<this-monday>.md` — the dated report
- `vault/output/meta/triage/latest.md` — same content
- A scheduler-fire row in `vault/raw/scheduled-runs.jsonl` and `.claude/state/events.db`

## Tuning

Thresholds are encoded in the prompt for transparency. Adjust by editing this frontmatter's `prompt:` field. Reasonable variants:

- Tight teams: drop thresholds (e.g. plan stale at 1 day, in-review at 7)
- Slower cadence: relax (in-review at 30 days)

If the report is consistently empty, the runbook may be over-tuned — consider widening thresholds or removing it.

## Related

- [[archetype-change]] — the change archetype contract
- [[standard-change-workflow]] — lifecycle states + skill chain
- [[meta-brief]] — covers stale changes daily (less archival)
- [[runbook-weekly-health-check]] — parallel weekly cadence for OS-wide drift
