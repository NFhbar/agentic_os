---
id: standard-skill-format
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-08-20T00:00:00Z
tags: [standard, os, skill]
source: manual
private: false
title: Skill format standard
url: internal://standard/skill-format
kind: doc
last_verified: 2026-08-20
---

# Skill format standard

## What it is

The mandatory shape of every skill in `.claude/skills/`. Claude Code's harness uses the `description` field for discovery and `user-invocable: true` to expose the skill as a slash command; the rest is consumed by the router, the dashboard's form generator, the dispatcher, and other meta tools.

## File layout

Each skill lives in its **own directory** as `.claude/skills/<name>/SKILL.md`. The harness expects this exact path — flat `.md` files at `.claude/skills/<name>.md` are NOT discovered. The directory may contain additional files alongside `SKILL.md` (helper scripts, reference data) if the skill needs them; see § "references/ — progressive disclosure".

## Frontmatter: three namespaces

Frontmatter looks like one block, but it is read by three different audiences that fail in three different ways. Knowing which namespace a key belongs to tells you who breaks when it is wrong.

```yaml
---
# 1 — Claude Code native
name: <kebab-case, == directory name>
description: <one-line summary>
user-invocable: true
version: <integer or semver>

# 2 — OS orchestration
domain: <owning domain>
inputs: {}
outputs: []
spawns: []
effort: <low|medium|high|xhigh|max>
model: <model id>

# 3 — Documentation
tags: [<string>, ...]
recommended_effort: <low|medium|high|xhigh|max>
---
```

### Namespace 1 — Claude Code native

Read by the harness itself. Wrong here means the skill does not appear, or does not load.

| field            | type            | effect                                                                             |
| ---------------- | --------------- | ---------------------------------------------------------------------------------- |
| `name`           | string          | Must equal the directory name; the harness resolves the skill by it                |
| `description`    | string          | Powers discovery — the harness, the router, and the dashboard all match against it |
| `user-invocable` | boolean         | `true` exposes the skill as a slash command                                        |
| `version`        | integer\|semver | Breaking-change tracking                                                           |

All four are recognized across the whole supported CLI range (`MIN_SUPPORTED`–`HIGHEST_TESTED`, `scripts/check-cc-compat.mjs`). **When a native key requires a newer CLI than the current minimum, record that here and raise `MIN_SUPPORTED` alongside it** — a native key that silently no-ops on an older CLI is exactly the quiet drift the version contract exists to catch.

### Namespace 2 — OS orchestration

Read by OS tooling: the router, the dashboard, the dispatcher, the run finalizer, the audit. The harness tolerates them as unknown keys. Wrong here means the skill loads fine and then behaves wrong — routed nowhere, dispatched at the wrong model, formless in the dashboard.

**Routing and structure:**

| field     | type   | effect                                                                                                                                                                                                                     |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`  | string | Owning domain; must match a directory under `domains/`. Groups the skill everywhere it appears                                                                                                                             |
| `inputs`  | map    | `<arg_name>: { type, required, pattern?, description, default? }` — the dashboard renders a form from this                                                                                                                 |
| `outputs` | list   | `{ kind, path }` declarative side effects; `kind` ∈ `folder\|file\|folder-or-file\|wiki-entry\|skill\|router-log\|process\|text\|event\|frontmatter\|field\|report\|deletion`, `path` may carry `{{input.x}}` placeholders |
| `spawns`  | list   | Other skill names this one dispatches. Each must resolve to a real skill directory                                                                                                                                         |

**Dispatch tuning** — read at `claude -p` spawn time by `scripts/dispatch-claude.mjs` (and surfaced in Settings → Effort & cost), except `model_policy` / `model_fallbacks`, read at run-finalization time by `scripts/model-error-policy.mjs`:

| field                   | type    | effect                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effort`                | enum    | `low\|medium\|high\|xhigh\|max` — per-skill override; beats `settings.local.json` / `settings.json` `effortLevel`                                                                                                                                                                                                                          |
| `model`                 | string  | Claude model id — per-skill override; same precedence chain as effort                                                                                                                                                                                                                                                                      |
| `model_execute`         | string  | Phase-aware override for dual-phase skills: when a change-scoped dispatch classifies EXECUTE-bound from the change's review gate (`approved`/`overridden`, or `not-required` with a plan; includes address-comments), `startRun` passes this instead of `model:`. Frontmatter-only — no settings fallback. v1 consumer: `dev-write-change` |
| `effort_execute`        | enum    | Phase-aware effort override, sibling of `model_execute`: same EXECUTE-bound classification, swaps `effort:` instead of `model:`. Frontmatter-only (no settings fallback), validated against the effort enum, fail-open. v1 consumer: `dev-write-change` (`xhigh` — Opus executes at the posture's xhigh floor while Fable plans at `max`)  |
| `model_policy`          | enum    | `required` \| `fallback-allowed` (absent → `inherit`). What the runtime may do when the pinned model is unavailable: `required` parks with a structured error and no side effects; `fallback-allowed` allows ONE auto re-dispatch. Availability is classified from the run's journal + stderr tails                                        |
| `model_fallbacks`       | string  | Comma-separated model ids, meaningful only with `model_policy: fallback-allowed`. The hook re-dispatches the same prompt once on `[0]` at effort `high`, titled `fallback(<model>): <skill>` — a leg already resolved to `[0]` stays failed                                                                                                |
| `wall_time_cap_minutes` | integer | Watchdog/supervisor kill threshold for this skill's runs. Absent → derived from history: max(25 min, 2 × p95 of the skill's successful durations), capped at 240 min. Cap-kills are artifact-verified before being marked failed                                                                                                           |

