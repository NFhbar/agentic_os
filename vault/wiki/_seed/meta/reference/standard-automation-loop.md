---
id: standard-automation-loop
type: reference
domain: meta
created: 2026-06-02T01:30:00Z
updated: 2026-06-02T01:30:00Z
tags: [standard, automation, orchestrator, change-lifecycle]
source: vault/wiki/development/change/change-automation-phase-2-orchestrator.md
private: false
title: Standard — change-automation loop (v1)
url: internal://standard/automation-loop
kind: standard
last_verified: 2026-06-02
---

# Standard — change-automation loop (v1)

The canonical loop the per-change orchestrator drives. Single source of truth for the step vocabulary, ordering, transition rules, and extension points. The data layer (see [[archetype-change]] § Automation) stores `current_step` as a free-form string so this standard can evolve without frontmatter migrations.

## Scope

Applies to changes with:

- `automation.enabled === true`
- `review_status === 'approved'` (OR `'not-required'`, `'overridden'`) — the human has signed off on the plan; automation runs the _implementation_, not the _judgment_
- `automation.state.phase ∈ {idle, running}`

**Why review_status, not status.** PLAN and plan-review stay manual by design (the human reads the auto-drafted plan + decides whether the approach is sound). Once the plan is approved, `status` is still `planning` — the change hasn't started executing yet. The orchestrator's first step (EXECUTE) is what transitions `status: planning → in-progress`. So gating on `status: in-progress` would make automation impossible to start; the gate is `review_status: approved` instead.

Out of scope (deferred to future loops):

- Cross-repo coordination (one change → multiple repos)
- Deploy / release steps
- Pre-flight integration tests

## The v1 loop

```
EXECUTE  ──▶  OPEN-PR  ──▶  PR-REVIEW  ──┬─ no blockers ──▶  complete
                                          │                  (PR open + reviewed clean,
                                          │                   awaiting human merge)
                                          │
                                          └─ needs-changes ──▶  ADDRESS-COMMENTS  ──▶  PR-REVIEW
                                                                (loops; iteration_count++
                                                                 when entering address-comments;
                                                                 parks at iteration_cap)
```

`dev-pr-review` walks an open PR (not a local branch) — that's why OPEN-PR precedes PR-REVIEW. Boundary: automation stops at `complete`. The GitHub-side merge is the human's call.

## Step vocabulary (v1)

| `current_step`     | Skill dispatched                           | What it does                                                                        |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `execute`          | `dev-write-change` (EXECUTE phase)         | Plan is approved; writer creates branch, follows plan, runs tests, commits + pushes |
| `open-pr`          | `dev-open-pr`                              | Opens the GitHub PR for the change's branch via the github MCP                      |
| `pr-review`        | `dev-pr-review`                            | Walks the open PR's diff + repo conventions, writes verdict + inline comments       |
| `address-comments` | `dev-write-change` (address-comments mode) | Folds inline review comments into code, commits + pushes follow-up                  |

**Free-form string at the data layer.** New step kinds (deploy, notify, analyze, …) can be introduced without an archetype migration — the orchestrator's `decideNextChangeStep` function gets new cases; the parser keeps reading `current_step` as a string. Unknown step values fall back to `park` with reason `unknown-step` (forward-compat safety).

## Transition rules

`decideNextChangeStep(current_step, iteration_count, iteration_cap, last_exit, pr_review_status)` is a pure function — same inputs → same outputs, no I/O. Returns one of three actions: `dispatch` (advance to next step) · `park` (transition `phase: paused` with a reason) · `complete` (transition `phase: complete`, terminal).

| current_step       | last_exit | pr_review_status                     | Decision                                                                                                                                                                                                                                                      |
| ------------------ | --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any                | ≠ 0       | any                                  | **park** — `skill-failure: <step> exited <exit>`                                                                                                                                                                                                              |
| `null` (fresh)     | 0         | —                                    | **dispatch** `execute`                                                                                                                                                                                                                                        |
| `execute`          | 0         | —                                    | **dispatch** `open-pr`                                                                                                                                                                                                                                        |
| `open-pr`          | 0         | —                                    | **dispatch** `pr-review`                                                                                                                                                                                                                                      |
| `pr-review`        | 0         | `needs-changes`                      | If `iteration_count < iteration_cap` → **dispatch** `address-comments`; else **park** — `iteration-cap-reached`                                                                                                                                               |
| `pr-review`        | 0         | `pending` / `ready-for-human` / null | **complete** — orchestrator also flips `pr_review_status: pending → ready-for-human` + stamps `pr_ready_at` (vault-only, same as dev-mark-pr-ready). Fires `dashboard.mark-pr-ready` audit so the lifecycle stepper + subscribed notification rules light up. |
| `address-comments` | 0         | —                                    | **dispatch** `pr-review` (re-review the follow-up commit)                                                                                                                                                                                                     |
| any unknown        | 0         | —                                    | **park** — `unknown-step` (forward-compat fail-safe)                                                                                                                                                                                                          |

