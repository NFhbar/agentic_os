# Troubleshooting

Common failure modes by phase, with quick fixes. If you hit something not listed here, file a note via `meta-add-note` (per-install) or open an issue against the OS repo if it's likely to affect others.

## Install (`./install.sh`)

### `✗ node v26.1.0 required (found: v<other>)`

**Cause:** Your active Node version doesn't match `.nvmrc`. The OS pins Node for reproducibility.

**Fix:**

```bash
nvm install $(cat .nvmrc)   # if you use nvm
nvm use
./install.sh
```

If you don't use nvm, download Node from <https://nodejs.org> matching the `.nvmrc` version, then re-run `./install.sh`.

### `✗ claude CLI not found`

**Cause:** Claude Code CLI isn't installed or isn't on `PATH`.

**Fix:** Install from <https://claude.com/claude-code>. After install, verify with `claude --version`. If installed but not found, your shell's `PATH` may need a refresh (`exec $SHELL` or restart the terminal).

### `✗ git not found`

**Cause:** `git` isn't installed. Required for `/os ingest repo` and the `dev-*` skill family.

**Fix:** `brew install git` (macOS) OR install from <https://git-scm.com>.

### `⚠ git identity not fully set`

**Cause:** `git config --global user.name` and/or `user.email` are unset. The OS will run, but `dev-write-change` will fail when committing against your repos.

**Fix:**

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

This is global identity. If your team uses different identities per directory, set per-repo locally instead.

### `npm install` fails with native-module errors (Apple Silicon, sqlite, etc.)

**Cause:** Node-native modules sometimes need rebuilding for your architecture. Most commonly seen with `better-sqlite3` or `node-pty`.

**Fix:**

```bash
rm -rf node_modules domains/meta/app/node_modules
./install.sh
```

If still failing, install Xcode Command Line Tools (`xcode-select --install` on macOS) and retry. Some packages need `python3` + a C compiler available.

### Install completes but `claude` doesn't see the workspace

**Symptom:** You run `claude` in the repo, but `/os` commands aren't available and `CLAUDE.md` doesn't seem loaded.

**Cause:** Claude Code only auto-loads `CLAUDE.md` when invoked from the directory containing it. Make sure you're in the repo root.

**Fix:**

```bash
cd /path/to/agentic_os
claude
```

Verify `CLAUDE.md` is in the working directory: `ls CLAUDE.md`.

## First run / Claude session

### `/os dashboard` fails to open / port in use

**Symptom:** Dashboard tries to launch but errors out, OR launches but the browser shows a connection-refused.

**Cause:** Port 5173 (Vite default) is already in use, or the Fastify backend port is bound.

**Fix:**

```bash
# Find what's using the port
lsof -i :5173
# Kill it, OR launch dashboard on a different port:
cd domains/meta/app && PORT=5174 npm run dev
```

### Dashboard opens but is blank / shows error

**Cause:** Build artifact stale, or `node_modules` missing in `domains/meta/app/`.

**Fix:**

```bash
cd domains/meta/app
rm -rf node_modules dist .vite
npm install
npm run dev
```

### `/os` commands aren't recognized

**Symptom:** Typing `/os brief` in Claude shows the router fallback or "skill not found."

**Cause:** Either `CLAUDE.md` didn't load (see install section), OR your `OS.md` intent vocabulary is missing rows the router expects.

**Fix:**

```bash
node scripts/audit.mjs           # surfaces router-vocab-missing findings
# OR check OS.md exists and has the Intent vocabulary table
grep "^### Intent vocabulary" OS.md
```

## MCP setup

### `MCP auth failed` when running PR/GitHub skills

**Symptom:** `dev-pr-review`, `dev-open-pr`, or `dev-pr-review-publish` surfaces an auth error.

**Cause:** `mcps/github/.env` is missing or `GITHUB_TOKEN` is unset/wrong.

**Fix:**

```bash
cp mcps/github/.env.example mcps/github/.env
# Edit mcps/github/.env, paste a Classic PAT with `repo` scope
# (or fine-grained PAT with PR + contents permissions — see file comments)
```

