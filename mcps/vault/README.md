# `mcps/vault` — Vault MCP server

Surfaces the OS wiki as structured tool calls for Claude Code. Read-only — no auth, no network.

## Setup

```sh
cd mcps/vault
npm install
```

No `.env` needed. The server resolves the repo root via `CLAUDE_PROJECT_DIR` (set automatically by Claude Code), with a fallback to walking up from `mcps/vault/`.

After install, restart Claude Code so it picks up the new MCP server. Confirm with `/mcp`.

## Tools

| Tool              | Purpose                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `search_wiki`     | Free-text search across the wiki index. Filter by `archetype` and/or `domain`. Returns scored hits. |
| `get_entry`       | Fetch a full wiki entry by `id` (preferred) or `path`. Returns parsed frontmatter + body.           |
| `list_archetypes` | List all archetypes present in the index with entry counts.                                         |

## Index dependency

`search_wiki` reads `vault/.index/manifest.json` — the prebuilt index that lists every wiki entry with title, archetype, domain, snippet, etc. The index auto-rebuilds when Claude Code edits files in `vault/wiki/` (via `.claude/hooks/rebuild-vault-index.mjs`). External edits need a manual rebuild:

```sh
node .claude/hooks/rebuild-vault-index.mjs
```

If the index is stale or missing, `search_wiki` returns an error explaining how to rebuild.

## Local smoke test

```sh
cd mcps/vault
node server.mjs
# Process waits on stdio for MCP requests. Ctrl-C to exit.
# Exercise tools through Claude Code itself once .mcp.json is wired up.
```

## Reference

- Standard: `vault/wiki/_seed/meta/reference/standard-mcp-architecture.md`
- Index schema: `vault/wiki/_seed/meta/reference/standard-index-schema.md`
- Wiki structure: `vault/wiki/_seed/meta/reference/concept-vault.md`