## Iteration counting

- Increments **when entering** `address-comments` (each time the orchestrator dispatches it).
- Cap check fires **before** dispatching `address-comments` — if `iteration_count >= iteration_cap`, the orchestrator parks instead.
- Default `iteration_cap`: **4**. Configurable per-change in the `automation:` block.
- `iteration_count` resets only on explicit user action: `POST /api/changes/:id/automation/reset` (full state wipe) or `POST /api/changes/:id/automation/resume {reset_iteration: true}`.

Mental model: cap N means up to N `address-comments → pr-review` loops before parking. If the reviewer is still surfacing new concerns after N passes, automation steps aside.

## Pause reasons (v1)

Free-form string at the data layer. Canonical orchestrator-written values:

| `paused_reason`                                                | When it's set                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `skill-failure: <step> exited <exit>`                          | Any orchestrator-dispatched run exits non-zero                                      |
| `iteration-cap-reached: N loops`                               | `pr-review` returns `needs-changes` while `iteration_count >= iteration_cap`        |
| `unknown-step: '<step>' — orchestrator vocabulary out of sync` | `current_step` value isn't in the canonical v1 set (forward-compat)                 |
| `dispatch-failure: <error>`                                    | `startRun` returned an error (e.g. blocked by an in-flight run for the same change) |
| `user-paused`                                                  | Manual pause via `POST /api/changes/:id/automation/pause`                           |

New reasons can be added by orchestrator updates without frontmatter migration.

## Phase machine (closed enum)

| `state.phase` | Meaning                                                          | Transitions out                                                     |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `idle`        | Automation enabled; no skill in flight; eligible to dispatch     | → `running` (via Start endpoint or auto-tick when conditions match) |
| `running`     | Orchestrator dispatched a skill; awaiting run terminal           | → `running` (next step), `paused` (gate hit), or `complete`         |
| `paused`      | Halted on a gate or user action; needs manual Resume / Reset     | → `idle` (via Resume) or stays paused                               |
| `complete`    | Terminal — PR open, locally reviewed clean, awaiting human merge | → `idle` (via Reset, restarts the loop)                             |

**Phase is a closed enum.** Adding a phase is a deliberate orchestrator + UI change — not a config tweak. Free-form `current_step` and `paused_reason` are the canonical extension points.

## Endpoints (reference)

All under `/api/changes/:id/automation/`. Source: `domains/meta/app/server/routes/automation.ts` (`changeAutomationRoutes` plugin).

| Verb | Path       | Effect                                                                                         |
| ---- | ---------- | ---------------------------------------------------------------------------------------------- |
| GET  | `/`        | Returns the change's automation block + a small change summary (title, status, pr_url, etc.)   |
| POST | `/enable`  | Toggle on; initializes block if absent; takes optional `iteration_cap` override                |
| POST | `/disable` | Toggle off; preserves `state.*` so re-enabling resumes from same point                         |
| POST | `/start`   | Manual kick — required for first dispatch and post-Resume restart                              |
| POST | `/pause`   | Set `phase: paused, paused_reason: 'user-paused'`                                              |
| POST | `/resume`  | Set `phase: paused → idle`; optional `reset_iteration: true` clears counter                    |
| POST | `/reset`   | Wipe state to initial (phase: idle, current_step: null, iteration_count: 0); enabled unchanged |

## Auto-tick

`onChangeAutomationStepComplete(changeId, skill, exitStatus, runId)` runs from `runs.ts`'s close handler on every run terminal. Match conditions:

- Change has `automation.enabled === true`
- `state.phase === 'running'`
- `state.last_run_id === runId` (rejects stale ticks)

When matched: reads the change frontmatter for `pr_review_status` (the latest pass's verdict), calls `decideNextChangeStep`, applies the result (dispatch / park / complete).

Stale ticks (mismatched `last_run_id`) silently no-op — they happen when the user manually reset or this was an orphan dispatch.

## Related

- [[archetype-change]] § Automation — frontmatter schema
- [[change-automation-phase-1-data-model]] — data model history
- [[change-automation-phase-2-orchestrator]] — orchestrator implementation
- [[change-automation-phase-3-detail-panel]] — UI surface
- [[standard-change-workflow]] — broader change lifecycle this loop runs inside
- [[standard-git-hygiene]] — branch + commit conventions the orchestrated steps respect
