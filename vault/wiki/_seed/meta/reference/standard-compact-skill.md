---
id: standard-compact-skill
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [standard, skills, context, progressive-disclosure]
source: manual
private: false
title: Compact skill format — SKILL.md plus references/
url: internal://standard/compact-skill
kind: doc
last_verified: 2026-08-20
---

# Compact skill format — SKILL.md plus references/

## What it is

A layout for large skills. `SKILL.md` keeps only what the model needs to _decide_; bulk material it needs to _copy_ moves to `references/*.md` inside the skill directory, and the procedure says exactly when to Read each one.

A skill's whole body is loaded before the first decision is made. A 300-line skill whose bulk is an output template pays for that template on every run, including runs that stop at step 1 because the input was invalid. Splitting the file moves that cost to the step that actually needs the material.

[[meta-status-report]] is the worked example: 300 → 125 lines in `SKILL.md`, with four reference files carrying the output skeleton, the per-type variants, the rollup query, and the audit-log args.

## What stays in SKILL.md

- **Frontmatter** — always, unchanged. It is the routing, scaffolding, and dispatch contract; nothing about it is bulk.
- **Purpose** — what the skill does and what it writes.
- **Inputs** — the human-readable mirror of the `inputs:` block.
- **The decision-making procedure** — every step, every branch, every condition. The numbered spine stays whole even when a step's payload moves out.
- **Error handling** — failure modes and recovery, including what to do when a reference file is missing.
- **Anything load-bearing but short.** A four-line rule costs less to keep than the round-trip to fetch it.

Target: about 40% of the pre-split length. That is a target, not a gate — a skill that is 55% decision-making legitimately lands at 55%.

## What moves to references/

- Output templates and skeletons — the literal markdown/JSON/text shape the skill emits.
- Type or variant taxonomies — "when the input is X, add these sections, drop those."
- Long example blocks and command invocations with many arguments.
- Lookup and derivation tables consulted while composing, not while deciding.

Each reference file is a real document, not a fragment: a heading, one line saying which procedure step reads it, then the material. Files below ~20 lines are not worth splitting out.

## The progressive-disclosure rule

The procedure must name the file and the moment:

> 8. **Compose the report.** Read `references/output-template.md` for the skeleton …

Requirements:

- **Name the path literally**, relative to the skill directory (`references/<file>.md`). Some dispatch paths hand the skill text to the model verbatim, with no variable substitution and no frontmatter processing — a path assembled from a variable will not resolve there, but a literal relative path Read on demand always does.
- **Say "Read"** — the tool call is the point. A reference nobody is told to open is a reference that silently stops affecting output.
- **One index near the top** listing each file, the step that reads it, and what it holds. Cheap to keep, and it makes an unrouted reference obvious.
- **Route every moved line.** Any instruction that affects output must survive either in `SKILL.md` or in a reference the procedure demonstrably routes to.
- **When in doubt, keep it in `SKILL.md`.** Ambiguity between "decision" and "material" resolves toward staying.

## Acceptance bar per application

Every application of this pattern clears all three before it lands:

1. **Structurally identical output.** A comparison run against the pre-split version produces the same sections, in the same order, with the same fields populated. Wording may differ the way any two runs differ; structure may not.
2. **References actually Read.** The run's transcript shows the Read calls for the reference files the procedure names. No Read means the model composed from memory and the material is now decorative.
3. **Cost not worse.** Compare tokens and wall-time for the comparison run against a pre-split run of similar shape. The extra Read calls must be more than paid for by the smaller preamble.

A split that fails (2) is worse than no split at all: the instructions left the file and stopped being followed. Revert rather than patch around it.

## When not to apply it

- Skills already under ~150 lines — the split costs more than it saves.
- Skills whose body is decision-making end to end, with no template or table to lift.
- Material read on _every_ step. If the model needs it continuously, keeping it inline is cheaper than re-reading it.

## Related

- [[standard-skill-format]] — the frontmatter contract and body sections every skill carries
- [[standard-file-naming]] — where skills and their files live
- [[meta-status-report]] — the first skill in this layout
