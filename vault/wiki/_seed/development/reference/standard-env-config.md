---
id: standard-env-config
type: reference
domain: development
created: 2026-05-30T00:35:00Z
updated: 2026-05-30T00:35:00Z
tags: [standard, env, config, secrets, dashboard, mcp]
source: vault/wiki/development/change/env-standard-app-loader.md
private: false
title: Environment variables — per-surface .env files
url: internal://standard/env-config
kind: doc
last_verified: 2026-05-30
---

# Environment variables — per-surface .env files

## Why

`process.env.X` reads scattered across the codebase are hard to discover, hard to test (no single config surface), and hard to audit (which secrets does this service actually need?). This standard locks one pattern: **each independent surface owns a `.env` file at its root, loaded at process start, populating `process.env` for downstream readers.** Existing `process.env.X` reads continue to work unchanged — the `.env` file is just where those values come from.

## Layout

```
mcps/<name>/.env              # per-MCP server (Claude Code spawns; reads at start)
mcps/<name>/.env.example      # committed; documents required vars
domains/<domain>/app/.env     # dashboard app server (per-domain app)
domains/<domain>/app/.env.example
```

The `.env` files themselves are gitignored. The `.env.example` siblings are committed and document every variable the surface needs, with safe placeholder values and a comment explaining each.

Gitignore (in repo root `.gitignore`):

```
mcps/*/.env
domains/*/app/.env
```

## Loader

Each surface has its own ~30-line loader near its entry point. No `dotenv` npm dependency — the format is simple enough to parse inline. Loader contract:

1. Read the surface-local `.env` file.
2. For each `KEY=value` line (ignoring `#` comments + blank lines):
   - Strip optional surrounding single or double quotes from the value
   - **If `process.env[KEY]` is already set, leave it alone** — shell-exported values take priority
   - Otherwise set `process.env[KEY] = value`
3. Return a small summary (number of keys loaded, or "missing file") so the boot log can confirm.

### Canonical implementations

- `mcps/github/server.mjs::loadEnv` — the original; pure ESM, no deps
- `domains/meta/app/server/load-env.ts` — typed TypeScript version; same contract

When introducing a new app/MCP, copy one of these as the starting point. Don't introduce a `dotenv` dep — the format is too simple to warrant it.

## Boot order

The loader MUST run before any module that reads `process.env.X` at import time. For the dashboard server (`server/index.ts`), this means:

```ts
import Fastify from 'fastify';
import { loadAppEnv } from './load-env.js';

{
  const result = loadAppEnv();
  console.log(result.missing
    ? `[env] no .env at ${result.path} — using shell process.env only`
    : `[env] loaded ${result.loaded} key(s) from ${result.path}`);
}

import { auth } from './auth.js';
// … route imports, register calls, listen …
```

A bare `import { loadAppEnv } …` placed AFTER route imports won't work — the route modules will have already captured `process.env.X` snapshots at their top-level. Keep the loader call at the very top of the boot file, immediately after the loader's own import.

## When NOT to use this pattern

- **Per-request secrets** (per-user tokens, session keys) — those belong in a session store or request header, not process.env
- **Build-time constants** — vite + react use `import.meta.env.*` at build time; that's separate from server runtime env
- **Skill outputs** — skills writing transient values should write to `vault/raw/`, `.claude/state/`, or the events DB; not to env

## What this standard does NOT cover

- **Secret rotation / vault integration** — when a token leaks, you edit `.env` and restart. A future `standard-secret-rotation` could wrap this with secret-manager integration if the cost/benefit shifts.
- **Multi-environment configs** (.env.production, .env.staging) — defer until there's actual multi-env deployment.

## Migration

Existing `process.env.X` reads need NO code change once the loader is wired up. Just:

1. Add the loader call near the top of the surface's entry file.
2. Create `.env.example` documenting every variable the surface reads.
3. Update `.gitignore` to cover the surface's `.env`.
4. Optionally, audit existing `process.env.X` reads in the surface and add them to `.env.example` so new contributors see the full needed set.

## Related

- [[standard-code-quality]] §1 — "Reuse before introducing" (this loader is the reusable thing)
- [[standard-shared-types]] — sibling pattern for types, complementary to this for secrets
