---
id: decision-skip-plan-mode
type: decision
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [skills, dashboard, ai-bridge, destructive]
source: manual
private: false
project: build-agentic-os-v1
title: Dashboard-driven destructive skills skip plan mode
status: accepted
alternatives:
  [
    "Use meta-evolve with plan mode (interactive only)",
    "Dedicated skills that skip plan mode (chosen)",
    "Dashboard runs raw file ops, no AI",
    "Two-phase: plan via SDK, execute via CLI",
  ]
---

# Dashboard-driven destructive skills skip plan mode

## Context

Destructive OS operations (rename, delete a skill / domain / wiki entry) involve filesystem moves PLUS cleanup of cross-references (OS.md vocab, playbook listings, sub-domain references, `[[wikilinks]]`). They need AI reasoning because the references aren't fully enumerable in advance.

`meta-evolve` is the existing skill for "modify OS structure" and its procedure includes step 4: "draft a plan: list every file to be modified… present via ExitPlanMode for approval." This works great in an interactive Claude Code session but breaks the dashboard's AI bridge:

The bridge shells out to `claude -p "<prompt>"` (one-shot mode). There's no user at the terminal to approve `ExitPlanMode`. Plan-mode steps would either hang or be misinterpreted.

## Options considered

- **Use `meta-evolve` with plan mode** — the existing skill, designed for interactive use. Doesn't work over `claude -p`.
- **Dedicated `meta-rename` + `meta-delete` skills that skip plan mode** — structured inputs (`target_type`, `target_path`, `new_name?`), explicit "do NOT enter plan mode" in the procedure. The dashboard's UX handles confirmation upfront (RenameModal, ConfirmModal with type-to-confirm). Chosen.
- **Dashboard runs raw filesystem ops, no AI** — fast but can't reason about cross-references reliably; would miss arbitrary `[[wikilink]]` updates.
- **Two-phase: plan via SDK, execute via CLI** — too much machinery for v1.

## Decision

Build two new skills with explicit `# Notes` section saying "The user has already confirmed from the dashboard. **Do not enter plan mode.** Execute directly using Read/Write/Edit/Bash tools." Each skill's procedure is deterministic enough that plan mode adds no value — the operations are mechanical (rename file, update N references).

The dashboard collects confirmation upfront:

- **Rename**: text input with pattern validation + sibling-collision check (`RenameModal`)
- **Delete**: type-to-confirm (user must type the exact target name) before the Delete button enables (`ConfirmModal`)

`meta-evolve` remains for **interactive** OS modifications (used directly from `/os evolve …` in CC). It keeps its plan-mode behavior.

## Rationale

- **Headless mode reality**: `claude -p` cannot interactively confirm plans; pretending otherwise leads to broken UX.
- **Dashboard already confirms**: type-to-match is stronger than plan-mode approval (user types the literal name).
- **Two skills, two contexts**: interactive vs headless have different UX needs; one skill per context is cleaner than one skill with a "are we interactive?" branch.
- **Audit log still captures everything** — even without plan mode, every action appends to `vault/raw/dashboard-actions.jsonl`.

## Consequences

- Two new skills (`meta-rename`, `meta-delete`) live alongside `meta-evolve`. The vocabulary in `OS.md` directs `rename` / `delete` intents to the new skills; `evolve` still routes to `meta-evolve`.
- Dashboard prompt builders (`buildRenamePrompt`, `buildDeletePrompt`) embed the "do NOT enter plan mode" instruction so the skill behaves correctly even if a user invokes it manually from `claude -p` later.
- Future destructive operations follow the same pattern: dedicated skill + skip-plan-mode + dashboard confirms.

## References

- [[standard-ai-bridge]] — why `claude -p` is the dashboard's transport
- `.claude/skills/meta-rename/SKILL.md`, `.claude/skills/meta-delete/SKILL.md`
- `domains/meta/app/src/lib/destructive.ts` — prompt builders
