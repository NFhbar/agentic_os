---
name: dev-drive-project
description: 'Drive a project''s scaffolded changes through their lifecycle in parent_change dependency order — derive each change''s state fresh from the vault, dispatch the next node through the same endpoints the dashboard buttons call (stamped origin: driver), watch by artifact, and hand back at every human gate. When a node stops, classify the stop from its recorded evidence: infrastructure gets a bounded retry, everything else — refusals, failures, gates, anything unclassifiable — still hands back with the remedy quoted.'
user-invocable: true
recommended_effort: high
version: 2
domain: development
tags: [project, driver, orchestration, lifecycle, recovery]
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
  retry_budget:
    type: number
    required: false
    default: 2
    description: 'How many recovery retries one change may consume across this invocation. Only environmental stops (§ Step 6) ever spend it. `0` restores v1 exactly — every stop is a hand-back.'
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
    description: 'The drive report — every node the driver evaluated, what it dispatched, how every stop was classified, where it ended and what the operator must do next.'
spawns: [dev-write-change, dev-review-change, dev-revise-plan, dev-close-change, meta-overseer-review]
---

# dev-drive-project

## Purpose

Sequence a project's scaffolded changes through the lifecycle so the **edges between nodes** stop living in an operator's head. Every node — plan, plan-review, execute, open-PR, PR-review, close, audit — is already a skill with its own gates. What nobody owns is the transition: which node follows which, what must be true before dispatching it, how to tell it actually finished, and when the answer belongs to a human. This skill owns exactly that, and nothing else.

Three properties define what it is:

**It is an optional outer layer.** Every node skill, dashboard button, and API endpoint stays primary and unchanged. The driver calls the same endpoints the buttons call. It writes no state of its own — no lock, no claim, no driver-only field. An operator can run a whole project by hand with the driver absent, take over mid-drive, or hand back to it later; nothing about the driver has to be stopped or told.

**It derives state fresh, every time.** Before every gate the driver re-reads the change entry and the artifacts on disk. It never acts on what it remembers from earlier in the same invocation. This is what makes mixed-mode safe: a step the operator completed by hand simply reads as done, and the driver moves to the next gate. It is also the resume mechanism — a killed drive resumes by being invoked again.

**It recovers from the infrastructure, and only from the infrastructure.** When a node stops, the driver classifies the stop from the evidence the OS already recorded — the park reason, the run's error line, its journal, the exit shape — and acts per class (§ Step 6). An overloaded API, a transport blip, a dispatch that never started: bounded retry. A usage window with a reset time: stop and say when it clears. Everything else — a gate that refused, work that failed, a decision a human owns, evidence that does not resolve — is the v1 hand-back, unchanged, with the remedy quoted. The asymmetry is the design: a retry is only ever justified when nothing about the work has to change for it to succeed, and that is true of exactly one class.

The driver is **never self-engaging**. It runs only when explicitly invoked — `/os drive project <id>` or a direct call. There is no schedule, no runbook, no daemon, and no auto-adoption of active projects. Do not propose one.

The driver is **tracker-agnostic**. Its queue comes from change entries in the vault. A change scaffolded from a tracker issue and a change founded by hand are indistinguishable at drive time; the driver reads no external tracker and calls no tracker API.

## Inputs

`project` (required) is the only thing the driver needs. `dry_run`, `max_changes`, `spend_cap_usd`, and `api_port` are the optional controls described in the frontmatter above — restated here because a dispatched run reads this file as text and never processes that block:

- `dry_run: true` — derive and print, dispatch nothing.
- `max_changes: <n>` — stop after `n` changes have been driven in this invocation.
- `spend_cap_usd: <n>` — refuse the dispatch that would cross this cumulative spend, and stop.
- `retry_budget: <n>` — recovery retries one change may spend (default `2`; `0` = never retry).
- `api_port: <n>` — where the OS API is listening (default `5174`).

A persistent operator-level spend default is deliberately not offered: the Settings surface writes git-tracked frontmatter, which is a standing dirty-tree hazard for the very EXECUTE dispatches this driver is about to make.

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

- **Row 3's verdict postcondition.** `dev-review-change` writes one of `approved` / `request-changes` / `rejected`. A `review_status` still reading `pending` after the run means the review did not land — treat it as no artifact movement (step 5) and classify it (step 6), regardless of exit code.
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
- HTTP 409 `{"error": "blocked", ...}` → another run is already in flight for this change. Classify it (step 6, `--run-error 'blocked by run <id>'`): it comes back `environmental` / `wait`. Report the blocking run id and skill, and never cancel it — the driver does not cancel runs it did not start.
- HTTP 409 `{"refusal": "head-unchanged"}` → the server debounced a re-review because the branch head has not moved. Classify it (`skill-refusal`) and stop. Forcing past it is not a recovery: the premise the driver dispatched on was false, and `force: true` would buy a second review of identical code.
- HTTP 400 → the body was rejected (bad origin, missing prompt). Stop and quote the error; it is a driver bug, not a lifecycle condition, and no class in the table covers it.