**The headless policy is deliberately NOT a frontmatter key.** The `default(...)` / `park` / `refuse` vocabulary is declared inline at each gate, in the body — see § "Headless behavior" for why that placement is load-bearing rather than stylistic.

### Namespace 3 — Documentation

Read by humans and by UI affordances that only ever suggest. Wrong here costs nothing at runtime.

| field                | type   | effect                                                                      |
| -------------------- | ------ | --------------------------------------------------------------------------- |
| `tags`               | list   | Grouping and search                                                         |
| `recommended_effort` | enum   | UI-only guidance — never affects dispatch; Settings shows an "apply" action |
| `recommended_model`  | string | UI-only guidance — never affects dispatch                                   |

### Dual consumption — frontmatter is invisible to raw-Read children

A skill's instructions reach a model four different ways, and only two of them process frontmatter. When a dispatch says _"Read `.claude/skills/<name>/SKILL.md` and follow its Procedure exactly"_ — which is how the dashboard AI bridge and the per-change / project orchestrators run nearly everything — the child gets the file as **content**. The frontmatter arrives as a block of text at the top of a document. Nothing in it configures anything. The full mode matrix is in [[standard-execution-modes]].

The consequence is a rule:

> **Any constraint that must bind on a dispatched path has to be repeated in the body text.**

Frontmatter is where a constraint is _declared_ for tooling; body text is where it is _stated_ for the model. A skill that declares `outputs:` and never mentions in its procedure where to write is correct in an interactive session and wrong in an orchestrated one. Same for tool restrictions, required pre-conditions, and every headless gate policy.

Declaring it twice is not redundancy. The two copies have different readers, and the automated reader only ever sees the second one.

## Body: semantic coverage, not a heading order

The body must **cover** five things. It does not have to cover them under fixed headings, in a fixed order, or in five separate sections:

- **Purpose** — what this skill is for, and when it is the right one to reach for
- **Inputs** — what it needs to run, including anything mirrored in `inputs:` frontmatter
- **Procedure** — the steps, concretely enough that two runs produce the same shape of work
- **Outputs** — what gets written where, including anything mirrored in `outputs:` frontmatter
- **Errors** — known failure modes and how to recover, including every headless gate policy

The requirement is that a reader (human or model) can find each of the five. A skill whose Procedure step 6 says "if the branch already exists, stop and report" has covered that error case; it does not also need an `## Errors` bullet repeating it. A short skill may cover Purpose and Inputs in one paragraph.

Why coverage and not a scaffold: the fixed five-heading order was easy to satisfy without saying anything — sections got created and left as `TODO`, which reads as complete to the audit and as empty to the model. Coverage cannot be satisfied by an empty heading. Most skills will still end up with roughly those five headings, because they are a good default shape; the difference is that the shape is now a means rather than the requirement.

`## Purpose` remains the conventional home for a skill-wide contract — an interactive-only skill states that there, so nobody has to read the whole procedure to discover it.

