---
id: standard-mcp-usage
type: reference
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [standard, mcp, usage, skills]
source: manual
private: false
title: MCP usage standard
url: internal://standard/mcp-usage
kind: doc
last_verified: 2026-05-22
---

# MCP usage standard

How skills (and other OS callers) invoke MCP tools at runtime. Counterpart to [[standard-mcp-architecture]] (how MCPs are built and registered) — this one is about consumption.

> See also: [[concept-mcp]] for the plain-language overview, [[standard-mcp-architecture]] for the build/registration contract, [[standard-skill-format]] for skill structure.

## 1. Mental model

When `.mcp.json` is wired up and Claude Code is restarted, each MCP's tools appear in Claude's tool list alongside built-ins like Bash, Read, Edit. **Skills don't invoke MCP tools through any special mechanism** — they reference them in their procedure (markdown) and Claude calls them just like any other tool.

The only thing the skill author needs to know:

- **Tool names** are prefixed: `mcp__<server>__<tool>` (double-underscore separator; hyphens in server ids are normalized to underscores).
- **Hosted MCPs need authentication first** via Claude Code's `/mcp` command (OAuth browser flow).
- **Tool discovery is dynamic** — Claude Code defers MCP tool schemas until needed (per the tool-search docs), so a session that doesn't touch a tool never pays its context cost.

## 2. Naming examples

| MCP server id                     | Tool registered       | Claude tool name                   |
| --------------------------------- | --------------------- | ---------------------------------- |
| `vault`                           | `search_wiki`         | `mcp__vault__search_wiki`          |
| `vault`                           | `get_entry`           | `mcp__vault__get_entry`            |
| `github`                          | `create_pull_request` | `mcp__github__create_pull_request` |
| `pr-review` (hyphen → underscore) | `start_review`        | `mcp__pr_review__start_review`     |

## 3. Referencing MCP tools in a skill procedure

Two equally-valid patterns, depending on how prescriptive the skill is:

### Pattern A — descriptive (preferred for most skills)

```markdown
3. Call the **`github`** MCP's `create_pull_request` tool with `{ owner, repo, title, head, base }` (read these from the change entry's frontmatter). Capture the returned `{ number, url, state }`.
```

Claude reads "the github MCP's create_pull_request tool" and finds `mcp__github__create_pull_request` via tool search. No need to hardcode the prefix.

### Pattern B — prescriptive (when you want zero ambiguity)

```markdown
3. Invoke `mcp__github__create_pull_request` with the JSON payload described below.
```

Use B for skills where the tool name needs to be stable across docs (e.g. a runbook another skill quotes), or where Claude has hesitated in past runs to pick the right tool.

**Default to A** — it's more readable and resilient to MCP renames.

## 4. Discovery — finding tools to call

| from                          | how                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Claude Code (running session) | `/mcp` lists configured servers + tool counts + auth state                                   |
| Dashboard (visual)            | **MCPs** view shows every server's tool inventory with summaries                             |
| Manifest (OS-built MCPs)      | `mcps/<id>/manifest.json` `tools:` array (documentation; runtime list lives in `server.mjs`) |
| Vendor docs (hosted MCPs)     | The vendor's MCP repo (e.g. `github/github-mcp-server`'s `docs/toolsets-and-icons.md`)       |

Skill authors building a procedure should reference the manifest first — it tells you what the OS thinks the tool surface is. The dashboard's MCPs view is the same data, just visual.

## 5. Auth state — what to assume

Before invoking a tool, the skill should not assume auth has happened. Two safe patterns:

### Hard-fail with a helpful hint

```markdown
If the call returns an authentication error, stop and report:
"Run `/mcp` in Claude Code to authenticate the **{{server}}** MCP, then re-run this skill."
```

### Probe first (only when fallback is available)

```markdown
1. Try `mcp__github__get_pull_request` with the PR number. If it returns auth-related error, fall back to `gh pr view --json …` via Bash. Otherwise use the structured response.
```

Probe-first adds complexity and is usually overkill. For OS-built MCPs (vault, scheduler, future internal ones) **no auth is needed** — they read local files. Skip the auth path for these.

