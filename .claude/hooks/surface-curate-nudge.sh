#!/usr/bin/env bash
# UserPromptSubmit hook. If the curation queue is non-empty, surface a
# one-line nudge so Claude sees it as context for the upcoming turn.
# Cheap: one file stat + line count.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
queue="$repo_root/.claude/state/pending-curation.txt"

if [ ! -s "$queue" ]; then exit 0; fi

count=$(wc -l < "$queue" | tr -d ' ')
if [ "$count" -eq 0 ]; then exit 0; fi

printf '<system-reminder>📥 %s item(s) in vault/raw/ awaiting curation. The user may want to run /os curate.</system-reminder>\n' "$count"
