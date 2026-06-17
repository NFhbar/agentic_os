---
id: standard-event-store
type: reference
domain: meta
created: 2026-05-21T00:00:00Z
updated: 2026-05-27T04:10:10Z
tags: [standard, observability, telemetry, sqlite, persistence]
source: manual
private: false
title: Event store / telemetry layer
url: internal://standard/event-store
kind: doc
last_verified: 2026-05-21
---

# Event store / telemetry layer

A pure-Node SQLite database at `.claude/state/events.db` that records **every action the OS executes** with structured metadata (timestamp, kind, action, skill, project, model, tokens, cost, duration, exit status, files touched). It is the canonical observability layer.

This entry defines:

1. The **vault vs telemetry** separation of concerns
2. The **schema** of the `events` table
3. **What writes** into it and from where
4. The **JSONL legacy compatibility** plan
5. Retention and operational policy

## 1. Vault vs telemetry — the separation

> **Vault holds what you _know_. events.db holds what _happened_.**

The OS has two distinct persistence layers. They serve different purposes and must not be conflated.

| dimension         | Vault (`vault/`)                                       | events.db (`.claude/state/events.db`)              |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------- |
| **Content type**  | Knowledge — reasoned, semantic, archetype-typed        | Telemetry — mechanical, measured, instrumented     |
| **Authorship**    | Mostly human (curated) or human-prompted skill output  | Automatic — every action emits a row, no curation  |
| **Granularity**   | One entry per concept                                  | One row per action                                 |
| **Lifecycle**     | Long-lived, edited, evolves                            | Append-only, immutable, time-series                |
| **Schema**        | Archetype frontmatter (markdown + YAML)                | SQL columns (structured + indexed)                 |
| **Query shape**   | Backlinks + wikilinks + manifest scan                  | Indexed SQL across columns                         |
| **Portability**   | Committed (in `_seed/`) or carried in git per instance | Gitignored, machine-local — never shipped          |
| **When you read** | "I need to _understand_ X" / "where is the doc on Y?"  | "I need to _count_ Y" / "what happened last hour?" |
| **Location**      | `vault/wiki/`, `vault/raw/`, `vault/output/`           | `.claude/state/events.db`                          |
| **Backup model**  | Git (per-instance) and `_seed/` (shipped with OS)      | Local-only; reproducible from JSONL backfill       |

### The handoff rule

A single OS action typically writes to **both**:

```
                            ACTION
              (skill invocation, dashboard click, scheduler tick)
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     1 row in events.db           0..N writes to vault/
     (metadata: when, who,         (the actual KNOWLEDGE
      model, cost, duration,        produced: wiki entry,
      files_touched, exit)          status report, plan,
                                    change body, etc.)
```

The event row's `files_touched` column references the vault paths it produced. The dashboard can navigate **telemetry row → artifact**. It does NOT navigate the other way — knowledge stays clean of execution metadata.

### What belongs where (decision rubric)

When deciding where new structured state should live, ask:

| question                                                      | answer → goes in       |
| ------------------------------------------------------------- | ---------------------- |
| Would another human want to read this in narrative form?      | Vault (wiki or output) |
| Does it have an archetype frontmatter shape?                  | Vault                  |
| Would it ship usefully to another instance of the OS?         | Vault                  |
| Is it produced automatically by every action, no curation?    | events.db              |
| Is it time-series with millions of rows expected?             | events.db              |
| Will it primarily be queried with aggregates (count/sum/avg)? | events.db              |

