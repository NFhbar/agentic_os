---
id: standard-self-healing
type: reference
domain: meta
created: 2026-05-30T16:10:00Z
updated: 2026-05-30T16:10:00Z
tags: [standard, self-healing, audit, sweeper, scheduler, coverage]
source: vault/wiki/development/change/standard-self-healing.md
private: false
title: Self-healing — coverage requirement for new OS state
url: internal://standard/self-healing
kind: doc
last_verified: 2026-05-30
---

# Self-healing — coverage requirement for new OS state

## The principle

Every piece of **load-bearing OS state** — state that's read by skills, the dashboard, or the scheduler AND influences behavior — should have a self-healing affordance that catches drift, recovers from interruption, or routes around known-broken cases. New features ship with the coverage; without it the OS quietly accumulates dead state.

"Self-healing" here means automated detection + an actionable next step. It does NOT mean automatic repair — the OS surfaces issues; the user (or a follow-up skill run) acts on them. The goal: no silent corruption.

## What counts as load-bearing state

In scope (needs coverage):

- **Frontmatter fields driving lifecycle** — `status` on project/change, `review_status` on change/research-report, `plan_status` on project, `enabled` on notification-config
- **Persistent state files** — `.claude/state/*.jsonl`, `events.db`, `vault/raw/*.jsonl`
- **Artifacts the OS reads at runtime** — notification rules, runbooks, templates, audit-registry
- **Cross-entity references** — `project: <id>` on a runbook, `derived_from_report` on a change, `parent_change` chains
- **Env configuration** — `process.env.X` reads in server / MCP code
- **Long-running processes + their attribution** — skill runs, dispatched events, scheduled jobs

Out of scope (no coverage required):

