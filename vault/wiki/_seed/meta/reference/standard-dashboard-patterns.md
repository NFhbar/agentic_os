---
id: standard-dashboard-patterns
type: reference
domain: meta
created: 2026-05-20T00:00:00Z
updated: 2026-05-20T00:00:00Z
tags: [standard, os, app, dashboard, patterns]
source: manual
private: false
title: Dashboard authoring patterns
url: internal://standard/dashboard-patterns
kind: doc
last_verified: 2026-05-20
---

# Dashboard authoring patterns

## What it is

The set of reusable component + library patterns that the OS dashboard uses to do its job (read OS state, drive OS evolution). Future apps that need similar capabilities should use the same primitives.

## Components

| component          | when to use                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActionRunner`     | Run an AI action and stream output. Modal overlay. Consumes [[standard-ai-bridge]].                                                                                                   |
| `ScaffoldForm`     | Auto-generate a strict-validated form from a skill's `inputs:` frontmatter schema. Submits a prompt invoking the skill. Used for every "add X" operation.                             |
| `EditableMarkdown` | View/edit toggle for any markdown file. View mode renders rich markdown (react-markdown + remark-gfm) with frontmatter collapsed; edit mode is a textarea. Save POSTs to `/api/edit`. |
| `RenameModal`      | Text input + pattern validation + collision check against a `taken` list. Used by every "rename X" operation.                                                                         |
| `ConfirmModal`     | Destructive confirmation with optional **type-to-confirm** (user must type the exact name). Used for delete.                                                                          |

### `ScaffoldForm` presentation modes

Same generated form, two chromes — pick by field count, not by taste:

| mode            | when                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| modal (default) | A handful of short inputs where the surrounding page is the context the user needs to keep in view.                                                                                                          |
| `inline` (page) | Multi-field authoring: renders as page content inside a host screen with back-navigation instead of an overlay. The host owns a real URL (`/ops/new`), so the screen is deep-linkable and back/forward-safe. |

Inline mode also takes `backLabel` (the back control's text) and `submitLabel` (both modes). It deliberately does not carry the modal's `.scaffold-form` class — that one caps the field list at 60vh, which is the constraint a dedicated page exists to shed.

The rule of thumb: a form that needs a scrollbar of its own has outgrown the modal. Long forms in overlays lose focus on resize, fight the viewport on narrow screens, and can't be linked to — which is why multi-field flows go inline and the modal stays for short confirmations.

## Libraries (in `src/lib/`)

| lib              | role                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `api.ts`         | Generic `getJson` / `postJson` / `runAction` (SSE) wrappers                                     |
| `skills.ts`      | `SkillSummary` type, `fetchSkills`/`findSkill` (with module-level cache), `buildScaffoldPrompt` |
| `destructive.ts` | `buildRenamePrompt`, `buildDeletePrompt`, `lastSegment`                                         |
| `vault.ts`       | `Manifest` types, `fetchManifest`, `fetchEntry`                                                 |
| `navigation.ts`  | `NavigationContext` + `useNavigation()` — cross-view nav for wikilink clicks                    |

## Wikilink navigation

`EditableMarkdown` preprocesses `[[entry-id]]` patterns into `[entry-id](wiki://entry-id)` before passing to react-markdown. A custom `<a>` renderer intercepts `wiki://` hrefs and routes through `useNavigation().navigateToEntry(id)`. The Vault view watches `targetEntryId` from context; on arrival it finds the entry by `id` in the manifest and selects it (clearing filters first). Missing targets surface as a dismissible warning banner.

## State-machine pattern for "X with confirmation → AI action"

Every authoring flow follows the same shape:

```
[Add/Rename/Delete button click]
  ↓ opens modal (ScaffoldForm / RenameModal / ConfirmModal)
[User confirms in modal]
  ↓ modal emits a prompt string; parent sets pendingPrompt
[ActionRunner mounts with the prompt]
  ↓ streams claude CLI output via SSE
[ActionRunner onClose fires]
  ↓ parent clears selection + refreshes its list
```

This is implemented identically across Skills, Domains, and Vault views.

## Adding a new authoring flow

To add e.g. "Add report" in a future app:

1. Write the meta skill (`.claude/skills/<name>/SKILL.md`) with structured `inputs:` and clear procedure
2. Surface a button in the relevant view
3. Open `ScaffoldForm skill={...}` — the form generates itself from the inputs schema
4. On submit, set `pendingPrompt` and mount `ActionRunner`
5. On close, refresh

No new components needed — just data + a button.

## Related

[[standard-ai-bridge]], [[standard-app-layout]], [[standard-skill-format]]
