# Agentic OS — workspace instructions

You are working inside the Agentic OS. This is not an ordinary project.

## Dispatch

- Canonical entry point: `/os <intent>` (the `os` router skill)
- Read `OS.md` for the domain map and intent vocabulary
- Direct skill invocation (e.g. `/dev-pr-review`) is a power-user escape hatch; prefer `/os`

## Vault discipline

- `vault/raw/` — unstructured ingest; OK to drop, but raw is not knowledge
- `vault/wiki/` — structured memory; archetype frontmatter required (see `vault/wiki/_seed/meta/`)
- `vault/output/` — generated artifacts; mirror domain tree

## Evolving the OS

- Adding a domain, skill, app, or archetype is itself an OS action — route through `meta-*` skills
- Do not edit `OS.md` or playbooks freehand; route through `meta-evolve` or the dashboard

## Standards (load-bearing)

- Skills live at `.claude/skills/<name>/SKILL.md` (one directory per skill); frontmatter must include `user-invocable: true`
- Domain knowledge lives under `domains/<name>/` (`playbook.md` + optional `app/` + sub-domains)
- Wiki entries carry shared frontmatter (`id`, `type`, `domain`, `created`, `updated`, `tags`, `source`, `private`) plus per-archetype fields
- Logs are JSONL (one event per line) at known paths
- Templates use Mustache `{{var}}` placeholders
- Full standards: `domains/meta/playbook.md` + `vault/wiki/_seed/meta/`

## On a fresh clone

Run `./install.sh` once before `claude`.

<!-- ─────────────────────────────────────────────────────────────────────────
     team-config-start

     Per-team Claude Code behavioral overrides go here. Teams adopting the OS
     edit ONLY this block when customizing for their stack. Everything above
     this marker is OS core — leave it alone so upstream merges stay clean.

     What belongs in this block:
       - Tooling preferences (e.g. "always use pnpm, not npm")
       - Coding conventions specific to your team's product code
       - Repo-specific behavior (e.g. "PRs against api-* repos always need
         a perf benchmark in the description")
       - Default reviewer assignments, deploy windows, on-call awareness
       - Custom skill discoverability hints (e.g. "for deploys, prefer
         /os acme deploy over the raw github MCP")

     What does NOT belong here:
       - OS architecture overrides (those go in the OS itself via meta-evolve)
       - Skill/domain definitions (use the appropriate meta-add-* scaffolder)
       - Per-user preferences (those live in .claude/settings.local.json,
         which is gitignored)

     See vault/wiki/_seed/meta/reference/standard-team-customization.md for
     the full customization model.
     ───────────────────────────────────────────────────────────────────── -->

## Team configuration

_No team-specific overrides set yet. Edit the block below this comment to
add your team's conventions, tooling preferences, and product-specific
guidance. Delete this paragraph once you've added real content._

<!-- team-config-end ──────────────────────────────────────────────────── -->