After editing, restart `claude` so the MCP picks up the new env. Verify with `/mcp` — github MCP should show as connected. Run `node scripts/check-mcp.mjs github` for a CLI-level check.

### PAT scope insufficient

**Symptom:** MCP connects but specific operations 403 (e.g., open-PR fails on a private repo).

**Cause:** Your PAT doesn't have the right scopes.

**Fix:** Visit <https://github.com/settings/tokens>, regenerate with `repo` scope (or fine-grained: Contents read/write + Pull requests read/write). Replace the token in `mcps/github/.env` and restart `claude`.

### `/mcp` shows no MCPs registered

**Cause:** `.mcp.json` is missing or out of sync with `mcps/` directory.

**Fix:**

```bash
node scripts/sync-mcp-config.mjs    # regenerates .mcp.json from mcps/*/manifest.json
```

Restart `claude` after.

### Hosted MCP DCR error: "SDK auth failed: Incompatible auth server"

**Cause:** The vendor's hosted MCP doesn't support OAuth Dynamic Client Registration (RFC 7591). GitHub's hosted MCP is the canonical case.

**Fix:** Use a custom OS-built MCP with PAT auth instead. The shipped `mcps/github/` is exactly that. See `vault/wiki/_seed/meta/decision/decision-github-mcp-custom-not-hosted.md` for context.

## Repo ingestion + change lifecycle

### `dev-write-change` rejects: "repo not ingested"

**Symptom:** Trying to write a change against a repo that isn't known to the OS.

**Cause:** No entity wiki entry exists for the repo.

**Fix:**

```
/os ingest repo https://github.com/your-org/your-app
```

After ingestion completes, retry `/os write-change <change-id>`.

### `dev-open-pr` fails: "Cannot extract owner/name from remote_url"

**Cause:** The repo entity's `remote_url` field doesn't parse as a GitHub URL.

**Fix:** Edit `vault/wiki/<domain>/entity/<repo>.md` and fix the `remote_url` field. Accepted shapes documented in `.claude/skills/dev-open-pr/SKILL.md` § Procedure step 5.

### `dev-close-change` skips branch cleanup: "origin/HEAD not set"

**Cause:** The local clone of the repo doesn't have `origin/HEAD` configured (typical for older clones).

**Fix:** The skill now auto-falls-back in three tiers, but if all three fail:

```bash
git -C /path/to/your/repo remote set-head origin --auto
```

Then re-run `/os close-change <change-id>`.

### PR review publish: "Can not approve your own pull request"

**Symptom:** `dev-pr-review-publish` reports the verdict was auto-downgraded from APPROVE to COMMENT.

**Cause:** GitHub blocks self-approve when the PAT identity matches the PR author. This is expected for single-identity team installs.

**Fix:** None needed — the skill auto-downgrades and surfaces the intended verdict in a banner at the top of the review body. The OS-side entry still records `result: approved`. For true APPROVE events, you'd need bot-account separation (see Task #430 / `decision-distribution-v1-architecture.md` § "Explicitly deferred to v2+").

### Skill seems hung

**Symptom:** A skill dispatch shows in the runs drawer as "running" for many minutes.

**Cause:** Claude is taking time on a complex task (EXECUTE phase on a big change can run 10-20 minutes). Skills don't stream progress to the dashboard until they emit named tool outputs.

**Fix:** Wait. Click the run row in the drawer to see streaming stdout — that's the live signal. If genuinely stuck (no output for 5+ minutes on a small task), the wall-time cap (default 30 min) will eventually SIGTERM it; see the orphan-recognizer UX for diagnosis.

## Vault state

### Tests fail with "dangling wikilink"

**Symptom:** `npm test` shows `wikilink resolution > reports zero dangling wikilinks` failure.

**Cause:** A wiki entry references `[[some-id]]` but no entry with that id exists.

**Fix:** Two options:

1. Create the missing entry (`/os add note` or whatever archetype fits)
2. If the link is intentionally a placeholder (e.g., "for an example like `[[some-future-thing]]`"), add it to `WIKILINK_EXCEPTIONS` in `tests/structural/wikilinks.test.ts` with a one-line reason