If unsure, write to events.db (you can always also write to vault if you later decide it's knowledge-worthy).

## 2. Schema

Single wide table `events` with indexed columns for the common filter axes. Designed to evolve via additive columns; schema-version not tracked in v1 (init script is idempotent).

```sql
CREATE TABLE IF NOT EXISTS events (
  -- Identity
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                 -- ISO-8601 UTC timestamp
  dedupe_key TEXT UNIQUE,           -- sha256(ts|kind|action|raw); enables INSERT OR IGNORE

  -- Classification
  kind TEXT NOT NULL,               -- 'router'|'dashboard'|'schedule'|'skill'|'audit'|'manual'|'edit'
  action TEXT NOT NULL,             -- e.g. 'ai-prompt', 'edit', 'schedule-fire', 'route'
  source TEXT,                      -- where it came from: 'dashboard'|'launchd'|'cli'|'router'

  -- Subject (any may be null)
  skill TEXT,                       -- skill name if invoked via skill
  project TEXT,                     -- project id if scoped to a project
  change_id TEXT,                   -- change entry id if related
  report_id TEXT,                   -- research-report id if scoped to a report
  domain TEXT,                      -- domain id

  -- AI metadata (nullable — populated when known)
  model TEXT,                       -- e.g. 'claude-opus-4-7'
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache_hit INTEGER,
  tokens_cache_write INTEGER,
  cost_usd REAL,

  -- Execution
  duration_ms INTEGER,
  exit_status INTEGER,
  status TEXT,                      -- 'success'|'error'|'skipped'|'partial' (free-form)
  description TEXT,                 -- one-line human summary

  -- Linkage to vault
  files_touched TEXT,               -- JSON array of relative paths
  prompt TEXT,                      -- truncated prompt text (≤4KB)
  stdout_preview TEXT,              -- truncated stdout (≤4KB)
  stderr TEXT,                      -- truncated stderr (≤2KB)

  -- Provenance
  origin_log TEXT,                  -- 'backfill:router-log.jsonl' etc — null for fresh writes
  raw TEXT                          -- JSON of the original payload, for safety
);

CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS events_skill ON events(skill);
CREATE INDEX IF NOT EXISTS events_project ON events(project);
CREATE INDEX IF NOT EXISTS events_change ON events(change_id);
CREATE INDEX IF NOT EXISTS events_report ON events(report_id);
CREATE INDEX IF NOT EXISTS events_model ON events(model);
```

### Column policies

- **`dedupe_key`** — `sha256(ts || '|' || kind || '|' || action || '|' || (raw||''))`. Lets `INSERT OR IGNORE` make backfill and accidental double-writes safe. Computed by the helper, not the caller.
- **`raw`** — always populated for fresh writes (the structured payload as JSON). For backfill, the original JSONL line.
- **`status`** — free-form short tag. Common values: `success`, `error`, `skipped`, `partial`. Audit will not enforce an enum here (deliberately permissive).
- **Truncation** — `prompt`, `stdout_preview`, `stderr` all truncated at insert. Helper handles this; callers can pass full text.

### Run origin — who dispatched a run

The `runs` table (same DB file, separate table — see `scripts/runs-db-init.mjs`) carries an `origin` column stamped at **create time**, capturing _who dispatched the run_. It is a structural property, not a title convention: the `[origin]` prefix shown on run titles is **derived at render time** from this column, never stored in the title string.

| `origin`     | who                                                         | stamped by                                           |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| `human`      | a person, via the dashboard / API (the default)             | `startRun` default when no explicit origin is passed |
| `automation` | the change/project automation orchestrator                  | `routes/automation.ts` dispatch sites                |
| `scheduler`  | a manual schedule fire (`run-now`)                          | `routes/schedules.ts` run-now                        |
| `driver`     | reserved for `dev-drive-project` dispatches (not yet wired) | (future) an explicit `origin` on the start payload   |

Rules:

- **Vocabulary is closed.** `RUN_ORIGINS` in `scripts/runs-db-init.mjs` is the runtime source of truth; the `RunOrigin` type in `runs.types.ts` mirrors it (types-only file, can't import the runtime list).
- **NULL reads as `human`.** Legacy rows predate the column; the derive/display layer and the Processes filter both treat `NULL` as `human`. No backfill — the migration is purely additive.
- **Explicit origin wins.** A caller may pass `origin` on the start payload; it overrides the `human` default (this is the `driver` integration point).
- **Enforced by audit.** `run-origin-missing` (§ 6) pins the column's presence and that no row carries a value outside the vocabulary.

## 3. Write sites

| site                                       | kind        | action(s)                        | when                                      |
| ------------------------------------------ | ----------- | -------------------------------- | ----------------------------------------- |
| `scripts/scheduler-tick.mjs` (fireJob)     | `schedule`  | `schedule-fire`, `schedule-skip` | After every fire or skip                  |
| `domains/meta/app/server/routes/action.ts` | `dashboard` | `ai-prompt`                      | After the spawned `claude -p` closes      |
| `domains/meta/app/server/routes/edit.ts`   | `dashboard` | `edit`                           | After a vault file write succeeds         |
| `scripts/audit.mjs` (future)               | `audit`     | `audit-run`                      | After the audit completes                 |
| Skills (future)                            | `skill`     | `skill-invocation`               | Skill bodies can call the helper directly |

The pattern is **dual-write**: existing JSONL append continues unchanged for backward compatibility; events.db insert is added next to it. If the DB write fails, the JSONL still has the record — telemetry is best-effort.

### Event attribution — pulling `change_id` / `project` / `domain`

Every writer above must populate `change_id`, `project`, and `domain` on its event row whenever the action operates on one of those primitives. **All extraction goes through one helper**, `scripts/extract-event-attribution.mjs`, so the regexes evolve in one place when the prompt/intent/path formats shift:

| input source             | helper to call           | what it lifts                                 |
| ------------------------ | ------------------------ | --------------------------------------------- |
| Dashboard prompt body    | `extractFromPrompt`      | `change_id`, `project`, `domain`, `report_id` |
| CLI router intent        | `extractFromIntent`      | `change_id`, `project`                        |
| Edited file path         | `extractFromPath`        | `change_id`, `domain` (from canonical layout) |
| Review id (args.review)  | `extractFromReviewId`    | `change_id` (manifest lookup)                 |
| Report id (args.report)  | `extractFromReportId`    | `project` (manifest lookup)                   |
| Multiple signals at once | `mergeAttributions(...)` | first non-null wins                           |

**Contract:** events whose `skill` is in `CHANGE_SCOPED_SKILLS` (`dev-add-change`, `dev-write-change`, `dev-review-change`, `dev-open-pr`, `dev-close-change`, `dev-pr-review`, `dev-address-comments`) MUST have `change_id` set. Events whose `skill` is in `REPORT_SCOPED_SKILLS` (`research-write`, `research-review`, `research-revise`, `research-update`, `research-scaffold-recommendations`) MUST have `report_id` set. The audit checks `events-skill-attribution-missing` and `events-report-attribution-missing` enforce these — surfacing untagged rows so a missed writer doesn't silently empty the Changes / Research views' Activity tabs.

When adding a new `recordEvent` call site: import the appropriate helper, pass the result through to the event payload. When adding a new change-scoped skill: append it to `CHANGE_SCOPED_SKILLS` so the audit knows to enforce attribution.

Retroactive cleanup uses `scripts/events-db-tag-changes.mjs`, which replays the JSONL audit logs through the same helper and updates events.db rows that were written before a writer was patched. Idempotent; `--dry-run` for preview.

## 4. JSONL legacy compatibility

Three JSONL files already exist in `vault/raw/`:

- `router-log.jsonl` — `/os` dispatches
- `dashboard-actions.jsonl` — dashboard AI bridge calls + edits
- `scheduled-runs.jsonl` — cron fires

**Decision: keep them where they are for v1.** They were placed in `vault/raw/` before the vault/telemetry separation was crisp. Moving them now would touch ~6 files (endpoints, audit, standards). Instead:

- New writes continue to append to JSONL (backward compat)
- New writes ALSO insert into events.db (the new canonical layer)
- `scripts/events-db-backfill.mjs` reads the existing JSONL and seeds the DB
- The dashboard's Activity view continues reading JSONL (no churn); the new Insights view reads from events.db

A future cleanup phase can move the JSONL files to `.claude/state/` and retire the dual-write path, once events.db is proven.

## 5. Operations

### Bootstrap

```bash
node scripts/events-db-init.mjs        # idempotent create
node scripts/events-db-backfill.mjs    # seed from existing JSONL
```

### Inspect from CLI

```bash
sqlite3 .claude/state/events.db "SELECT count(*) FROM events"
sqlite3 .claude/state/events.db "SELECT kind, count(*) FROM events GROUP BY kind"
sqlite3 .claude/state/events.db "SELECT * FROM events ORDER BY ts DESC LIMIT 10"
```

### Read endpoints

| endpoint                             | returns                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `GET /api/events-db?since=&kind=...` | Filtered event rows (skill, project, change, since, limit)       |
| `GET /api/events-db/stats?window=`   | Aggregate counts by kind/skill/model + total cost + slowest list |

### Retention

No retention policy in v1. SQLite handles tens of millions of rows comfortably; a rough estimate is ~1KB per row, so 1M rows ≈ 1GB. We will revisit once the DB crosses 100MB.

When retention is added, it will be a `scripts/events-db-vacuum.mjs` that prunes rows older than N days while preserving aggregate snapshots — never inside the helper or write path.

### File-system layout

```
.claude/state/
  events.db           ← NEW canonical telemetry store
  schedule-runs.json  ← unchanged (dedupe state)
  installed-at        ← unchanged
  pending-curation.txt ← unchanged
```

### Failure modes

| failure                           | behavior                                                   |
| --------------------------------- | ---------------------------------------------------------- |
| events.db file missing            | Helper auto-runs init; first write recreates schema        |
| Disk full / permission denied     | Write fails silently (logged to stderr); JSONL still wrote |
| Schema drift (new column missing) | Audit's `events-db-schema-current` check warns             |
| Backfill re-run                   | INSERT OR IGNORE on `dedupe_key` — safe to re-run anytime  |

## 6. Audit checks

| id                         | severity   | what                                                                                                                                                                                      |
| -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events-db-exists`         | info       | DB file is present (opt-in: only warns if any other code has tried to write)                                                                                                              |
| `events-db-schema-current` | error      | Actual `events` columns match the standard's column list                                                                                                                                  |
| `run-origin-missing`       | error/info | `runs.origin` column exists (error if missing) + every non-NULL value is in the `RUN_ORIGINS` vocabulary (error otherwise); NULL rows tolerated as legacy `human` (info)                  |
| `runs-db-schema-current`   | warn       | Actual `runs` columns include every entry in `RUNS_EXPECTED_COLUMNS`; a non-origin column going missing warns here (not under `run-origin-missing`), mirroring `events-db-schema-current` |

## 7. Why these choices

- **SQLite over MySQL/Postgres** — zero daemon, no containers, single file, embedded in Node 22.5+ via `node:sqlite`. Aligns with the OS's "no external services" principle.
- **node:sqlite over `better-sqlite3`** — no npm dependency, no native compilation. Available since Node 22.5; stable. The OS already requires Node 22+.
- **Single wide table over normalized schema** — query patterns are dominated by "filter by axis, aggregate" rather than joins. Wide table is faster to iterate; columns are cheap; nullable everywhere.
- **Dual-write to JSONL** — defensible v1 migration. Either layer alone provides full audit trail; dropping JSONL is a future decision once events.db proves itself.
- **`dedupe_key` over UNIQUE composite** — content-addressed; resilient to fast successive events that share `ts|kind|action`.

## See also

- [[concept-vault]] — the knowledge layer this entry differentiates from
- [[standard-os-audit]] — registers the `events-db-*` checks
- [[meta-audit]] — the skill that surfaces drift
- [[concept-app]] — the OS dashboard reads events.db via `/api/events-db`
- [[note-layered-defense-pattern]] — events.db is not a defense layer, it is the **observability surface** that lets defenses be diagnosed
