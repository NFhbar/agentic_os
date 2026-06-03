---
id: archetype-decision
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [archetype, memory]
source: manual
private: false
title: Decision archetype
url: internal://archetype/decision
kind: doc
last_verified: 2026-05-19
---

# Decision archetype

## What it is

A captured choice with context, alternatives considered, and rationale. The point of writing it down is for future-you to understand _why_ a current shape exists — and to avoid relitigating already-settled questions.

## Required frontmatter (in addition to shared)

| field          | type   | notes                                                          |
| -------------- | ------ | -------------------------------------------------------------- |
| `title`        | string | imperative or declarative; e.g. "Use Fastify for app backends" |
| `status`       | enum   | `proposed`, `accepted`, `deprecated`, or `superseded`          |
| `alternatives` | array  | list of options that were rejected (free-form strings)         |
| `supersedes`   | string | optional; ID of an older decision this replaces                |

## When to use

Capture a decision when:

- The rationale is non-obvious from the resulting state
- You expect the question to come up again
- It commits future work in a particular direction

Don't capture trivial choices ("named the variable foo") or things that are self-evident from code.

## Example

```markdown
---
id: use-fastify
type: decision
domain: development
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [stack, backend]
source: conversation/session-abc123
private: false
title: Use Fastify for app backends
status: accepted
alternatives: ["Express (more popular)", "Hono (lighter)", "Raw http.Server"]
---

# Use Fastify for app backends

## Context

Apps need a backend for fs access and the AI bridge. Want TypeScript-native, fast, low-ceremony.

## Options considered

- Express — most familiar but feels slow, plain JS-y
- Fastify — TS-native, fast, schema-aware
- Hono — lighter but smaller ecosystem
- Raw http — too much boilerplate at scale

## Decision

Fastify.

## Rationale

TS-native plugins + schema validation reduce boilerplate. Speed isn't critical
locally but matters if we ever go remote. Mature enough to trust.

## Consequences

All scaffolded apps inherit this. Replacing later would mean rewriting
server/routes/\* and possibly auth middleware.
```

## Related

[[archetype-project]] (decisions often emerge from projects), [[standard-wiki-format]]
