#!/usr/bin/env bash
# PostToolUse hook on Write. If the written file landed in vault/raw/,
# append it to the pending-curation queue (idempotent).
#
# Event format: receives JSON on stdin with tool_input.file_path.
# Output: nothing on stdout. Errors silently ignored to avoid breaking sessions.
set -euo pipefail

event=$(cat)
file_path=$(printf '%s' "$event" | sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$file_path" ]; then exit 0; fi

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
queue="$repo_root/.claude/state/pending-curation.txt"

case "$file_path" in
  "$repo_root"/vault/raw/*)
    base=$(basename "$file_path")
    case "$base" in
      .gitkeep|router-log.jsonl|dashboard-actions.jsonl) exit 0 ;;
    esac
    # Skip files inside .archived/
    case "$file_path" in
      "$repo_root"/vault/raw/.archived/*) exit 0 ;;
    esac
    rel="${file_path#$repo_root/}"
    mkdir -p "$(dirname "$queue")"
    if ! grep -qFx "$rel" "$queue" 2>/dev/null; then
      printf '%s\n' "$rel" >> "$queue"
    fi
    ;;
esac
