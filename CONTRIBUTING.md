# Contributing to the Agentic OS

This is a team-scale agentic operating system — a router (`/os <intent>`), a catalog of skills, a vault of structured knowledge, and a dashboard for observation and dispatch. Contributions come in two flavors: **extending the OS itself** (new skills, domains, archetypes, MCPs) and **using it for product work** (changes against your team's external repos).

This doc is about the first flavor. The second is implicit in how you run `/os` — see `OS.md` and the dashboard for that.

## The contract

Three principles all contributions follow.

1. **Use the meta-\* scaffolders.** When adding a skill, domain, archetype, MCP, or schedule, dispatch the matching `meta-add-*` skill rather than hand-creating files. The scaffolders enforce frontmatter, register entries in the playbook + router vocab, and emit canonical structures. Hand-rolling creates audit drift.
2. **Ship functionality, not artifacts.** The OS code (skills, domains, MCPs, hooks, scripts, dashboard app) is shared via git. Your personal vault (`vault/wiki/<domain>/`, `vault/output/`, `vault/raw/`, `.claude/state/`) is per-install and gitignored. When you contribute to the OS, you're adding code or canonical seed entries — not your day-to-day work artifacts. See `vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md` for the full state model.
3. **Standards are load-bearing.** Anything documented in `vault/wiki/_seed/meta/reference/standard-*.md` is enforced — by tests, audits, or the orchestrator. If your contribution conflicts with a standard, update the standard explicitly (a separate change) rather than working around it silently.

## Adding things

| You want to…                | Dispatch                                                                        | What it does                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a new skill             | `/os add skill <name>`                                                          | Scaffolds `.claude/skills/<name>/SKILL.md` from template, registers in domain playbook (`meta-add-skill-to-playbook`), adds router vocab row (`meta-add-skill-to-router-vocab`). Reads your inputs for `domain`, `intent_phrases`, `description`. |
| Add a new domain            | `/os add domain <name>`                                                         | Creates `domains/<name>/playbook.md`, scaffolds `vault/wiki/<name>/` subdirs, registers in `OS.md`. Sub-domain support via nested folders.                                                                                                        |
| Add an archetype            | `/os add archetype <name>`                                                      | Registers a new wiki entry type. Creates frontmatter contract + entry template + seed reference. The archetype-enums test pulls the canonical set from here.                                                                                      |
| Add an MCP                  | `/os add mcp <id>`                                                              | Two modes: `custom` (scaffolds `mcps/<id>/server.mjs` + manifest + `.env.example`) or `hosted` (registers a vendor endpoint in `.mcp.json`).                                                                                                      |
| Add a schedule              | `/os add schedule <name>`                                                       | Creates a runbook entry with cron + prompt + project scope. The scheduler reads these at startup.                                                                                                                                                 |
| Add a notification template | Hand-author at `vault/wiki/_seed/meta/template/notification-<kind>-<action>.md` | See `standard-template-syntax.md`. Templates are Mustache-style + canonical placeholders (`{{change_id}}`, `{{pr}}`, etc.).                                                                                                                       |

If you find yourself wanting to add something not in this list — that's a meta-evolution. Dispatch `/os evolve` and describe the shape; if the change recurs, eventually it gets its own scaffolder.

## Editing existing things

Skills, domains, and archetypes can be edited directly — they're markdown files. Two conventions:

- **Single source of truth for verdict, comment, or status enums.** If you change a documented enum value, also update `tests/structural/archetype-enums.test.ts` and any deriver that branches on it. The tests fail fast when a value is missing.
- **Update `vault/wiki/_seed/meta/decision/`** when the change reflects a deliberate architectural decision. Records why we chose what we chose — future contributors don't have to re-derive.

For changes against external repos (your team's product code), use the canonical lifecycle: `dev-add-change` → `dev-write-change` (PLAN → REVIEW → EXECUTE) → `dev-open-pr` → `dev-pr-review` → `dev-pr-review-publish` → `dev-close-change`. The dashboard's Changes app drives this end-to-end.

## Review conventions

- **OS-level changes** (changes to this repo): use the OS's own lifecycle — open a PR against the OS repo, request review from a teammate, merge through GitHub. The CI workflow runs lint + tests on every PR.
- **Skill changes**: skill prose is the contract. Test thoroughly — dispatch the skill against a test case and verify behavior before merging. Skills can have subtle non-deterministic effects when SKILL.md is ambiguous; explicit rules beat clever defaults.
- **Standards changes** (anything in `vault/wiki/_seed/meta/reference/standard-*.md`): require a one-line decision rationale in the PR description. These shape downstream code; the rationale lives forever.
- **Archetype changes**: bump `archetype-enums.test.ts` in the same PR. CI fails otherwise.

## Testing expectations

Run before opening a PR:

```bash
npm test                                       # 840+ structural + unit tests
cd domains/meta/app && npx tsc --noEmit       # typecheck the dashboard app
node .claude/hooks/rebuild-vault-index.mjs    # rebuild manifest (idempotent)
```

The pre-commit hook (`.git/hooks/pre-commit`, symlinked to `scripts/git-hooks/pre-commit` by `install.sh`) runs these automatically. CI runs them on every PR.

Tests are in two tiers:

- **Tier 1** (`tests/unit/`): pure-function tests against extracted modules. Add when you extract a pure helper (e.g. state machine, deriver, parser).
- **Tier 2** (`tests/structural/`): integrity tests against the live vault (skill frontmatter, wiki link resolution, archetype enums). Add when a new invariant could silently drift.

See `vault/wiki/_seed/meta/reference/standard-testing.md` for the test/audit decision matrix.

## What ships vs what stays local

| Tracked in git (ships with the OS)                   | Gitignored (per-install)                             |
| ---------------------------------------------------- | ---------------------------------------------------- |
| `.claude/skills/`                                    | `.claude/state/` (events.db, runs, dismissals)       |
| `.claude/hooks/`                                     | `.claude/settings.local.json`                        |
| `domains/` (playbooks, apps, MCPs)                   | `vault/wiki/<domain>/` (your personal vault entries) |
| `mcps/` (server code + `.env.example`)               | `mcps/*/.env`, `domains/*/app/.env`                  |
| `scripts/`                                           | `vault/raw/`, `vault/output/`, `vault/.index/`       |
| `vault/wiki/_seed/` (canonical reference content)    | `repos/` (ingested external repos)                   |
| `_templates/`                                        | `node_modules/`, `dist/`, `*.log`                    |
| `OS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md` |                                                      |
| `tests/`, `package.json`, `install.sh`, `.gitignore` |                                                      |

The `_seed/` boundary is load-bearing: anything under `vault/wiki/_seed/` ships as canonical reference (archetypes, standards, decisions, example entries). Anything elsewhere in `vault/wiki/` is your working state.

## Dependencies

- **Node** — version pinned in `.nvmrc` (currently v26); the dashboard app + scripts require it
- **GitHub PAT** — for the github MCP (PR review, open-PR, etc.). Set `GITHUB_TOKEN` in `mcps/github/.env` (copy from `.env.example`)
- **Optional Slack** — for notification delivery. See `domains/meta/app/.env.example` for the env shape (the vault MCP is read-only and needs no secrets)
- **Claude Code** — the harness that runs skills. Install separately; `scripts/check-cc-contract.mjs` verifies your CLI version exposes the dispatch contract (`--effort`/`--model`, stream-json result fields)

`./install.sh` handles `npm install` + manifest rebuild + initial vault scaffolding + per-surface `.env` scaffolds, applies any pending data migrations, and offers two opt-in steps: headless commit signing (`dev-setup-repo-identity` across your ingested repos) and the launchd scheduler. Run it after cloning; it's idempotent.

## Upgrading

When the OS core ships new versions, teams pull the updates into their fork. The compatibility contract (versioning policy + what's guaranteed across versions) lives at [`vault/wiki/_seed/meta/reference/os-version.md`](vault/wiki/_seed/meta/reference/os-version.md). The changelog at [`CHANGELOG.md`](CHANGELOG.md) records what shipped in each version, including any required actions.

### The upgrade dance

```bash
# 1. Pull upstream
git remote add upstream <core-os-repo-url>   # one-time, if not already added
git fetch upstream
git merge upstream/main                       # or: git rebase upstream/main

# 2. Resolve any conflicts (see § Where conflicts land below)

# 3. Re-run install (idempotent — picks up new deps, applies vault data migrations, regenerates manifest, refreshes hooks)
./install.sh

# 4. Verify the install
npm test
node scripts/audit.mjs    # surfaces any drift

# 5. Read the CHANGELOG for the version range you just pulled — any required actions?
```

For loose tracking, teams stay on `main` and pull periodically. For strict control, teams pin to a specific tag or SHA and update deliberately:

```bash
git checkout v0.5.0      # pin to release tag
git checkout <sha>       # pin to specific commit
```

### Where conflicts land

When you pull updates, conflicts are most likely in:

- **`OS.md`** (router vocabulary table) — teams add custom skills here; core might also add new core skills. Resolution: keep both, ordered by the table's existing grouping.
- **`domains/<your-domain>/playbook.md`** (Skills section) — same shape as OS.md vocabulary; keep both.
- **`.claude/skills/<name>/SKILL.md`** when a core skill gets revised AND your team has local edits to it. Resolution: either re-apply your edits on top of upstream, OR fork the skill into a team-named variant (`acme-write-change` shadowing `dev-write-change`) and ignore upstream updates to the original.
- **`vault/wiki/_seed/meta/reference/standard-*.md`** when a team has overridden a core standard. Same resolution pattern as skills.
- **`CLAUDE.md`** — should NOT conflict if your customizations stay inside the `<!-- team-config-start --> ... <!-- team-config-end -->` markers. If they don't, move them inside before next pull.

If the CHANGELOG documents a major-version bump, read it carefully — it'll name the specific schemas / files / behaviors that changed and what action your team needs to take.

### What's guaranteed across versions

Within a major version (e.g., 0.x.y → 0.x+1.y), teams can pull with confidence that:

- No skill they were using has been removed (skills deprecated for one minor before removal)
- No archetype field has changed shape (additive only)
- No event store schema migration required (additive only)
- No notification template variable removed
- Existing wiki entries continue to load and render

Across major versions, the CHANGELOG explicitly names what changed and the migration steps required. Major bumps are rare and discussed in advance via decision entries.

### Versioning your team's customizations

If your team customizes heavily, consider a brief decision entry recording your team's compatibility position — what core version you're on, what you've customized, why. Lives at `vault/wiki/meta/decision/decision-team-customizations-<topic>.md` (per-install, gitignored from upstream perspective).

When you pull a new core version, that decision entry becomes the reference for "what we need to re-verify after this merge."

## Filing findings (bugs / improvements)

For findings about the OS itself, use the dashboard's Add Note quick-action (`meta-add-note`) — note lands at `vault/wiki/meta/note/` per-install. If the finding is shareable (a real bug, a feature gap that affects all teams), open an issue against the OS repo on GitHub.

The audit panel (`/os audit` or the dashboard's Action Items card) surfaces ongoing drift — dangling wikilinks, missing skills in playbook, recurring no-op events. Many findings have one-click Accept buttons that dispatch the resolving skill automatically (see `decision-distribution-v1-architecture.md` for the design).

## See also

- `README.md` — install + first-run
- `OS.md` — full intent vocabulary + domain map
- `CLAUDE.md` — per-install Claude Code behavioral overrides
- `vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md` — why the OS is shaped this way
- `vault/wiki/_seed/meta/reference/` — all the load-bearing standards
- `domains/meta/playbook.md` — the meta-domain's full skill catalogue
