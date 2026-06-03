---
id: standard-ai-bridge
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [standard, os, app, ai, bridge]
source: manual
private: false
title: AI bridge pattern (dashboard → claude CLI)
url: internal://standard/ai-bridge
kind: doc
last_verified: 2026-05-20
---

# AI bridge pattern

## What it is

The mechanism that lets an app's UI trigger AI-driven OS actions. The dashboard (and any future app) builds a prompt, the backend shells out to `claude -p "<prompt>"` in the repo root, and streams the output back to the frontend over SSE. Every call gets audit-logged.

## Files involved

| file                                               | role                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `domains/meta/app/server/routes/action.ts`         | Fastify `POST /api/action` — spawns `claude -p`, pipes stdout/stderr as SSE events, appends to audit log |
| `domains/meta/app/src/lib/api.ts`                  | `runAction(prompt)` async generator — frontend wrapper that parses the SSE stream                        |
| `domains/meta/app/src/components/ActionRunner.tsx` | Modal that consumes `runAction` and renders prompt + streaming output + exit status                      |
| `vault/raw/dashboard-actions.jsonl`                | Audit log: one JSON object per action                                                                    |

The app template (`_templates/app/server/routes/action.ts.tmpl`) ships this same pattern, so every scaffolded app inherits it.

## Wire protocol

`POST /api/action` body:

```json
{ "prompt": "<full prompt string>" }
```

Response: `Content-Type: text/event-stream`. Each SSE `data:` line is a JSON object:

```json
{ "chunk": "<stdout fragment>" }
{ "stderr": "<stderr fragment>" }
{ "done": true, "exit": 0 }
```

The frontend `runAction(prompt)` is an `AsyncGenerator<ActionChunk>` — consumers iterate until `done`.

## Constructing prompts

Use a helper module to keep prompts consistent and machine-traceable. The dashboard uses `src/lib/skills.ts` (`buildScaffoldPrompt`) and `src/lib/destructive.ts` (`buildRenamePrompt`, `buildDeletePrompt`).

Prompts that invoke a specific skill should:

1. Direct Claude to the exact skill file (`Read .claude/skills/<name>/SKILL.md`).
2. Provide structured `Inputs:` as a list (one per line).
3. State whether to enter plan mode or execute directly — dashboard prompts that already collected confirmation should say "Do NOT enter plan mode."

## Audit log

`vault/raw/dashboard-actions.jsonl` — see [[standard-log-formats]] for shape. Every `/api/action` call appends exactly one line on completion, regardless of success or failure.

## Auth

The bridge inherits `claude` CLI auth from the user's shell environment. Local-only use needs no extra config. For tunneled access, see [[standard-app-layout]] (auth middleware) — the bridge still needs the `claude` CLI to be authenticated as the _server-running_ user.

## Why this shape

- **No new auth surface**: reuses the CLI's existing auth, no API key handling
- **One-shot mode (`-p`)**: matches the "run a task and return" UX of dashboard actions
- **SSE streaming**: matches `claude` CLI's incremental output behavior
- **Audit log**: every AI action is replayable from history

See [[decision-skip-plan-mode]] for why dashboard-driven destructive skills bypass plan mode.

## Related

[[standard-app-layout]], [[standard-log-formats]], [[standard-skill-format]]
