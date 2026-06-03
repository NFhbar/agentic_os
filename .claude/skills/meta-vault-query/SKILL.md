---
name: meta-vault-query
description: 'Query the OS vault via the structured MCP interface — search wiki entries, fetch a specific entry by id, or list archetypes with counts. The canonical access pattern when skills (or the user) need vault context that''s richer than a raw manifest read.'
user-invocable: true
version: 1
domain: meta
tags: [vault, query, mcp, search]
inputs:
  mode:
    type: string
    required: true
    enum: [search, get, list-archetypes]
    description: 'Which vault operation to run. `search` does full-text + filter search. `get` fetches a single entry. `list-archetypes` enumerates archetype counts.'
  query:
    type: string
    required: false
    description: 'Free-text search query (only used when `mode: search`). Matched against title + body + tags.'
  archetype:
    type: string
    required: false
    description: 'Filter to a single archetype (used by `mode: search` to narrow results). Examples: `change`, `pr-review`, `decision`, `note`.'
  domain:
    type: string
    required: false
    description: 'Filter to a single domain (used by `mode: search`). Examples: `meta`, `development`.'
  limit:
    type: integer
    required: false
    default: 20
    description: 'Maximum number of search hits to return (only used when `mode: search`). Capped at 100 server-side.'
  id:
    type: string
    required: false
    description: 'Entry id (used when `mode: get`). Preferred over path — stable across renames.'
  path:
    type: string
    required: false
    description: 'Entry path (used when `mode: get`, fallback when no id is known). Form: `vault/wiki/<domain>/<archetype>/<slug>.md`.'
outputs:
  - kind: text
    description: 'Formatted result block printed inline — search hits as a list, entry as a section, archetypes as a table.'
spawns: []
---

# meta-vault-query

## Purpose

Provide a typed, structured query interface over the OS vault. Three modes — search, get, list — each thin-wrapping a tool from the `vault` MCP server:

| Mode              | Tool                          | Use when…                                                             |
| ----------------- | ----------------------------- | --------------------------------------------------------------------- |
| `search`          | `mcp__vault__search_wiki`     | You need "find entries about X" — full-text + filters                 |
| `get`             | `mcp__vault__get_entry`       | You know the id and need the full content + parsed frontmatter        |
| `list-archetypes` | `mcp__vault__list_archetypes` | You need to know what kinds of entries exist before composing a query |

The skill exists to:

1. **Surface the MCP** as a `/os` command so the user can query the vault without writing a script.
2. **Document the call pattern** so future skills that need vault context can crib from it instead of re-reading `manifest.json` and walking files.
3. **Clear the `mcp-tool-orphan` audit warnings** for the three vault MCP tools by providing at least one consumer.

This skill is **read-only**. It never mutates the vault.

## Pre-conditions

- vault MCP available. Pre-flight via:

  ```bash
  node scripts/check-mcp.mjs vault
  ```

- For `mode: search` — the manifest at `vault/.index/manifest.json` must exist and be reasonably fresh (the MCP server reads it). The morning brief / health-digest will surface staleness; rerun `.claude/hooks/rebuild-vault-index.mjs` if needed.

## Procedure

1. **Pre-flight: verify the vault MCP.** Run `node scripts/check-mcp.mjs vault --json`. Non-zero exit → surface hint and stop.

2. **Validate inputs by mode.** Reject early on malformed input:
   - `mode: search` → require `query` (non-empty string). `archetype` / `domain` / `limit` are optional filters.
   - `mode: get` → require either `id` OR `path` (not both — `id` wins). At least one must be set.
   - `mode: list-archetypes` → no other inputs needed.

3. **Dispatch the appropriate MCP call:**

   **`mode: search`** — call `mcp__vault__search_wiki` with:

   ```json
   { "query": "<inputs.query>", "archetype": "<inputs.archetype>", "domain": "<inputs.domain>", "limit": <inputs.limit ?? 20> }
   ```

   Capture the response: `hits: [{id, title, archetype, domain, path, snippet, score}, ...]`.

   **`mode: get`** — call `mcp__vault__get_entry` with EITHER:

   ```json
   { "id": "<inputs.id>" }
   ```

   …OR (fallback when only path is given):

   ```json
   { "path": "<inputs.path>" }
   ```

   Capture the response: `{ id, title, archetype, domain, path, frontmatter, body, mtime }`.

   **`mode: list-archetypes`** — call `mcp__vault__list_archetypes` with no args. Capture: `archetypes: [{name, count}, ...]`.

4. **Format the output for the user** based on mode:

   **`mode: search`** — markdown list:

   ```
   ## Search: "<query>"
   <filters summary if any: archetype=<x>, domain=<y>>
   <n> hit(s):

   1. [[<id>]] — <title> · <archetype> · <domain> · score <score>
      <snippet>

   2. [[<id>]] — ...
   ```

   Cap at the requested limit. End with `0 hits — try different search terms or remove filters` when empty.

   **`mode: get`** — formatted entry view:

   ```
   ## <title> · <archetype> · <domain>

   id:   <id>
   path: <path>
   updated: <mtime>

   ### Frontmatter
   <key>: <value>
   ...

   ### Body
   <body verbatim, possibly truncated to 2000 chars with "[…truncated]" footer when longer>
   ```

   Error case (entry not found) → surface the MCP's error message verbatim.

   **`mode: list-archetypes`** — table:

   ```
   ## Archetypes (<n> kinds)

   | archetype     | count |
   | ------------- | ----- |
   | change        | 12    |
   | pr-review     | 4     |
   | ...
   ```

5. **No vault writes; no event recording.** This skill is read-only — no `record-dashboard-action.mjs` invocation. Read-side queries don't pollute the action log.

## Inputs schema notes

- `mode`: required strict enum. Reject unknown modes with: `Unknown mode "<mode>". Valid: search, get, list-archetypes.`
- For `search`: `query` is required; filters are AND-combined when provided.
- For `get`: prefer `id` over `path`. Path is the escape hatch when the entry isn't in the manifest yet (just-created entries, etc.).

## Outputs

- A formatted block printed to stdout. No files written. No mutations.

## What this skill must NOT do

- **Mutate the vault.** This skill is strictly a query interface. Use `meta-curate` to write to `vault/raw/`, the various `meta-add-*` skills to scaffold new entries, or direct Edit-tool calls for surgical mutations.
- **Replace `manifest.json` reads for skill internals.** When you're writing a skill that needs to walk all changes in a domain, reading the manifest is faster + zero-dependency. Use the MCP when you need full-text search, parsed frontmatter, or computed metadata that the manifest doesn't carry.
- **Aggregate across modes in one call.** Each invocation does one thing. If you need to search-then-fetch, that's two invocations.

## Errors

- `MCP vault not configured` → the vault MCP server isn't reachable. Check `mcps/vault/` exists and `.mcp.json` includes it.
- `Manifest missing/stale` → run `node .claude/hooks/rebuild-vault-index.mjs` (or accept the manifest-stale action item in the Overview's Action Items panel).
- `Unknown mode "<mode>"` → caller passed an invalid mode.
- `Either id or path required for mode: get` → caller didn't provide a target.

## See also

- `mcps/vault/server.mjs` — the MCP server implementation (read-only, manifest-backed)
- `mcps/vault/manifest.json` — tool declarations
- [[archetype-entity]] / [[archetype-change]] / etc. — the archetypes you'll be querying
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
- `meta-brief` — uses manifest reads directly; doesn't go through this skill (lower latency for the on-mount path)
- `meta-curate` — the write-side counterpart for `vault/raw/`
