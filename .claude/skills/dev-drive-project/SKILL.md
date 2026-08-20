---
name: dev-drive-project
description: 'Drive a project''s scaffolded changes through their lifecycle in parent_change dependency order — derive each change''s state fresh from the vault, dispatch the next node through the same endpoints the dashboard buttons call (stamped origin: driver), watch by artifact, and hand back at every human gate. Happy path only: any park, failure, or ambiguity stops the drive and returns control to the operator.'
user-invocable: true
recommended_effort: high
version: 1
domain: development
tags: [project, driver, orchestration, lifecycle, happy-path]
wall_time_cap_minutes: 240
inputs:
  project:
    type: string
    required: true
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Project id (slug). Must match an existing `type: project` entry. The driver drives the changes that carry `project: <id>`.'
  max_changes:
    type: number
    required: false
    description: 'Stop after driving this many changes in one invocation. Unset means "keep going until a hand-back or until every change is terminal" — in practice the human merge gate ends most invocations well before any cap.'
  spend_cap_usd:
    type: number
    required: false
    description: 'Hard stop before the dispatch that would push this invocation''s cumulative driver-dispatched spend past this number. Unset means no cap is enforced; the drive report always states the spend either way.'
  dry_run:
    type: boolean
    required: false
    default: false
    description: 'Derive the queue and the next node for every change and print the plan, dispatching nothing. Costs one cheap read pass and is the right first call on an unfamiliar project.'
  api_port:
    type: number
    required: false
    default: 5174
    description: 'Port the OS API (Fastify) is listening on. Must match the running dashboard — the driver dispatches through HTTP, not through the Skill tool.'
outputs:
  - kind: process
    description: 'One run per dispatched node, created through POST /api/runs with origin: driver (visible in the Processes list as [driver] …). The change-automation inner loop dispatches its own runs under origin: automation.'
  - kind: event
    path: '.claude/state/events.db (kind: dashboard, action: drive-project, project: <project>)'
  - kind: text
    description: 'The drive report — every node the driver evaluated, what it dispatched, where it stopped and what the operator must do next.'
spawns: [dev-write-change, dev-review-change, dev-revise-plan, dev-close-change, meta-overseer-review]
---

# dev-drive-project

## Purpose

Sequence a project's scaffolded changes through the lifecycle so the **edges between nodes** stop living in an operator's head. Every node — plan, plan-review, execute, open-PR, PR-review, close, audit — is already a skill with its own gates. What nobody owns is the transition: which node follows which, what must be true before dispatching it, how to tell it actually finished, and when the answer belongs to a human. This skill owns exactly that, and nothing else.

Three properties define what it is:

**It is an optional outer layer.** Every node skill, dashboard button, and API endpoint stays primary and unchanged. The driver calls the same endpoints the buttons call. It writes no state of its own — no lock, no claim, no driver-only field. An operator can run a whole project by hand with the driver absent, take over mid-drive, or hand back to it later; nothing about the driver has to be stopped or told.

**It derives state fresh, every time.** Before every gate the driver re-reads the change entry and the artifacts on disk. It never acts on what it remembers from earlier in the same invocation. This is what makes mixed-mode safe: a step the operator completed by hand simply reads as done, and the driver moves to the next gate. It is also the resume mechanism — a killed drive resumes by being invoked again.

**It is the happy path only.** v1 has no recovery table. A park, a non-zero exit, a run that exited clean without moving its artifact, a review verdict that needs judgment, a dependency chain it cannot read — each is a full stop with a named next action for the operator. Classifying parks (session-limit kill, wall-cap kill, auth wall, skill refusal, transport failure) and re-dispatching with the right framing is deferred to **v2**. Do not improvise it here: the value of v1 is that at every friction point its behavior is identical to today's manual mode, so a stop is never worse than what the operator would have gotten anyway.

The driver is **never self-engaging**. It runs only when explicitly invoked — `/os drive project <id>` or a direct call. There is no schedule, no runbook, no daemon, and no auto-adoption of active projects. Do not propose one.

