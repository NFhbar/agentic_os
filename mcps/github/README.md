# `mcps/github` — GitHub MCP server (custom, PAT-based)

Tight GitHub integration exposed to Claude Code via stdio. Built and maintained inside the OS; uses [`@octokit/rest`](https://github.com/octokit/rest.js) under the hood for the four tools `dev-open-pr` + `dev-pr-review` need.

**Why custom and not the hosted GitHub MCP?** The official hosted server (`api.githubcopilot.com/mcp/`) uses OAuth Dynamic Client Registration (RFC 7591) for client onboarding. GitHub's OAuth implementation doesn't support DCR, so Claude Code can't authenticate to the hosted endpoint. Until upstream resolves, a custom MCP with PAT auth is the path that works today.

## Setup

```sh
cd mcps/github
npm install
cp .env.example .env
# Edit .env, paste a GitHub PAT (see .env.example for required scopes)
```

Then **restart Claude Code** from the repo root so it re-reads `.mcp.json` and spawns this MCP server. Confirm with `/mcp` — `github` should show as available (no further auth step needed; PAT loads at server boot).

## Tools

| Tool                       | Purpose                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `create_pull_request`      | Open a PR. Returns `{ number, url, state, draft, user_login }`.                    |
| `get_pull_request`         | Read PR state by number. Returns key fields (state, merged, draft, head/base ref). |
| `list_pull_requests`       | List PRs filtered by head branch — used for idempotent open-pr detection.          |
| `list_pull_request_checks` | Snapshot CI: check runs + commit statuses bucketed by state. Single read, no poll. |

## Auth

Reads `GITHUB_TOKEN` from `mcps/github/.env` at server boot. Required scopes:

- **Classic PAT**: `repo` scope (full control of private repos — covers all 4 tools)
- **Fine-grained PAT**: Pull requests `read+write` + Contents `read` + Checks `read`

`.env` is gitignored globally via `mcps/*/.env`. `.env.example` is committed as the template.

## Local smoke test

```sh
cd mcps/github
GITHUB_TOKEN=test node server.mjs
# Process waits on stdio for MCP requests. Ctrl-C to exit.
# Real tool calls require a valid token; this just verifies the server boots.
```

End-to-end exercising the tools happens via Claude Code itself.

## Adding a tool

1. Append an entry to the `TOOLS` array in `server.mjs` (name + JSON Schema for input).
2. Add a handler function.
3. Register it in `HANDLERS`.
4. Update the `tools` array in `manifest.json` (documentation only, runtime list lives in server.mjs).
5. Restart Claude Code so the MCP server reloads.

## Reference

- Standard: `vault/wiki/_seed/meta/reference/standard-mcp-architecture.md`
- Skill that calls these tools: `.claude/skills/dev-open-pr/SKILL.md`
- octokit docs: https://github.com/octokit/rest.js
