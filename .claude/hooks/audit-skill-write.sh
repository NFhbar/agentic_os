#!/usr/bin/env bash
# PostToolUse on Write|Edit. When the change touched a `.claude/skills/<name>/SKILL.md`,
# run scripts/audit.mjs and surface any warn/error findings that mention the
# skill's name (in the finding's path, message, or hint). Surfaces to stderr
# so the author sees them in the same Claude Code session instead of via
# the dashboard health card later.
#
# Quiet on success. Errors swallowed — never block a write.
#
# Catches the common drift modes from skipping meta-add-skill:
#   - wiki-link-dangling (the SKILL.md references a non-existent [[wikilink]])
#   - playbook-skill-coverage (skill not listed in domains/<domain>/playbook.md)
#   - router-vocab-skill-uncovered (skill not in OS.md's intent vocab)
set -euo pipefail

event=$(cat)
file_path=$(printf '%s' "$event" | sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$file_path" ]; then exit 0; fi

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

case "$file_path" in
  "$repo_root"/.claude/skills/*/SKILL.md) ;;
  *) exit 0 ;;
esac

# Extract the skill name from the path:
#   <repo_root>/.claude/skills/<name>/SKILL.md  →  <name>
relpath="${file_path#$repo_root/.claude/skills/}"
skill_name="${relpath%%/*}"

if ! command -v node >/dev/null 2>&1; then exit 0; fi

# Run the audit (JSON output) and pipe through a node filter that selects only
# findings whose path/message/hint mentions THIS skill. Keeps the surface focused
# on what the just-completed write actually broke.
output=$(node "$repo_root/scripts/audit.mjs" --json 2>/dev/null \
  | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const name = process.argv[1];
const hits = (data.findings || []).filter(f =>
  (f.severity === 'warn' || f.severity === 'error') &&
  ((f.message || '').includes(name) ||
   (f.path || '').includes(name) ||
   (f.hint || '').includes(name))
);
for (const f of hits) {
  const sev = (f.severity || '').padEnd(5);
  const id = (f.id || '').padEnd(32);
  const msg = (f.message || '').trim().slice(0, 120);
  console.log('  ' + sev + ' ' + id + ' ' + msg);
  if (f.hint) console.log('        → ' + f.hint.slice(0, 120));
}
" "$skill_name" 2>/dev/null || true)

if [ -n "$output" ]; then
  printf '\n⚠ audit findings for skill `%s` (after writing .claude/skills/%s):\n%s\n\n' \
    "$skill_name" "$relpath" "$output" >&2
fi
