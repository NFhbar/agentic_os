#!/usr/bin/env bash
# Agentic OS installer — verifies prerequisites, installs dashboard deps,
# stamps the install marker so SessionStart can detect first-run.
set -euo pipefail

cd "$(dirname "$0")"

echo "→ Verifying prerequisites..."

if [ ! -f .nvmrc ]; then
  echo "  ✗ .nvmrc not found at repo root. The OS pins its node version there."
  exit 1
fi

required=$(tr -d 'v[:space:]' < .nvmrc)

# If nvm is available, try to activate the pinned version automatically.
if [ -z "${NVM_DIR-}" ]; then NVM_DIR="$HOME/.nvm"; fi
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node not found."
  echo "    The OS pins v${required} via .nvmrc. Install it:"
  echo "      nvm install ${required} && nvm use"
  echo "    Or download from https://nodejs.org and re-run ./install.sh"
  exit 1
fi

current=$(node -v | tr -d 'v\n')
if [ "$required" != "$current" ]; then
  echo "  ✗ node v${required} required (found: v${current})"
  echo "    Run from this directory:"
  echo "      nvm install ${required}"
  echo "      nvm use"
  echo "    Or install v${required} from https://nodejs.org and re-run ./install.sh"
  exit 1
fi

echo "  ✓ node v${current} (matches .nvmrc)"

if ! command -v claude >/dev/null 2>&1; then
  echo "  ✗ claude CLI not found. Install from https://claude.com/claude-code"
  exit 1
fi
echo "  ✓ claude CLI installed"

# git is required for /os ingest repo (clones external repos) and for any
# dev-write-change / dev-open-pr workflow against the user's product repos.
if ! command -v git >/dev/null 2>&1; then
  echo "  ✗ git not found."
  echo "    Required for /os ingest repo and the dev-* skill family."
  echo "    Install from https://git-scm.com or via Homebrew (brew install git)."
  exit 1
fi
echo "  ✓ git installed"

# Git identity check — warn-only (the OS itself doesn't need git locally for
# this repo, but dev-write-change will fail when committing against the user's
# product repos if identity is unset).
git_name=$(git config --global user.name 2>/dev/null || echo "")
git_email=$(git config --global user.email 2>/dev/null || echo "")
if [ -z "$git_name" ] || [ -z "$git_email" ]; then
  echo "  ⚠ git identity not fully set (user.name='${git_name}', user.email='${git_email}')"
  echo "    dev-write-change will fail when committing against your repos."
  echo "    Set with:"
  echo "      git config --global user.name 'Your Name'"
  echo "      git config --global user.email 'you@example.com'"
else
  echo "  ✓ git identity: ${git_name} <${git_email}>"
fi

echo ""
echo "→ Installing root tooling (Prettier for markdown)..."
if [ -f "package.json" ]; then
  npm install --silent
  echo "  ✓ root deps installed"
fi

echo ""
echo "→ Installing dashboard dependencies..."
if [ -d "domains/meta/app" ] && [ -f "domains/meta/app/package.json" ]; then
  ( cd domains/meta/app && npm install --silent )
  echo "  ✓ dashboard deps installed"
else
  echo "  ⊘ dashboard not yet scaffolded — skipping (will install on first build)"
fi

echo ""
echo "→ Stamping install marker..."
mkdir -p .claude/state
date -u +"%Y-%m-%dT%H:%M:%SZ" > .claude/state/installed-at
echo "  ✓ .claude/state/installed-at"

echo ""
echo "→ Initializing empty state files..."
: > .claude/state/pending-curation.txt
mkdir -p vault/raw vault/.index
: > vault/raw/router-log.jsonl
: > vault/raw/dashboard-actions.jsonl
echo '{"version":1,"generated":null,"entries":[]}' > vault/.index/manifest.json
echo "  ✓ state files initialized"

echo ""
echo "→ Initializing event store (.claude/state/events.db)..."
# Telemetry layer — see vault/wiki/_seed/meta/reference/standard-event-store.md
node scripts/events-db-init.mjs >/dev/null
# Backfill is a no-op on a fresh clone (JSONL files just touched); on a
# re-install over existing data it harmlessly idempotently seeds any new rows.
node scripts/events-db-backfill.mjs >/dev/null
echo "  ✓ events.db ready"

