---
id: standard-skill-format
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-07-06T04:43:10Z
tags: [standard, os, skill]
source: manual
private: false
title: Skill format standard
url: internal://standard/skill-format
kind: doc
last_verified: 2026-05-19
---

# Skill format standard

## What it is

The mandatory shape of every skill in `.claude/skills/`. Claude Code's harness uses the `description` field for discovery and `user-invocable: true` to expose the skill as a slash command; the rest is consumed by the router, the dashboard's form generator, and other meta tools.

## File layout

Each skill lives in its **own directory** as `.claude/skills/<name>/SKILL.md`. The harness expects this exact path — flat `.md` files at `.claude/skills/<name>.md` are NOT discovered. The directory may contain additional files alongside `SKILL.md` (helper scripts, reference data) if the skill needs them.

## Frontmatter contract

```yaml
---
name: <kebab-case, == directory name> # required
description: <one-line summary> # required
user-invocable: true # required for slash-command discovery
version: <integer or semver> # required
domain: <owning domain> # OS extension — optional in stock CC
tags: [<string>, ...] # OS extension — optional
inputs: # OS extension — optional; dashboard renders a form
  <arg_name>:
    type: string|number|boolean|array|object
    required: true|false
    pattern: <regex> # optional, for string validation
    description: <hint>
    default: <value> # optional
outputs: # OS extension — optional, declarative side effects
  - kind: folder|file|folder-or-file|wiki-entry|skill|router-log|process|text|event|frontmatter|field|report|deletion
    path: <pathspec with {{input.x}} placeholders>
spawns: [<other-skill-name>, ...] # OS extension — optional
---
```

`name`, `description`, `user-invocable`, and `version` are the fields Claude Code's harness recognizes. All others are OS conventions — the harness tolerates them as unknown keys but only OS tooling reads them.

### Dispatch-tuning fields (optional)

Read at `claude -p` spawn time by `scripts/dispatch-claude.mjs` (and surfaced in Settings → Effort & cost):

| field                   | type    | effect                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effort`                | enum    | `low\|medium\|high\|xhigh\|max` — per-skill override; beats `settings.local.json` / `settings.json` `effortLevel`                                                                                                                                                                                                                          |
| `model`                 | string  | Claude model id — per-skill override; same precedence chain as effort                                                                                                                                                                                                                                                                      |
| `model_execute`         | string  | Phase-aware override for dual-phase skills: when a change-scoped dispatch classifies EXECUTE-bound from the change's review gate (`approved`/`overridden`, or `not-required` with a plan; includes address-comments), `startRun` passes this instead of `model:`. Frontmatter-only — no settings fallback. v1 consumer: `dev-write-change` |
| `effort_execute`        | enum    | Phase-aware effort override, sibling of `model_execute`: same EXECUTE-bound classification, swaps `effort:` instead of `model:`. Frontmatter-only (no settings fallback), validated against the effort enum, fail-open. v1 consumer: `dev-write-change` (`xhigh` — Opus executes at the posture's xhigh floor while Fable plans at `max`)  |
| `wall_time_cap_minutes` | integer | Watchdog/supervisor kill threshold for this skill's runs. Absent → derived from history: max(25 min, 2 × p95 of the skill's successful durations), capped at 240 min. Cap-kills are artifact-verified before being marked failed                                                                                                           |
| `recommended_effort`    | enum    | UI-only guidance — never affects dispatch; Settings shows an "apply" action                                                                                                                                                                                                                                                                |
| `recommended_model`     | string  | UI-only guidance — never affects dispatch                                                                                                                                                                                                                                                                                                  |

## Body sections

H2 headers, in this order. Sections may be empty (with TODO) but should not be omitted:

1. **Purpose** — one paragraph
2. **Inputs** — human-readable description; mirrors `inputs:` frontmatter
3. **Procedure** — numbered steps the AI should follow
4. **Outputs** — what gets written where; mirrors `outputs:` frontmatter
5. **Errors** — known failure modes and recovery

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

Declare the policy with a literal `Headless:` clause at the gate step — this is the exact token the enforcement test greps for. Example:

```markdown
AskUserQuestion: archive the raw file? Headless: default(archive).
```

Prose-worded gates ("ask the user to confirm …") are governed by this standard too, but the string-based test can't see them — declare a `Headless:` clause anyway.

### Enforcement

`tests/structural/headless-gates.test.ts` walks every `.claude/skills/*/SKILL.md`: any file with a positive interactive-tool mention (an `AskUserQuestion` / `ExitPlanMode` line not negated by `do not use`) must carry at least one `Headless:` declaration, modulo a small documented exception set that is itself asserted load-bearing. The park machinery's runtime contract lives in [[standard-automation-loop]].

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

- `name` matches filename so the harness loads it correctly
- `description` powers discovery (harness, router, dashboard)
- `domain` lets the dashboard group skills sensibly
- `inputs` lets the dashboard auto-generate forms; without it, AI actions are unstructured prompts
- `version` supports breaking-change tracking
- Prescriptive `Procedure` makes the AI's behavior consistent across invocations

## Related

- [[standard-playbook-format]] · [[standard-file-naming]]
- [[meta-add-skill]] — scaffolds new skills against this contract
- [[standard-mcp-usage]] — how to call MCP tools from a skill
- [[meta-rename]] · [[meta-delete]] — rename/remove skills while updating cross-references
- [[meta-evolve]] — escape hatch for changes that don't fit the add/rename/delete shapes
