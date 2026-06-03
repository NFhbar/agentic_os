---
id: standard-mcp-architecture
type: reference
domain: meta
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [standard, mcp, integration, external-services]
source: manual
private: false
title: MCP architecture standard
url: internal://standard/mcp-architecture
kind: doc
last_verified: 2026-05-22
---

# MCP architecture standard

How the OS exposes structured access to external services (GitHub, Slack, Linear…) and internal subsystems (vault, scheduler) via the Model Context Protocol.

There are **two kinds of MCPs** the OS uses, and they have different homes:

| kind            | lives at                         | governed by this standard? | example                                                                         |
| --------------- | -------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| **OS-built**    | `mcps/<id>/` (custom code)       | yes — full contract below  | `mcps/vault/`, `mcps/scheduler/`, future composite tools                        |
| **Third-party** | `.mcp.json` row only (no folder) | no — just a config entry   | a vendor-hosted MCP with OAuth, e.g. Linear / Notion / Slack official endpoints |

Prefer **third-party hosted** when the vendor offers a maintained MCP that fits your needs (e.g. GitHub's official server covers ~80 tools you'd otherwise reimplement). Prefer **OS-built** when:

- The vendor has no MCP (most niche services)
- You want a _tight_ tool surface (avoid bloating Claude's context with 80 tools when you need 2)
- You're surfacing an internal OS subsystem (vault, scheduler, events.db) as MCP tools
- You're building **composite tools** that combine multiple service calls with OS-side behaviors (event-logging, vault writes, audit hooks)

Consumed by [[meta-add-mcp]] (scaffolds OS-built MCPs), `scripts/sync-mcp-config.mjs` (merges discovered manifests into `.mcp.json`, preserving third-party rows), and the audit pipeline.

> See also: [[standard-app-architecture]] for the shell/app contract (mirrors this one in shape).

## 1. Directory layout (OS-built MCPs)

```
mcps/                                     ← all OS-built MCP servers live here, parallel to domains/, vault/
  <id>/
    manifest.json                         ← declarative contract (id, domain, transport, tools, env)
    server.mjs                            ← MCP implementation using @modelcontextprotocol/sdk
    package.json                          ← per-MCP deps (own node_modules)
    .env                                  ← secrets (gitignored — see auth section)
    .env.example                          ← committed template
    README.md                             ← human-facing setup + tools docs
  <next-id>/
    ...
```

Each MCP is **self-contained** — its own `package.json`, its own `node_modules`, its own `.env`. Matches the per-app pattern in [[standard-app-architecture]] (`description` in the root `package.json` says it explicitly: "App-level tooling lives in each app's own package.json"). MCPs follow the same principle.

Third-party MCPs (hosted endpoints, vendor binaries) have **no folder** under `mcps/` — they live only as a row in `.mcp.json` and are passed through by `sync-mcp-config.mjs` unchanged.

## 2. Manifest contract — OS-built only (`manifest.json`)

```json
{
  "id": "vault",                                   ← REQUIRED · kebab-case, must equal folder name
  "domain": "meta",                                ← REQUIRED · owning domain (must exist under domains/)
  "description": "Vault tools — query wiki, …",    ← REQUIRED · one-line purpose
  "transport": "stdio",                            ← REQUIRED · 'stdio' for v1 (HTTP/SSE later)
  "command": "node",                               ← REQUIRED · how Claude Code starts the server
  "args": ["mcps/vault/server.mjs"],               ← REQUIRED · relative to repo root
  "env": ["SOME_TOKEN"],                           ← OPTIONAL · env vars to pass through (see auth)
  "tools": [                                       ← OPTIONAL · documentation only; runtime tool list
    { "name": "search_wiki",                         lives in server.mjs's TOOLS array
      "summary": "Full-text search over vault/wiki/. Returns matching entries." }
  ]
}
```

Third-party MCPs do **not** need a manifest — their entry goes directly in `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

The `tools` array in the OS-built manifest is **documentation**; the actual list returned to Claude Code lives in the server's `ListToolsRequestSchema` handler. Keep them in sync (the audit flags drift).

## 3. Server pattern (`server.mjs`)

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// 1. Load env from mcps/<id>/.env (each server does its own dotenv read; see github MCP for the
//    minimal parser — avoids pulling a dotenv dep just for ~10 lines of code).
// 2. Validate required env vars; process.exit(1) with a helpful error if missing.
// 3. Construct a `Server({ name, version }, { capabilities: { tools: {} } })`.
// 4. setRequestHandler(ListToolsRequestSchema, …) → returns { tools: [...] }
// 5. setRequestHandler(CallToolRequestSchema, …) → dispatches to per-tool handlers, returns
//    { content: [{ type: 'text', text: JSON.stringify(result) }] }
// 6. Errors return { isError: true, content: [...] } — Claude Code surfaces the message.
// 7. await server.connect(new StdioServerTransport()).
```

Reference implementation: the next OS-built MCP (e.g. `mcps/vault/server.mjs` when scaffolded). For the bootstrapping pattern, model on `meta-add-mcp`'s template output until a long-lived reference lands in the repo.

## 4. Auth + secrets

Each MCP keeps its secrets in `mcps/<id>/.env`. The server reads its own `.env` at boot (minimal parser, no dotenv dep). `.env` is gitignored globally via `mcps/*/.env`. `.env.example` is committed and documents the required vars.

The manifest's `env` field lists var names that should also be passed through from the parent shell (so CI or `direnv`-using devs don't need a file). `sync-mcp-config.mjs` reads `process.env` at sync time and inlines values it finds into `.mcp.json`'s per-server `env` block. **Empty/missing vars are simply omitted** — no leaks, no committed secrets.

