---
id: decision-biome-and-prettier
type: decision
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [linting, formatting, tooling]
source: manual
private: false
project: build-agentic-os-v1
title: Biome for code, Prettier for markdown (split-tool linting)
status: accepted
alternatives:
  [
    "ESLint + Prettier (traditional)",
    "Biome alone",
    "Prettier alone",
    "Biome for code + Prettier for markdown (chosen)",
  ]
---

# Biome for code, Prettier for markdown

## Context

The OS is markdown-heavy (skills, playbooks, wiki entries, templates) AND code-heavy in apps (TS, JSX, JSON, CSS). We needed consistent formatting and basic lint rules without spinning up multiple parallel toolchains.

## Options considered

- **ESLint + Prettier** — the traditional combo. Two configs, plugin ecosystem, well-understood. Slow on large repos; lots of config.
- **Biome alone** — modern, fast, single tool. Handles TS/JS/CSS/JSON/JSX well. But: Biome 1.9 doesn't format Markdown (planned for 2.x). Rejected for markdown coverage.
- **Prettier alone** — handles Markdown well + can format TS/JS. Slower than Biome on TS; no linting. Rejected for TS performance and lack of lint rules.
- **Biome for code + Prettier for markdown** — split by responsibility. Each tool does what it's strongest at. Chosen.

## Decision

- **Biome** handles TS, TSX, JS, JSX, CSS, JSON in apps. Per-app installation (each app has its own `biome.json`).
- **Prettier** handles `.md` files OS-wide. Installed at repo root. Configured to exclude `_templates/` (Mustache placeholders), `vault/raw/`, `vault/output/`, and `domains/meta/app/` (Biome territory).
- A single PostToolUse hook (`auto-format.sh`) walks up from the edited file to find the nearest `biome.json` (with installed Biome) or detects `.md` extension and runs the right tool.

## Rationale

- **Biome's speed** matters because the auto-format hook runs on every Write/Edit. Slow hooks degrade every interaction.
- **Prettier's markdown handling** is mature: table alignment, code-fence normalization, link wrapping. Biome 2.x will eventually subsume this but isn't shipping yet.
- **Per-app Biome config** lets each app tune rules independently (e.g. a future strict app could enable rules the dashboard disables).
- **Root Prettier config** centralizes markdown style — every `.md` in the OS follows the same rules.

## Consequences

- Two configs (`biome.json` per-app, `.prettierrc.json` at root) — small maintenance cost.
- `install.sh` runs `npm install` at root (for Prettier) AND in each app (for Biome).
- App template (`_templates/app/`) ships with `biome.json.tmpl` + lint scripts so future apps inherit the same config.
- When Biome 2.x ships Markdown support, we can revisit — but the split also has the advantage of letting per-app code rules diverge while markdown stays unified.

## References

- [[standard-linting]] — the operational spec
- [[standard-hook-protocol]] — auto-format hook registration