The driver is **tracker-agnostic**. Its queue comes from change entries in the vault. A change scaffolded from a tracker issue and a change founded by hand are indistinguishable at drive time; the driver reads no external tracker and calls no tracker API.

## Inputs

`project` (required) is the only thing the driver needs. `dry_run`, `max_changes`, `spend_cap_usd`, and `api_port` are the optional controls described in the frontmatter above — restated here because a dispatched run reads this file as text and never processes that block:

- `dry_run: true` — derive and print, dispatch nothing.
- `max_changes: <n>` — stop after `n` changes have been driven in this invocation.
- `spend_cap_usd: <n>` — refuse the dispatch that would cross this cumulative spend, and stop.
- `api_port: <n>` — where the OS API is listening (default `5174`).

A persistent operator-level spend default is deliberately not added in v1: the Settings surface writes git-tracked frontmatter, which is a standing dirty-tree hazard for the very EXECUTE dispatches this driver is about to make.

## Preconditions

1. **The OS API must be up.** The driver dispatches through HTTP so its runs are attributed and appear in Processes exactly like button-pressed ones. Probe `curl -sf http://localhost:<api_port>/api/health`. If it does not answer, stop: `⊘ OS API not reachable on <api_port> — start the dashboard (/os dashboard) and re-invoke.` Do **not** fall back to invoking node skills through the Skill tool: that path stamps no origin, creates no run row, and is invisible to every surface an operator watches.
2. **The project must exist.** Read `vault/wiki/*/project/<project>.md`. If missing or `type != project`, stop with `⊘ project "<project>" not found`.
3. **The project must be active.** A `status` of `completed` or `cancelled` stops the drive: `⊘ project "<project>" is <status> — reopen it (/os reopen project <id>) before driving.`

## Procedure

### Step 1 — Build the queue in dependency order

Run the resolver rather than sorting by hand; it is the deterministic, tested definition of the queue (`tests/unit/lifecycle/drive-order.test.ts`):

```bash
node scripts/drive-order.mjs --project <project> --json
```

