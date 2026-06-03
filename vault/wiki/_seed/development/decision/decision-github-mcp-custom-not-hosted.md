---
id: decision-github-mcp-custom-not-hosted
type: decision
domain: development
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [mcp, github, oauth, dcr, pat, integration]
source: manual
private: false
title: 'GitHub MCP: custom OS-built (PAT) over hosted (OAuth)'
deciders: [meta-domain]
status: accepted
---

# GitHub MCP — custom OS-built (PAT) over hosted (OAuth)

## Context

The OS needs structured GitHub access to open PRs, read PR state, and snapshot CI checks (used by `dev-open-pr` and the planned PR-review backend). MCPs are the OS's structured-tool-surface primitive; the question is which MCP to use for GitHub.

We initially picked the **official hosted GitHub MCP** at `https://api.githubcopilot.com/mcp/` (see the earlier conversation where we deleted a custom prototype in its favor). Hosted seemed strictly better: 80+ tools, zero install, no maintenance burden, OAuth handled by Claude Code's `/mcp` flow.

When the workflow first exercised it for real (opening the PR for `add-license`), `/mcp` reported:

```
SDK auth failed: Incompatible auth server: does not support dynamic client registration
```

Claude Code's MCP SDK uses **Dynamic Client Registration** (RFC 7591) to register itself as an OAuth client on first connection. GitHub's OAuth implementation requires manually-registered OAuth apps with pre-issued client IDs — DCR is not supported. The hosted MCP is therefore unreachable from Claude Code today, regardless of how `.mcp.json` is configured.

## Decision

Build and maintain a small custom MCP at `mcps/github/` with PAT-based auth instead of using the hosted one.

The custom MCP exposes exactly four tools — the minimum surface `dev-open-pr` + `dev-pr-review` need:

- `create_pull_request`
- `get_pull_request`
- `list_pull_requests` (for idempotent open-pr re-runs)
- `list_pull_request_checks` (single-read CI snapshot)

Implementation is ~250 LOC of Node + `@octokit/rest`. The PAT lives in `mcps/github/.env` (gitignored). The MCP runs as a stdio subprocess on Claude Code session start — no OAuth, no DCR, no auth handshake.

## Alternatives considered

1. **`@modelcontextprotocol/server-github` (deprecated npm package)** — Anthropic-published reference server. Works via `npx`, PAT auth, similar shape to what we built. But the package was deprecated in early 2026 ("Package no longer supported"). Functionally OK today; structurally a dead end.

2. **`github/github-mcp-server` (official, Go binary / Docker)** — GitHub's own server, 80+ tools, actively maintained. Right answer when we need more than the 4 tools we built. Skipped now because it adds Docker (or binary download per OS+arch) as a runtime dependency, which install.sh would need to manage.

3. **Wait for Claude Code to support OAuth-app flows (no DCR required)** — passive. Blocks the workflow indefinitely. Rejected.

4. **Skip the MCP, use `gh` CLI via Bash from skills** — works but defeats the structured-tool-surface premise of MCPs. We'd parse stdout strings, lose typed errors, and break the precedent set by [[concept-mcp]]. Acceptable as a fallback; not the right primary path.

## Consequences

- **Pro**: works today, no external runtime deps, owned end-to-end. Tool surface is exactly what we need (no context cost from unused tools).
- **Pro**: PAT auth is a single env var — easier to reason about than OAuth state. Suits OS-bootstrapping (a fresh clone is functional after `cp .env.example .env`).
- **Con**: we maintain ~250 LOC and track GitHub API changes. Mitigated by `@octokit/rest` (Octokit handles API specifics; we just dispatch).
- **Con**: adding new tools (e.g. PR comments, file diffs) means appending to `server.mjs`. For the planned PR-review backend, this is a real ask — `dev-pr-review` needs to read existing PR review threads. When that surface grows beyond ~10 tools, revisit alternative #2 (GitHub's official Go server) — at that point Docker becomes worth the install-step cost.
- **Con**: the hosted MCP path stays available via `meta-add-mcp --kind hosted` for vendors that DO support DCR (Linear, Notion, Slack official MCPs). But for GitHub specifically, the OS-built path is now canonical.

A future revisit point: when GitHub adds DCR support to their OAuth implementation, or when Claude Code adds support for manually-registered GitHub OAuth apps, hosted becomes viable again. Until then: custom.

## Implementation

- `mcps/github/` — manifest, server, package, README, .env.example
- `.mcp.json` — managed by `scripts/sync-mcp-config.mjs`; points at the stdio server
- `[[standard-mcp-architecture]]` § 8 — documents the DCR limitation broadly so future MCP integrations check this first
- `[[standard-mcp-usage]]` § 9 — pre-flight check via `scripts/check-mcp.mjs` catches the missing-PAT case before tool calls

## Related

- [[standard-mcp-architecture]] — MCP contract; § 8 (DCR compatibility) was added because of this
- [[standard-mcp-usage]] — how skills call MCP tools; pre-flight pattern
- [[dev-open-pr]] — the first consumer of this MCP
- [[concept-mcp]] — what MCPs are
