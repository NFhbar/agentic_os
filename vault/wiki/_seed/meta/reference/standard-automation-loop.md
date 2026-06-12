---
id: standard-automation-loop
type: reference
domain: meta
created: 2026-06-02T01:30:00Z
updated: 2026-06-12T00:00:00Z
tags: [standard, automation, orchestrator, change-lifecycle]
source: vault/wiki/development/change/change-automation-phase-2-orchestrator.md
private: false
title: Standard — change-automation loop (v1)
url: internal://standard/automation-loop
kind: standard
last_verified: 2026-06-12
---

# Standard — change-automation loop (v1)

The canonical loop the per-change orchestrator drives. Single source of truth for the step vocabulary, ordering, transition rules, and extension points. The data layer (see [[archetype-change]] § Automation) stores `current_step` as a free-form string so this standard can evolve without frontmatter migrations.

## Scope

Applies to changes with:

- `automation.enabled === true`
- `review_status === 'approved'` (OR `'not-required'`, `'overridden'`) AND `plan_path` set — the human has signed off on the plan; automation runs the _implementation_, not the _judgment_
- `automation.state.phase ∈ {idle, running}`

**Enforced, not just prose (since 2026-06-12).** Both `enable` and `start` reject (HTTP 400, reason carries this section's wording) when `review_status ∉ {approved, not-required, overridden}` OR `plan_path` is unset — via `checkChangeAutomationEligibility` in `automation-state-machine.ts`. The `plan_path` conjunct is deliberate: an eligible review_status (e.g. `not-required`) with no plan still has nothing for EXECUTE to follow.

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

`decideNextChangeStep(current_step, iteration_count, iteration_cap, last_exit, pr_review_status, comments_to_address?, artifact_moved?, artifact_detail?)` is a pure function — same inputs → same outputs, no I/O. Returns one of three actions: `dispatch` (advance to next step) · `park` (transition `phase: paused` with a reason) · `complete` (transition `phase: complete`, terminal).

**Artifact-verified advance (since 2026-06-12).** A clean exit alone is not proof of progress — a skill can REFUSE and still exit 0 (the 2026-06-12 incident: EXECUTE refused on a state mismatch, the orchestrator advanced to a ghost open-pr → pr-review). Each dispatch snapshots a baseline (`state.dispatch_baseline`: branch `head_sha` + a `head_degraded` flag when that read failed, `pr_url`, review `pass_count`); at verification time (auto-tick AND `start`'s re-evaluate path, which threads the previous run's recorded exit status) the orchestrator gathers observations and the pure `evaluateArtifactMovement(step, baseline, observed)` judges movement per step:

| step                           | artifact that must move                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute` / `address-comments` | new commits on the change branch (head ≠ baseline; absent ref = determinate no-movement)                                                                                                   |
| `open-pr`                      | `pr_url` set on the change entry (already-set counts: `dev-open-pr` is idempotent — a linked PR is the satisfied postcondition, so Reset → Start on a change with an existing PR advances) |
| `pr-review`                    | a new `## Pass <N>` on the linked pr-review entry                                                                                                                                          |

Degraded reads (repo entity missing, dir missing, git/spawn failure, no `branch:` configured) yield _unknown_ at **verification** time — the gate stays inert rather than false-parking on infrastructure hiccups. Absent baseline (states written before the gate existed) is also inert. A degraded read at **dispatch** time is different: the baseline's `head_sha: null` would masquerade as "branch absent" and any later head would read as movement (fail-open past a refusing run), so the snapshot carries `head_degraded: true` and verification parks as `verification-unavailable` instead of silently passing. Recovery: **Reset → Start** re-snapshots a fresh baseline.

| current_step       | last_exit               | pr_review_status                                  | Decision                                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any                | ≠ 0                     | any                                               | **park** — `skill-failure: <step> exited <exit>`                                                                                                                                                                                                                                        |
| any                | 0, artifact didn't move | any                                               | **park** — `skill-refused: <step> exited 0 without artifact movement — <detail>` (skill-failure takes precedence)                                                                                                                                                                       |
| any                | 0, baseline degraded    | any                                               | **park** — `verification-unavailable: cannot verify <step> artifact movement — <detail>` (movement can't be established against a degraded snapshot; never silently advance)                                                                                                            |
| `null` (fresh)     | 0                       | —                                                 | **dispatch** `execute`                                                                                                                                                                                                                                                                  |
| `execute`          | 0                       | —                                                 | **dispatch** `open-pr`                                                                                                                                                                                                                                                                  |
| `open-pr`          | 0                       | —                                                 | **dispatch** `pr-review`                                                                                                                                                                                                                                                                |
| `pr-review`        | 0                       | `needs-changes`                                   | If `iteration_count < iteration_cap` → **dispatch** `address-comments`; else **park** — `iteration-cap-reached`                                                                                                                                                                         |
| `pr-review`        | 0                       | `pending` / `approved` / `ready-for-human` / null | **complete** — orchestrator sets `pr_review_status: pending → approved` (loop-state: review clean, human triage + Mark ready pending). It no longer flips `ready-for-human` or fires `dashboard.mark-pr-ready` — that is exclusively the human's Mark-ready action (dev-mark-pr-ready). |
| `address-comments` | 0                       | —                                                 | **dispatch** `pr-review` (re-review the follow-up commit)                                                                                                                                                                                                                               |
| any unknown        | 0                       | —                                                 | **park** — `unknown-step` (forward-compat fail-safe)                                                                                                                                                                                                                                    |

## Iteration counting

- Increments **when entering** `address-comments` (each time the orchestrator dispatches it).
- Cap check fires **before** dispatching `address-comments` — if `iteration_count >= iteration_cap`, the orchestrator parks instead.
- Default `iteration_cap`: **4**. Configurable per-change in the `automation:` block.
- `iteration_count` resets only on explicit user action: `POST /api/changes/:id/automation/reset` (full state wipe) or `POST /api/changes/:id/automation/resume {reset_iteration: true}`.

Mental model: cap N means up to N `address-comments → pr-review` loops before parking. If the reviewer is still surfacing new concerns after N passes, automation steps aside.

## Pause reasons (v1)

Free-form string at the data layer. Canonical orchestrator-written values:

| `paused_reason`                                                               | When it's set                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill-failure: <step> exited <exit>`                                         | Any orchestrator-dispatched run exits non-zero                                                                                                                                                                                                                                                                                                     |
| `skill-refused: <step> exited 0 without artifact movement — <detail>`         | A run exited 0 but the step's expected artifact didn't move (skill refused / no-opped). `<detail>` carries the per-step fact + the refusing run's summary line when readable. Recovery: fix the cause, then **Reset → Start** to re-dispatch the step — Resume → Start re-verifies the artifact and (correctly) re-parks while it's still unmoved. |
| `verification-unavailable: cannot verify <step> artifact movement — <detail>` | The dispatch-time baseline snapshot was degraded (`head_degraded: true` — git head read failed at dispatch), so the artifact check is unanswerable. Parking beats silently advancing past a possibly-refusing run. Recovery: **Reset → Start** re-snapshots a fresh baseline and re-dispatches the step.                                           |
| `iteration-cap-reached: N loops`                                              | `pr-review` returns `needs-changes` while `iteration_count >= iteration_cap`                                                                                                                                                                                                                                                                       |
| `unknown-step: '<step>' — orchestrator vocabulary out of sync`                | `current_step` value isn't in the canonical v1 set (forward-compat)                                                                                                                                                                                                                                                                                |
| `dispatch-failure: <error>`                                                   | `startRun` returned an error (e.g. blocked by an in-flight run for the same change)                                                                                                                                                                                                                                                                |
| `user-paused`                                                                 | Manual pause via `POST /api/changes/:id/automation/pause`                                                                                                                                                                                                                                                                                          |

New reasons can be added by orchestrator updates without frontmatter migration.

## Phase machine (closed enum)

| `state.phase` | Meaning                                                                                                                       | Transitions out                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `idle`        | Automation enabled; no skill in flight; eligible to dispatch                                                                  | → `running` (via Start endpoint or auto-tick when conditions match) |
| `running`     | Orchestrator dispatched a skill; awaiting run terminal                                                                        | → `running` (next step), `paused` (gate hit), or `complete`         |
| `paused`      | Halted on a gate or user action; needs manual Resume / Reset                                                                  | → `idle` (via Resume) or stays paused                               |
| `complete`    | Terminal — PR open, locally reviewed clean (`pr_review_status: approved`), awaiting human comment triage + Mark ready + merge | → `idle` (via Reset, restarts the loop)                             |

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

When matched: reads the change frontmatter for `pr_review_status` (the latest pass's verdict), gathers artifact observations against `state.dispatch_baseline` (see § Transition rules — artifact-verified advance), calls `decideNextChangeStep`, applies the result (dispatch / park / complete).

Stale ticks (mismatched `last_run_id`) silently no-op — they happen when the user manually reset or this was an orphan dispatch.

## Related

- [[archetype-change]] § Automation — frontmatter schema
- [[standard-change-workflow]] — broader change lifecycle this loop runs inside
- [[standard-git-hygiene]] — branch + commit conventions the orchestrated steps respect

The orchestrator landed across four implementation phases (data model →
orchestrator core → UI surface → cap-reached handling). The per-phase change
entries live in the maintainer's vault (not shipped in `_seed/`) — see the
`change-automation-phase-*` entries on the canonical OS repo if you want to
read the implementation history.
