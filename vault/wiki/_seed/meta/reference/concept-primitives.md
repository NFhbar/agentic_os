---
id: concept-primitives
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [concept, core, registry]
source: seed
private: false
title: Primitives registry
url: internal://concept/primitives
kind: doc
last_verified: 2026-05-20
---

# Primitives registry

## What this is

The complete list of "kinds of things" the OS understands. Each primitive is a stable building block — composable, scaffoldable, documented. When you add a new capability (see [[standard-feature-anatomy]]), you either reuse a primitive or extend one. Inventing a new primitive is a kernel-level change and warrants a `decision-*.md` entry.

## The primitives

| primitive   | what it is                                         | where it lives                                                 | scaffolded by                    |
| ----------- | -------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `domain`    | named area of knowledge + skills + apps            | `domains/<name>/`                                              | `/os add-domain`                 |
| `skill`     | invokable action — a procedure Claude runs         | `.claude/skills/<name>/SKILL.md`                               | `/os add-skill`                  |
| `app`       | optional Vite + React + Fastify UI inside a domain | `domains/<domain>/app/`                                        | `/os add-app`                    |
| `archetype` | typed wiki entry kind with required frontmatter    | `_templates/wiki-entry/<name>.md.tmpl` + reference entry       | `/os add-archetype`              |
| `hook`      | lifecycle shell/JS script CC fires on events       | `.claude/hooks/<purpose>.sh` (+ `.mjs`)                        | manual (no scaffolder yet)       |
| `template`  | scaffolder source with Mustache placeholders       | `_templates/<thing>.<ext>.tmpl`                                | created by other meta-add skills |
| `playbook`  | a domain's protocol document                       | `domains/<domain>/playbook.md`                                 | created with the domain          |
| `schedule`  | scheduled job (runbook + cron + prompt)            | `vault/wiki/<domain>/runbook/<slug>.md` with `schedule:` field | `/os add-schedule`               |
| `runner`    | out-of-band Node script invoked by cron/launchd    | `scripts/<feature>-*.mjs`                                      | (part of feature anatomy)        |
| `installer` | system-level integration script                    | `scripts/install-<feature>.sh`                                 | (part of feature anatomy)        |

## The wiki-archetype sub-registry

Archetypes are themselves a primitive, but they have their own registry because every wiki entry must declare one:

| archetype   | purpose                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `entity`    | person, project, repo, system you have ongoing relationship with                          |
| `decision`  | architectural or design decision + rationale                                              |
| `runbook`   | repeatable procedure (optional `schedule` + `prompt` makes it a scheduled job)            |
| `reference` | pointer to an external resource (URL, dashboard, doc)                                     |
| `project`   | active initiative with goals + status + deadline + (optional) repos array                 |
| `change`    | atomic unit of code work — single repo, single branch, single PR (composes into projects) |
| `note`      | free-form escape hatch                                                                    |

Each archetype has a `vault/wiki/_seed/meta/reference/archetype-<name>.md` entry documenting its required frontmatter.

## The vault-stage sub-registry

The vault has three named stages — they're conceptual primitives even though they're just folders:

| stage           | purpose                                            | committed?    |
| --------------- | -------------------------------------------------- | ------------- |
| `vault/raw/`    | unstructured ingest (drops, snippets, log files)   | no            |
| `vault/wiki/`   | structured memory, organized by domain + archetype | only `_seed/` |
| `vault/output/` | generated artifacts (reports, drafts)              | no            |

## How to read this registry

- **For users** — answers "what kinds of things exist in this OS?"
- **For future Claude sessions** — answers "what should I scaffold vs. invent?"
- **For feature designers** — paired with [[standard-feature-anatomy]], tells you whether your new idea fits an existing primitive or needs a new one

## Adding a new primitive

This is rare. A new primitive means "the OS understands a fundamentally new kind of thing." Before inventing one:

1. Could it be an **archetype** (typed wiki entry) instead? Most new "kinds of things" are.
2. Could it be a **skill** that operates on existing primitives? Most new "kinds of actions" are.
3. Could it be a **field extension** on an existing primitive? (Schedules extended `runbook`.)

If none of those fit, write a `decision-add-primitive-<name>.md` entry explaining why, add a row here, and follow [[standard-feature-anatomy]] for the full anatomy.

## Related

- [[concept-domain]] · [[concept-skill]] · [[concept-app]] · [[concept-router]] · [[concept-vault]]
- [[standard-feature-anatomy]] — checklist for capabilities that span multiple primitives
- [[archetype-runbook]] · [[archetype-decision]] · [[archetype-reference]] · [[archetype-entity]] · [[archetype-project]] · [[archetype-change]] · [[archetype-note]]
