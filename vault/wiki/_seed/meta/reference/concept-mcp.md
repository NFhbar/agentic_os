---
id: concept-mcp
type: reference
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [concept, core, plain-language, mcp, integration]
source: manual
private: false
title: MCP
url: internal://concept/mcp
kind: doc
last_verified: 2026-05-22
---

# MCP

## What it is

An **MCP** (Model Context Protocol server) is a tool surface Claude Code can call. Each MCP wraps one service or subsystem — GitHub, Slack, the vault, the scheduler — and exposes a small set of typed actions (`create_pull_request`, `search_wiki`, `list_schedules`) that any skill or session can invoke with structured input and structured output.

Two kinds, with different homes:

- **OS-built** MCPs live at `mcps/<id>/` — custom Node servers we write and own. Used when no vendor MCP exists, when we need a tight tool surface, or when the MCP combines external calls with OS-specific behavior (event logging, vault writes, audit hooks).
- **Third-party** MCPs live only as a row in `.mcp.json` — vendor-hosted (e.g. GitHub's official MCP at `https://api.githubcopilot.com/mcp/`) or someone else's binary. We don't own the code; we just configure Claude Code to talk to them.

## When you use it

- A skill needs structured access to an external service (push to GitHub, post to Slack, query Linear) instead of parsing CLI output
- The OS itself has internal data Claude should query with typed tools rather than `cat` / `grep` (vault search, scheduler state, events.db queries)
- You're building a workflow that calls the same external API from multiple skills — wrap it once as an MCP rather than duplicating the integration code

## When you don't

- One-off shell commands → just use Bash
- Anything that renders UI → that's an [[concept-app]]
- A markdown procedure for Claude to follow → that's a [[concept-skill]]
- Data the vault already holds → read the markdown directly, no need to wrap it

## Example

`.mcp.json` ships with one row already wired up: the official hosted GitHub MCP. After `./install.sh` and running `/mcp` once (a browser OAuth flow), skills like `dev-open-pr` can call `create_pull_request` with `{ owner, repo, title, head, base }` and get back `{ number, url, state }` — no shelling out to `gh`, no string parsing, no auth juggling.

When we need an MCP for something the vendor doesn't offer (or where we want a tight surface), we scaffold one with `/os add-mcp`. A planned `mcps/vault/` MCP surfaces wiki search as a tool — so any skill can ask "have we made a decision about retry backoff?" without re-implementing the search loop.

## How to create one

```
/os add-mcp
```

The scaffolder asks: id, domain, hosted (third-party) or custom (OS-built), required env vars, starter tool names. For a custom MCP it creates `mcps/<id>/` with manifest, server stub using the `@modelcontextprotocol/sdk`, `package.json`, `.env.example`, and a README. For a hosted one it just writes the row to `.mcp.json`. Either way, restart Claude Code to pick up the change.

## Related

- [[standard-mcp-architecture]] — the contract: file layout, manifest schema, server pattern, auth, lifecycle
- [[concept-skill]] — skills are the things that _call_ MCP tools
- [[concept-app]] — apps render UI; MCPs render tool surfaces. Both consume vault.
- [[meta-add-mcp]] — scaffolds a new MCP (custom or hosted)