For the **inner loop** (row 5) the dispatch is two gestures instead of one, against the change-automation endpoints the Automation panel uses:

```bash
curl -s -X POST "http://localhost:<api_port>/api/changes/<change-id>/automation/enable"
curl -s -X POST "http://localhost:<api_port>/api/changes/<change-id>/automation/start"
```

Both return the change's automation block. A `400` from `enable` is the eligibility gate or the clean-tree gate refusing — classify it (both come back `skill-refusal`), quote the `error` verbatim and stop; both are conditions a human resolves. The runs the orchestrator then dispatches carry `origin: automation`, which is correct and deliberate: they are the orchestrator's runs, not the driver's, and the driver does not relabel them. The driver's own footprint for row 5 is the two gestures, recorded as `change-automation-enable` / `change-automation-*` events.

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
3. Advance only when the artifact moved. Otherwise classify the stop — see step 6.

**The artifact check runs before the classifier, always.** This ordering is what makes the ugliest case a non-event: a run killed mid-flight after its artifact was already written reads as _advanced_, not as a failure to recover from, no matter what the exit code or the park reason says. A stop only reaches step 6 when the work demonstrably did not land — which is the only situation in which the question "should we try again?" is even meaningful.

Two boundaries on the watch itself:

- **A failed HTTP read is not a run outcome.** The dev server restarts on file changes, so a refused connection mid-poll is routine. Re-poll. Ten consecutive failed reads (the `UNREADABLE` branch above — several minutes) is a different thing: stop with `⊘ OS API unreadable across 10 consecutive polls while watching <run_id> — the run may still be live; check the Processes list.` Never write a run off as failed because a read failed, and never feed a failed read to the classifier as though it were the run's evidence — a transport failure between the driver and the API says nothing at all about the child. This is refusing to invent an outcome, not recovering one.
- **The loop above bounds the wait at two hours.** If it expires with the run still live, stop and report the run id — do not cancel it. This skill's own `wall_time_cap_minutes: 240` is set high for the same reason: a drive that watches a real EXECUTE plus a PR review is legitimately long, and the derived 25-minute floor would kill it mid-watch.

### Step 6 — Classify the stop, then act

A node stopped. Before deciding anything, **name the class of stop from the evidence already on record** — then apply that class's row. The classification is not a judgment call; run the classifier:

```bash
node scripts/drive-recovery.mjs --json \
  --park-reason   '<automation.state.paused_reason, verbatim, or omit>' \
  --run-error     '<the run row error column, verbatim, or omit>' \
  --exit-status   <run.exit_status> \
  --journal-file  .claude/state/runs/<run_id>.raw.jsonl \
  --retries-used  <retries already spent on THIS change this invocation> \
  --retry-budget  <retry_budget> \
  --iteration-count <automation.state.iteration_count, for a parked change>
```

It returns `{class, action, retry_ok, reset_at, reset_hint, signature, evidence, retry_gesture, retries_remaining, rationale}` and is unit-tested (`tests/unit/lifecycle/drive-recovery.test.ts`). Do not re-derive the class from the table below by reading a stack trace — the table documents what the script decides, and the script is what decides it. The exit code says only whether the classifier ran; the verdict is in the payload.

#### The recovery table

