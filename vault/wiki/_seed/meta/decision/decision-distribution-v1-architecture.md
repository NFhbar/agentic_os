---
id: decision-distribution-v1-architecture
type: decision
domain: meta
created: 2026-06-02T22:00:00Z
updated: 2026-06-02T22:00:00Z
tags: [decision, distribution, architecture, team-install]
source: seed
private: false
title: Distribution v1 architecture — four locked decisions for shipping the OS to small teams
status: accepted
deciders: [graviton]
---

# Distribution v1 architecture

## Context

The Agentic OS started as a personal power tool — single owner, single machine. After substantial validation (mull-serve + websocket-head shipped end-to-end via automation, cost telemetry tracking, Project Pulse rendering), the natural next phase is **distribution**: enabling other engineers to fork/clone the OS and use it for their own work.

The OS is shaped by four foundational decisions made at the start of the distribution arc. This entry records them so future contributors don't have to re-derive the architecture from inference.

## Decision 1 — Audience: small teams (2-10 engineers)

The OS targets small engineering teams that adopt it together. Each engineer runs their own OS instance against a team-shared skill catalogue.

**Implications:**

- The install model assumes a fork or template-clone, not an `npm install agentic-os` package
- Documentation level: middle ground — heavier than personal-only, lighter than open-source
- Security model: within-team trust (you trust your teammates' skill contributions)
- Auth: each engineer uses their own GitHub PAT for their own commits; bot-account separation deferred to v2

**Rejected alternatives:**

- _Personal power tool only_: too narrow; the OS has matured past this
- _Open-source community_: too broad for v1 — would require heavy security investment (untrusted-input skills, sandboxing, versioning) and a contributor model that doesn't yet exist
- _Reference implementation only_: leaves real adoption value on the table; the OS works, not just demonstrates

## Decision 2 — State model: per-user vault, shared code only

The OS state splits cleanly into two tiers:

**Shared via git (the OS as code):**

- `domains/` — domain playbooks + apps + sub-domains
- `.claude/skills/` — every user-invocable skill
- `.claude/hooks/` — automation hooks
- `mcps/` — MCP server implementations
- `scripts/` — shared tooling
- `_templates/` — scaffold templates
- `vault/wiki/_seed/` — canonical reference content (archetypes, standards, decisions)
- `OS.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md` — shared docs

**Per-user, gitignored (the OS as runtime):**

- `vault/wiki/<domain>/` — user's personal vault entries (changes, projects, research, decisions, notes)
- `vault/raw/`, `vault/output/`, `vault/.index/` — drop zone, generated artifacts, cache
- `.claude/state/` — events.db, runs/, dismissals, dashboard prefs
- `mcps/*/.env`, `domains/*/app/.env` — secrets

The team's "shared brain" is the **codebase being worked on** (the team's product repos), NOT the OS's vault. Each engineer's vault is their personal IDE-like state — knowledge they're accumulating, plans they're drafting, reviews they've run.

**Implications:**

- No vault-merge problem — engineers never collide on each other's wiki entries
- No multi-user sync infrastructure needed (no shared events.db, no cross-engineer Pulse)
- The OS-owner dogfoods the same install other team members will use
- Team-wide metrics aggregation is deferred to v2 (would require a shared events.db backend)

**Rejected alternatives:**

- _Shared vault via git PRs_: heavy merge surface, slow edit-cycle, every wiki edit requires PR review
- _Hybrid (shared wiki, per-user output)_: awkward boundary — wiki entries reference output paths that exist only in some users' vaults

## Decision 3 — Install model: `git clone` + `./install.sh`

The simplest viable install:

```bash
git clone <team-fork-url>
cd <repo>
./install.sh
claude
```

`install.sh` does dependency setup (npm install, MCP env scaffolding, hook registration). First run is `claude` in the repo root; the user discovers the OS via the dashboard (`/os dashboard`) and the canonical `/os <intent>` router.

No tutorial, no bootstrap CLI, no interactive wizard. The dashboard + good docs do the onboarding work.

**Implications:**

- README must do real work — it's the new engineer's first touch
- `install.sh` must be robust on a fresh macOS/Linux box (no graviton-specific paths)
- Dashboard's first-render UX matters — must be self-explanatory
- Teams customize via their fork (commit team-specific skills/domains/MCPs)

**Rejected alternatives:**

- _Guided first-run tour_: nice-to-have, not v1
- _`npx create-agentic-os`_: bootstrap CLI is overkill for team-scale; revisit for open-source

## Decision 4 — Repo strategy: one repo, gitignore per-install state

The current `agentic_os` repo IS the distributable template. Per-install state (everything in Decision 2's "per-user" tier) is gitignored. The OS-owner's working tree contains their personal vault and state, but those files aren't tracked by git, so a fresh clone gets a clean empty vault.

**Implications:**

- No separate template-repo sync burden
- OS-owner dogfoods the exact install path teams will use
- The `_seed/` directory boundary is load-bearing — anything in `vault/wiki/_seed/` ships with the OS as canonical reference; anything else is per-install
- Existing vault entries (mull project, OS-development changes, etc.) stay on the OS-owner's disk but never get tracked

**Rejected alternatives:**

- _Sanitize current repo in place (force-reset vault)_: destructive — would lose months of organic working history
- _Separate `agentic-os-template` repo_: creates a two-repo sync burden, OS-owner doesn't dogfood the same install path

## What v1 distribution ships

The work decomposed into ~9 changes (down from initial 10 because gitignore + MCP env templates were already distribution-ready from earlier OS work):

1. ~~Gitignore per-install state~~ — already done
2. ~~MCP `.env.example` templates~~ — already done
3. Harden `install.sh` for fresh-machine bootstrap
4. Sanitize personal references (`/Users/graviton` paths, install-specific examples)
5. README onboarding — new-engineer flow
6. CONTRIBUTING.md — how to add/edit skills, domains, MCPs
7. `.github/workflows/ci.yml` — lint + tests on PRs to the OS repo itself
8. Pre-commit hook — manifest sync + tests
9. Customization standards doc — where teams put custom code; how to keep custom + core separate
10. CLAUDE.md per-team config block pattern
11. `git init` + first commit + create GitHub repo (foundational — the agentic_os directory isn't currently a git repo)

## Explicitly deferred to v2+

- **Bot-account separation** (recorded as Task #430) — each engineer using their own PAT means PR self-approval gets auto-downgraded to COMMENT (short-term mitigation already shipped in `dev-pr-review-publish` SKILL.md). The architectural fix is a separate `agentic-os-reviewer` GitHub App identity per team. Worth doing when distribution starts but not blocking v1.
- **Skill marketplace / upstream pull** — teams fork independently; no upstream-tracking mechanism. If multiple teams adopt the OS, we'd want a "pull bugfixes from core" story. Defer until there's a second team using the OS.
- **Team-shared metrics aggregation** — Pulse v1 is per-user; v2 might aggregate across engineers via a shared events.db backend. Defer until there's demand.
- **Onboarding wizard / interactive tour** — `/os tour` skill that walks new engineers through dashboard + first change + lifecycle. Nice-to-have; the README + dashboard's self-explanatory layout should suffice for v1.

## Decision rationale

The four decisions were made interactively at the start of the distribution arc, working through dependencies in order: audience → state model → install model → repo strategy. Each downstream answer narrows the option space of the next; deciding audience first prevented over-engineering for cases that don't apply (open-source security, multi-user vault sync).

The recurring principle: **ship the smallest thing that lets another engineer use the OS productively, and defer everything that can wait.** Team-scale distribution is the maturity step that proves the OS can leave the laptop; v2+ adds the polish that proves it can scale further.
