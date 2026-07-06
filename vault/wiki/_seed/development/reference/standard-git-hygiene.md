---
id: standard-git-hygiene
type: reference
domain: development
created: 2026-05-21T23:55:00Z
updated: 2026-07-05T23:41:44Z
tags: [standard, git, branching, commits, conventions]
source: manual
private: false
title: Git hygiene standard
url: internal://standard/git-hygiene
kind: doc
last_verified: 2026-05-21
---

# Git hygiene standard

Universal git workflow conventions for every code change. Repo-specific overrides (e.g. trunk-based vs git-flow, specific commit prefixes, signed commits) live in the repo's entity entry under `## Conventions` and take precedence where they conflict.

Consumed by [[dev-write-change]] EXECUTE phase (which actually creates branches + makes commits) and [[dev-review-change]] (which checks the plan's git steps for hygiene).

## 1. Pre-branch state — working tree must be clean

Before creating a branch for a change, the working tree at `entity.local_path` MUST be clean:

```bash
git -C <local_path> status --porcelain
```

If output is non-empty, the EXECUTE phase MUST abort with a specific message identifying the dirty files, and ask the user to handle them (commit, stash, or discard) before re-running. Do NOT auto-stash — losing the user's in-progress work is worse than the delay.

The pre-branch check also verifies:

- Currently on `entity.default_branch` (typically `main` or `master`) — if not, abort with the current branch
- Latest from origin pulled: `git -C <local_path> fetch origin && git -C <local_path> pull --ff-only origin <default_branch>` — abort on merge conflict, never auto-merge

## 2. Branch creation

Once preconditions pass:

```bash
git -C <local_path> checkout -b <branch>
```

The branch name comes from the change entry's `branch:` field. If a branch with that name already exists locally or on origin:

- If local + same SHA as default branch → switch to it (continuing prior work)
- If local + diverged → abort, ask user to resolve manually
- If on origin → abort with a hint to use a new branch name or sync first

## 3. Branch naming conventions

> **Repo conventions always take precedence.** If the repo entity entry's `## Conventions` section specifies a different branch shape (ticket-id-first, etc.), use that instead. The defaults below apply only when the repo has no override.

Branch names follow the **semantic-release / Angular convention**:

```
<type>/<task_description>
<type>/<issue_number>/<task_description>
```

Where `<type>` is one of:

| type       | meaning                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `feat`     | New feature for the user                                               |
| `fix`      | Bug fix for the user                                                   |
| `docs`     | Documentation changes (README, LICENSE, CHANGELOG, comments-only docs) |
| `style`    | Formatting, missing semicolons, whitespace — no behavior change        |
| `refactor` | Refactoring production code — no behavior change                       |
| `test`     | Adding missing tests, refactoring tests — no production-code change    |
| `chore`    | Updating build tools, CI config, dep bumps — nothing user-facing       |

**Examples:**

```
git checkout -b feat/double-shield-strength
git checkout -b fix/#1234/ammo-counter
git checkout -b docs/add-license
git checkout -b chore/bump-eslint-v9
```

**`<task_description>`** is kebab-case, derived from the change entry's `name` (slug). When an issue tracker reference exists, embed it as `#<number>` between the type and the description.

**The change entry's `branch:` field is authoritative** — if it's set when EXECUTE runs, use that verbatim. The OS's `dev-add-change` computes a default branch by selecting a `type` (from explicit input or by inferring from the title — see [[dev-add-change]] procedure) and assembling `<type>/<slug>` or `<type>/#<issue>/<slug>`.

**`agent/` is no longer used** as a default prefix — every change maps to one of the seven types above.

## 4. Commits

Commit messages follow the **semantic-release / Angular Commit Message Conventions**. The commit's `<type>` determines the release bump:

| commit example                                                                                                         | release type           |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `fix(pencil): stop graphite breaking when too much pressure applied`                                                   | **Patch** (e.g. 1.2.4) |
| `feat(pencil): add 'graphiteWidth' option`                                                                             | **Minor** (e.g. 1.3.0) |
| `perf(pencil): remove graphiteWidth option`<br>`<br>`<br>`BREAKING CHANGE: The graphiteWidth option has been removed.` | **Major** (e.g. 2.0.0) |

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

- `<type>` — one of: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`, `ci`, `revert`. Matches the branch's `<type>` for the primary commit on a branch.
- `<scope>` — optional. The area touched (e.g. `pencil`, `api`, `auth`). Omit if the change cuts across.
- `<subject>` — imperative present tense ("Add retry logic" not "Added"/"Adds"). No trailing period. Lowercase.
- `<body>` — explains **why**, not what. Wrap at 72 chars. Optional, but encouraged for non-trivial changes.
- `<footer>` — `BREAKING CHANGE: <description>` for breaking changes (triggers major release). Also where the change-entry reference goes: `refs: vault/wiki/<domain>/change/<slug>.md`.

### Rules

- **One logical change per commit.** Multiple commits per branch when there are natural boundaries ("add the new function" + "wire it into the call site" + "add tests"). Don't squash everything; don't fragment unrelated edits either.
- **Subject ≤ 72 chars.** Hard limit to keep `git log --oneline` scannable.
- **BREAKING CHANGE footer is load-bearing.** Any commit with this footer triggers a major version bump under semantic-release. Use deliberately.
- **No `--no-verify`** to bypass hooks. If a hook fails, fix the underlying issue. If the hook is genuinely wrong, raise it as a §Risk in the plan rather than silently bypassing.
- **Match repo's commit history** if the repo predates these conventions or uses a different format. The repo's entity `## Conventions` section captures the override.

## 4a. Identity — who's authoring + pushing + opening the PR

Three identities are involved in landing a change, and they must all be the same person:

| identity             | source                                                                                                                                            | who it is in practice                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Commit author**    | `git config user.name` + `user.email` (per-repo preferred over global) — recorded on every commit by `dev-write-change` EXECUTE                   | the human running the OS                    |
| **Push credentials** | SSH key (resolved via `~/.ssh/config` host-alias mapping) or PAT in the credential helper for HTTPS remotes — used by `git push` in `dev-open-pr` | same human, via their `~/.ssh/config` entry |
| **PR opener**        | The authenticated user behind the `github` MCP — for the hosted MCP, whoever ran `/mcp` and completed OAuth; for a custom MCP, the PAT owner      | same human, via Claude Code's MCP auth      |

If these diverge, you get pathologies like: commits attributed to the wrong person, PR opened by a service account that doesn't have write to your branch, push rejected because the SSH alias points at a different key than the remote URL expects.

### Multi-account setup (personal + work)

When the same machine pushes to repos owned by different identities, configure **per-repo** `user.email` and **host-aliased** SSH keys:

```bash
# Personal repo
git -C ~/code/personal/api config user.name "Jane Doe"
git -C ~/code/personal/api config user.email "jane@personal.example"

# ~/.ssh/config maps github.com-personal → ~/.ssh/id_personal
# The repo's remote uses: git@github.com-personal:jane/api.git
```

The combo of per-repo `user.email` + a custom SSH host alias keeps the three identities aligned for that specific repo.

### Headless signing for automation (dedicated signing-only key)

Automated lifecycles ([[dev-write-change]] EXECUTE / ADDRESS-COMMENTS) commit with no human at the keyboard. Two failure modes observed live (2026-06-12) block them at the commit/push step:

1. **Agent-managed signing key prompts or locks.** When `gpg.ssh.program` points at an agent binary (e.g. 1Password's `op-ssh-sign`), a locked vault or a mid-update agent fails headless commits with `error: agent returned an error`.
2. **GH007 email-privacy push block.** GitHub rejects pushes whose commits carry the account's real email while "Block command line pushes that expose my email" is enabled.

The counter-pattern (configured by [[dev-setup-repo-identity]], offered across ingested repos by install.sh's optional signing step):

- A dedicated **passphrase-less ed25519 signing-only key** on disk (default `~/.ssh/agentic_os_signing`) — no agent in the signing path, so commits never prompt.
- The four **repo-local** config values: `user.signingkey <pub path>`, `gpg.ssh.program ssh-keygen`, `gpg.ssh.allowedSignersFile <signers path>`, `user.email <id>+<login>@users.noreply.github.com`. On machines whose inherited `gpg.format` / `commit.gpgsign` are wrong for silent SSH signing, those two are additionally set — also repo-local.
- The public key registered on GitHub as a **Signing Key** — not an Authentication Key.

**The security trade, stated plainly:** a passphrase-less key on disk means anyone with read access to the disk can produce signatures that verify as yours for these repos. It is bounded: a signing-only registration cannot authenticate or push; revocation is one click (GitHub → Settings → SSH and GPG keys); scope is per-repo opt-in. Accept the trade deliberately — it is what makes silent signing for automation possible at all.

**Rotation is manual:** delete the key pair (`~/.ssh/agentic_os_signing` + `.pub`), re-run [[dev-setup-repo-identity]] to generate + configure a fresh key, register the new public key on GitHub — and hand-prune the old key's line from `agentic_os_allowed_signers`. Nothing prunes that file automatically; a stale entry keeps old-key signatures verifying locally indefinitely.

**Never-touch-global rule:** every write is repo-local (`git -C <repo> config <key> <value>`). Global git config is never modified, so the operator's interactive setup — e.g. 1Password-managed signing for human commits — keeps working in every other repo on the machine.

**SSH authentication posture** — signing is headless by construction; authentication is a separate, documented choice:

- **(a) Prompt-per-session (recommended default):** keep the agent-managed auth key and enable the agent's "remember approval" setting — one human checkpoint per sitting. Automated lifecycles generate many pushes/pulls per session, so per-use prompting is untenable; per-session approval keeps a human in the loop.
- **(b) Fully headless dedicated auth key:** zero prompts. Blast radius stated plainly: auth keys can push. Reserve for routine unattended driving.

### Skill enforcement

[[dev-open-pr]] verifies the git side before pushing:

- `git config user.name` and `user.email` are set (per-repo or global). **Fails** the skill if either is unset (pushing without an identity is a foot-gun).
- The HEAD commit's author email matches the configured `user.email`. **Warns** if mismatched (could be intentional, e.g. a rebase from another machine) but proceeds.
- On the GitHub side, the MCP response includes the PR opener's `user.login` — the skill surfaces it in the success report so any divergence from the commit author is visible.

The skill cannot directly verify the push credentials match the commit author (that lives in SSH config / credential helper / token), but a mismatch surfaces immediately as either a push rejection ("Permission denied") or as a PR opened by the wrong GitHub user. Both are visible in the skill's report.

## 5. Pushing + PR opening

When the change is ready to open a PR:

```bash
git -C <local_path> push -u origin <branch>
```

Then open the PR — preferred path is the `github` MCP (via [[dev-open-pr]]), which both pushes the branch and creates the PR in one skill invocation.

**PR title + body composition is governed by [[standard-pr-description]]** — that standard owns the precedence rules:

- **Title**: explicit `pr_title:` frontmatter on the change → already-conventional `change.title` → inferred `<type>(<scope>): <description>` from the branch prefix + change fields. Always conforms to the same semantic-release type set as commits (`feat | fix | docs | style | refactor | perf | test | chore | build | ci | revert`).
- **Body**: repo's `.github/pull_request_template.md` (or equivalents) if present, otherwise the OS default `# what / # why / # tests` structure.

**After PR opens**, the skill writes back `pr_url:` to the change entry's frontmatter and transitions `status: in-progress → in-review`. The skill also captures a CI snapshot (single read, no polling) and includes it in the success report — `dev-open-pr` does not block on CI.

## 6. Working with the change-entry state machine

The git operations map to the [[standard-change-workflow]]'s state machine:

| state transition            | git operation                                 |
| --------------------------- | --------------------------------------------- |
| `planning` → `in-progress`  | branch created, commits made, tests passing   |
| `in-progress` → `in-review` | branch pushed, PR opened, `pr_url:` populated |
| `in-review` → `merged`      | PR merged on the host (external action)       |
| `(any)` → `abandoned`       | branch deleted locally + remotely if pushed   |

The EXECUTE phase of `dev-write-change` handles the first transition. The (future) `dev-open-pr` handles the second. The (future) `dev-close-change` handles the merged + abandoned cases.

## 7. Recovery / aborts

If EXECUTE fails mid-flight (tests fail, edit conflicts, etc.):

- Leave the branch in place — do NOT auto-delete. The user inspects the partial state.
- Write the execution log to `vault/output/<domain>/changes/<slug>-execution-log.md` per [[dev-write-change]] Step 4's failure path.
- The user decides: fix manually + retry the test_command, abandon (branch deleted + change marked abandoned), or re-plan (capture new context, fresh plan goes through review again).

## 8. Repo-specific overrides

Some repos diverge from these defaults. Capture overrides in the entity entry's `## Conventions` section:

- Different branch prefix scheme (e.g. ticket-id-first like `JIRA-1234-add-thing`)
- Signed commits required
- Trunk-based dev (short-lived branches, fast merge)
- Squash-merge policy on PRs (affects how the writer should structure commits)
- Specific PR template the repo uses

When the entity entry conflicts with this standard, the entity wins.

## See also

- [[standard-code-quality]] — code-shape side of change quality (the WHAT to commit; this standard covers the HOW)
- [[standard-change-workflow]] — the change lifecycle this serves
- [[dev-write-change]] — consumer (EXECUTE phase implements this)
- [[dev-review-change]] — consumer (checks plan's git steps)
- [[archetype-entity]] — where repo-specific overrides live