| class                          | evidence that names it                                                                                                                                                                                                 | action                                                                                      | retry budget                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| **environmental**              | park `env-failure: …` · `dispatch-failure: …` · error/journal reading `overloaded_error` / 529 / 503, `rate limit` / 429 / `model-unavailable(rate-limit)`, `ECONNRESET` / `fetch failed` / `socket hang up`           | **retry** — one more attempt at the same node (`retry_gesture`)                             | spends 1 of `retry_budget` (default 2) |
| **environmental**, clock-bound | the same, plus something the driver cannot hurry: `usage limit reached` / `session-limit` / any parsed reset time · `dispatch-failure: blocked` (a live run owns the change)                                           | **wait** — stop and report `reset_at` (or `reset_hint`, verbatim). Never busy-poll a clock. | spends nothing                         |
| **auth-wall**                  | `model-unavailable(auth\|credits\|model-not-found)` · `GH007` · `push declined` · `Permission denied (publickey)` · `gpg failed to sign` · `could not read Username`                                                   | **stop** — quote the wall, name the one-line human ask, attempt no credential work          | never retries                          |
| **skill-refusal**              | park `skill-refused: …` · `dirty-tree: …` · `not eligible for automation` · `⊘ Re-review debounced — head unchanged` · a clean exit whose artifact did not move                                                        | **stop** — the refusal text _is_ the remedy; quote it verbatim as the `next:` line          | never retries                          |
| **skill-failure**              | park `skill-failure: <step> exited <n>` with nothing more specific behind it · `killed: wall-time cap exceeded` · exit 143 / 137 / any other non-zero                                                                  | **stop** — hand back for triage                                                             | never retries                          |
| **human-gate**                 | park `needs-triage` · `user-paused` · `iteration-cap-reached` · `review returned <verdict>` — plus the driver's own gates: rows 1 and 6, a `rejected` verdict, the spent revise budget, `spend_cap_usd`, `max_changes` | **hand back** — the v1 handoff, word for word. Not a failure.                               | never retries                          |
| **unknown**                    | park `verification-unavailable: …` · `unknown-step: …` · a park reason outside this vocabulary · `supervisor: PID not alive` · no evidence at all                                                                      | **stop** and say plainly that the evidence did not resolve                                  | never retries                          |

Four things bind on every use of this table:

- **`skill-failure` never retries, by design.** Re-running a skill that failed, without changing anything it reads, spends money to reproduce a known result. If the failure has a fix, the fix is an operator's edit and the drive resumes by being re-invoked.
- **A wall-cap kill is a `skill-failure`, not an environmental stop.** The supervisor terminated it for running too long; the same dispatch would run just as long again. The surgical re-dispatch framing the design sketch describes ("read the findings, fold in place, no workspace re-walk") is a prompt the driver does not compose — it hands back with the cap named instead.
- **Precedence is park reason → error line → journal → exit shape, with one carve-out.** `skill-failure: <step> exited <n>` and `<skill> exited <n>` restate the exit code and nothing else; they were written before anything looked at _why_. Those two defer to the error line, which is how a session-limit kill filed under `skill-failure` gets read as the usage window it actually was. Every other park reason carries a real verdict and wins outright — a `skill-refused` park stays a refusal even when its spliced-in run summary happens to mention a network word.
- **The classifier only ever downgrades toward stopping.** It has no path from `stop` to `retry`. When it is wrong, the cost is a hand-back the operator did not need — the same cost v1 paid on every stop.

#### Performing a retry

Only `action: retry` with `retry_ok: true` continues the drive. Then, exactly once per returned verdict:

- `retry_gesture: re-dispatch` — repeat the step-4 dispatch for the same node, unchanged. Same prompt, same tags, same `origin: driver`. No new framing, no added instructions: the premise of an environmental retry is that nothing about the work needed to change.
- `retry_gesture: reset-then-start` — the stop came from a parked automation block, so re-enter it through the endpoints the Automation panel uses:

  ```bash
  curl -s -X POST "http://localhost:<api_port>/api/changes/<change-id>/automation/reset"
  curl -s -X POST "http://localhost:<api_port>/api/changes/<change-id>/automation/start"
  ```

  Reset nulls `current_step`, and Start then derives the entry step from the artifacts on disk — so this re-enters where the work actually got to, not at `execute`. That artifact derivation is the only reason this gesture is safe; without it, a reset would re-run completed steps.

Then watch (step 5) and re-verify the postcondition. Count the retry against the change, and if it stops again, classify again with `--retries-used` incremented. Two guards make the retry impossible to abuse:

- **The budget is per change, per invocation.** Two by default. Spent means `action` comes back as `stop` with the budget named in the rationale; a transient condition that keeps recurring is a fact the operator needs, not a loop to grind.
- **`reset-then-start` is refused once the review loop has iterated.** Reset zeroes `iteration_count` on its way to nulling `current_step`, which would hand the address-comments cycle a cap the operator never granted. The classifier returns `stop` for any parked change with `iteration_count > 0` and says so. `re-dispatch` touches no counter and carries no such limit.

#### Waiting honestly

`action: wait` is a stop that names what has to move. It is **not** a sleep. The driver never polls past a clock, and never sits out a usage window inside its own wall-time cap: a four-hour cap spent waiting is four hours of run cost buying nothing, and the drive resumes perfectly from a cold re-invocation anyway. Report it as:

```
⏸ Waiting on <signature> for <change-id>
  resets: <reset_at or reset_hint, verbatim — or "not recorded">
  next:   re-invoke /os drive project <project> after that
```

