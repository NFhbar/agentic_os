---
id: standard-tracker-intake
type: reference
domain: meta
created: 2026-08-20T00:00:00Z
updated: 2026-08-20T00:00:00Z
tags: [standard, tracker, intake, integration, portability]
source: manual
private: false
title: Tracker intake standard
url: internal://standard/tracker-intake
kind: doc
last_verified: 2026-08-20
---

# Tracker intake standard

## What it is

The portable frontmatter contract for OS entries that mirror an item in an **external work tracker** — a system outside the OS where humans file, refine, and prioritize work (issue trackers, project-management tools, support desks; Linear, Jira and GitHub Issues are examples of what an install might integrate, not requirements of this contract).

**The OS core ships no tracker code.** No adapter, no sync skill, no schedule, no vendor client, no default configuration. An install that wants a tracker builds the integration itself out of primitives that already exist — a hosted MCP, a skill, a schedule (see § Building an integration). This document is the entire core contribution: a small set of field names, and the rules about who may write them.

It exists for one reason. Two installs that independently build integrations against two different trackers should still produce entries a third party can read — and, more importantly, entries the OS's own skills can read without knowing a tracker exists at all. A tracker-derived change must be **indistinguishable from a hand-founded one** everywhere downstream: the same `status` vocabulary, the same review gate, the same queue position. The linkage fields are annotations on an ordinary entry, never a second kind of entry.

## Scope

Two entry kinds carry tracker linkage:

- A [[archetype-project]] entry maps to the tracker's **container** — whatever the tracker calls the thing that groups items (project, epic, board, milestone, workspace).
- A [[archetype-change]] entry maps to a single tracker **item** — one ticket, one issue, one card.

The mapping is one-to-one in both cases and optional in both cases. A change may be tracker-linked without its project being; an orphan change (no `project:`) may be tracker-linked on its own.

Nothing else in the vault gains tracker fields. A tracker item that does not correspond to a unit of code work is not a change — it is a note, or it is nothing.

## The field set

### On a project entry

| field                | type   | notes                                                                                                                                      |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tracker`            | string | Kind label — a lowercase kebab-case slug naming which tracker this entry is linked to. Install-local vocabulary; core never interprets it. |
| `tracker_project_id` | string | The tracker's own identifier for the container mapped to this project, verbatim.                                                           |

### On a change entry

| field                    | type   | notes                                                                                                                                                |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker`                | string | Same kind label. Inherit from the owning project when absent; set it explicitly on orphan changes so the entry is self-describing.                   |
| `tracker_issue_id`       | string | The tracker's canonical identifier for the item, **verbatim** — whatever shape it uses (numeric, prefixed, opaque). Never normalized, never coerced. |
| `tracker_issue_url`      | string | Stable deep link to the item. HTTP(S), openable by a human with no tooling.                                                                          |
| `tracker_synced_at`      | string | ISO 8601 UTC — when the most recent successful sync touching this entry completed.                                                                   |
| `tracker_sync_direction` | enum   | `inbound` \| `outbound` — which way data moved on that sync.                                                                                         |

All five are optional. Their absence is the normal case, and it is not a defect: an entry with no tracker fields was founded by hand, which is the OS's default mode.

### Why these names

- **`tracker`** is a label, not a switch. Core reads no behavior from it. It exists so an integration can answer "is this entry mine?" when an install syncs with more than one tracker, and so a human reading a cold entry knows where the item lives.
- **`tracker_project_id` / `tracker_issue_id`** use the `<noun>_id` foreign-key form, which the meta playbook's primary-key convention reserves exactly for references to a row that lives elsewhere. These reference rows in another system, so the form is right; the entry's own primary key stays the bare `id:`.
- **`tracker_issue_url`** mirrors `pr_url`, the change archetype's existing external-link field — same shape, same expectation (a plain HTTP(S) string a human can click).
- **`tracker_synced_at`** mirrors the `_at` timestamp convention already dense on changes (`merged_at`, `reviewed_at`, `pr_ready_at`, `plan_generated_at`).
- **`tracker_sync_direction`** is a two-value enum rather than a second timestamp because the only thing it has to support is the self-echo guard, which needs one comparison: _if the tracker's item was last modified no later than `tracker_synced_at` and the direction was `outbound`, the tracker-side change is the OS's own write coming back._ Two nullable per-direction timestamps would double the states an integration has to reason about to answer that one question.

### Composing with `issue_number`

`issue_number` already exists in the OS and is **not** part of this contract. It is an input to [[dev-add-change]], constrained to digits, and its entire job is to shape the branch ref — `<type>/#<issue>/<name>` per [[standard-git-hygiene]] § 3. It is consumed at scaffold time and never persisted as frontmatter.

`tracker_issue_id` is the persisted linkage and accepts the tracker's identifier verbatim, including non-numeric forms.

The two compose like this:

