---
id: archetype-reference
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [archetype, memory]
source: manual
private: false
title: Reference archetype
url: internal://archetype/reference
kind: doc
last_verified: 2026-05-19
---

# Reference archetype

## What it is

A pointer to an external resource: a URL, an internal dashboard, a doc, a paper. The body summarizes what the resource is and when to consult it; the URL is the canonical pointer.

## Required frontmatter (in addition to shared)

| field           | type   | notes                                                    |
| --------------- | ------ | -------------------------------------------------------- |
| `title`         | string | display name                                             |
| `url`           | string | the pointer (HTTP URL, file path, or internal:// scheme) |
| `kind`          | enum   | `dashboard`, `doc`, `repo`, `api`, `paper`, `other`      |
| `last_verified` | date   | optional; hint that the URL was reachable on this date   |

## When to use

- An external link you want to find again with one search
- A doc that informs decisions but lives outside the repo
- A dashboard or runbook owned elsewhere

The OS's own standards and archetype contracts also live as `reference` entries — they're "internal references" with `url: internal://...`.

## Example

```markdown
---
id: claude-code-hooks-docs
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [claude-code, hooks]
source: manual
private: false
title: Claude Code hooks documentation
url: https://docs.claude.com/claude-code/hooks
kind: doc
last_verified: 2026-05-19
---

# Claude Code hooks documentation

<https://docs.claude.com/claude-code/hooks>

## What it is

Official Claude Code documentation for the hook system — events, matchers,
JSON event shapes, and the settings.json schema.

## When to consult it

- Adding a new hook event to the OS
- Debugging a hook that doesn't fire as expected
- Understanding what tool_input fields are available per event type

## Related

- `[[standard-hook-protocol]]` — OS's local hook conventions
```

## Related

[[archetype-entity]] (vs. things that have ongoing state), [[archetype-runbook]] (when the reference is a procedure)