When neither a `reset_at` nor a `reset_hint` came back, say the limit is standing and no reset time was recorded. Do not estimate one.

#### Everything else still stops the drive

Do not try the next node and do not move to the next change on any of: a `stop` or `hand-back` verdict from the table, a resolver `stop` from step 1 (quote `reason` + `detail`), an HTTP 400 from a dispatch (a driver bug — quote it), `spend_cap_usd` about to be crossed, or `max_changes` reached. And the row that carries the most weight is still `unknown`: an ambiguous state is a stop, not an improvisation.

### Step 7 — Next change, or report

When a change reaches row 9 (terminal, audit satisfied or not applicable), re-run **step 1** — the whole resolver, not a cached queue — and continue with the new `next`. Re-running it is what lets a change an operator merged and closed by hand drop out of the queue mid-drive.

When the drive ends for any reason, record one event and print the report.

```bash
node scripts/record-dashboard-action.mjs \
  --action drive-project \
  --skill dev-drive-project \
  --args '{"project":"<project>","queue":["<id>",...],"changes_driven":["<id>",...],"nodes":[{"change":"<id>","node":"<node>","run_id":"<id>","outcome":"advanced|retried|stopped"}],"recovery":[{"change":"<id>","node":"<node>","run_id":"<id>","class":"<class>","signature":"<signature>","evidence":"<layer>","action":"<action>","retry_ok":<bool>,"reset_at":"<iso or null>","retries_remaining":<n>,"rationale":"<verbatim>"}],"retries_spent":<n>,"retry_budget":<n>,"stopped_at":"<node or gate>","stop_reason":"<reason>","spend_usd":<n>,"dry_run":<bool>}' \
  --description 'drove <project>: <n> node(s), <k> recovery retr(y|ies), stopped at <node> — <reason>'
```

**Every classification goes into `recovery[]`, including the ones that changed nothing.** A verdict the driver acted on and a verdict it merely recorded are equally informative to a lifecycle audit: the first says the table worked, the second says the class was reachable and the action was declined. One entry per classification, in the order they happened, with the classifier's own `rationale` copied verbatim rather than paraphrased — the whole point of banking these is that a later audit can score the decision against what actually turned out to be true.

No `--files-touched`: the driver writes no files. That is not an omission, it is the contract — the driver holds no state the manual surfaces cannot read.

## Outputs

- **Runs** — one per dispatched node, created through `POST /api/runs` with `origin: driver`, so the Processes list renders them `[driver] …`. Inner-loop runs belong to the orchestrator and carry `origin: automation`.
- **One event** — `action: drive-project` in `.claude/state/events.db` (and `vault/raw/dashboard-actions.jsonl`), carrying the queue, the nodes attempted, every stop classification, where it ended and why.
- **The drive report** — printed at the end, in this shape:

```
▶ Drive <project> — <n> change(s) in queue

  queue (dependency order):
    ✓ <change-id>            merged
    ▶ <change-id>            in-progress   ← driven this invocation
    · <change-id>            planning      (waits on <parent-id>)

  this invocation:
    <change-id>  plan          → run <id>  ✓ plan_path written
    <change-id>  plan-review   → run <id>  ↻ environmental/api-overload → retry (1 left)
    <change-id>  plan-review   → run <id>  ✓ approved
    <change-id>  inner loop    → enable+start  ⊘ paused: skill-refused: execute exited 0 without artifact movement — …

  recovery:
    <change-id>  plan-review   class: environmental · signature: api-overload · evidence: run_error · action: retry · retries left: 1 — the run's error line says the API reported itself overloaded
    <change-id>  inner loop    class: skill-refusal · signature: skill-refused · evidence: park_reason · action: stop — the step exited cleanly and its gate named what is missing …

⊘ Stopped at inner loop on <change-id>
  class:   <class> / <signature>
  reason:  <paused_reason / error / gate, verbatim>
  next:    <the one thing the operator does>
  spend:   $<n.nn> across <k> driver-dispatched run(s), <r> of them recovery retries
```

Each `recovery:` line is `formatRecoveryLine()` from the classifier, so the prose an operator reads and the record an audit scores are the same sentence. The `next:` line is still the deliverable of a stop — name the concrete gesture (the button, the skill, the file to edit), not "investigate". For an `action: wait`, `next:` is the reset time and a re-invocation, and the header is `⏸ Waiting` rather than `⊘ Stopped`.

## Human gates and headless behavior

The driver **never asks a question**. Every gate that needs a human is a clean stop with the pending artifact left exactly where it is, and the dashboard fully operable on the same entities. Designing the gates out this way is the standard's preferred option ([[standard-skill-format]] § Headless behavior) and it makes the driver's behavior identical whether a human is watching or it was itself dispatched headless from a Drive button. Stated per gate, in the standard's vocabulary:

