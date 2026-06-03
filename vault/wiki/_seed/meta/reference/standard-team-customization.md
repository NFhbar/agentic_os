---
id: standard-team-customization
type: reference
domain: meta
created: 2026-06-02T22:30:00Z
updated: 2026-06-02T22:30:00Z
tags: [standard, customization, team-install, fork]
source: seed
private: false
title: Standard — team customization (extending the OS for your team's stack)
url: internal://standard/team-customization
kind: standard
last_verified: 2026-06-02
---

# Standard — team customization

## Context

When a team adopts the Agentic OS, they typically need to extend it for their stack: custom skills that automate their workflows, custom domains that capture their problem areas, custom MCPs for their tooling, and team-specific overrides to docs and standards.

This standard documents **where customizations live, how to keep them separate from core, and how to evolve them**. The goal: a team's fork should be a clean superset of the OS core, not a tangled mess that's painful to update.

## The core/custom boundary

The OS ships with everything under git tracking (skills, domains, MCPs, hooks, scripts, seed entries). Teams add to that by following the same conventions — there's no separate "user customizations" directory. The distinction between core and custom is **convention + intent**, not file-system layout:

- **Core**: anything that ships with the OS template repo. Maintained upstream; pulled into team forks via rebase or merge.
- **Custom**: anything a team adds. Lives alongside core files in the same directories. Identified by naming convention (see below) so it's easy to tell which is which.

This is deliberate. Customizations behave exactly like core — same scaffolders, same standards, same tests, same audit checks. A custom skill is a real skill; a custom domain is a real domain. No second-class extension point.

## Where customizations go

| Customization         | Location                                                                                                              | Naming convention                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill                 | `.claude/skills/<team-prefix>-<name>/`                                                                                | Prefix with team shorthand (e.g. `acme-deploy`, `acme-release`). Avoids name collisions with core `dev-*` / `meta-*` / `research-*` skills. |
| Domain                | `domains/<team-domain>/` with its own `playbook.md`                                                                   | Domain name reflects the problem area (e.g. `frontend`, `infra`, `data`). Not the team name.                                                |
| Sub-domain            | `domains/<parent>/<sub>/` with nested `playbook.md`                                                                   | Used when a sub-area is substantial but lives under an existing domain.                                                                     |
| MCP                   | `mcps/<id>/` with `server.mjs` + `manifest.json` + `.env.example`                                                     | Use the vendor/protocol name (e.g. `jira`, `pagerduty`, `linear`).                                                                          |
| Hook                  | `.claude/hooks/<purpose>.{mjs,sh}`                                                                                    | Names describe the purpose (e.g. `rebuild-vault-index.mjs`). No team prefix needed — hooks are typically purpose-named.                     |
| Wiki archetype        | Register via `meta-add-archetype`; entries land at `vault/wiki/<domain>/<archetype>/<id>.md` per archetype convention | Same as core archetypes — no special handling.                                                                                              |
| Notification template | `vault/wiki/_seed/meta/template/notification-<kind>-<action>.md`                                                      | Same shape as core templates. Adding a per-event template overrides the default for that event_type.                                        |

## Identifying custom code

The naming-prefix convention (`acme-*` for skills) is the primary signal — `ls .claude/skills/` shows custom vs core at a glance. For other surfaces, use frontmatter metadata when helpful:

- **Skill SKILL.md**: add `team_custom: true` to frontmatter when you want to make it explicit (optional — the prefix is usually enough).
- **Domain playbook.md**: add `team_custom: true` to frontmatter for clarity.
- **Wiki entries** (decisions, references, templates): add `team_custom: true` to frontmatter only when the entry overrides a core seed entry's behavior or convention.

The `team_custom: true` field is informational — no skill or test branches on it today. Its purpose is to make upstream tracking tractable later (v2+) without requiring it now.

## The `_seed/` directory

`vault/wiki/_seed/` ships with the OS as canonical reference content (archetypes, standards, decisions, example entries). Teams MAY add to `_seed/` when:

- Adding a team-specific standard that other engineers on the team need (e.g. `standard-acme-eslint-config.md`)
- Adding a decision entry that captures a team-level architectural choice (e.g. `decision-acme-deploy-pipeline.md`)
- Adding example entries that demonstrate team-specific patterns

Customizations in `_seed/` ship with the team's fork. They're tracked in git and visible to every team member. Use them when the customization is **canonical for the team** (not personal scratch).

For ephemeral team notes, decisions-in-progress, or work-tracking artifacts: those belong in the per-user vault (`vault/wiki/<domain>/`, gitignored). Don't pollute `_seed/` with working state.

## Updating from upstream

When the OS core ships a new version (bug fix, new skill, refined standard), teams pull it into their fork. v1 uses standard git merge / rebase:

```bash
git remote add upstream <core-os-repo-url>
git fetch upstream
git merge upstream/main         # or: git rebase upstream/main
```

Conflicts are most likely in:

- `OS.md` (router vocabulary table — teams add their custom skills here; core might also add new core skills)
- `domains/meta/playbook.md` (Skills section — same shape)
- `.claude/skills/<name>/SKILL.md` (when a core skill gets revised AND the team has local edits to it)
- `vault/wiki/_seed/meta/reference/standard-*.md` (when a team has overridden a core standard)

Resolution: keep team additions, take core updates. The naming-prefix convention (`acme-*`) makes it visually clear which lines are team additions in the OS.md vocabulary table.

For substantial divergence (a team has heavily customized a core skill), the cleaner pattern is to **fork the skill into a team-named variant** (`acme-write-change` shadowing `dev-write-change`) and ignore upstream updates to the original. The router vocab can route team intent to the team variant.

## Versioning + compatibility

The OS doesn't currently have explicit version numbers. Teams pin compatibility by:

- Recording the upstream commit SHA they merged from (in a decision entry or CHANGELOG)
- Running the full test suite after each upstream merge — failures surface compatibility breaks
- Using the audit panel after each merge to catch silent drift (orphan wikilinks, missing playbook entries)

For v2+: explicit semver-style versioning of the OS core, with a compatibility matrix for custom skills against core APIs. Deferred until there's a second team using the OS.

## Customization-friendly patterns

A few conventions that make customization tractable:

- **Configuration over code**: prefer driving behavior via frontmatter fields or environment variables rather than hardcoded values in skills. Lets teams override without forking.
- **Composition over inheritance**: when a team needs "core skill behavior plus extra step," prefer adding a wrapper skill that dispatches core + does the extra, rather than editing the core skill in place.
- **Standards as data**: standards live in `_seed/meta/reference/` as markdown — teams can read them programmatically (the vault MCP can query) and adapt their custom skills to follow them.
- **One source of truth for enums**: archetype enums live in `tests/structural/archetype-enums.test.ts` AND `vault/wiki/_seed/meta/reference/archetype-*.md`. When adding a custom enum value, update both. The test fails fast if they drift.

## See also

- [[decision-distribution-v1-architecture]] — why the OS is shaped this way
- [[standard-feature-anatomy]] — how the OS accepts new primitives (skills, domains, apps, archetypes)
- [[standard-app-architecture]] — for custom dashboard apps
- `CLAUDE.md` — per-team config block pattern (where team-specific Claude Code behavior overrides live)
- `CONTRIBUTING.md` — the user-facing how-to for adding things
