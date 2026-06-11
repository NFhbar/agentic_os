---
id: reference-pr-review-config
type: reference
domain: development
created: 2026-05-22T00:00:00Z
updated: '2026-05-23T04:42:34.601Z'
tags: [config, pr-review, singleton]
source: seed
private: false
title: PR review configuration
url: internal://config/pr-review
kind: config
last_verified: 2026-06-09
comment_style: concise
focus_areas: [logic, security, performance, style, tests, docs]
context_strategy: full-diff
custom_instructions: ''
custom_instructions_hash: null
---

# PR review configuration

This is the **singleton config** for [[dev-pr-review]]. Every review run reads from this entry, snapshots the relevant fields onto the resulting [[archetype-pr-review]] entry, and proceeds. There is exactly one of these — at `vault/wiki/development/reference/reference-pr-review-config.md` (this file) — and editing the frontmatter changes the defaults that future reviews use.

Historical reviews are unaffected by changes here: each `pr-review` entry snapshots the config it ran under, so changing `comment_style` from `concise` to `detailed` only affects reviews you run _after_ the edit.

## Edit policy

This file ships in `_seed/` with defaults. You're meant to edit it. When you `git pull` and upstream has changed the defaults, you'll get a merge conflict — that's intentional, it surfaces "the OS shipped new defaults; do you want them?" as a deliberate choice. Resolve like any other config conflict.

If you maintain a fork and never want upstream defaults to change yours: edit once, commit, and reject upstream changes in conflicts.

## Field reference

### Model selection — moved out of this file (0.4.3)

The `primary_model` and `analyzer_model` fields were **removed** in 0.4.3. Model choice now lives in the Settings app (`/settings`) → Model:

- Project-wide default: `.claude/settings.json` field `model`
- Per-skill override: `model:` frontmatter on `.claude/skills/dev-pr-review/SKILL.md` (and `dev-analyze-repo-for-review/SKILL.md`)
- Precedence: per-skill > local (`.claude/settings.local.json`) > project (`.claude/settings.json`) > Claude Code default

The dispatcher resolves the model at `claude -p` spawn time and appends `--model <id>` to the subprocess args (see `domains/meta/app/server/routes/runs.ts:resolveModelForRun`). The running skill stamps its own runtime model id into the produced entry's `config.primary_model` / `analyzer_model` field — these become _records_ of what ran, not _configuration_ for what should run.

### `comment_style`

How verbose the comments should be.

| value      | what it means                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `terse`    | One-line observations. No explanation, no suggestions unless trivial                                                       |
| `concise`  | Two-to-three sentences. Brief reasoning + suggestion where applicable. **Default**                                         |
| `detailed` | Full reasoning, suggestion code blocks, links to related context. Use when reviewing PRs you want a deep teaching trace on |

### `focus_areas`

Which review aspects the model considers. Each comment the model produces is tagged with one of these categories.

Default: `[logic, security, performance, style, tests, docs]` — all six.

| category      | what it covers                                                            |
| ------------- | ------------------------------------------------------------------------- |
| `logic`       | Correctness, edge cases, error handling, control flow                     |
| `security`    | Auth, injection, secrets, unsafe deserialization, sensitive data handling |
| `performance` | Allocations, N+1, blocking I/O, complexity, cache misses                  |
| `style`       | Naming, structure, readability, idioms                                    |
| `tests`       | Coverage, missing cases, test smell, brittle assertions                   |
| `docs`        | Comments, docstrings, README/CHANGELOG drift, public API surface          |

You can also add custom strings (e.g. `accessibility`, `i18n`) — the model will use them as additional category labels but won't have a built-in policy for what they mean unless you describe it in `custom_instructions`.

### `context_strategy`

How the skill assembles the code context it sends to the model.

| value          | what it means                                                       |
| -------------- | ------------------------------------------------------------------- |
| `full-diff`    | Send the full PR diff. Simplest. **Only supported value in v1.**    |
| `symbol-graph` | (Future) Send the diff plus expanded definitions of touched symbols |
| `semantic`     | (Future) Send the diff plus semantically-similar code regions       |

### `custom_instructions`

Free-text additional instructions injected into the review prompt after the skill's skeleton prompt. Use this for project-specific concerns — e.g. "We use `tsx` not `enzyme`, flag any usage", "This repo uses Effect; surface non-Effect error handling", etc.

Defaults to empty string. The skill computes a `custom_instructions_hash` (sha256 hex, first 12 chars) and snapshots it onto each pr-review entry so historical reviews carry a fingerprint of the prompt they ran under.

When you edit this field, also clear `custom_instructions_hash` — the skill recomputes and writes it on the next review run.

## What's _not_ configurable here yet

These are mentioned in the planned Settings UI but defer to later phases:

- **Per-repo overrides** — Phase 3+. For now, config is global.
- **Automation** (`auto_review_enabled`, branch patterns, auto-publish, block thresholds) — Phase 3+. For now, reviews run only when explicitly triggered.
- **Notifications** (Slack, email) — Phase 3+.
- **Per-agent prompts** — not coming. The "agents" framing was collapsed into `focus_areas` + categorized comments. See [[archetype-pr-review]] § Comments for the rationale.

If you need any of these now, you can add the fields here and consume them in your own fork of `dev-pr-review` — the schema isn't fenced.

## Related

- [[archetype-pr-review]] — entries this config produces, including the `config.*` snapshot block
- [[dev-pr-review]] — the skill that reads this entry
- [[standard-pr-description]] — companion config-by-convention for the PR-writing side of the lifecycle
