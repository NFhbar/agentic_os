---
id: archetype-repo-knowledge
type: reference
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [archetype, memory, development, review, knowledge]
source: seed
private: false
title: Repo knowledge archetype
url: internal://archetype/repo-knowledge
kind: doc
last_verified: 2026-05-22
---

# Repo knowledge archetype

## What it is

A **repo-knowledge** entry captures structured prose knowledge about a single repository — what it does, how it's organized, what conventions govern it, what dependencies matter. Produced by [[dev-analyze-repo-for-review]] in a single Claude call against the repo's [[archetype-pr-review-repo-cache]] clone; consumed by [[dev-pr-review]] before forming opinions on style or correctness.

This is the **Stage 2** of repo indexing — slow, judgment-requiring, refreshed on demand. The companion Stage 1 fields (languages, build_system, test_pattern, etc.) live on the cache archetype itself and refresh on every pull.

The point: when reviewing a PR, the model should evaluate against **this repo's** conventions, not generic best practices. A "use Result<T,E>, don't throw" convention in one repo and "always throw, never use Result" in another are both correct _for that repo_ — the review model can only know which applies if we tell it.

## Required frontmatter (in addition to shared)

| field             | type   | notes                                                                                                   |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `title`           | string | `"Repo knowledge: <owner>/<repo>"`                                                                      |
| `owner`           | string | GitHub owner — joins to the cache entry                                                                 |
| `repo`            | string | GitHub repo name — joins to the cache entry                                                             |
| `status`          | enum   | `ready`, `analyzing`, `error`                                                                           |
| `analyzed_at`     | string | ISO timestamp — when the last analysis pass completed                                                   |
| `based_on_commit` | string | Git SHA of HEAD at analysis time. Drift = (cache.head_sha != based_on_commit).                          |
| `analyzer_model`  | string | Model id that produced this analysis (e.g. `claude-opus-4-7`). Lets us re-analyze if we upgrade models. |

## Optional frontmatter

| field        | type   | notes                                       |
| ------------ | ------ | ------------------------------------------- |
| `last_error` | string | Captured error message when `status: error` |

## Lifecycle

| stage       | what it means                                                            |
| ----------- | ------------------------------------------------------------------------ |
| `analyzing` | Skill is mid-analysis. Body may be partial or absent.                    |
| `ready`     | Analysis complete; body sections populated.                              |
| `error`     | Last analysis failed; `last_error` describes the cause. Re-run to retry. |

## Drift semantics

The entry has TWO timestamps that matter:

- `analyzed_at` — wall-clock time of the analysis
- `based_on_commit` — git SHA the analysis was based on

Drift is detected when `pr-review-repo-cache.head_sha != based_on_commit`. The audit's `repo-knowledge-stale` check fires when:

- `analyzed_at` > 30 days old (calendar drift — even unchanged repos benefit from a refresh as the analyzer model improves)
- OR the head_sha has moved by more than ~50 commits since `based_on_commit` (structural drift — meaningful changes may have landed)

The dashboard's Repos tab surfaces this as a yellow "stale" badge with a Re-analyze button.

## Body sections (the actual knowledge)

The body is **prose, not structured data**. The review model reads it like documentation. Each section has a defined purpose, but the analyzer is free to leave sections short when there's nothing notable to say.

```markdown
# <title>

## Overview
One paragraph. What does this repo do, who uses it, deployment shape, scale.

## Stack
- Language: <lang> (<version, mode>)
- Framework: <framework>
- Test: <runner>
- Build: <tool>
- Lint/format: <tool>
- Run: <command(s)>
- Type system: <ts/flow/mypy/none>

## Structure
Top-level layout — list of dirs with one-line purposes. Bias toward the dirs a reviewer needs to know about; skip generated/boring ones.

## Conventions

### Error handling
Prose: how errors are handled in this codebase. Catch-and-wrap? Result types? Throw-and-let-bubble? Library functions used? Anti-patterns to flag?

### Tests
Prose: where tests live, what runner, what shape (describe/it, table-driven, snapshot, etc.), test naming, mocking style.

### Logging
Prose: which logger, what log shape, what NOT to use (`console.*`, raw print).

### Type discipline
Prose: how strict, where types live, treatment of `any`/`unknown`, public type exposure pattern.

### (other sections as relevant)
The analyzer adds extra subsections when the repo has notable conventions in other areas: async, state management, security, formatting, etc.

## Notable dependencies
Bullet list of deps the reviewer needs to know about. Skip generic ones (lodash, axios). Call out:
- Auth library + its setup pattern
- ORM / DB client
- Validation lib + where schemas live
- HTTP client wrapper
- Internal libraries with conventions

## Docs
Bullet list of doc files that exist + a one-line summary of each:
- README — `<one-line summary>`
- CONTRIBUTING — `<one-line summary>` (or "absent")
- CHANGELOG — `<one-line summary>` (or "absent")
- (others)
```

