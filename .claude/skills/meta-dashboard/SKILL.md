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

0. **Reuse check — `Headless: default(reuse)`.** Before spawning anything, probe whether a dashboard is already up:
   - `curl -sf http://localhost:<port_web>` (frontend reachable), AND
   - `curl -sf http://localhost:<port_api>/api/health` (the OS API's own health route, registered in `server/index.ts`).

   If BOTH respond, a dashboard is already running — do NOT spawn a second one (vite would auto-shift its port and the fresh Fastify would die `EADDRINUSE`, leaving an orphan pair and a false "launched" report). Instead:
   - Interactive: open the browser to `http://localhost:<port_web>`.
   - Headless: report the reuse (no browser).

   Record the launch event (step 6) noting the reuse, then stop. When both probes do NOT succeed, fall through to step 1.

   _Residual (accepted): the web probe accepts **any** server on `<port_web>` — only the `/api/health` probe is OS-specific. In a half-orphan state (OS API alive on `<port_api>` but its vite dead, and a foreign dev server squatting on `<port_web>`) both probes answer and this check would misreport reuse, opening the browser to the wrong app. Exotic precondition, and still a strict improvement over the duplicate-spawn false-success it replaces. Remedy if it bites: free `<port_web>` or pass a different `port_web`._

1. Verify `domains/meta/app/` exists. If not, tell the user the dashboard is not yet scaffolded and stop.
2. Check `domains/meta/app/node_modules/`. If missing, run `npm install --silent` in that directory.
3. Spawn the dev server in `domains/meta/app/` as a background process via Bash with `run_in_background: true`, wiring the declared port inputs into the child env:
   ```bash
   PORT=<port_api> OS_API_PORT=<port_api> OS_WEB_PORT=<port_web> npm run dev
   ```
   `PORT` drives Fastify's listen (`server/index.ts`), `OS_API_PORT` the vite proxy target (existing pattern in `vite.config.ts`), `OS_WEB_PORT` the vite dev-server port (added by this change). Without this wiring the inputs are inert and both processes fall back to their compiled-in defaults. Capture the shell ID.
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

- Port-conflict gate — `<port_web>` responds but `/api/health` on `<port_api>` does NOT (a non-dashboard squatter), OR the spawn hits `EADDRINUSE`:
  - Interactive: ask the user — reuse existing dashboard, or pick a different port?
  - `Headless: refuse` — print `⊘ Port conflict — <port_web>/<port_api> occupied by a non-dashboard process`, name the symptom (web port answers but `/api/health` does not, or the spawn hit `EADDRINUSE`) and the remedy (pass different `port_web`/`port_api`, or free the port). Stop with no spawn.
  - (When BOTH the web port AND `/api/health` respond, that is the reuse case, not a conflict — handled by step 0's `default(reuse)`.)
- If `domains/meta/app/package.json` is missing, the dashboard scaffold is incomplete — report and stop
