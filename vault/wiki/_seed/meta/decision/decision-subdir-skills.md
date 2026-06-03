---
id: decision-subdir-skills
type: decision
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [skills, layout, claude-code]
source: manual
private: false
project: build-agentic-os-v1
title: Skills live at .claude/skills/<name>/SKILL.md (subdir per skill)
status: accepted
alternatives:
  ["Flat .claude/skills/<name>.md", "Subdir with SKILL.md", "Frontmatter-tagged files in a flat dir"]
---

# Skills live at `.claude/skills/<name>/SKILL.md` (subdir per skill)

## Context

v1 scaffolded skills as flat `.md` files in `.claude/skills/`. After install, `/os brief` failed with "Unknown command: /os" — Claude Code's harness didn't discover any of the skills. Inspection of installed plugin skills (`~/.claude/plugins/marketplaces/.../skills/<name>/SKILL.md`) showed the actual format CC expects is one **directory** per skill, with `SKILL.md` inside.

## Options considered

- **Flat `.claude/skills/<name>.md`** — what we originally built. Simpler tree, single-file per skill. But: not discovered by CC's harness.
- **Subdir with `SKILL.md`** — directory per skill, `SKILL.md` is the canonical entry, additional files (helpers, fixtures) can live alongside. Matches CC's installed plugin format. Chosen.
- **Frontmatter-tagged files in flat dir** — declare a `type: skill` field and let the harness scan. Speculative; not how CC actually works.

## Decision

Use `.claude/skills/<name>/SKILL.md`. The frontmatter must include `user-invocable: true` for the harness to expose the skill as a `/<name>` slash command.

## Rationale

- Matches CC's actual discovery contract (verified against installed plugins).
- The directory leaves room for skill-specific support files (helper scripts, fixtures, sample data) without polluting the flat `.claude/skills/` namespace.
- `user-invocable: true` is explicit — opts skills into the slash-command surface deliberately rather than by default.

## Consequences

- Every meta-add-skill / meta-rename / meta-delete operation must use the subdir path.
- The standards files (skill format, file naming, app layout) all reference the subdir form.
- Existing skills scaffolded with the flat format had to be migrated (10 files → 10 directories with SKILL.md inside).
- App template's launch-skill output path (`_templates/skill/...`) also uses subdir form for consistency.

## References

- [[standard-skill-format]] — the lock-down spec
- [[standard-file-naming]] — file-pattern table
- CC plugin examples: `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/*/skills/*/SKILL.md`