- When the tracker's identifier is already digits-only, an integration **may** pass it as `issue_number` so the branch name carries the ticket, and **must** also write `tracker_issue_id` with the same value.
- When it is not digits-only, the integration **must omit the `issue_number` input entirely** — not pass an empty string, which `dev-add-change` validates against its digits-only pattern — and write `tracker_issue_id` alone. The branch stays two-part.
- Never coerce a non-numeric identifier into digits to satisfy the branch shape. The branch is a convenience; `tracker_issue_id` is the field that has to survive, and a lossy digit-extraction makes the link unrecoverable in the direction that matters.
- When both are present, `issue_number` is a derivative of `tracker_issue_id`, never a second source of truth. Nothing reads it back.

### Value shape

Every field in this contract is a **single-line scalar**. No nested blocks, no multi-line YAML, no arrays.

This is a parser contract, not a style preference. The flat frontmatter readers behind the audit, the index rebuild, and the dashboard routes drop multi-line YAML structures silently — a multi-line block does not fail loudly, it disappears. An integration with richer per-item state keeps it in its own entry, not in these fields.

## Authority — who owns which field

The governing question for any sync is: _if the two sides disagree, which one is describing reality?_ Identity comes from the tracker. Execution state comes from the OS, because the OS is the side that actually did the work.

| concern                                                                                                      | authoritative side       | rule                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item identity — `tracker_issue_id`, `tracker_issue_url`, `tracker_project_id`                                | tracker                  | Written once when the link is established. Rewritten only to repair a tracker-side reissue; never by an OS skill.                                                                                        |
| The label — `tracker`                                                                                        | install configuration    | Set at link time. A sync reads it to decide ownership; it does not rewrite it.                                                                                                                           |
| Sync bookkeeping — `tracker_synced_at`, `tracker_sync_direction`                                             | the integration          | The only fields a sync freely rewrites on every pass.                                                                                                                                                    |
| OS lifecycle — `status`, `branch`, `repo`, `merged_at`, `ci_*`, `review_*`, `plan_*`, `pr_*`, `automation.*` | OS                       | Outputs of skills that ran. A tracker-side edit is an opinion about these, never a write to them.                                                                                                        |
| Shared frontmatter — `id`, `type`, `domain`, `created`, `source`, `private`                                  | OS                       | `id` especially: a tracker-side rename does not rename an entry. Renaming is [[meta-rename]]'s job because it also fixes wikilinks.                                                                      |
| Change body — `## Why` / `## Approach` / `## Done when`                                                      | tracker until frozen     | The tracker is where humans refine intent, so it wins **while the change has not started**. The freeze marker is `plan_path`: once set, the body is in-flight work and the integration stops writing it. |
| `## Notes`                                                                                                   | append-only, either side | The one body section a sync may add to after freeze — and only by appending.                                                                                                                             |
| `updated`                                                                                                    | whoever wrote last       | Any writer bumps it, per [[standard-wiki-format]].                                                                                                                                                       |

The body-freeze rule resolves the obvious conflict case. Before a plan exists, a change is a restatement of tracker intent and refreshing it from upstream is a feature. After a plan exists, the body has been reviewed and is being executed against; upstream text that contradicts it is a new change or a comment, not an overwrite.

## Lifecycle mapping — you define the table

This standard deliberately ships **no** state table. Tracker workflows are configured per install — two teams on the same product use different column names, different numbers of states, and different meanings for the same word. A fixed table would be wrong for almost everyone.

What is fixed is the OS side. The change status vocabulary is closed, defined by [[archetype-change]]:

```
planning · in-progress · in-review · merged · abandoned
```

An integration **maps into** that vocabulary. It never extends it.

The integration declares its own mapping, in two directions, and records it in its own entry so a cold session can read it:

- **Inbound gate** — which tracker states make an item eligible to scaffold a change. Usually exactly one ("ready to build"). Every other state is inert.
- **Outbound writeback** — change status → tracker state, applied on transitions the OS makes.

Rules the mapping must obey:

1. **Map on transitions the OS makes; never infer OS status backwards from a tracker edit mid-flight.** An item dragged to the tracker's done column does not make a change `merged`. The PR merging makes a change `merged`.
2. **Inbound creates, it does not advance.** A scaffolded change starts at `planning` and the human draft-accept gate stands (see § What a sync must not do). A sync never moves a change that is already past `planning`.
3. **Terminals are asymmetric.** `merged` is earned in the repo and only the merge path writes it. `abandoned` is the one terminal an inbound signal may _propose_ — and it proposes to a human, it does not write.
4. **Partial is fine, both directions.** Unmapped tracker states do nothing; unmapped OS statuses write nothing. A mapping that covers one inbound state and two outbound transitions is a complete, valid mapping.
5. **Many-to-one is fine; one-to-many is not.** Several tracker states may map to one OS status. One OS status must not map to a choice of tracker states, or the writeback is nondeterministic.

## What a sync must not do

