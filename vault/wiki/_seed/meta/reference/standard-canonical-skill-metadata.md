---
id: standard-canonical-skill-metadata
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [standard, os, skill, design, routing]
source: manual
private: false
title: Canonical skill metadata (design)
url: internal://standard/canonical-skill-metadata
kind: doc
last_verified: 2026-08-20
---

# Canonical skill metadata (design)

> **This document is a design, not shipped behavior.** Nothing described below is implemented. No generator exists, no generated views exist, and no drift test enforces any of it. Today's routing surfaces are hand-maintained and reconciled after the fact by audit checks. This is the proposal for changing that, written down so the proposal can be reviewed, argued with, and implemented deliberately — or rejected on the record. Do not cite it as a contract; skills conform to [[standard-skill-format]].

## The problem

A skill's routing facts are written down in at least four places, by hand:

| where                                      | what it holds                                   | maintained by                                |
| ------------------------------------------ | ----------------------------------------------- | -------------------------------------------- |
| `.claude/skills/<n>/SKILL.md`              | `name`, `description`, `domain`, `spawns`       | the skill author                             |
| `OS.md` § Intent vocabulary                | the natural-language phrasings that route to it | `meta-add-skill` step 8, or by hand          |
| `domains/<d>/playbook.md` § Skills         | a one-line roster entry                         | `meta-add-skill` step 7, or by hand          |
| `domains/meta/app/server/lib/skill-ids.ts` | the id constant app code references             | generated — `scripts/generate-skill-ids.mjs` |

Three of the four are copies. Nothing keeps them equal at write time, so the OS detects divergence afterwards, with audit findings: `router-vocab-skill-uncovered` when a skill never made it into the vocabulary table, `playbook-skill-coverage` when it never made it into a roster, `playbook-skill-exists` when a roster names a skill that is gone. Each of those findings is a small repair task, and each exists only because the same fact was written twice.

The fourth row is the counter-example that motivates this design. `skill-ids.ts` is generated from the skills tree and guarded by a staleness check (`skill-ids-module-stale`), so it cannot drift from reality — it can only be _stale_, which is a different and much cheaper failure: mechanical, detectable before commit, and fixed by re-running one command.

## The proposal

**Skill frontmatter becomes the single routing source. Every other routing surface becomes a generated view with a drift test.**

Concretely:

1. Routing facts that today live outside the skill move _into_ the skill's frontmatter — most importantly the intent phrasings, which are the one routing fact with no home in the skill at all today.
2. A generator renders the derived surfaces from the skills tree: the intent-vocabulary table, each domain playbook's Skills roster, and any spawn/dependency table.
3. A structural test asserts each generated region matches what the generator would produce right now — the `skill-ids-module-stale` pattern, promoted from an audit finding to a pre-commit gate.
4. Hand-editing a generated region stops being a repair and becomes a test failure, with the fix being "edit the skill, re-run the generator".

### Sketch: the frontmatter additions

```yaml
# Namespace 2 (OS orchestration) gains the routing facts that are
# currently written into OS.md and the playbook by hand.
intent_phrases:
  - review a pull request
  - pr review
  - look at this PR
roster_line: 'Review a PR — categorized comments, written to a pr-review entry.'
```

`intent_phrases` is a list rather than the pipe-separated string `meta-add-skill` takes as input today, because the string form exists only to survive a single-line form field, and the canonical source should not inherit that constraint.

`roster_line` is separate from `description` on purpose. `description` is tuned for harness discovery — it is matched against, so it is long and keyword-dense. A playbook roster wants a human-readable sentence. Collapsing the two would degrade one of them; the design keeps both and lets the generator choose.

### Sketch: the generated regions

Generated views live inside their existing files, delimited by markers, so the surrounding hand-written prose survives:

```markdown
<!-- generated:intent-vocabulary — edit skill frontmatter, then run scripts/generate-routing-views.mjs -->
| `review a pull request`, `pr review` | `dev-pr-review` |
<!-- /generated:intent-vocabulary -->
```

The marker text carries its own repair instruction, because the person who finds it is usually the person who just tried to edit it.

### Sketch: the drift test

One structural test per generated region, all the same shape: render from the tree, compare to the file, fail with a diff and the regenerate command. That is a stronger guarantee than today's audit findings — it fires before the commit rather than at the next audit — and it replaces three separate coverage checks with one equality check.

## What this deliberately does not change

- **`description` stays the harness's field.** Discovery quality is a separate problem from routing consistency, and this design must not become a reason to rewrite descriptions. Any description rewrite needs its own regression gate against trigger collisions, independent of this.
- **Playbooks keep their prose.** Only the roster region is generated. A playbook is a document about how a domain works, not a table of contents.
- **`OS.md` keeps its structure.** Only the vocabulary table's rows are generated.
- **Nothing about dispatch tuning moves.** `effort` / `model` / `model_policy` and friends are already single-sourced in frontmatter and read directly; they are not copied anywhere and need no view.

## Open questions

- **Ordering.** Generated rows need a stable order or every regeneration produces a diff. Alphabetical by skill name is the obvious answer; grouping by domain reads better in `OS.md`. The generator has to pick one and never revisit it.
- **Phrase collisions.** Moving phrasings into frontmatter makes collisions across skills detectable for the first time (today they are only visible in the assembled table). Should the generator refuse to emit a colliding phrase, or emit it and let a separate test fail? Refusing is fail-closed but blocks unrelated work.
- **Migration.** The existing vocabulary table and rosters are hand-written and not uniformly shaped. A one-time extraction back into frontmatter is a mechanical but lossy step — some rows carry commentary that has nowhere to go.
- **Cost.** Three audit findings and one occasional repair task is a real but small tax. This design trades it for a generator, a marker convention, per-region tests, and a migration. That trade is worth stating explicitly before anyone starts, and it is the main reason this is a design document rather than a change.

## Related

- [[standard-skill-format]] — the frontmatter contract this design would extend
- [[standard-execution-modes]] — why frontmatter alone cannot carry constraints that must bind on dispatched paths
- [[standard-os-audit]] — the drift checks this design would replace with equality tests
- [[standard-playbook-format]] — the roster region a generated view would own
- [[meta-add-skill]] · [[meta-add-skill-to-playbook]] · [[meta-add-skill-to-router-vocab]] — the write-time and repair-time paths this design collapses into one