## 6. Error handling

MCP tool calls fail in three distinct ways. Skills should handle each differently:

| Failure mode                  | What Claude sees                                                                 | Skill response                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| MCP unreachable / not started | Tool not in available list                                                       | Stop early; instruct the user to run `/mcp` or check `.mcp.json`          |
| Auth failure (401/403)        | Error in tool response: `{ isError: true, content: [{ text: "Error in ..." }] }` | Stop; tell the user to run `/mcp` for OAuth                               |
| Tool-level error              | Same shape; message describes the failure (e.g. "PR already exists")             | Surface the message to the user; decide whether to retry, abort, or adapt |

Skills should **fail loud, not silently**. If an MCP call fails, surface the underlying error message — don't swallow it.

## 7. Worked example — calling the vault MCP

The `vault` MCP exposes `search_wiki`, `get_entry`, `list_archetypes` (read-only, no auth). A skill that wants to surface relevant decisions before drafting:

```markdown
## Procedure

1. Use the **`vault`** MCP's `search_wiki` tool with `{ query: <change.title>, archetype: "decision", limit: 5 }`. Capture the returned `hits` array.

2. For each hit, call the **`vault`** MCP's `get_entry` tool with `{ id: hit.id }` to read the full body. Skip entries whose `domain` doesn't match the change's domain.

3. Compose a summary referencing each relevant decision by `[[id]]`. Include this in the change's body under `## Prior context`.

4. If `search_wiki` returns zero hits, skip the prior-context section entirely — don't fabricate one.
```

Note: the skill doesn't need to know the wiki manifest path, doesn't shell out to `grep`, doesn't reimplement scoring. The MCP handles all of that with typed I/O.

## 8. When NOT to use an MCP from a skill

- The skill needs to **edit** a vault entry → use the Edit tool. MCPs are typed I/O; the file-editing surface is Claude's built-in.
- The data is in `vault/.index/manifest.json` and you only need a tiny read → also fine to use Read directly. The MCP is sugar, not a wall.
- The action is **destructive** and you want an audit-able shell command (rm, git push, mv) → use Bash. MCPs hide the exact action; sometimes you want it visible.

## 9. Pre-flight checking — verify the MCP exists before calling

Skills that depend on a specific MCP should **verify it's configured before** attempting any tool call. Fail-fast with an actionable hint beats a cryptic "tool not found" error mid-procedure.

Use the shared helper:

```bash
node scripts/check-mcp.mjs <mcp-id> --json
```

The helper exits 0 if the MCP is configured and (for OS-built MCPs) its required env vars are filled. It exits non-zero with a specific `hint` describing the fix — missing config, missing env, unrecognized shape. The JSON output makes it easy for a skill to parse and surface the hint verbatim.

**Convention:** the first numbered step of any skill that calls an MCP tool is a pre-flight check. Example from `dev-open-pr`:

```markdown
1. **Pre-flight: verify the github MCP is wired up.**
   Run: `node scripts/check-mcp.mjs github --json`. If exit code is non-zero,
   stop and surface the script's `hint` field verbatim.
```

This catches: missing `.mcp.json` row, missing `mcps/<id>/` folder (for custom), missing env vars (for custom). It does NOT catch hosted-MCP auth state — that surfaces only when the tool is actually called (Claude Code's `/mcp` is the manual way to verify auth ahead of time).

`check-mcp.mjs --list` shows all configured MCPs at a glance.

## 10. Subagents (open question)

Claude Code's docs don't specify whether subagents spawned via the Agent tool inherit the parent session's MCP servers. **Treat as unavailable until proven otherwise.** If you need an Agent subtask to call an MCP tool, prefer surfacing the tool result back into the parent session and passing it as text into the Agent prompt.

Will revisit this section once we have evidence one way or the other.

## Related

- [[concept-mcp]] — plain-language MCP overview
- [[standard-mcp-architecture]] — how MCPs are built and registered (counterpart standard)
- [[standard-skill-format]] — skill structure; MCP calls slot into a skill's Procedure section
- [[meta-add-mcp]] — scaffolds a new MCP
