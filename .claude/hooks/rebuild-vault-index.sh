#!/usr/bin/env bash
# PostToolUse on Write|Edit. If the change touched vault/wiki/, rebuild
# vault/.index/manifest.json. Silent on success, errors swallowed.
set -euo pipefail

event=$(cat)
file_path=$(printf '%s' "$event" | sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p' | head -1)

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

case "$file_path" in
  "$repo_root"/vault/wiki/*) ;;
  *) exit 0 ;;
esac

if command -v node >/dev/null 2>&1; then
  node "$repo_root/.claude/hooks/rebuild-vault-index.mjs" >/dev/null 2>&1 || true
fi