It walks every `type: change` entry in the vault, takes the ones carrying `project: <project>` in `created` order (which is the order the scaffolders wrote them, i.e. the owning artifact's order), pulls in any out-of-project `parent_change` ancestors as gating-only records, topologically sorts the whole set on `parent_change`, and returns:

- `ordered[]` — every record with `terminal` and `blocked_by` annotated
- `next` — the one change to drive now, or `null`
- `remaining` — how many in-scope changes are still live
- `stop` — `null`, or `{reason, detail, ids}`

`stop` is a hard stop for the whole drive. Its reasons and what each means:

| `stop.reason`                       | what the driver found                        | hand-back                                                            |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `no-changes`                        | no change entry carries `project: <project>` | scaffold the project's changes first                                 |
| `unresolved-parent`                 | a `parent_change` names an id no entry has   | fix the `parent_change` field, or create the missing entry           |
| `dependency-cycle`                  | `parent_change` chains do not terminate      | break the cycle in the named entries                                 |
| `blocked-out-of-scope`              | a live parent belongs to another project     | drive or close that parent first — the driver will not reach outside |
| `duplicate-id` / `malformed-record` | two entries share an id, or one has none     | fix the vault entries                                                |

`next: null` with `stop: null` means every change in the project is terminal. Report that as success and finish.

Print the ordered queue in the drive report whatever happens — it is the cheapest artifact of the run and the thing an operator wants first.

### Step 2 — Re-derive the change's state

**Do this immediately before every gate evaluation, and again after every run terminates.** Anything you learned earlier in this invocation is stale by contract; an operator may have hand-advanced the change while you were watching a run.

Read the change entry at its path from step 1 and parse the frontmatter (js-yaml, so nested `automation.*` values are real values). Read directly from the file — not from a cached response and not from memory. The fields the gates below use:

`status` · `review_required` · `review_status` · `plan_path` · `plan_generated_at` · `plan_revision` · `review_path` · `reviewed_at` · `pr_url` · `pr_review_status` · `pr_review_path` · `automation.enabled` · `automation.state.phase` · `automation.state.current_step` · `automation.state.paused_reason` — plus the body, for `> **DRAFT** —` markers.

### Step 3 — Pick the node from the sequence table

Evaluate top to bottom; the first row whose gate holds is the node. Every gate is a **premise check against the frontmatter the server itself reads** — that is the whole point of it, because a dispatch whose premise was already false is a paid no-op.

| #   | node                       | gate (all must hold)                                                                                                                             | driver action                                | postcondition to verify                                                                    |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **draft acceptance**       | body contains `> **DRAFT** —`                                                                                                                    | **HUMAN** — hand back                        | markers gone                                                                               |
| 2   | **plan**                   | no DRAFT markers · `plan_path` unset or its file missing · `status` ∈ {planning}                                                                 | dispatch `dev-write-change` (PLAN)           | `plan_path` set, file exists, `plan_generated_at` later than the baseline                  |
| 3   | **plan-review**            | `review_required: true` · `plan_path` set and readable · `review_status: pending` · `reviewed_at` unset or earlier than `plan_generated_at`      | dispatch `dev-review-change`                 | `review_path` set and readable · `reviewed_at` moved · `review_status` no longer `pending` |
| 4   | **revise**                 | `review_status: request-changes` · the revise budget for this change is unspent (see below)                                                      | dispatch `dev-revise-plan`, then re-enter #3 | `plan_revision` bumped · `plan_revised_at` moved                                           |
| 5   | **inner loop**             | `review_status` ∈ {approved, overridden, not-required} · `plan_path` set · `status` ∉ {merged, abandoned} · `automation.state.phase` ∉ {running} | `POST …/automation/enable` then `…/start`    | `automation.state.phase` reaches `complete`                                                |
| 6   | **triage · ready · merge** | `automation.state.phase: complete` (PR open, locally reviewed clean) — or `pr_url` set with `status: in-review` reached by hand                  | **HUMAN** — hand back                        | PR merged on GitHub                                                                        |
| 7   | **close**                  | `pr_url` set · PR merged on GitHub · `status` ∉ {merged, abandoned} · no `status: new` comments on the latest pr-review pass                     | dispatch `dev-close-change`                  | `status: merged` · `merged_at` stamped                                                     |
| 8   | **audit**                  | `status: merged` · owning project has `audit.enabled: true` · no `vault/wiki/meta/lifecycle-audit/audit-<change>.md`                             | dispatch `meta-overseer-review`              | the lifecycle-audit entry exists                                                           |
| 9   | **done**                   | `status` ∈ {merged, abandoned} and #8's gate does not hold                                                                                       | move to the next change in the queue         | —                                                                                          |

Notes that bind on every run of this table:

- **Row 3's verdict postcondition.** `dev-review-change` writes one of `approved` / `request-changes` / `rejected`. A `review_status` still reading `pending` after the run means the review did not land — treat it as no artifact movement (step 5) and stop, regardless of exit code.
- **`rejected` is always a hand-back.** Never dispatch `dev-revise-plan` against a rejected plan; rejection says the approach is wrong, which is a judgment the operator owns.
- **The revise budget is one cycle per change per invocation.** After one `revise → re-review` round trip, a second `request-changes` hands back. A reviewer still surfacing new concerns after a fold is a signal about the plan, not a loop to grind.
- **`review_required: false`** means row 3 and row 4 never fire; row 5's gate accepts `review_status: not-required` directly.
- **Row 7's disposition gate** is the belt to `dev-close-change`'s own braces: if the latest pass on `pr_review_path` still has comments at `status: new`, do not dispatch close — hand back to triage (row 6's wording). Same check gates the operator's Mark-ready in row 6.
- **Row 8 respects the project's opt-in.** No `audit.enabled: true` on the project means the audit node does not exist for this change; do not pass `force: true` to conjure it.

### Step 4 — Dispatch

Compose the prompt in the dashboard's shape — a run of the node skill, the skill file to read, the inputs, and the non-interactive contract — and `POST /api/runs`:

```bash
curl -s -X POST "http://localhost:<api_port>/api/runs" \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "<see below>",
    "title": "<node> for <change-id>",
    "tags": {"skill": "<node-skill>", "change_id": "<change-id>", "project": "<project>", "repo": "<repo>", "domain": "<domain>"},
    "origin": "driver"
  }'
```

**`"origin": "driver"` is mandatory on every dispatch.** It is a validated field (the server rejects anything outside `human | automation | scheduler | driver` with HTTP 400), and it is the only reason the Processes list can answer "who started this" while a drive and a human share a project. Omitting it silently stamps `human` and makes the drive indistinguishable from hand-work.

The prompt body always carries the non-interactive declaration, because the child is a headless `claude -p` with nobody at the keyboard:

```
Run the <node-skill> skill for change "<change-id>".
Read .claude/skills/<node-skill>/SKILL.md and follow its Procedure exactly.

Inputs:
- change: "<change-id>"

IMPORTANT — headless driver-dispatched call:
- Do NOT use AskUserQuestion or any interactive prompt.
- Follow the skill's own gates. If a gate refuses, print the refusal and stop — do not work around it.
- Report a short summary of what ran and what the next step is.
```

**The driver's own run must never be tagged with a `change_id`,** and its own prompt must not contain a `change:` input line. `startRun` blocks any dispatch for a change that already has a live run, and it also derives `change_id` from the prompt text — so a driver run attributed to a change would refuse every dispatch it then tried to make for that change. Tag the driver's own run with `project` only. Whoever dispatches this skill (a Drive button, a scheduler, a human) has to honor that; it is the one attribution mistake that breaks the driver silently.

Response handling:

- `{"run_id": "..."}` → watch it (step 5).
- HTTP 409 `{"error": "blocked", ...}` → another run is already in flight for this change. Stop; report the blocking run id and skill. Do not cancel it.
- HTTP 409 `{"refusal": "head-unchanged"}` → the server debounced a re-review because the branch head has not moved. Stop; this is a premise the driver was wrong about, and forcing past it is a v2 judgment call at best.
- HTTP 400 → the body was rejected (bad origin, missing prompt). Stop and quote the error; it is a driver bug, not a lifecycle condition.

For the **inner loop** (row 5) the dispatch is two gestures instead of one, against the change-automation endpoints the Automation panel uses:

```bash
curl -s -X POST "http://localhost:<api_port>/api/changes/<change-id>/automation/enable"
curl -s -X POST "http://localhost:<api_port>/api/changes/<change-id>/automation/start"
```

Both return the change's automation block. A `400` from `enable` is the eligibility gate or the clean-tree gate refusing — quote the `error` verbatim and stop; both are conditions a human resolves. The runs the orchestrator then dispatches carry `origin: automation`, which is correct and deliberate: they are the orchestrator's runs, not the driver's, and the driver does not relabel them. The driver's own footprint for row 5 is the two gestures, recorded as `change-automation-enable` / `change-automation-*` events.

### Step 5 — Watch by artifact

Exit codes lie in both directions: a skill can refuse cleanly and exit 0, and a killed run can leave complete artifacts behind. **The run terminating is permission to look; the artifact is what decides.**

Poll the run at a ~20-second cadence until it reaches a terminal state, in one blocking command rather than a burst of short ones:

```bash
API="http://localhost:<api_port>"; RUN="<run_id>"; misses=0
for i in $(seq 1 360); do
  body=$(curl -s --max-time 10 "$API/api/runs/$RUN")
  state=$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).run;console.log(`${r.state} ${r.exit_status} ${r.cost_usd}`)}catch{console.log("")}})')
  if [ -z "$state" ]; then
    misses=$((misses+1))
    [ "$misses" -ge 10 ] && { echo "UNREADABLE after $misses consecutive failed reads"; break; }
    sleep 20; continue
  fi
  misses=0
  case "$state" in
    done*|failed*|cancelled*|died-after-writeback*) echo "TERMINAL $state"; break ;;
  esac
  sleep 20
done
```

For the inner loop, poll `GET /api/changes/<change-id>/automation` on the same cadence instead, until `automation.state.phase` is `complete` or `paused`. (That GET also runs the orchestrator's park reconciliation, so a park an operator finished by hand clears while the driver watches.)

Then, and only then:

1. **Re-read the change entry from disk** (step 2 again).
2. **Check the node's postcondition** from the sequence table's last column, against the baseline you recorded before dispatching.
3. Advance only when the artifact moved. Otherwise stop — see step 6.

Two boundaries on the watch itself:

- **A failed HTTP read is not a run outcome.** The dev server restarts on file changes, so a refused connection mid-poll is routine. Re-poll. Ten consecutive failed reads (the `UNREADABLE` branch above — several minutes) is a different thing: stop with `⊘ OS API unreadable across 10 consecutive polls while watching <run_id> — the run may still be live; check the Processes list.` Never write a run off as failed because a read failed. This is refusing to invent an outcome, not recovering one.
- **The loop above bounds the wait at two hours.** If it expires with the run still live, stop and report the run id — do not cancel it. This skill's own `wall_time_cap_minutes: 240` is set high for the same reason: a drive that watches a real EXECUTE plus a PR review is legitimately long, and the derived 25-minute floor would kill it mid-watch.

### Step 6 — Stop conditions

Stop the entire drive — do not try the next node, do not move to the next change — on any of:

| condition                                                | how it presents                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| run terminal with non-zero exit                          | `state: failed`, or `done` with `exit_status != 0`                    |
| run exited clean, artifact did not move                  | postcondition check fails after a `done`                              |
| `died-after-writeback`                                   | terminal but silently killed — verify by artifact and stop either way |
| automation `phase: paused`                               | quote `paused_reason` verbatim                                        |
| dispatch refused (409 blocked / debounced, 400)          | quote the error                                                       |
| resolver `stop` (step 1)                                 | quote `reason` + `detail`                                             |
| human gate reached (rows 1, 6; `rejected`; budget spent) | not a failure — a clean hand-back                                     |
| spend cap would be crossed                               | before the dispatch, never after                                      |
| `max_changes` reached                                    | clean stop between changes                                            |
| anything the table above does not describe               | stop and say so plainly                                               |

The last row is load-bearing. An ambiguous state is a stop in v1, not an improvisation.

### Step 7 — Next change, or report

When a change reaches row 9 (terminal, audit satisfied or not applicable), re-run **step 1** — the whole resolver, not a cached queue — and continue with the new `next`. Re-running it is what lets a change an operator merged and closed by hand drop out of the queue mid-drive.

When the drive ends for any reason, record one event and print the report.

```bash
node scripts/record-dashboard-action.mjs \
  --action drive-project \
  --skill dev-drive-project \
  --args '{"project":"<project>","queue":["<id>",...],"changes_driven":["<id>",...],"nodes":[{"change":"<id>","node":"<node>","run_id":"<id>","outcome":"advanced|stopped"}],"stopped_at":"<node or gate>","stop_reason":"<reason>","spend_usd":<n>,"dry_run":<bool>}' \
  --description 'drove <project>: <n> node(s), stopped at <node> — <reason>'
```

No `--files-touched`: the driver writes no files. That is not an omission, it is the contract — the driver holds no state the manual surfaces cannot read.

## Outputs

- **Runs** — one per dispatched node, created through `POST /api/runs` with `origin: driver`, so the Processes list renders them `[driver] …`. Inner-loop runs belong to the orchestrator and carry `origin: automation`.
- **One event** — `action: drive-project` in `.claude/state/events.db` (and `vault/raw/dashboard-actions.jsonl`), carrying the queue, the nodes attempted, where it stopped and why.
- **The drive report** — printed at the end, in this shape:

```
▶ Drive <project> — <n> change(s) in queue

  queue (dependency order):
    ✓ <change-id>            merged
    ▶ <change-id>            in-progress   ← driven this invocation
    · <change-id>            planning      (waits on <parent-id>)

  this invocation:
    <change-id>  plan          → run <id>  ✓ plan_path written
    <change-id>  plan-review   → run <id>  ✓ approved
    <change-id>  inner loop    → enable+start  ⊘ paused: skill-refused: execute exited 0 without artifact movement — …

⊘ Stopped at inner loop on <change-id>
  reason:  <paused_reason / error / gate, verbatim>
  next:    <the one thing the operator does>
  spend:   $<n.nn> across <k> driver-dispatched run(s)
```

The `next:` line is the deliverable of a stop. Name the concrete gesture — the button, the skill, the file to edit — not "investigate".

## Human gates and headless behavior

The driver **never asks a question**. Every gate that needs a human is a clean stop with the pending artifact left exactly where it is, and the dashboard fully operable on the same entities. Designing the gates out this way is the standard's preferred option ([[standard-skill-format]] § Headless behavior) and it makes the driver's behavior identical whether a human is watching or it was itself dispatched headless from a Drive button. Stated per gate, in the standard's vocabulary:

- **Draft acceptance** (row 1) — `Headless: park`. Print the drafted sections' location and stop; never strip `> **DRAFT** —` markers on the operator's behalf.
- **Plan-review verdict `rejected`, or `request-changes` with the revise budget spent** (row 4) — `Headless: park`. Quote the verdict and the review path.
- **Comment triage · Mark ready · PR merge** (row 6) — `Headless: park`. State which of the three are outstanding: undispositioned comments (count + pass), `pr_review_status` not yet `ready-for-human`, PR not merged.
- **Force or destructive operations** — `Headless: refuse`. v1 performs none. It never merges a PR, never passes `force: true` or `override: true` to a node skill, never resets or resumes a parked automation block, never cancels a run, and never edits a change entry's frontmatter. Every one of those is an operator gesture.
- **Spend beyond `spend_cap_usd`** — `Headless: park`. Stop before dispatching, with the cumulative figure.

Resuming after any of these is just invoking the driver again: it re-derives everything from the vault and picks up wherever the operator left it.

## Errors

- **API not reachable at start** → `⊘ OS API not reachable on <port>` + start the dashboard. No dispatches.
- **API unreachable mid-watch** → tolerate and re-poll; stop after ten consecutive failures without declaring the run failed.
- **Project missing / not `type: project` / closed** → stop with the id and the state (preconditions above).
- **Resolver `stop`** → quote `reason` + `detail`; the queue is unsound and no dispatch is safe.
- **Dispatch blocked (409)** → another run owns this change; report its id and skill, stop, cancel nothing.
- **Re-review debounced (409 `head-unchanged`)** → the premise was false; stop rather than forcing.
- **Node run failed, or exited clean without moving its artifact** → stop and quote the run's summary; this is the `skill-refused` shape and the refusal text names what a human must fix.
- **Automation parked** → quote `paused_reason` verbatim and stop. Never Reset, Resume, or re-Start; a park whose named gate you bypass is the failure mode the guards exist to prevent.
- **Change entry unreadable / frontmatter parse error** → stop naming the file; a driver that guesses at a malformed entry is worse than one that stops.

## Boundaries — what v2 owns

Deliberately absent from v1, and not to be improvised into it:

- **The recovery table.** Classifying a park or kill (session-limit, wall-cap exit 143, auth wall, skill refusal, transport) and re-dispatching with the framing proven for that class. v1 stops instead. The one thing v1 does that resembles it — re-polling through a failed HTTP read — is refusing to fabricate a run outcome, not recovering a run.
- **Any bypass of a named gate.** If a refusal names a gate, that gate stands until a human moves it. This holds in v2 as well.
- **The report tier.** Driving `research-write → research-review → research-scaffold-recommendations` before the change queue exists. v1 starts from changes that are already scaffolded; when a project has none, it says so and stops.
- **A Drive affordance in the dashboard,** and any schedule, runbook, or auto-adoption. The first is a separate ticket; the rest are ruled out by design.

## See also

- [[standard-automation-loop]] — the change-tier inner loop row 5 delegates to: step vocabulary, artifact-verified advance, park reasons, endpoints
- [[archetype-change]] — the frontmatter the gates read
- [[standard-skill-format]] § Headless behavior — the gate-policy vocabulary used above
- [[dev-write-change]] · [[dev-review-change]] · [[dev-revise-plan]] · [[dev-close-change]] · [[meta-overseer-review]] — the nodes the driver dispatches
- `scripts/drive-order.mjs` — the queue resolver; its decision core is pure and unit-tested
