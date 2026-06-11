#!/usr/bin/env bash
# SessionStart hook. Prints a compact OS brief inline, or a welcome banner
# on first run. All best-effort: missing files just skip their line.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"

# First run: print banner instead of brief
if [ ! -s ".claude/state/installed-at" ]; then
  cat <<'BANNER'

  ✨ Welcome to the Agentic OS — first session detected.

  Quick start:
    1. Run ./install.sh from this directory to verify prereqs & init state
    2. Try /os brief
    3. Try /os dashboard (once the dashboard is scaffolded)

  Reading order: README.md → OS.md → domains/meta/playbook.md

BANNER
  exit 0
fi

pending=0
oldest_age="—"
if [ -s ".claude/state/pending-curation.txt" ]; then
  pending=$(wc -l < ".claude/state/pending-curation.txt" | tr -d ' ')
  if [ "$pending" -gt 0 ]; then
    oldest=$(head -1 ".claude/state/pending-curation.txt")
    if [ -f "$oldest" ]; then
      now=$(date +%s)
      mtime=$(stat -f %m "$oldest" 2>/dev/null || stat -c %Y "$oldest" 2>/dev/null || echo "$now")
      days=$(( (now - mtime) / 86400 ))
      oldest_age="${days}d"
    fi
  fi
fi

miss_rate="—"
log="vault/raw/router-log.jsonl"
if [ -s "$log" ]; then
  total=$(tail -100 "$log" | wc -l | tr -d ' ')
  if [ "$total" -gt 0 ]; then
    misses=$(tail -100 "$log" | grep -c '"confidence":"miss"' || true)
    miss_rate="$(( misses * 100 / total ))%"
  fi
fi

dashboard_last="never"
dlog="vault/raw/dashboard-actions.jsonl"
if [ -s "$dlog" ]; then
  last_ts=$(grep '"action":"launch"' "$dlog" | tail -1 | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')
  if [ -n "$last_ts" ]; then
    dashboard_last=$(echo "$last_ts" | cut -dT -f1)
  fi
fi

# CC contract status — written by the background check below on a prior
# session. A failed status means a Claude Code update drifted a surface the
# OS depends on (flags / stream-json fields / transcript format).
cc_warn=""
if [ -s ".claude/state/cc-contract-status.json" ] && grep -q '"ok":false' ".claude/state/cc-contract-status.json"; then
  cc_warn="  ⚠ CC contract drift detected — run: node scripts/check-cc-contract.mjs
"
fi

cat <<EOF

📋 Agentic OS — session brief
  • ${pending} raw item(s) awaiting curation (oldest: ${oldest_age})
  • Router miss rate (last 100): ${miss_rate}
  • Dashboard last opened: ${dashboard_last}
${cc_warn}
  Run \`/os brief\` for a fuller report.

EOF

# Keep session telemetry fresh: import new transcript usage into events.db
# in the background (idempotent — dedupe is content-addressed). Without this
# the Usage analytics only update when someone clicks Sync (3 days stale at
# the time of the Fable review). Fire-and-forget: the brief prints instantly
# and import output is discarded; chosen over a scheduled runbook because a
# runbook would spawn a whole `claude -p` session to run one node script.
(node scripts/import-session-usage.mjs --all >/dev/null 2>&1 &) || true

# Refresh the CC contract status in the background (fixture + flags tiers;
# the paid live probe is manual-only). The NEXT session's brief surfaces a
# WARN if this finds drift — one-session lag by design, keeps the hook fast.
(node scripts/check-cc-contract.mjs --no-live --status-file .claude/state/cc-contract-status.json >/dev/null 2>&1 &) || true
