---
name: dev-setup-repo-identity
description: 'Configure a repo for headless commit signing — dedicated signing-only ed25519 key, repo-local git config (never global), allowed-signers maintenance, GitHub Signing-Key handoff. Idempotent per-repo; wraps scripts/setup-repo-identity.mjs.'
user-invocable: true
recommended_effort: medium
version: 1
domain: development
tags: [git, signing, identity, headless, automation]
inputs:
  repo:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Repo entity id. Must match an existing entity entry with kind=repo.'
  email:
    type: string
    required: false
    description: 'Noreply email override (<id>+<login>@users.noreply.github.com). When omitted, the script reuses the repo''s effective user.email only if it is already noreply-form; otherwise user.email is left unset and lookup instructions are printed.'
spawns: []
---

# dev-setup-repo-identity

## Purpose

Make one repo automation-ready at the commit/push step. Two live walls block headless lifecycles: an agent-managed signing key that prompts or locks (`agent returned an error` on headless commits) and GitHub's email-privacy push block (GH007). This skill configures the proven counter-setup — a dedicated passphrase-less ed25519 **signing-only** key plus repo-local git config (`user.signingkey`, `gpg.ssh.program ssh-keygen`, `gpg.ssh.allowedSignersFile`, noreply `user.email`) — and hands the operator the exact GitHub registration steps.

Idempotent: re-runs converge (key reused, config values skipped when already set, signers entry deduped by key blob). Every git write is repo-local scope — the operator's interactive setup (e.g. 1Password-managed signing for human commits) keeps working in every other repo. See [[standard-git-hygiene]] § 4a "Headless signing for automation" for the pattern and the security trade.

## Procedure

1. **Validate the repo entity.** Read `vault/wiki/<domain>/entity/<repo>.md` (search across domains if needed; parse via js-yaml). Reject with specific messages:
   - Entry missing → `repo entity "<repo>" not found — run /os ingest repo first (see [[dev-ingest-repo]])`
   - `kind != repo` → `entity "<repo>" is kind=<kind>, expected kind=repo`
   - `local_path` unset or not on disk → `entity "<repo>" has no usable local_path (<value>) — re-ingest or fix the entry`
2. **Resolve the email argument.** Precedence: `inputs.email` when provided → otherwise let the script auto-detect (it reuses the repo's effective `user.email` only when it already matches the noreply shape `<id>+<login>@users.noreply.github.com`; anything else stays unresolved and the script prints lookup instructions). **Never derive the identity from the gh CLI** (`gh api user` or similar) — gh may be authenticated as a different GitHub account than the repo owner (observed live on this install), which would silently configure the wrong identity.
3. **Run the setup script** and relay its full report (per-repo results + public key + handoff instructions) to the user:
   ```bash
   node scripts/setup-repo-identity.mjs --repo-path <local_path> [--email <email>]
   ```
4. **Verify the config landed.** The script's report enumerates every config key it wrote or found already set (the `config:` lines). Read back **each key named in that report** with `git -C <local_path> config --local --get <key>` — not a fixed list: on fresh machines the report includes `gpg.format` / `commit.gpgsign`, and that path is precisely where silent signing is most likely to be misconfigured. Surface any mismatch between the script's report and the read-back as an error — do not silently proceed.
5. **Print the handoff block** (the script emits it; make sure it reaches the user, don't swallow it):
   - The public key line, with the GitHub registration steps: Settings → SSH and GPG keys → New SSH key → key type **Signing Key** — not Authentication Key.
   - The noreply-email lookup instructions when the email stayed unresolved (GitHub → Settings → Emails).
   - The SSH-auth posture choice: **(a) prompt-per-session** (recommended default — the agent's "remember approval" setting gives one human checkpoint per sitting; automated lifecycles push/pull many times, so per-use prompting is untenable) or **(b) fully headless dedicated auth key** (blast radius stated plainly: auth keys can push; reserve for routine unattended driving).
   - The suggested smoke test — suggest it, don't auto-run it:
     ```bash
     git -C <local_path> commit --allow-empty -m "chore: signing smoke test"
     git -C <local_path> log --show-signature -1
     git -C <local_path> reset --hard HEAD~1   # drop the smoke commit
     ```
6. **Record the event:**
   ```bash
   node scripts/record-dashboard-action.mjs \
     --action setup-repo-identity \
     --skill dev-setup-repo-identity \
     --args '{"repo":"<id>","email_resolved":<true|false>}' \
     --files-touched '[]' \
     --exit-status 0
   ```
   (`files_touched` is a vault-write log; this skill's writes — repo-local git config and `~/.ssh` — live outside the vault.)

## Outputs

- Dedicated signing key at `~/.ssh/agentic_os_signing` (+ `.pub`) — created on first run, reused after
- Repo-local git config on the target repo (four reference values; plus `gpg.format`/`commit.gpgsign` only on machines whose inherited values are wrong for silent SSH signing)
- Allowed-signers entry in `~/.ssh/agentic_os_allowed_signers` (when the email resolved)
- Handoff instructions printed to the user (GitHub Signing-Key registration + auth posture choice)
- Audit event `setup-repo-identity`

## Errors

- Repo entity missing → reject with the id and a pointer to [[dev-ingest-repo]]
- Entity `kind != repo` → reject with the actual kind
- `local_path` unset / gone from disk → reject with the stale value
- `local_path` is not a git repository → the script exits non-zero with `not a git repository`; relay it
- `ssh-keygen` unavailable → the script exits non-zero with install guidance; relay it
- Email unresolved → **not an error.** Partial setup: signing works, but GH007 remains until `user.email` is set — the report says so and prints the lookup instructions. Re-run with the `email` input to finish.

## See also

- [[standard-git-hygiene]] — § 4a identity rules; the new "Headless signing for automation" subsection documents this pattern + the security trade
- [[dev-ingest-repo]] — produces the repo entity this skill validates against ([[archetype-entity]])
- [[dev-open-pr]] — the push/PR step this setup unblocks (its identity pre-flight consumes the config written here)
