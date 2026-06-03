---
id: standard-hook-protocol
type: reference
domain: meta
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
tags: [standard, os, hooks]
source: manual
private: false
title: Hook script protocol
url: internal://standard/hook-protocol
kind: doc
last_verified: 2026-05-19
---

# Hook script protocol

## What it is

Every script in `.claude/hooks/` is invoked by Claude Code at well-defined lifecycle moments. These rules ensure hooks are safe, fast, and idempotent.

## Rules

1. **Input**: hook receives Claude Code's hook event as JSON on stdin
2. **Output**: stdout becomes context for the model (when applicable); stderr is logged but invisible
3. **Side effects**: write only to `.claude/state/` or `vault/raw/`. Never modify `vault/wiki/`, `.claude/skills/`, playbooks, or templates from a hook.
4. **Exit code**: 0 on success, non-zero on failure
5. **Idempotency**: safe to re-run with the same input
6. **Performance target**: <200ms; longer hooks delay every interaction
7. **Language**: bash by default. Use `.mjs` Node helpers when JSON/YAML parsing is needed.

## Hook events used by v1

| event                                  | hook                      | purpose                                                                                                                |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PostToolUse` (matcher: `Write`)       | `note-raw-write.sh`       | Append to pending-curation queue if write targets `vault/raw/`                                                         |
| `PostToolUse` (matcher: `Write\|Edit`) | `rebuild-vault-index.sh`  | Rebuild `vault/.index/manifest.json` if change touches `vault/wiki/`                                                   |
| `PostToolUse` (matcher: `Write\|Edit`) | `auto-format.sh`          | Auto-format TS/JS/JSON/CSS via Biome (per-app, walks up for nearest `biome.json`); auto-format `.md` via root Prettier |
| `UserPromptSubmit`                     | `surface-curate-nudge.sh` | Inject system-reminder when pending curation queue is non-empty                                                        |
| `SessionStart`                         | `session-brief.sh`        | Print compact OS state (or welcome banner on first run)                                                                |

## Wiring

All hooks registered in `.claude/settings.json`. The schema is:

```json
{
  "hooks": {
    "<event>": [
      {
        "matcher": "<tool-pattern>",
        "hooks": [{ "type": "command", "command": ".claude/hooks/<script>" }]
      }
    ]
  }
}
```

## Rationale

- Bash keeps hooks portable across machines
- Restricting writes to `.claude/state/` + `vault/raw/` prevents hooks from quietly corrupting load-bearing structure
- Fast hooks keep sessions snappy
- Idempotency is critical because hooks may fire many times per session

## Related

[[standard-log-formats]]