- **Draft acceptance** (row 1) — `Headless: park`. Print the drafted sections' location and stop; never strip `> **DRAFT** —` markers on the operator's behalf.
- **Plan-review verdict `rejected`, or `request-changes` with the revise budget spent** (row 4) — `Headless: park`. Quote the verdict and the review path.
- **Comment triage · Mark ready · PR merge** (row 6) — `Headless: park`. State which of the three are outstanding: undispositioned comments (count + pass), `pr_review_status` not yet `ready-for-human`, PR not merged.
- **Force or destructive operations** — `Headless: refuse`. It never merges a PR, never passes `force: true` or `override: true` to a node skill, never cancels a run, and never edits a change entry's frontmatter. Every one of those is an operator gesture.
- **Resetting a parked automation block** — permitted in exactly one place: as the `reset-then-start` gesture behind an `environmental` verdict with `retry_ok: true` (§ Step 6). Every other park — refusal, failure, gate, unknown — is still hands-off. The distinction is not the endpoint, it is whether a named gate is being stepped over: an overloaded API named no gate, and a refusal names one in its own text.
- **Spend beyond `spend_cap_usd`** — `Headless: park`. Stop before dispatching, with the cumulative figure. A recovery retry is a dispatch like any other: check the cap before it, not after.

Resuming after any of these is just invoking the driver again: it re-derives everything from the vault and picks up wherever the operator left it.

## Errors

Conditions the recovery table does not cover, because they happen outside a node run:

- **API not reachable at start** → `⊘ OS API not reachable on <port>` + start the dashboard. No dispatches.
- **API unreachable mid-watch** → tolerate and re-poll; stop after ten consecutive failures without declaring the run failed. Do not classify a failed read as the run's outcome.
- **Project missing / not `type: project` / closed** → stop with the id and the state (preconditions above).
- **Resolver `stop`** → quote `reason` + `detail`; the queue is unsound and no dispatch is safe.
- **Dispatch rejected with HTTP 400** → the body was wrong. Stop and quote it; no class covers a driver bug.
- **Change entry unreadable / frontmatter parse error** → stop naming the file; a driver that guesses at a malformed entry is worse than one that stops.

Everything that happens _to a node run_ — a failure, a clean exit with no artifact, a park, a 409 — goes through step 6 and is answered by its class.

## Boundaries

What v2 does, and where it deliberately stops:

- **v2 recovers environmental stops, and nothing else.** A bounded retry when the infrastructure got in the way; an honest wait when a clock governs it. Refusals, failures, gates and unresolved evidence still hand back exactly as v1 did — same wording, same artifacts left in place, same resumability. The classifier has no path from `stop` to `retry`, so the worst it can do is hand back a case it might have recovered.
- **Any bypass of a named gate is still out.** If a refusal names a gate, that gate stands until a human moves it. `reset-then-start` is a retry of a step the infrastructure prevented from running, not a way around a gate that ran and said no — and the classifier is what draws that line, not a judgment made at the moment of stopping.
- **Re-dispatch framings are not composed.** The design sketch records prompts that recovered specific incidents by hand ("the written artifact is YOUR OWN interrupted work — continue, do not start over"; "read findings, fold in place, no workspace re-walk"). v2 does not write those. Its retry repeats the original dispatch byte for byte, because an environmental stop by definition needed nothing about the work to change. A stop that needs a different prompt is a stop that needs a human.
- **The report tier.** Driving `research-write → research-review → research-scaffold-recommendations` before the change queue exists. The driver starts from changes that are already scaffolded; when a project has none, it says so and stops.
- **A Drive affordance in the dashboard,** and any schedule, runbook, or auto-adoption. The first is a separate ticket; the rest are ruled out by design.

## See also

- [[standard-automation-loop]] — the change-tier inner loop row 5 delegates to: step vocabulary, artifact-verified advance, park reasons, endpoints
- [[archetype-change]] — the frontmatter the gates read
- [[standard-skill-format]] § Headless behavior — the gate-policy vocabulary used above
- [[dev-write-change]] · [[dev-review-change]] · [[dev-revise-plan]] · [[dev-close-change]] · [[meta-overseer-review]] — the nodes the driver dispatches
- `scripts/drive-order.mjs` — the queue resolver; its decision core is pure and unit-tested
- `scripts/drive-recovery.mjs` — the stop classifier behind § Step 6; pure, unit-tested, and the authority on precedence
- `scripts/model-error-policy.mjs` — where `model-unavailable(<class>): …` error lines come from
