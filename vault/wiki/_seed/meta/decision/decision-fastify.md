---
id: decision-fastify
type: decision
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [stack, backend, app]
source: manual
private: false
project: build-agentic-os-v1
title: Use Fastify for app backends
status: accepted
alternatives:
  [
    "Express (most familiar)",
    "Hono (lighter)",
    "Raw http.Server",
    "Next.js / Remix (full framework)",
    "Vite middleware mode",
  ]
---

# Use Fastify for app backends

## Context

Apps in the OS need a backend for filesystem reads (vault data), simple direct-fs writes, and the AI bridge that shells out to `claude -p`. We need TypeScript-native, fast enough that local dev feels instant, and low ceremony.

## Options considered

- **Express** — most familiar JS ecosystem. Plenty of middleware. But: JS-y rather than TS-native; aging API; slower than modern alternatives.
- **Fastify** — TS-native plugins, schema-aware route declarations, fast (matters for streaming SSE). Chosen.
- **Hono** — lighter, edge-friendly. Smaller ecosystem; designed for serverless rather than local dev.
- **Raw `http.Server`** — too much boilerplate at scale, especially around plugins, CORS, route registration.
- **Next.js / Remix** — full meta-framework. Heavyweight for our small APIs; conflates frontend + backend in ways the OS doesn't want.
- **Vite middleware mode** — frontend-tool extension. Couples backend to Vite; awkward when backend needs to outlive a Vite restart.

## Decision

Fastify on a separate process (port 5174), proxied through Vite (port 5173) at `/api/*`. Two processes managed by `concurrently` under `npm run dev`.

## Rationale

- **TS-native** out of the box — no `@types/express` mismatch issues.
- **Speed** — handles SSE streaming for the AI bridge without buffering surprises.
- **Plugin model** is clean — `vault.ts`, `action.ts`, etc. each register as Fastify plugins under a prefix.
- **Schema-aware** — route Body/Querystring types enforce inputs at registration time, catching shape errors early.
- **No CORS complexity** — same-origin via Vite proxy keeps the frontend's fetch calls simple.

## Consequences

- Every scaffolded app inherits this — `_templates/app/server/` carries Fastify boilerplate.
- Adding routes is `fastify.get('/<path>', handler)` rather than middleware chains.
- App template's `package.json.tmpl` pins `fastify@^5.0.0` and `@fastify/cors`.
- Future "what backend tool?" questions for new apps should still default to Fastify unless there's a specific reason otherwise (e.g. an app that's mostly static + a tiny edge function — but those are rare).

## References

- [[standard-app-layout]] — server folder structure
- [[standard-ai-bridge]] — SSE handling via Fastify reply.raw
