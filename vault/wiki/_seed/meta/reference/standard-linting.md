---
id: standard-linting
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [standard, os, linting, tooling]
source: manual
private: false
title: Linting + formatting setup (Biome + Prettier)
url: internal://standard/linting
kind: doc
last_verified: 2026-05-20
---

# Linting + formatting setup

## What it is

The OS uses two formatters with split responsibilities. A single PostToolUse hook (`auto-format.sh`) routes each file to the right tool based on extension and the presence of a config file upstream.

## Tool split

| tool         | scope                                                        | config                                              | scripts                                                 |
| ------------ | ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------- |
| **Biome**    | TS, TSX, JS, JSX, CSS, JSON inside any app (per-app install) | `<app>/biome.json`                                  | `npm run lint`, `lint:fix`, `format` (from the app dir) |
| **Prettier** | Markdown across the whole OS (root install)                  | `.prettierrc.json` + `.prettierignore` at repo root | `npm run md:check`, `md:format` (from repo root)        |

Biome 1.9 doesn't format Markdown; Prettier is slower on TS than Biome. The split keeps each tool to its strength.

## Per-app vs root

- **Root** (`package.json` at the OS root): only Prettier. One config covers all `.md` files OS-wide.
- **Per-app** (`domains/<x>/<app>/app/package.json`): Biome + its own `biome.json`. Each app can customize.
- **App template** (`_templates/app/biome.json.tmpl` + scripts in `package.json.tmpl`): future scaffolded apps inherit the same Biome config.

## Auto-format hook

`.claude/hooks/auto-format.sh` runs after every Write/Edit:

1. If file is `.md` and `.prettierrc.json` + `node_modules/.bin/prettier` exist at repo root → `prettier --write <file>` from repo root
2. Else if file is TS/JS/JSON/CSS → walk up from the file's directory looking for the nearest `biome.json` + installed `@biomejs` package; run `biome check --write <file>` from that project's root
3. Silent on success; failures swallowed so they never break a session

This lets ANY app (current or future) get auto-formatted code+markdown by just having `biome.json` + `node_modules` installed.

## Excluded paths

`.prettierignore` excludes:

- `vault/raw/`, `vault/output/`, `vault/.index/`, `.claude/state/` — working state
- `_templates/` — contains Mustache placeholders that look like Prettier-targets but aren't
- `domains/meta/app/` — Biome territory, Prettier shouldn't touch
- `node_modules/`, `dist/`, `.vite/` — generated

## Rationale

- **Biome's speed** (Rust) keeps the auto-format hook under 200ms even on large files
- **Prettier's markdown** is mature — table alignment, code fence normalization, link wrapping
- **Hook walks up** for biome.json → multi-app monorepo works without per-app hook registration
- **Both tools auto-discover their config** → no env vars, no per-call flags

See [[decision-biome-and-prettier]] for the split rationale and what we considered.

## Related

[[standard-hook-protocol]], [[standard-app-layout]]