## references/ — progressive disclosure

A skill may move bulk reference material out of `SKILL.md` and into `references/*.md` inside its own directory: report templates, output-format examples, taxonomies, long enumerations, per-type checklists. What stays in `SKILL.md` is the part every run needs — frontmatter, purpose, inputs, the decision procedure, errors.

This matters because of how the automated modes load: a raw-Read child pulls the entire file into context in one shot, before it has done anything, whether or not the run needs the material. A skill that branches five ways and inlines all five branches' templates pays for all five on every run.

The mechanism is entirely in the procedure. There is no automatic loading, so the procedure must **say when to read what**, at the step that needs it:

```markdown
4. Determine the report type from the project's `reporting.kind`.
5. Read `references/report-templates.md` and use the section matching that type.
   Do not read the other sections.
```

Two rules keep this honest:

- **The pointer lives at the branch, not in a preamble.** "See `references/` for details" at the top loads nothing and helps nobody; a Read instruction inside step 5 loads exactly what step 5 needs.
- **`SKILL.md` still has to satisfy semantic coverage on its own.** Purpose, inputs, procedure, outputs and errors stay in the skill. What moves out is material the procedure _consults_, never the procedure itself — a skill whose steps live in a reference file is unreadable in every mode.

Progressive disclosure works in all four execution modes, because `Read` is available in all four.

## Headless behavior (interactive gates)

A skill runs in one of two contexts:

- **Interactive session** — a human is at the keyboard and can answer an `AskUserQuestion`, approve an `ExitPlanMode` plan, or confirm a prose "ask the user" step.
- **Headless `claude -p` dispatch** — the per-change / project orchestrators (`automation.ts`), the scheduler (`scripts/scheduler-tick.mjs`), and the dashboard AI bridge all spawn skills with no human attached. Every such dispatch prompt carries a non-interactive declaration — canonically the line `Do NOT use AskUserQuestion or any interactive prompt` (scheduler dispatches get it appended by `scripts/headless-guard.mjs`). **The rule: when a gate cannot obtain a human answer, treat the run as headless.**

An interactive gate on a dispatched path is a coin-flip — the model either guesses (an unrecorded decision) or stalls until the wall-time cap. Every interactive gate that can sit on a dispatched path MUST therefore declare a headless policy.

### Zeroth option — design the gate out

Before reaching for a policy, ask whether the gate is needed at all. When the **dispatch surface itself** collects the confirmation, the skill carries no interactive gate and needs no policy. The dashboard's type-to-match flow for [[meta-rename]] / [[meta-delete]] is the precedent: the destructive confirmation happens in the UI before the skill is ever dispatched, so those two skills are headless-by-design and declare nothing. Imitate this before adding a policy.

### Policy vocabulary

Every interactive gate (`AskUserQuestion`, `ExitPlanMode`, or a prose "ask the user") that can be reached on a dispatched path MUST declare exactly one policy inline at the gate:

- **`default(<value>)`** — proceed with the named safe default. The auto-decision MUST be recorded in the run report (and in the audit-event args when the step records one), so a headless auto-decision is never silent. Use only when a conservative default is genuinely safe.
- **`park`** — do not decide. Leave the pending-state artifact in place (or write the designated marker), print a refusal summary line **opening with a report glyph** (`⊘` preferred) that names what a human must do, and exit cleanly with **no downstream side effects**. The precise effect is per-surface:
  - On **per-change-automation-tracked steps** (`execute` / `address-comments` / `open-pr` / `pr-review`) a clean glyph-opening refusal produces the `skill-refused` park (`automation-state-machine.ts`), which quotes the glyph line in the park reason and auto-unparks when the step later completes out-of-band.
  - On **non-orchestrated dispatches** (dashboard AI bridge, scheduler runbooks) the run simply ends cleanly with the `⊘` summary and the pending artifact in place — the operator's cue.
  - The **project-level orchestrator's `write` step is NOT park-aware**: its tick advances on any exit-0, so a `park` fired there surfaces late and mislabeled. Do not rely on `park` on that surface; a gate that can only be reached via the project `write` step must document the ghost-advance residual (see [[dev-write-change]]'s DRAFT gate for the worked example).
