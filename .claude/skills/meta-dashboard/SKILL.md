---
name: meta-dashboard
description: Launch the Agentic OS dashboard (Vite + Fastify), opens browser to localhost
user-invocable: true
version: 1
domain: meta
tags: [app, dashboard, launch]
inputs:
  port_web:
    type: number
    required: false
    default: 5173
    description: Vite dev server port
  port_api:
    type: number
    required: false
    default: 5174
    description: Fastify backend port
outputs:
  - kind: process
    description: Background dev server (frontend + backend)
---

# meta-dashboard

## Purpose

Start the OS dashboard. Spawns the Vite frontend and Fastify backend in `domains/meta/app/`, waits for the frontend to be reachable, then opens the user's browser.

## Procedure

1. Verify `domains/meta/app/` exists. If not, tell the user the dashboard is not yet scaffolded and stop.
2. Check `domains/meta/app/node_modules/`. If missing, run `npm install --silent` in that directory.
3. Spawn `npm run dev` in `domains/meta/app/` as a background process via Bash with `run_in_background: true`. Capture the shell ID.
4. Poll `http://localhost:<port_web>` until it responds 200 OK (or 5 seconds elapses). Use a short bash `until curl -sf ...; do sleep 0.5; done` loop with a timeout.
5. Open the browser: `open http://localhost:<port_web>` on macOS, `xdg-open ...` on Linux.
6. Record the launch event via the dual-write wrapper (appends to
   `vault/raw/dashboard-actions.jsonl` AND inserts into `.claude/state/events.db`):
   ```bash
   node scripts/record-dashboard-launch.mjs --port-web <n> --port-api <n>
   ```
7. Report the background shell ID to the user so they can stop it with KillShell.

## Outputs

- Background process (frontend + backend via `concurrently`)
- Browser tab pointed at the dashboard
- One audit log line

## Errors

- If `<port_web>` is already in use, ask the user: reuse existing dashboard, or pick a different port?
- If `domains/meta/app/package.json` is missing, the dashboard scaffold is incomplete — report and stop
