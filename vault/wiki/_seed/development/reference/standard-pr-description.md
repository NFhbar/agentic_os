---
id: standard-pr-description
type: reference
domain: development
created: 2026-05-22T00:00:00Z
updated: 2026-05-22T00:00:00Z
tags: [standard, pr, github, change, template]
source: manual
private: false
title: PR description + title standard
url: internal://standard/pr-description
kind: doc
last_verified: 2026-05-22
---

# PR description + title standard

How the OS composes pull request titles and bodies when opening a PR for a change. The skill that follows this contract is [[dev-open-pr]]. The git-side conventions (branch naming, commits) live in [[standard-git-hygiene]] — this standard is specifically about the PR artifact itself.

## 1. PR title — precedence

The skill picks a title in this order, **first source wins**:

1. **Explicit `pr_title:` frontmatter field** on the change entry (if the author wrote a deliberate one)
2. **`change.title` field** if it already looks like a conventional-commit title — matches `^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?:\s+.+$` (case-insensitive)
3. **Inferred** from the branch name + change.title:
   - Branch type prefix: `<type>/<slug>` → use `<type>` as the commit type (`docs/add-license` → `docs`)
   - Scope: use `change.scope` if set, else omit the parenthesized scope
   - Description: lowercase `change.title`, trim trailing period
   - Final: `<type>(<scope>): <description>` or `<type>: <description>` when scope is empty

### Examples

| change.title        | branch             | scope   | result                                                    |
| ------------------- | ------------------ | ------- | --------------------------------------------------------- |
| `Add MIT LICENSE`   | `docs/add-license` | —       | `docs: add mit license`                                   |
| `Fix race in cache` | `fix/cache-race`   | `cache` | `fix(cache): fix race in cache`                           |
| `feat(auth): OIDC`  | (any)              | (any)   | `feat(auth): OIDC` (already-conventional, passed through) |

Conventional-commit types are the same set [[standard-git-hygiene]] uses: `feat | fix | docs | style | refactor | perf | test | chore | build | ci | revert`. The `<type>` must match — if the branch prefix isn't in the allowlist, fall back to `chore`.

## 2. PR description — precedence

The skill picks a description template in this order, **first source wins**:

1. **Repo PR template** — check the repo's working tree (under `local_path` from the repo entity) for, in this order:
   - `.github/pull_request_template.md`
   - `.github/PULL_REQUEST_TEMPLATE.md`
   - `.github/PULL_REQUEST_TEMPLATE/default.md`
   - `docs/pull_request_template.md`
   - `pull_request_template.md` (repo root)

   Case-insensitive match on filename. The first match wins. Read the file's content as a string. Comment lines (`<!-- ... -->`) are preserved — that's where the repo's authors hint at what fills each section.

2. **OS default template** (used when no repo template found):

   ```markdown
   # what

   <one-paragraph description of what this PR changes — derived from the change's `## Why` section, condensed>

   # why

   <2-4 sentences on motivation — full `## Why` from the change body>

   # tests

   <bulleted list — derived from the plan's "tests added/updated" section, or the change body's `## Done when` checklist if no plan>
   ```

The `# what / # why / # tests` shape is deliberate: most repos either have no template (in which case this provides structure) or have a template the skill should follow (so the OS doesn't impose its own shape on top).

## 3. Filling the template

Whatever template the skill ends up with, it's filled from the change's data:

| placeholder pattern                               | filled from                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `# what` (or `## What`)                           | one-paragraph summary derived from `## Why` section                              |
| `# why` (or `## Why`)                             | full `## Why` from the change body                                               |
| `## summary` / `## description`                   | one-paragraph summary derived from `## Why`                                      |
| `## approach` / `## changes`                      | `## Approach` from the change body                                               |
| `# tests` / `## test plan` / `## testing`         | plan's tests-added section, or `## Done when` checklist                          |
| Free-form sections (`## Screenshots`, `## Notes`) | leave as-is (the skill can't fill them automatically; humans can edit post-open) |
| `## Checklist` items already in the template      | leave unchecked (`- [ ]`) — the author decides what to check                     |
| HTML comments (`<!-- … -->`)                      | preserve verbatim — they guide reviewers                                         |

Always append a footer with the OS provenance:

```markdown
---

### Generated by the Agentic OS
- Change record: `vault/wiki/<domain>/change/<change>.md`
- Plan: `<plan_path or "(none)">`
- Review verdict: `<review_status>` (`<review_path or "(no review file)">`)
```

Reviewers can find the structured context this PR was derived from.

## 4. Post-open: CI snapshot

After the PR is created, the skill takes **one snapshot** of the PR's CI checks via the github MCP. It does not poll. The snapshot becomes part of the success report:

```
ci: <pass | fail | running (N checks) | none>
```

If `running`, the report includes a hint to re-query later — typically via a `/os pr-status <change>` skill (planned) or by opening the PR in the browser. The skill **does not block** on CI completion — CI can take many minutes, and a multi-minute hang in a headless `/os open-pr` invocation is worse than reporting "running, check later".

## 5. Logging

Per the OS event-attribution standard ([[standard-event-store]] § Event attribution), every PR open is logged via `record-dashboard-action.mjs` with:

- `--action open-pr`
- `--skill dev-open-pr`
- `--args '{"change":"<id>","pr_number":<n>,"draft":<bool>,"ci_snapshot":"<state>"}'`
- `--files-touched '["<change-entry-path>"]'`

The shared attribution helper extracts `change_id` from `args.change` — the event row in events.db will be tagged correctly without further work.

## Related

- [[standard-git-hygiene]] — branch naming, commit conventions, the git side
- [[standard-change-workflow]] — full lifecycle, where this slots in
- [[standard-mcp-usage]] — how the skill calls the github MCP
- [[dev-open-pr]] — the skill that implements this contract
