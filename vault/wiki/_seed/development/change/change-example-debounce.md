---
id: change-example-debounce
type: change
domain: development
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [example, seed, bug-fix, search]
source: seed
private: false
title: Add debounce to search input (example)
repo: example-repo
status: merged
branch: agent/add-search-debounce
scope: src/search/Input.tsx, src/search/__tests__/Input.test.tsx
size: small
pr_url: https://github.com/example-org/example-app/pull/123
review_required: true
review_status: approved
plan_path: vault/output/development/changes/change-example-debounce-plan.md
review_path: vault/output/development/changes/change-example-debounce-review.md
plan_generated_at: 2026-05-21T00:00:00Z
reviewed_at: 2026-05-21T00:00:00Z
---

# Add debounce to search input (example)

> **This is a seed/illustrative entry.** It targets [[example-repo]] (synthetic) and is shown in the dashboard as a worked example of the change lifecycle: planning → in-progress → in-review → **merged**. Do not invoke `dev-write-change` against it.

## Why

The search input's autocomplete fires on every keystroke — typical typing produces 60+ requests per minute, which exceeds the backend's 30 rpm rate-limit. Users intermittently see 429 errors that block subsequent searches even after they slow down. Debouncing input by 300ms keeps us comfortably under the limit while preserving perceived responsiveness.

## Approach

1. Wrap `onChange` in `useDebouncedCallback(300)` from `lib/hooks` (already in the repo)
2. Add three snapshot tests covering: empty input, fast typing burst, slow typing
3. Verify keyboard navigation tests still pass (arrow keys + enter should not be debounced — they go through a separate `onKeyDown`)
4. Open PR; reference this entry in the description

## Done when

- [x] Debounce wrapping in place
- [x] Three new test cases added
- [x] Existing keyboard nav tests pass unchanged
- [x] PR opened and `pr_url:` updated in this entry's frontmatter
- [x] Review approved
- [x] Merged

## Notes

- During the work, the team noticed the autocomplete component also fires on focus events — debouncing doesn't help that path. Captured as a follow-up: `[[change-example-debounce-focus-followup]]` (illustrative reference — no such entry exists, this just shows the pattern of linking to a sibling change).
- The original implementation used `setTimeout` directly; the reviewer (see review) suggested `useDebouncedCallback` from the existing hooks lib so the cleanup logic is consistent. Plan was revised before EXECUTE.

## Links

- [[example-repo]] — the (synthetic) repo this change targets
- [[standard-change-workflow]] — the canonical workflow this entry illustrates
- [[dev-write-change]] · [[dev-review-change]] — the skills that drove the lifecycle
