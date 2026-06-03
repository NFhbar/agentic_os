#!/usr/bin/env bash
# PostToolUse hook on Write|Edit. Auto-formats TS/TSX/JS/JSX/CSS/JSON files
# in any app (or other project) with a biome.json and installed Biome.
# Walks up from the file's directory looking for the nearest biome.json.
# Silent on success; failures swallowed so they never break a session.
set -euo pipefail

event=$(cat)
file_path=$(printf '%s' "$event" | sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then exit 0; fi

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

# Skip files outside the repo, or in node_modules/dist/.vite anywhere
case "$file_path" in
  "$repo_root"/*) ;;
  *) exit 0 ;;
esac
case "$file_path" in
  */node_modules/*|*/dist/*|*/.vite/*) exit 0 ;;
esac

# Markdown: format via Prettier at repo root (handles all .md OS-wide)
case "$file_path" in
  *.md)
    if [ -f "$repo_root/.prettierrc.json" ] && [ -x "$repo_root/node_modules/.bin/prettier" ]; then
      ( cd "$repo_root" && ./node_modules/.bin/prettier --write --log-level error "$file_path" ) >/dev/null 2>&1 || true
    fi
    exit 0
    ;;
esac

# Code: format via Biome in the nearest enclosing project
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css) ;;
  *) exit 0 ;;
esac

# Walk up looking for the nearest biome.json with Biome installed.
dir=$(dirname "$file_path")
project_dir=""
while [ "$dir" != "/" ] && [ "$dir" != "$(dirname "$repo_root")" ]; do
  if [ -f "$dir/biome.json" ] && [ -d "$dir/node_modules/@biomejs" ]; then
    project_dir="$dir"
    break
  fi
  dir=$(dirname "$dir")
done

if [ -z "$project_dir" ]; then exit 0; fi

( cd "$project_dir" && npx --no-install biome check --write "$file_path" ) >/dev/null 2>&1 || true