### Tests fail with "archetype enum value not in canonical set"

**Cause:** A wiki entry has a `status` or `review_status` value not in the canonical enum (e.g., a typo or an undocumented value).

**Fix:** Either fix the entry's frontmatter, or — if the new value is intentional — add it to `tests/structural/archetype-enums.test.ts` AND to `vault/wiki/_seed/meta/reference/archetype-<type>.md`'s documented set. Both must stay in sync.

### Manifest out of date

**Symptom:** The dashboard shows stale entry counts, OR `/os audit` reports `manifest-stale`.

**Fix:**

```bash
node .claude/hooks/rebuild-vault-index.mjs
```

This is idempotent and safe to run anytime. The hook also runs after most skill dispatches automatically.

### YAML frontmatter parse error

**Symptom:** Manifest rebuild or audit reports a parse error on a wiki entry.

**Cause:** Malformed frontmatter. Common culprits:

- Unquoted strings starting with special chars (`@`, `:`, `[`, etc.)
- Tab indentation (YAML requires spaces)
- Trailing colons without values

**Fix:** Open the entry, repair the frontmatter, re-run the manifest rebuild. The error message names the file + line.

## Commit + CI

### Pre-commit hook fails: "test suite"

**Cause:** A test broke. Pre-commit blocks the commit until the test passes.

**Fix:** The hook re-runs tests with full output on failure. Fix the test (or the code that broke it), re-stage, retry the commit. To bypass for an emergency commit:

```bash
git commit --no-verify -m "..."   # NOT recommended — CI will still catch it
```

### Pre-commit hook fails: "markdown formatting"

**Cause:** A markdown file isn't Prettier-formatted.

**Fix:**

```bash
npm run md:format    # auto-fixes everything
git add -A
git commit ...
```

### CI fails on `npm ci`: "lock file out of sync"

**Cause:** `package-lock.json` was committed against a different npm version than the CI runner has.

**Fix:**

```bash
rm -rf node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "regen package-lock"
```

Repeat for `domains/meta/app/` if the dashboard's lockfile is the one out of sync.

### 1Password Touch ID prompts on every OS-driven commit

**Symptom:** Every commit made by `dev-write-change` triggers a biometric prompt from 1Password's git signing integration.

**Cause:** 1Password signs every commit via SSH key + Touch ID, including the ones the OS makes on your behalf.

**Fix (v1):** No clean fix in the OS yet — this is tracked as Task #402. Workaround: temporarily disable Touch ID on the 1Password SSH agent for the duration of a long-running automation, OR use a non-signing identity for OS-driven commits.

### SSH push fails when key is locked

**Symptom:** `dev-open-pr` or auto-push fails silently when the SSH key isn't loaded into `ssh-agent`.

**Cause:** The OS doesn't currently check key availability before push (Task #404).

**Fix:**

```bash
ssh-add ~/.ssh/id_<your-key>   # unlock the key
```

Then re-dispatch the failing skill.

## Where to get help

- **Inside Claude:** Most skills surface diagnostic hints in their error output. Read the full skill output before debugging — it usually names the file or command to run.
- **Audit panel:** Open the dashboard's Overview, scroll to **Action Items**. Many runtime issues surface here with one-click resolutions.
- **CLI audit:** `node scripts/audit.mjs --json` dumps the full finding set machine-readably.
- **Run logs:** `.claude/state/runs/r_<id>.jsonl` — every skill dispatch's stdout/stderr. Useful for post-mortems.
- **Events.db:** `sqlite3 .claude/state/events.db` — query the structured event log. See `vault/wiki/_seed/meta/reference/standard-event-store.md` for schema.

If you're truly stuck and the OS itself seems broken, the conservative recovery is:

```bash
node .claude/hooks/rebuild-vault-index.mjs    # rebuild manifest
node scripts/sync-mcp-config.mjs              # resync MCP registry
npm test                                       # confirm test suite passes
node scripts/audit.mjs                        # surface any drift
```

If those all clean and you still see weirdness, file an issue against the OS repo with: the error message, the skill that surfaced it, and the run log id.
