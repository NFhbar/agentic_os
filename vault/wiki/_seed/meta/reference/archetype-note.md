---
id: archetype-note
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [archetype, memory]
source: manual
private: false
title: Note archetype
url: internal://archetype/note
kind: doc
last_verified: 2026-05-19
---

# Note archetype

## What it is

Free-form. The escape hatch when the other archetypes don't fit.

## Required frontmatter (in addition to shared)

| field   | type   | notes                                   |
| ------- | ------ | --------------------------------------- |
| `title` | string | display name                            |
| `topic` | string | high-level subject (used for filtering) |

## When to use

- Half-formed thoughts, observations, open questions
- Conversation snippets that don't cleanly fit another archetype yet
- Working notes during a long task

Notes can later be promoted to a more specific archetype via `meta-evolve` if a clearer shape emerges.

## Example

```markdown
---
id: prefer-jsonl-over-csv
type: note
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [logs, format]
source: conversation/session-xyz
private: false
title: Prefer JSONL over CSV for OS logs
topic: log-formats
---

# Prefer JSONL over CSV for OS logs

JSONL gives us:

- Append-only without escaping concerns
- Arbitrary nesting (e.g. files_touched: array)
- Easy parse in node + grep-friendly

CSV would feel more spreadsheet-friendly but the dashboard renders these anyway.
Settled in [[standard-log-formats]].
```

## Related

All other archetypes — note is the "couldn't decide which" default.
