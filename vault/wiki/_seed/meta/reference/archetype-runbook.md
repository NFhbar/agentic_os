---
id: archetype-runbook
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [archetype, memory]
source: manual
private: false
title: Runbook archetype
url: internal://archetype/runbook
kind: doc
last_verified: 2026-05-19
---

# Runbook archetype

## What it is

A repeatable step-by-step procedure for a recurring task. Runbooks turn one-off "I did X" moments into reusable knowledge — and let skills execute the same procedure consistently.

## Required frontmatter (in addition to shared)

| field     | type   | notes                                                     |
| --------- | ------ | --------------------------------------------------------- |
| `title`   | string | "Deploy to staging", "Recover from corrupted vault index" |
| `trigger` | string | what causes you to reach for this runbook                 |
| `owner`   | string | `[[entity-id]]` of the person/system responsible          |

## Optional frontmatter — scheduling

A runbook becomes a **scheduled job** when both fields below are present. The
scheduler-tick (`scripts/scheduler-tick.mjs`) fires `prompt` via `claude -p`
whenever `schedule` says it is due.

| field      | type   | notes                                                                  |
| ---------- | ------ | ---------------------------------------------------------------------- |
| `schedule` | string | standard 5-field cron expression in machine local time (`"0 9 * * *"`) |
| `prompt`   | string | the intent fed to `claude -p` when due (e.g. `"/os brief"`)            |

When set, the runbook's body sections (Steps, Verification, Rollback) describe
what the agent is expected to do — same as a manual runbook, but the
**trigger** section now states the schedule in plain English (e.g. "Every
weekday at 9am"). See `vault/wiki/_seed/meta/reference/standard-scheduled-jobs.md`
for the full pattern.

## When to use

- A procedure you've done more than twice
- Steps that are not self-evident from the code
- Recovery procedures where forgetting a step causes pain
- **Proactive surfacing** — anything you want the OS to do without you asking (add `schedule` + `prompt`)

Runbooks differ from `note` in that they're action-oriented and meant to be replayed.

## Example

```markdown
---
id: rebuild-vault-index-manually
type: runbook
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [vault, recovery]
source: manual
private: false
title: Rebuild vault index manually
trigger: When .index/manifest.json is missing or stale
owner: [[meta-domain]]
---

# Rebuild vault index manually

## Trigger

When `.index/manifest.json` is missing, corrupted, or visibly stale (e.g.
"generated" timestamp older than recent wiki edits).

## Owner

[[meta-domain]]

## Prerequisites

- Node.js >= 20 installed

## Steps

1. From repo root: `node .claude/hooks/rebuild-vault-index.mjs`
2. Verify output reports the expected number of entries
3. Open dashboard — Overview should now show correct stats

## Verification

`jq '.entries | length' vault/.index/manifest.json` matches
`find vault/wiki -name '*.md' | wc -l`.

## Rollback

The index is derived data — no rollback needed; just rerun the rebuild.
```

## Related

[[archetype-reference]] (often link to external runbooks)
