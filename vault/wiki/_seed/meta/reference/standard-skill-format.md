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