Three layers, decreasing priority at server boot:

1. Parent process env (set by Claude Code when spawning, populated by `sync-mcp-config.mjs`)
2. `mcps/<id>/.env` (read by the server itself if a var isn't already in `process.env`)
3. Server bails with `process.exit(1)` + helpful message if a required var is still missing

## 5. Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      MCP REGISTRATION SEQUENCE                          │
│                                                                         │
│  1. Author runs /os add-mcp → meta-add-mcp scaffolds mcps/<id>/         │
│  2. Author runs `cd mcps/<id> && npm install`                           │
│  3. Author copies .env.example → .env, fills in secrets                 │
│  4. scripts/sync-mcp-config.mjs runs (auto-invoked by meta-add-mcp,     │
│     also on install). Discovers manifests, writes .mcp.json.            │
│  5. Author restarts Claude Code (MCP config isn't hot-reloadable).      │
│  6. Claude Code spawns the MCP server via stdio on next session start.  │
│  7. Skills + dashboard can now call MCP tools.                          │
└─────────────────────────────────────────────────────────────────────────┘
```

When the user removes an MCP (deletes the folder): re-run `sync-mcp-config.mjs` to update `.mcp.json`, restart Claude Code.

## 6. Audit checks

| check                          | severity | description                                                                  |
| ------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `mcp-manifest-required-fields` | error    | All of `id, domain, description, transport, command, args` are present.      |
| `mcp-id-folder-match`          | error    | `manifest.id` equals the parent folder name.                                 |
| `mcp-domain-exists`            | error    | `manifest.domain` exists as a directory under `domains/`.                    |
| `mcp-env-example-present`      | warn     | If `env` is declared in the manifest, `.env.example` documents each var.     |
| `mcp-config-stale`             | info     | `.mcp.json` does not match the discovered manifests — suggests running sync. |

## 7. What MCPs are not

- **Not skills.** Skills are markdown procedures Claude follows. MCPs are runtime tool servers. Skills can _call_ MCP tools; an MCP doesn't have a procedure.
- **Not apps.** Apps render UI in the dashboard. MCPs have no UI — only a tool surface.
- **Not domain-owned in the same way.** An MCP's `domain` field is for organization + audit, but a single MCP can serve multiple domains (the github MCP is `dev` domain but the planned ops domain can call it too).
- **Not for purely internal data.** If you need structured access to the vault or events.db from inside the OS, use the existing vault/events APIs directly. MCPs are for what's _external_ to the OS — or for surfacing internal data to Claude Code as tools (which is a real use case, but a deliberate one).

## 8. Hosted MCPs and the DCR compatibility check

Hosted MCPs work in Claude Code only when the vendor's OAuth server supports **Dynamic Client Registration** (RFC 7591). Claude Code's MCP SDK registers itself as a client on first connection — if the vendor requires a manually-registered OAuth app instead, you'll see this in `/mcp`:

```
SDK auth failed: Incompatible auth server: does not support dynamic client registration
```

Known cases:

- **GitHub (`api.githubcopilot.com/mcp/`)** — does NOT support DCR. The OS uses a custom OS-built `mcps/github/` with PAT auth instead. See `mcps/github/README.md` for the rationale.
- **Most vendor MCPs that ship "for Claude Code" or "for Claude Desktop"** — do support DCR. They're explicitly designed for the OAuth flow.

When a hosted MCP fails with DCR incompatibility, your options:

1. Build a small OS-built MCP wrapping the vendor's REST API with PAT auth (`/os add-mcp` custom mode — typically <200 LOC using the vendor's official SDK)
2. Use the vendor's official local MCP server if they publish one (e.g. Docker image or binary) — register as a `command`-based entry in `.mcp.json`
3. Skip MCP entirely for that vendor and use Bash + CLI tools instead — fine for one-off integrations

The `kind: hosted` mode of [[meta-add-mcp]] still works for any vendor that DOES support DCR; the OS doesn't restrict the path, it just doesn't make it work where the vendor blocks.

## 9. Removing an MCP

**OS-built**: Delete `mcps/<id>/`, then **manually** remove the corresponding row from `.mcp.json`. `sync-mcp-config.mjs` does not auto-remove — it can't safely distinguish a deleted managed MCP from an always-third-party row. After both deletions, run `sync-mcp-config.mjs` to confirm clean state.

**Third-party**: just delete the row from `.mcp.json`. Restart Claude Code.

## Related

- [[standard-app-architecture]] — the parallel contract for dashboard apps
- [[meta-add-mcp]] — scaffolder that produces a new OS-built MCP following this standard
- `scripts/sync-mcp-config.mjs` — manifest discovery + `.mcp.json` merger (preserves third-party rows)