1. **Must not write OS-authoritative fields.** Everything in the OS row of the authority table is off-limits — including reaching them indirectly by dispatching a skill purely to force a transition.
2. **Must not invent statuses.** No value outside the closed change vocabulary, in any field, for any reason. A tracker state with no OS meaning maps to nothing.
3. **Must not overwrite an in-flight body.** Once `plan_path` is set, the body is frozen to the integration except for appends to `## Notes`.
4. **Must not pass a human gate.** Draft acceptance, plan-review overrides, and merge are human decisions. A sync may create work and may report outcomes; it may not consent on a person's behalf.
5. **Must not act on its own echo.** Before treating a tracker-side modification as human intent, compare it against `tracker_synced_at` / `tracker_sync_direction`. An outbound write reflected back is not a new instruction, and a loop between two automations is the failure this guard exists to prevent.
6. **Must not reap.** A tracker item that disappears — deleted, moved, archived — does not delete or abandon the OS entry. Surface the divergence; let a human decide.
7. **Must not use vendor-specific field names.** No `<vendor>_issue_id`, no `<vendor>_state`. Vendor-named frontmatter is exactly the portability failure this contract exists to prevent; the vendor's identity lives in the _value_ of `tracker`, never in a key.
8. **Must not write multi-line or nested values** into these fields (see § Value shape).
9. **Must not become required.** An install with no tracker, an entry with no linkage, and a person who never opens the tracker must all keep working unchanged. See below.

## Compatibility clause

Carried over verbatim from the `dev-drive-project` design sketch, whose compatibility constraint governs every optional outer layer the OS grows:

> **The driver must never interfere with the existing manual process.** Operators retain the ability to run any lifecycle — or any single step — entirely manually from the dashboard, with the driver absent.

Read for this contract: **tracker intake must not interfere with manual operation.** Concretely:

1. **Optional annotation only.** Every skill, dashboard surface, and API endpoint remains the primary interface, byte-unchanged. Tracker fields are additive frontmatter; nothing in core reads them, so nothing in core changes behavior because of them.
2. **Mixed-mode safe by construction.** A step a person completed by hand simply reads as done on the next sync pass, because the sync derives state fresh from frontmatter rather than from its own memory. No locks, no claimed ownership of an entry.
3. **Never self-engaging.** A sync runs when its schedule fires or a person invokes it — never by adopting entries it was not pointed at, and never on an install that has not configured it.
4. **Hand-back is always clean.** Deleting the tracker fields from an entry, disabling the schedule, or removing the integration entirely leaves an ordinary change behind, fully operable by hand.

The driver's queue is "owned changes in priority order, however they were scaffolded" — a tracker-derived change earns no special handling and suffers no special restriction.

## Building an integration

Three existing primitives, all user-side. None of this ships in core.

1. **Register the tracker's hosted MCP** — [[meta-add-mcp]] in `hosted` mode. A vendor-run endpoint is a `.mcp.json` row with no folder under `mcps/`, preserved across config syncs; see [[standard-mcp-architecture]]. Authentication is the install's own. Verify that headless reuse of the credential actually holds **before** depending on it from a schedule — if it does not, the sync stays manual and everything else in this contract is unaffected.
2. **Write the sync skill** — [[meta-add-skill]], in whichever domain owns the work. The skill holds the mapping, calls the MCP, and writes only the fields this contract assigns to it. Keep the vendor's vocabulary inside the skill: the moment tracker-shaped concepts leak into frontmatter, portability is gone.
3. **Schedule it** — [[meta-add-schedule]], per [[standard-scheduled-jobs]]. Keep a manual invocation path alongside the cadence, for first runs, backfills, and the case where scheduled authentication is not available.

Write the integration's own entry (its mapping table, its tracker label, its scope) alongside the skill. That entry — not this standard — is where install-specific detail belongs.

## Deliberately not specified

- **Ordering / priority.** Whether change entries gain a generic ordering field is deferred. The queue-order rule stands: do not invent schema before a driven lifecycle demands it. Until then, priority lives in the tracker and reaches the OS as the order a sync scaffolds in.
- **A tracker-side container URL.** `tracker_project_id` is enough to re-derive one, and an unused field is a field that goes stale.
- **Comment and attachment mirroring.** Comment disposition, review verdicts, and audit machinery stay OS-side. A tracker sees outcomes, not machinery.
- **Conflict resolution beyond the body freeze.** The authority table settles field-level ownership; anything it does not cover is a signal the integration is doing too much.

## Related

- [[archetype-change]] · [[archetype-project]] — the entries these fields annotate
- [[standard-change-workflow]] — the lifecycle a tracker-linked change runs unchanged
- [[standard-git-hygiene]] — § 3 branch naming, where `issue_number` is consumed
- [[standard-mcp-architecture]] — hosted-mode registration for a vendor endpoint
- [[standard-scheduled-jobs]] — the cadence primitive a sync runs on
- [[standard-wiki-format]] — shared frontmatter these fields extend
- [[dev-add-change]] — the scaffolder an inbound sync dispatches
