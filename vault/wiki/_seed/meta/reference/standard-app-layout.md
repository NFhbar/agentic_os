---
id: standard-app-layout
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, app]
source: manual
private: false
title: App layout standard
url: internal://standard/app-layout
kind: doc
last_verified: 2026-05-19
---

# App layout standard

## What it is

The required folder structure for every app at `domains/<x>/<name>/app/`. Apps are optional Vite + React + Fastify projects that read vault data and (optionally) trigger AI actions via the `claude` CLI shellout.

## Required files

```
domains/<domain>/<name>/app/
├── package.json              # scripts: dev, dev:web, dev:api, build, lint, lint:fix, format
├── tsconfig.json
├── vite.config.ts            # proxies /api/* to Fastify on 5174
├── biome.json                # lint + format config (covers src/ and server/)
├── index.html
├── README.md                 # what + how to run
├── .gitignore                # node_modules, dist, .vite, *.log
├── src/
│   ├── main.tsx              # React mount
│   ├── App.tsx
│   └── lib/
│       ├── vault.ts          # frontend wrapper for /api/vault
│       └── api.ts            # frontend wrapper for /api/action (SSE)
└── server/
    ├── index.ts              # Fastify entry
    ├── auth.ts               # no-op middleware (replace for tunneled mode)
    └── routes/
        ├── vault.ts          # GET reads, POST simple writes
        └── action.ts         # POST AI actions (claude CLI shellout, SSE)
```

Biome covers both frontend (`src/`) and backend (`server/`) in one pass — same tool, same config. `npm run lint:fix` reformats and applies safe fixes.

## Launch skill

The skill that starts the app does NOT live in the app folder. It lives at:
`.claude/skills/<domain>-<app-name>-app.md`

The flat-skills rule has no exceptions.

## Ports

- Frontend: 5173 (Vite default); subsequent apps get incrementing ports stored in `.claude/state/app-ports.json`
- Backend: 5174 (frontend +1)
- The launch skill must check for port collisions and pick free ports

## AI bridge

`POST /api/action` shells `claude -p "<prompt>"` and streams output back over SSE.
Audit log every call to `vault/raw/dashboard-actions.jsonl`.

## Auth

`server/auth.ts` is a no-op middleware in local-only mode. For tunneled access (Tailscale, Cloudflare), replace with token verification reading from an env var.

## Rationale

- Vite + React is mainstream, low-friction
- Fastify keeps the backend tiny and TypeScript-native
- Same-origin via Vite proxy means no CORS complexity
- SSE for AI actions matches the `claude` CLI's streaming behavior
- No-op auth keeps remote-readiness without v1 implementation cost

## Related

- [[standard-skill-format]] (launch skills) · [[standard-log-formats]] (audit log)
- [[meta-add-app]] — scaffolds new apps against this layout
- [[standard-dashboard-patterns]] — reusable React components for any app built against this layout
