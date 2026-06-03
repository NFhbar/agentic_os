#!/usr/bin/env bash
# Install the Agentic OS scheduler as a launchd LaunchAgent (macOS).
# Renders _templates/launchagent.plist.tmpl with absolute paths, drops it in
# ~/Library/LaunchAgents, and loads it via launchctl.
#
# Idempotent: re-running unloads + reloads so an updated tick script picks up
# the new path (the script path itself rarely changes — paths inside the
# plist do not — but reload is cheap insurance).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✗ install-scheduler.sh only supports macOS launchd (found: $(uname -s))."
  echo "  Linux/cron support is on the roadmap — for now, run scripts/scheduler-tick.mjs"
  echo "  manually from your own cron with a 'every minute' schedule."
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${REPO_ROOT}/_templates/launchagent.plist.tmpl"
PLIST_NAME="com.agentic-os.scheduler.plist"
DEST_DIR="${HOME}/Library/LaunchAgents"
DEST="${DEST_DIR}/${PLIST_NAME}"

if [[ ! -f "${TEMPLATE}" ]]; then
  echo "✗ template missing: ${TEMPLATE}"
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "✗ node not on PATH. Activate the right node version (see .nvmrc) before installing the scheduler."
  exit 1
fi

mkdir -p "${DEST_DIR}"

# Render template — replace {{node_bin}}, {{repo_root}}, {{path_env}}.
# Use awk so paths containing slashes don't trip up sed.
awk \
  -v node_bin="${NODE_BIN}" \
  -v repo_root="${REPO_ROOT}" \
  -v path_env="${PATH}" \
  '{
     gsub(/\{\{node_bin\}\}/, node_bin)
     gsub(/\{\{repo_root\}\}/, repo_root)
     gsub(/\{\{path_env\}\}/, path_env)
     print
   }' "${TEMPLATE}" > "${DEST}"

echo "✓ wrote ${DEST}"

# Reload to pick up any path changes.
launchctl unload "${DEST}" 2>/dev/null || true
launchctl load "${DEST}"
echo "✓ launchctl loaded ${PLIST_NAME}"

echo ""
echo "The scheduler will tick every 60s. Logs:"
echo "  ${REPO_ROOT}/.claude/state/scheduler.out.log"
echo "  ${REPO_ROOT}/.claude/state/scheduler.err.log"
echo ""
echo "To stop: launchctl unload ${DEST}"
echo "To uninstall: launchctl unload ${DEST} && rm ${DEST}"