echo ""
echo "→ Syncing MCP config (.mcp.json)..."
# Merges any OS-built MCPs (mcps/<id>/manifest.json) into .mcp.json. Preserves
# third-party / hosted rows. Idempotent — see standard-mcp-architecture.md.
node scripts/sync-mcp-config.mjs >/dev/null
echo "  ✓ .mcp.json in sync"

echo ""
echo "→ Scaffolding MCP env files..."
# For each OS-built MCP with an .env.example template, copy to .env if missing.
# Secrets (PATs, API keys) stay empty — user fills them in before first use.
# scripts/check-mcp.mjs catches missing secrets at skill pre-flight time.
for mcp_dir in mcps/*/; do
  [ -d "$mcp_dir" ] || continue
  if [ -f "${mcp_dir}.env.example" ] && [ ! -f "${mcp_dir}.env" ]; then
    cp "${mcp_dir}.env.example" "${mcp_dir}.env"
    echo "  ✓ ${mcp_dir}.env scaffolded — edit to add secrets"
  fi
done

echo ""
echo "→ Scaffolding app env files..."
# Per standard-env-config: each app server has its own .env, loaded by
# server/load-env.ts at boot. Mirror the MCP pattern — copy .env.example to
# .env if missing. The dashboard reads SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL
# from this file for notification delivery; GITHUB_TOKEN for server-side
# GitHub calls.
for app_env_example in domains/*/app/.env.example; do
  [ -f "$app_env_example" ] || continue
  app_env="${app_env_example%.example}"
  if [ ! -f "$app_env" ]; then
    cp "$app_env_example" "$app_env"
    echo "  ✓ ${app_env} scaffolded — edit to add secrets"
  fi
done

echo ""
echo "→ Installing git pre-commit hook..."
# Wire scripts/git-hooks/pre-commit into .git/hooks/pre-commit so every commit
# runs the same checks CI runs (manifest rebuild + typecheck + tests + format).
# Uses a symlink so updates to scripts/git-hooks/pre-commit take effect
# automatically — no re-install needed.
if [ -d .git ]; then
  hook_dest=".git/hooks/pre-commit"
  hook_src="../../scripts/git-hooks/pre-commit"
  if [ -L "$hook_dest" ] || [ -f "$hook_dest" ]; then
    # Preserve any existing hook the user installed manually — print a note
    # rather than clobbering. They can rm + re-run install.sh to refresh.
    echo "  ⊘ $hook_dest already exists — skipping (rm + re-run to refresh)"
  else
    ln -sf "$hook_src" "$hook_dest"
    chmod +x scripts/git-hooks/pre-commit
    echo "  ✓ $hook_dest → $hook_src (symlink)"
  fi
else
  echo "  ⊘ .git/ not found — skipping (run \`git init\` first, then re-run install.sh)"
fi

echo ""
echo "→ Scheduler (optional)..."
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "  Install the launchd agent that ticks scheduler-tick.mjs every 60s?"
  echo "  This enables seeded schedules (morning brief, weekly curation check)"
  echo "  and any future schedules to fire automatically."
  read -r -p "  Install scheduler now? [y/N] " ans
  if [[ "${ans}" =~ ^[Yy]$ ]]; then
    ./scripts/install-scheduler.sh
  else
    echo "  ⊘ skipped — run ./scripts/install-scheduler.sh later to enable"
  fi
else
  echo "  ⊘ macOS only in v1 — see scripts/scheduler-tick.mjs for manual cron"
fi

echo ""
echo "✓ Agentic OS installed."
echo ""
echo "Next steps:"
echo "  1. Configure your GitHub PAT in mcps/github/.env (see header comments)"
echo "  2. (Optional) Enable Slack notifications: set SLACK_BOT_TOKEN or"
echo "     SLACK_WEBHOOK_URL in domains/meta/app/.env (see file comments for"
echo "     bot-token vs webhook tradeoffs). Skip to ignore notifications."
echo "  3. Run \`claude\` from this directory"
echo "  4. Try /os brief"
echo "  5. Try /os dashboard"