## When to use

- Produced automatically on first cache of a repo by [[dev-cache-pr-review-repo]] (Phase 3.5 auto-trigger).
- Re-run manually via the dashboard's Repos tab "Re-analyze" button.
- Re-run on demand: `/os analyze repo <owner>/<repo>` (planned in the intent vocabulary).

## When NOT to use

- For repos the OS writes to — that's [[archetype-entity]] with `kind: repo`'s job. The entity's `## Conventions` section is the source of truth for _changes_; this archetype is the source of truth for _reviews_. They CAN overlap (you could review PRs against a repo you also write to), in which case both entries exist independently.
- To replace the [[archetype-pr-review-repo-cache]] — they're peers. Cache = filesystem state + cheap heuristics. Knowledge = prose understanding. Both refresh independently.

## Composition

```
pr-review-repo-cache(acme/api)            ← cache state + Stage 1 heuristics
  └─ repo-knowledge(acme/api)             ← Stage 2 prose knowledge
       └─ consumed by dev-pr-review's prompt for every review of acme/api
```

## Outputs / artifacts produced

| artifact        | location                                                              | when                                        |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| Knowledge entry | `vault/wiki/<domain>/repo-knowledge/repo-knowledge-<owner>-<repo>.md` | Created on first cache, refreshed on demand |

## Example

```markdown
---
id: repo-knowledge-acme-api
type: repo-knowledge
domain: development
created: 2026-05-22T14:00:00Z
updated: 2026-05-22T14:00:42Z
tags: [knowledge, review]
source: dev-analyze-repo-for-review
private: false
title: 'Repo knowledge: acme/api'
owner: acme
repo: api
status: ready
analyzed_at: 2026-05-22T14:00:42Z
based_on_commit: a3f9b2e1c0d8f7e6b5a4938271605f4e3d2c1b0a
analyzer_model: claude-opus-4-7
---

# Repo knowledge: acme/api

## Overview
A small TypeScript CLI for muddling… etc.

## Stack
- Language: TypeScript (strict mode)
- Framework: none (plain Node)
- Test: Vitest
- Build: tsc
- Lint/format: Biome
- Run: `npm run dev`
- Type system: typescript

## Structure
- `src/` — application code
- `tests/` — unit tests (Vitest)
- `bin/` — CLI entry point

## Conventions

### Error handling
Errors thrown directly; no Result wrappers. Use `Error` subclasses (`ParseError`, `IOError`) for domain errors. CLI catches at the top level and prints a colorized message.

### Tests
Tests in `tests/<module>.test.ts`. Use `describe`/`it`. No snapshots — explicit assertions preferred.

### Logging
`console.log` for CLI output is fine. No structured logger configured.

### Type discipline
Strict mode. No `any`. Public types in `src/types.ts`.

## Notable dependencies
- `commander` — CLI argument parsing, conventions in `bin/cli.ts`
- `chalk` — colorized output, lazy-loaded

## Docs
- README — install + usage examples
- (no CONTRIBUTING)
- (no CHANGELOG — use git tags)
```

## Related

- [[archetype-pr-review-repo-cache]] — sibling archetype; cache state + Stage 1 fields
- [[dev-analyze-repo-for-review]] — the skill that produces this archetype
- [[dev-cache-pr-review-repo]] — the upstream skill; invokes analyze on first clone
- [[dev-pr-review]] — the consumer; reads this entry into the review prompt's CODE CONTEXT block
- [[archetype-entity]] — the _other_ repo-knowledge concept; used for repos the OS writes to (its `## Conventions` body section)