- Ephemeral logs / debug output
- Transient client-side state (UI form state, scroll position, etc)
- Derived artifacts that are cheap to rebuild from source (manifest.json, vault/.index)
- Sandboxed scratch space (`vault/raw/` is the user's drop zone, not OS-managed state)

## The four pillars

Self-healing manifests through four complementary mechanisms. New features should reach for the pillar that matches the drift case — typically one suffices, sometimes two reinforce.

### 1. Audit hooks — drift detection

`scripts/audit.mjs` walks the OS periodically (manually via `/os audit`, weekly via `runbook-weekly-health-check`) and emits findings per registered check. Each load-bearing state surface should have a check that surfaces drift. See [[standard-os-audit]] for the canonical check registry + severity model + how to add new checks. The drift case for each new state should be explicit:

- "A `<thing>` references `<other-thing>` that doesn't exist" → orphan
- "A `<thing>` has gone too long without `<expected-update>`" → stale
- "A `<thing>` is in an enum value not recognized" → enum drift
- "A `<thing>` is documented but not implemented (or vice versa)" → registry coverage

### 2. Orphan sweeper — interruption recovery

`scripts/runs-db.mjs::sweepOrphanedRuns` runs every 5 minutes (called from `server/index.ts`). Detects skill runs that died mid-flight (PID dead but row says running). Marks them `failed` with a clear reason. Without this, partial work would block subsequent dispatches forever via `startRun()`'s in-flight gate.

The pattern: any long-running process should have a way to detect "this process is no longer alive" without relying on the process to clean up after itself.

### 3. Scheduler tick — autonomous recovery

`scripts/scheduler-tick.mjs` runs every minute via launchd (macOS) and fires due runbooks. When a runbook's prompt is `/os audit` or `meta-status-report`, the scheduler IS the self-healing mechanism — periodic drift detection runs without user intervention.

Three runbooks ship by default that exercise this pillar:

- `runbook-weekly-health-check` — fires `/os audit` weekly and writes a dated summary
- `runbook-weekly-curation-check` — scans `vault/raw/` for stale items
- `runbook-morning-brief` — daily reminder of in-flight work

New self-healing features that need to "check periodically" should ship as a runbook, not as inline code in another path.

### 4. Dismissable findings + reopen affordances — known-broken routing

Sometimes a finding is intentional. `.claude/state/dismissed-action-items.jsonl` lets the user route around findings they've consciously accepted (e.g., "yes this MCP is deprecated, I'll fix it next quarter"). The Overview page's "Show dismissed" toggle keeps the audit honest while letting the user clear current-state noise.

The parallel for lifecycle state: `meta-reopen-project` / `meta-mark-research-approved` are the escape hatches when canonical flows produce wrong-state — completed too early, reviewer's verdict too harsh, etc. The OS provides explicit "un-stick" paths rather than requiring users to hand-edit frontmatter.

## Coverage requirement when shipping a new feature

Before merging a change that introduces new load-bearing state:

1. **Identify the drift cases.** What can go wrong with this state? Examples: target entity gets deleted, value drifts out of the enum, file's contents become stale, reference graph develops a cycle.
2. **Pick the matching pillar** for each drift case:
   - Drift detected at scan time → **audit hook** (most common)
   - Process died mid-flight → **sweeper pattern** (extend `runs-db.mjs` or analogous)
   - Periodic self-check → **scheduled runbook**
   - User-routed-around → **dismissable finding** (default; works automatically if the audit hook follows the pattern)
3. **Ship the hook in the same change** as the feature. The OS's principle is that audit coverage is feature-completion criteria, not deferred work.
4. **Register the check** in [[standard-os-audit]]'s Check registry. The `audit-check-id-documented` self-check enforces this — it'll flag undocumented implementations on the next audit run.
5. **Verify** by running `node scripts/audit.mjs --json` — confirm the new check fires zero findings on a clean state AND fires the expected finding when you manually break the state (deliberately mis-set the field, point at a non-existent entity, etc).

## Current coverage matrix

Living document — when new state is added, update both this matrix and the [[standard-os-audit]] check registry. The two should stay in sync.

| State surface                                     | Pillar(s)           | Canonical check / mechanism                                                                    |
| ------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| Skill files (frontmatter, dispatch order)         | audit               | `skill-frontmatter-valid`, `skill-domain-known`, `skill-name-matches-dir`                      |
| Wiki entries (frontmatter, archetype conformance) | audit               | `entry-archetype-required-fields`, `entry-domain-valid`, `entry-project-exists`                |
| Domain folders                                    | audit               | `domain-playbook-exists`, `domain-folder-name-matches`                                         |
| Manifest freshness                                | audit               | `manifest-stale`                                                                               |
| Templates (Mustache placeholders)                 | audit               | `template-placeholder-valid`                                                                   |
| Router log (intent vocabulary drift)              | audit               | `router-vocab-miss`, `router-skill-exists`                                                     |
| Changes (lifecycle states + PR-frozen invariants) | audit               | `change-body-template-placeholder`, `changes-pr-frozen`, `change-size-enum`                    |
| PR-review cache                                   | audit               | `pr-review-cache-orphan`                                                                       |
| events.db (schema + freshness)                    | audit               | `events-db-schema-mismatch`, `events-db-stale`, `events-skill-attribution-missing`             |
| MCP manifests + .mcp.json                         | audit               | `mcp-tool-orphan`, `mcp-config-stale`                                                          |
| Notification rules                                | audit + dismissable | `notification-rule-orphan`, `notification-rate-limit-exceeded`, `notification-delivery-failed` |
| Runbooks with project: field                      | audit               | `runbook-orphan`                                                                               |
| Research-report `notes_log`                       | audit               | `notes-unconsidered-stale`                                                                     |
| Dismissed-action-items                            | audit               | `dismissed-action-items-stale`                                                                 |
| env vars (process.env reads)                      | audit               | `env-var-undocumented`                                                                         |
| Audit-check registry consistency                  | audit               | `audit-check-id-documented` (self-check)                                                       |
| Long-running skill runs (PID alive vs row state)  | sweeper             | `runs-db.mjs::sweepOrphanedRuns` (every 5 min)                                                 |
| Vault raw/ staleness                              | scheduler           | `runbook-weekly-curation-check`                                                                |
| OS health (cross-cutting)                         | scheduler           | `runbook-weekly-health-check` (writes dated summary)                                           |
| Project lifecycle escape hatches                  | reopen affordance   | `meta-reopen-project` skill + dashboard Reopen button                                          |
| Research-report verdict overrides                 | reopen affordance   | `meta-mark-research-approved` skill + dashboard Mark approved action                           |
| Known-broken findings                             | dismissable         | `.claude/state/dismissed-action-items.jsonl` + Overview "Show dismissed" toggle                |

## Known gaps (work in progress)

State surfaces that don't yet have full coverage. Each is a candidate for a future change.

- **`schedule-report` runbook frontmatter drift** — `meta-add-schedule` is the canonical writer now (per `schedule-report-delegates-to-meta-add-schedule`), but if a user hand-edits a runbook's `schedule:` to something invalid, the scheduler tick may silently skip it. Could ship `runbook-schedule-invalid` (cron syntax validator).
- **Notification template — missing per-event override** — when a rule references an event_type with no template, the renderer falls back to `notification-default.md` (by design). But the default's prose is bare. Could add an info-level `notification-template-missing-override` for high-fire events that would benefit from richer messages.
- **Stepper step → event_type catalog binding** — the `lifecycle_step` column in `event-catalog.md` is now the source of truth; if a stepper component renders a step id that has no catalog entry, the bell silently disappears. Could ship `stepper-step-uncatalogued` (detect via static analysis of the stepper components).
- **Shared types `process.env.<X>` dynamic indexing** — the `env-var-undocumented` check only catches static accesses. Dynamic accesses like `process.env[varName]` slip through. Acceptable for now (dynamic accesses are rare + typically in loader infrastructure); could ship a stricter check if drift becomes an issue.

## Anti-patterns

Things that LOOK like load-bearing state but shouldn't have hooks:

- **Per-render cache contents** — the render-cache LRU in `notifications/render.ts` is internal optimization; cache invalidation logic owns its own correctness.
- **Vite/build outputs** — `dist/`, `.vite/` are derived; rebuild on demand.
- **Per-session UI state** — drawer open/closed, tab selection, scroll position. Client-side ephemera.
- **events.db rows themselves** — individual events are append-only audit; correctness lives at the schema + attribution level (those have checks).
- **Logs** — `vault/raw/*.jsonl` are append-only; correctness lives at the event-store level.

## Severity guidance for new coverage

Match the severity model in [[standard-os-audit]]:

- **error** — the OS is broken in a way that needs action now (e.g., invalid YAML, broken cross-reference, schema mismatch).
- **warn** — drift that hides real misconfiguration (orphan attribution, undocumented secret, dead-letter findings).
- **info** — advisory state worth knowing about but not actionable as a bug (rate limits biting by design, stale-but-still-valid timestamps).

When in doubt, start with `warn` and demote to `info` if the noise outweighs the signal.

## Related

- [[standard-os-audit]] — operational standard for the audit script (severity model, check registry, how to add)
- [[standard-env-config]] — per-surface `.env` pattern enforced by `env-var-undocumented`
- [[standard-event-store]] — events.db schema + attribution rules enforced by multiple events-\* checks
- [[archetype-runbook]] — the artifact the scheduler tick fires; coverage via `runbook-orphan` + the scheduler's own state
