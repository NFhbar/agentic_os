---
id: standard-testing
type: reference
domain: meta
created: 2026-06-02T06:00:00Z
updated: 2026-06-02T06:00:00Z
tags: [standard, testing, integrity, ci, drift]
source: vault/wiki/development/change/tests-structural-suite-bootstrap.md
private: false
title: Standard — OS test suite (structural + unit + integration)
url: internal://standard/testing
kind: standard
last_verified: 2026-06-02
---

# Standard — OS test suite

How the OS is verified to stay coherent as it evolves. The biggest fragility risk isn't bugs in any one function — it's that the system has grown to where its integrity invariants live in operator memory. Tests codify those invariants.

## Tiers

Tests fall into three tiers by what they cover, where they run, and how fast they should be:

### Tier 1 — Pure unit tests

Tests of pure functions and parsers. Fast, isolated, no I/O.

- **Targets:** state machine deciders (`decideNextChangeStep`), frontmatter parsers, attribution helpers, audit-rule helpers — anything that takes input + returns output deterministically.
- **Where:** colocated with source in the owning app (e.g. `domains/meta/app/server/routes/__tests__/`) or at repo root under `tests/unit/` for shared scripts.
- **Run:** every code change. Pre-commit hook + watch-mode during dev.
- **Status today:** infrastructure scaffolded; concrete tests TODO. Migrate from manual tsc-clean validation as code is touched.

### Tier 2 — Structural integrity tests

Tests that validate the OS _as a system_. Run against the live vault, skills tree, manifest, and standards docs. Verify the structural invariants the OS depends on but doesn't itself enforce.

- **Targets (current coverage):**
  - `tests/structural/skills.test.ts` — every skill has parseable frontmatter, declares `name` + `description` + `user-invocable` + `version` + `domain`, name matches directory, `spawns:` references resolve
  - `tests/structural/wikilinks.test.ts` — every `[[name]]` resolves to a wiki entry, a skill, or a documented exception
  - `tests/structural/events.test.ts` — notification templates + rules reference event_types that exist in event-catalog.md
  - `tests/structural/standards-coverage.test.ts` — audit checks documented in standard-os-audit.md ↔ implemented in scripts/audit.mjs
  - `tests/structural/cross-refs.test.ts` — `change.project`, `change.repo`, `change.parent_change`, `change.derived_from_report`, `plan_path`, `pr_review_path` all resolve
- **Run:** every code change + every wiki edit. Pre-commit hook.
- **Status today:** five starter tests shipped. Coverage expands as new structural categories surface.

### Tier 3 — Integration tests

End-to-end tests that drive real flows through the dashboard server + orchestrator. Slow; run in CI or pre-release only.

- **Targets (planned):** automation state machine driven by synthetic terminal events, dashboard endpoint smoke tests, audit run-time
- **Where:** `tests/integration/`
- **Status today:** not started. Scoped after Tier 1 + 2 stabilize.

## Tests vs. audits — which to use

|               | Audit                      | Test                        |
| ------------- | -------------------------- | --------------------------- |
| When          | Manual or scheduled        | On every code change        |
| Severity      | Info / warn / error        | Pass / fail (always blocks) |
| Response      | User triages               | Build halts                 |
| What to cover | Drift tolerable mid-flight | Invariants that _must_ hold |

Some checks should stay audits. The split:

- **Promote to test** — structural invariants that break flows: parse errors, broken wikilinks, missing templates, archetype required-fields, audit-doc-coverage.
- **Keep as audit** — time-based or content-quality drift: `repo-knowledge-stale`, `deferred-comments-age`, `manifest-stale`, `events-report-attribution-missing`.

When promoting an audit check to a test, leave a comment in the audit referencing the test, and (when fully covered) retire the audit check.

## What NOT to test

Tests should be high-signal. Avoid:

- **Performance characteristics.** Brittle; use observability instead.
- **UI rendering / visual regression.** Its own discipline; not test-suite scope.
- **LLM output quality.** The skill's actual answers can't be unit-tested. Test the _procedure_ contract, not the output content.
- **External APIs.** Mock or skip — don't make tests depend on GitHub/Slack availability.

## Running tests

```bash
npm test              # one-shot run; exits non-zero on failure
npm run test:watch    # watch mode for active dev
```

Vitest discovers `tests/**/*.test.ts` per `vitest.config.ts`. Output is human-readable; failure messages should be actionable (point at the broken file + what to fix). When tests pass, they're silent — when they fail, they should tell you everything needed to resolve without further investigation.

## Adding a new test

1. **Tier 2 — structural test.** Add `tests/structural/<category>.test.ts`. Reuse helpers in `tests/helpers/vault.ts`. Failure messages must name the broken entry/file + the action to take.
2. **Tier 1 — unit test.** Colocate with source. Vitest is configured per-app where applicable; bootstrap if absent.
3. **Tier 3 — integration test.** Defer until Tier 1 + 2 are mature enough that mocking the right layers is obvious.

## Standards this enforces

- Skill frontmatter contract — via `tests/structural/skills.test.ts` (no separate archetype entry today; the contract is encoded in the test)
- [[archetype-change]] / [[archetype-project]] / [[archetype-research-report]] — frontmatter integrity (via `cross-refs.test.ts` + future archetype-required-fields test)
- [[standard-os-audit]] — every documented check is implemented (via `standards-coverage.test.ts`)
- [[event-catalog]] — every reference (template/rule) points at a cataloged event (via `events.test.ts`)
- Wikilink resolution — every wiki reference points at a real entry, skill, or documented exception (via `wikilinks.test.ts`)

## See also

- `vitest.config.ts` — test runner configuration
- `tests/helpers/vault.ts` — shared loaders (manifest, frontmatter, walks)
- [[standard-os-audit]] — the audit subsystem this complements
