---
id: concept-app
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [concept, core, plain-language]
source: manual
private: false
title: App
url: internal://concept/app
kind: doc
last_verified: 2026-05-20
---

# App

## What it is

An **app** is an _optional_ visual UI for a domain. Built as Vite + React + Fastify. Reads vault data directly from the filesystem; can trigger AI actions through the dashboard's `claude` CLI bridge.

Every app:

- Lives at `domains/<x>/<app-name>/app/` (or `domains/meta/app/` for the OS dashboard)
- Has its own `package.json`, Vite config, Biome config, `src/` (React) and `server/` (Fastify)
- Has a **launch skill** at `.claude/skills/<domain>-<app>-app/SKILL.md` that runs `npm run dev` + opens the browser

## When you use it

- A domain produces structured output that benefits from a browser-based view (charts, navigation, side-by-side comparison)
- You want a richer UI than terminal-based interaction
- You want to drive AI actions through clickable buttons rather than typed `/os` commands

Most domains do NOT need an app. The vault is already rich enough for many workflows just via wiki entries.

## Example

The **OS dashboard** is the canonical app — lives at `domains/meta/app/`. It browses skills/domains/wiki, edits playbooks, runs scaffolders, shows router telemetry. The OS uses the dashboard to evolve itself.

A planned future app: **pr-review** under `domains/development/pr-review/app/` for browsing PR review outputs visually.

## How to create one

```
/os add-app
```

The form asks for domain, app name, and display name. `meta-add-app` copies `_templates/app/` (a complete Vite + React + Fastify starter that inherits Biome + the AI bridge by default), installs npm deps, and creates the launch skill.

## Related

- [[concept-domain]] — apps belong to domains
- [[standard-app-layout]] — the required file structure
- [[standard-ai-bridge]] — how apps trigger AI actions
- [[standard-dashboard-patterns]] — reusable UI patterns for any app
- [[meta-add-app]] — scaffolds a new app
- [[meta-dashboard]] — launches the OS dashboard (the canonical first app)
