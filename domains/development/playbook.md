---
domain: development
version: 1
created: 2026-05-19T16:40:00Z
updated: 2026-05-19T16:40:00Z
---

# Development

## Purpose

Code, repositories, PRs, debugging, deployments. Anything related to building or maintaining software lives here. Repo-specific knowledge lives in sub-domains under this one.

## Entities

- `entity` — repos and codebases (kind: `repo`)
- `entity` — teammates, code owners (kind: `person`)
- `decision` — architectural choices, stack picks, tradeoffs accepted
- `runbook` — deployment procedures, debugging playbooks, recovery steps
- `reference` — external docs, internal wikis, dashboards
- `project` — features in-flight, bug investigations (coordinate multiple changes; have reporting cadence)
- `change` — single unit of code work: one repo, one branch, one PR (composes into projects when cross-repo)
- `note` — observations not yet structured

## Skills

- `dev-pr-review` — review a pull request, write a structured report (the first OS-built skill, scaffolded via Layer 11)
- `dev-ingest-repo` — clone + analyze a GitHub or local repository; produce an `entity` wiki entry that downstream skills navigate with
- `dev-add-change` — scaffold a `change` archetype entry (single-repo unit of work with status lifecycle, optional project ownership)
- `dev-write-change` — state-machine driven: PLAN phase composes a structured plan; EXECUTE phase creates the branch, makes edits, runs tests. Gated by the review state.
- `dev-review-change` — peer-reviews a plan (read-only). Walks the plan + repo + conventions, writes a structured review with verdict (approve / request-changes / reject).
- `dev-revise-plan` — folds a review's findings (blockers / concerns / nits / suggested-changes) back into the plan. Overwrites `plan_path`, bumps `plan_revision`, preserves the prior verdict so the original review stays as historical context. Symmetric counterpart to `dev-write-change`'s ADDRESS-COMMENTS phase, but for the plan-side review instead of the PR-side review. Triggered by the Review tab's "Apply findings to plan" button.
- `dev-open-pr` — push a change's branch + open the PR via the `github` MCP + capture `pr_url`. Pre-flights MCP availability via `scripts/check-mcp.mjs`. Transitions `status: in-progress → in-review`.
- `dev-cache-pr-review-repo` — maintain a read-only shallow clone of a repo at `.claude/state/pr-review-cache/<owner>/<repo>/` for `dev-pr-review` to consult as code context. Distinct from `dev-ingest-repo` (writable working tree); cache is never mutated by skills.
- `dev-analyze-repo-for-review` — Stage 2 indexing for review context: runs a single Claude analysis over a cached repo's README/manifest/sampled source files and writes a `repo-knowledge` archetype entry (overview, stack, structure, conventions, deps, docs). Consumed by `dev-pr-review` to judge PRs against this repo's conventions rather than generic best practices. Auto-triggered on first clone by `dev-cache-pr-review-repo`; re-runnable manually.
- `dev-mark-pr-ready` — vault-only state transition: flips a change's `pr_review_status` to `ready-for-human` and stamps `pr_ready_at` once the user signs off on the OS-side review of its own PR. No GitHub calls — the human reviews and merges on GitHub themselves. Strict-gated by default (requires `pr_review_status: pending`); the `override: true` input bypasses for emergency merges or external PRs. Backs the lifecycle stepper's "Ready for human" stage.
- `dev-pr-review-publish` — publishes a pr-review entry's pass back to GitHub as a single batched review via the `github` MCP. Accepted-only filter (dismissed/new comments are skipped); verdict (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`) is mapped deterministically from the entry's `result` field. Idempotent on already-published comments. Writes `github_comment_id` + `github_review_id` per comment + `status: published` back to the entry. Used in the external-PR flow where the OS reviewed a non-OS PR.
- `dev-close-change` — terminal-state handler for the OS-authored PR flow. Calls `mcp__github__get_pull_request` to verify the PR is merged on GitHub, then surgically writes `status: merged` + `merged_at` (from GitHub's timestamp) onto the change frontmatter. Idempotent stop when the PR isn't merged yet; `override: true` input bypasses the merge check for edge cases. Coexists with the CI-monitor runbook's polling auto-detect — whichever fires first wins.
- `dev-pull-pr-comments` — inbound counterpart of `dev-pr-review-publish`. Calls `mcp__github__list_pull_request_reviews` + `mcp__github__list_pull_request_review_comments` to ingest external reviewers' comments into the linked pr-review entry as a new pass (with `source: external` marker). Each comment carries `github_comment_id` + `github_review_id` upfront for idempotent re-runs. After ingest, external comments flow through the same Accept/Dismiss/Re-implement loop as model-generated ones.
- `dev-setup-repo-identity` — idempotent per-repo headless-signing setup: dedicated passphrase-less signing-only ed25519 key, repo-local git config (never global), allowed-signers maintenance deduped by key blob, GitHub Signing-Key handoff + SSH-auth posture guidance. Wraps `scripts/setup-repo-identity.mjs`; install.sh's optional signing step loops it across ingested repos.

Planned for v1.5:

- `dev-explore-repo` — Q&A over an unfamiliar repo

## Apps

- `pr-review` — visual dashboard for the PR review workflow. Lives at `domains/meta/app/src/apps/pr-review/` (apps physically reside inside the meta dashboard bundle; the manifest's `domain: 'dev'` field is what places it in the sidebar's **Development** section). Fully wired to the API: reviews list + detail (multi-pass, comment triage accept/dismiss, verdict-state banner + Mark-ready gate), metrics, and Settings with resolved model/effort verdict cards per skill.

## Sub-domains

- `pr-review` — PR review workflows; see `domains/development/pr-review/playbook.md`

## Conventions

- Wiki entries: `vault/wiki/development/<archetype>/<slug>.md`
- Outputs: `vault/output/development/<kind>/<slug>.md`
- Skills prefixed with `dev-` (e.g. `dev-pr-review`)
- Each repo this OS knows about gets a `kind: repo` entity entry in `vault/wiki/development/entity/`
- Repo-specific deep knowledge moves into a sub-domain when it outgrows a single entity

## Universal standards

Every code change (every `dev-write-change` PLAN + EXECUTE, every `dev-review-change` review) MUST read and respect these standards. Repo-specific overrides live in the repo's entity entry under `## Conventions` and take precedence where they conflict — but the standards are the floor.

- **[[standard-code-quality]]** — code shape, dependency hygiene, backwards compat, security, tests, comments, repo-convention adherence
- **[[standard-git-hygiene]]** — pre-branch state, branch creation, branch naming, commit conventions, PR structure, recovery

Skills load these at the start of their procedures so plans, edits, and reviews all check against the same rules.

## Cross-domain links

- Decisions made here often need supporting context from `research/` — link via `[[research-...]]`
- When research informs a development decision, mirror the link both ways