- **`refuse`** — the gate (or the whole skill) is interactive-only. Print an explicit refusal and stop. A skill that is interactive-only end-to-end states the contract in its **Purpose** ([[meta-evolve]] is the precedent).

### Declaration convention

Declare the policy with a literal `Headless:` clause at the gate step — this is the exact token the enforcement test greps for, and body text is the only text a raw-Read child sees. Example:

```markdown
AskUserQuestion: archive the raw file? Headless: default(archive).
```

Prose-worded gates ("ask the user to confirm …") are governed by this standard too, but the string-based test can't see them — declare a `Headless:` clause anyway.

### Enforcement

`tests/structural/headless-gates.test.ts` walks every `.claude/skills/*/SKILL.md`: any file with a positive interactive-tool mention (an `AskUserQuestion` / `ExitPlanMode` line not negated by `do not use`) must carry at least one `Headless:` declaration, modulo a small documented exception set that is itself asserted load-bearing. It reads each skill through the shared markdown scanner, so a tool name quoted inside a fenced example is not mistaken for a gate — and a `Headless:` clause that appears only inside an example does not count as a declaration. The park machinery's runtime contract lives in [[standard-automation-loop]].

## Calling MCP tools from a skill

When the OS has an MCP configured (`.mcp.json` + restart), its tools appear in Claude's available tool list as `mcp__<server>__<tool>`. Skills invoke them like any other tool — no special syntax in the Procedure.

**Convention:** reference the MCP descriptively in the Procedure markdown rather than hardcoding the prefix. Example:

```markdown
3. Call the **`github`** MCP's `create_pull_request` tool with `{ owner, repo, title, head, base }`. Capture the returned `{ number, url, state }`.
```

Claude finds `mcp__github__create_pull_request` via tool search. The skill stays readable and survives MCP renames.

For OS-built MCPs (`vault`, future `scheduler`/`events`), no auth is required — they read local files. For hosted MCPs (`github`), the user must run `/mcp` once to complete OAuth — skills should fail with that hint if the tool returns an auth error.

Full contract: [[standard-mcp-usage]].

## YAML hygiene — quote anything with a colon-space

The frontmatter is parsed by `js-yaml` (in the dashboard backend) and by the simpler flat parser (in the audit + index rebuilder). Both treat `: ` (colon followed by space) as a key/value separator, including inside unquoted string values. The most common failure mode is a `description:` line containing inline-code like `` `type: project` `` — js-yaml interprets it as a nested mapping at the wrong indent, fails, and the skill stops appearing in scaffolders. The audit's `skill-frontmatter-unquoted-colon` check catches this preemptively.

**Convention:** always single-quote any frontmatter string value that _might_ contain a colon-space — descriptions, prompts, examples. Single-quote escape for inner single quotes is `''` (double single quote). Examples:

```yaml
# bad — js-yaml errors on `type: project` inside backticks
  description: Project id (slug). Must match an existing `type: project` entry.

# good — single quotes turn the whole value into a literal
  description: 'Project id (slug). Must match an existing `type: project` entry.'

# good with inner apostrophe
  description: 'Defaults to the project''s reporting.last_sent.'
```

When in doubt, quote — the overhead is one character at each end. The dashboard's Commands view (Drift section) and Overview's Skills card surface broken skills, but it's better to catch them at write time.

## Rationale

- `name` matches the directory so the harness loads it correctly
- `description` powers discovery (harness, router, dashboard)
- `domain` lets the dashboard group skills sensibly
- `inputs` lets the dashboard auto-generate forms; without it, AI actions are unstructured prompts
- `version` supports breaking-change tracking
- A concrete Procedure makes behavior consistent across invocations — and across execution modes
- Semantic coverage over a scaffold, because an empty heading satisfies a scaffold and helps nobody

## Related

- [[standard-execution-modes]] — the four ways skill instructions reach a model; the basis for the dual-consumption rule
- [[standard-playbook-format]] · [[standard-file-naming]]
- [[meta-add-skill]] — scaffolds new skills against this contract
- [[standard-mcp-usage]] — how to call MCP tools from a skill
- [[meta-rename]] · [[meta-delete]] — rename/remove skills while updating cross-references
- [[meta-evolve]] — escape hatch for changes that don't fit the add/rename/delete shapes
- [[standard-canonical-skill-metadata]] — a design for making this frontmatter the single routing source
