---
id: standard-execution-modes
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [standard, os, skill, dispatch]
source: manual
private: false
title: Skill execution modes
url: internal://standard/execution-modes
kind: doc
last_verified: 2026-08-20
---

# Skill execution modes

## What it is

A skill is a markdown file, and there are four different ways its instructions reach a model. They are not interchangeable. What the harness does for you, what expands, what tools are answerable, and where the model and effort come from all change between them — and none of the differences announce themselves at runtime. A skill written for one mode and dispatched in another does not error; it behaves subtly differently, once, in a place nobody is watching.

This document names the four modes so the rest of the standards can refer to them, and so every proposed skill change can say which one it is written for.

## The four modes

### 1. Native interactive

A person types `/skill-name` (or `/os <intent>` routes to one) in a live session. The harness loads `SKILL.md`, reads its frontmatter as configuration, and puts the body in context. A human is present and answers gates.

### 2. Native headless

The harness resolves the skill the same way, but nothing is attached to the keyboard: a scheduled runbook whose prompt is a slash command, fired by `claude -p`. Frontmatter still configures; interactive gates still exist as tools, but there is nobody to answer them, so a gate either takes its declared headless branch or burns the run's wall-time cap waiting.

### 3. Raw-Read headless child

The dispatch prompt tells the child to read the skill file: _"Read `.claude/skills/<name>/SKILL.md` and follow its Procedure exactly."_ This is what the dashboard's AI bridge and the per-change / project orchestrators do. The distinction that matters: the child receives the file as **content**, not as a loaded skill. The harness never processes it. Frontmatter arrives as a block of text at the top of a document — visible to the model as prose, binding on nothing. Nothing is substituted. Nothing is configured.

### 4. Inline prompt fragment

Skill text travels inside the prompt itself, and the on-disk file is explicitly not to be consulted. The replay evaluator is the worked example: it ships an **edited** copy of a skill inside the prompt so a proposed change can be measured without touching the file. Whatever is in the prompt is the skill, in full.

## What differs, per mode

|                                                        | 1. native interactive                                                                            | 2. native headless                                                                              | 3. raw-Read child                                                                                     | 4. inline fragment                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Frontmatter                                            | processed as configuration                                                                       | processed as configuration                                                                      | **text only** — reaches the model as prose, binds nothing                                             | **text only** (if included at all)                                |
| `${...}` substitutions                                 | expanded by the harness                                                                          | expanded by the harness                                                                         | **never expand** — the literal `${...}` reaches the model                                             | **never expand**                                                  |
| Interactive gates (`AskUserQuestion` / `ExitPlanMode`) | answerable by a human                                                                            | tool exists, nobody answers — the declared `Headless:` policy is the only correct path          | same, plus the prompt usually carries an explicit non-interactive declaration                         | same                                                              |
| Model / effort                                         | the session's                                                                                    | resolved at spawn time from the skill's `model:` / `effort:` frontmatter and the settings chain | resolved at spawn time by the **dispatcher**, which reads the frontmatter itself — the child does not | whatever the spawn passed; the prompt's copy has no say           |
| Context / compaction                                   | the session's rolling window; long skills compact alongside everything else the session has done | one run's window, fresh at spawn                                                                | the entire file lands at once, as a single Read, before any work starts                               | the entire fragment lands with the prompt, before any work starts |
| Source of truth                                        | the file on disk                                                                                 | the file on disk                                                                                | the file on disk, at read time                                                                        | the prompt — the file is irrelevant, and may deliberately differ  |

## The consequences that bite

**Frontmatter is invisible where it matters most.** Modes 3 and 4 are the automated ones — the dispatches nobody watches. A constraint expressed only in frontmatter (a declared output shape, a tool restriction, a dependency) is exactly the constraint that stops applying when the run is unattended. Anything that must bind on a dispatched path **must also be stated in the body text**, where every mode can see it. See [[standard-skill-format]] § "Dual consumption".

**Harness substitutions are a native-only feature.** `${CLAUDE_PROJECT_DIR}` and friends expand in modes 1 and 2 and arrive as literal text in 3 and 4 — so a path built from one silently becomes the string `${CLAUDE_PROJECT_DIR}/vault/...`. Skills therefore never use them for path resolution. Scripts read an environment variable instead, which works in every mode: `AGENTIC_OS_ROOT`, exported into every dispatched child (see `scripts/os-root.mjs`).

**Model and effort resolve at the dispatcher, not in the child.** In modes 2–4 the skill's `model:` / `effort:` frontmatter is honored because `scripts/dispatch-claude.mjs` reads it and turns it into CLI flags before spawning. A child in mode 3 that reads a different skill's file mid-run does not inherit that skill's model — it is still running under the flags its own dispatch resolved. Chained work with different model needs must be dispatched, not read.

**Bulk lands all at once.** In modes 3 and 4 there is no progressive load: whatever the file (or fragment) contains enters context in one shot, before the model has done anything. This is what makes progressive disclosure worth doing — a skill that moves bulk reference material into `references/*.md` and Reads each only at the step that needs it pays for that material only when the branch is taken. It works in every mode, because `Read` is available in every mode; what makes it work is the **procedure saying when to read what**, since there is no other mechanism to trigger it.

**Interactive gates need a declared policy, and it has to be in the body.** Modes 2, 3 and 4 all reach gates with nobody to answer them. The policy vocabulary (`default(...)` / `park` / `refuse`) and its declaration convention live in [[standard-skill-format]] § "Headless behavior"; the point here is only that the declaration must be body text, because in modes 3 and 4 that is the only text there is.

## Convention: name the mode

**Every recommendation for a skill change names the mode it targets.** "Add a confirmation step" is not reviewable; "add a confirmation step for mode 1, with a `Headless: default(skip)` policy for modes 2–4" is. The same applies to tuning suggestions from lifecycle audits, to replay-eval verdicts, and to anything the OS proposes about its own skills: a change that reads well in an interactive session and quietly breaks an orchestrated dispatch is the failure this convention exists to catch, and it is only catchable at review time if the target mode was stated.

When a recommendation genuinely applies to all four, say so — that is a claim a reviewer can check, and "all modes" is a much stronger statement than silence.

## Related

- [[standard-skill-format]] — the frontmatter and body contract, including the dual-consumption rule
- [[standard-automation-loop]] — the orchestrated dispatches that run in mode 3
- [[standard-scheduled-jobs]] — the scheduled dispatches that run in mode 2
- [[meta-eval-skill-edit]] — the mode-4 consumer: an edited skill replayed inline
- [[standard-canonical-skill-metadata]] — a design that depends on which mode reads frontmatter
