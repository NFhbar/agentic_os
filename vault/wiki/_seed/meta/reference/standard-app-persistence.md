---
id: standard-app-persistence
type: reference
domain: meta
created: 2026-05-22T02:16:32Z
updated: 2026-05-22T02:16:32Z
tags: [standard, app, persistence, sqlite, vault, events]
source: manual
private: false
title: App persistence standard
url: internal://standard/app-persistence
kind: doc
last_verified: 2026-05-22
---

# App persistence standard

How OS apps store data. Defines the **three persistence layers** and the rubric for deciding which to use. Lives alongside [[standard-app-architecture]] (the structural contract) and [[standard-app-design]] (the visual layer).

The core principle: **apps don't own source-of-truth data**. They own _derived_ state (caches, indexes, UI preferences). Source-of-truth lives in OS-level services (vault, events.db). The forcing function: if you `rm -rf .claude/state/apps/<id>.db` the app should still function, just losing its cache.

## 1. The three layers

| layer             | path                             | purpose                                                                                                                                      | example for PR review                                                                  |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Vault**         | `vault/wiki/` + `vault/output/`  | Curated, semantic, archetype-typed knowledge artifacts. Long-lived. Often human-readable. Git-tracked in `_seed/` or per-instance.           | Each review pass's markdown at `vault/output/development/pr-review/<slug>-pass-<n>.md` |
| **events.db**     | `.claude/state/events.db`        | Telemetry. Every action invocation with metadata (model, tokens, cost, duration, files_touched). Append-only. Gitignored. One row per event. | Every "Run review" button click logged with kind=`app-pr-review`, cost, duration       |
| **App-DB** (this) | `.claude/state/apps/<app-id>.db` | Per-app SQLite for cache, derived state, UI prefs, queues. One DB per app. Schema declared in the app's manifest. Gitignored.                | Cached list of open PRs from `gh`, last-fetch timestamps, "hide drafts" prefs          |

The three layers don't overlap. Each piece of data has exactly one home.

## 2. Decision rubric — where does this data go?

Ask in order; the first match wins.

| question                                                                       | if yes → goes in                         |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| Is this a curated knowledge artifact (review report, status report, decision)? | Vault (`output/` or `wiki/`)             |
| Is this a long-lived semantic entity (repo, person, project)?                  | Vault (`wiki/<archetype>/`)              |
| Does this record that something happened (an action, a fire, a run)?           | events.db                                |
| Is this app-specific cache / index / derived state / UI preference?            | App-DB                                   |
| Does another app need to read this?                                            | NOT app-DB → raise to vault or events.db |
| Is it ephemeral within a single React component lifecycle?                     | React state (no persistence)             |

**The "another app needs to read this" rule is load-bearing.** Apps don't open each other's DBs. If shared data is genuinely needed, it belongs in vault (if knowledge) or events.db (if telemetry).

## 3. Per-app SQLite — the pattern

Each app that needs SQLite gets ONE database file at `.claude/state/apps/<app-id>.db`. The schema is declared in the app's manifest (see [[standard-app-architecture]] § 3); the shell calls `openAppDb` at boot to apply it.

### The shared helper: `scripts/app-db.mjs`

Mirrors the events-db helpers (`events-db-init.mjs` + `events-db.mjs`) but app-aware:

```javascript
import { openAppDb, listAppDbs } from './app-db.mjs';

// Open or create the app's DB; apply the schema idempotently.
const db = openAppDb('pr-review', {
  schema: `
    CREATE TABLE IF NOT EXISTS prs (
      number INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prs_state ON prs(state);
  `,
});

// Standard node:sqlite ops from here.
const stmt = db.prepare('SELECT * FROM prs WHERE state = ?');
const open = stmt.all('open');
```

`openAppDb(id, { schema })` does:

1. Validate `id` matches `^[a-z][a-z0-9-]*$`
2. Compute path: `.claude/state/apps/<id>.db`
3. `mkdir -p` the parent directory
4. Open via `node:sqlite` (built into Node ≥ 22.5)
5. Enable WAL mode + foreign keys
6. Run the schema (idempotent `CREATE … IF NOT EXISTS` only)
7. Return the connection (cached for process lifetime)

The helper is read-or-create — apps don't init their DB explicitly; the shell does it at boot from the manifest.

### `listAppDbs()` for tooling

Returns `[{ id, path, sizeBytes, mtime }]` for every existing app DB. Used by the dashboard's settings/diagnostic pages + the audit.

## 4. Sub-DBs when one DB is too coarse

The default is **one DB per app**. Use sub-DBs only when an app has multiple independent concerns whose lifecycles diverge:

```
.claude/state/apps/
  pr-review.db                ← default: one file, all tables
  large-app/
    cache.db                  ← cache lifecycle (re-fetchable from gh)
    prefs.db                  ← user prefs (sticky)
```

If you reach for sub-DBs, surface the decision in the app's README — it's a non-default choice.

## 5. Schema management

### Init: declarative via manifest

Schemas are declared as `CREATE TABLE IF NOT EXISTS …` blocks in the manifest. The shell applies them at boot. No migration framework, no schema_version table.

### Additive evolution

Schema changes are **additive only** in v1:

- ✓ Add new columns (default NULL or with a literal default)
- ✓ Add new indexes
- ✓ Add new tables
- ✗ Drop columns
- ✗ Rename columns / tables
- ✗ Change types

When a destructive change is genuinely needed, the cost-effective path is: delete `<app>.db`, redeploy with the new schema, let the app rebuild its cache from source-of-truth (vault + gh + wherever). This is acceptable because app-DBs hold derived state by definition.

### Future: migrations

If schema churn becomes a real problem, the helper can grow:

- A `schema_version` metadata table managed per-DB
- A `migrations: [{ from: 1, to: 2, sql: '…' }]` array in the manifest
- The shell runs missing migrations on boot

This is a v2 concern. Deferred until the pain is real.

## 6. What apps DON'T persist

| concern                                      | why not                                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| OS-level state (skill registry, manifest, …) | Owned by the OS. Apps read; never write.                                                                                                  |
| Secrets, API keys, tokens                    | Apps don't have their own secrets. They reuse what the dashboard's environment + skills provide.                                          |
| Cross-app data                               | If two apps need the same data, the data belongs in vault or events.db. Apps don't open each other's DBs.                                 |
| Knowledge artifacts                          | Belong in vault. Even if the app produced them (e.g. a status report), they go in `vault/output/<domain>/...`.                            |
| Audit trails / what happened                 | Belong in events.db. App audit events have `kind: app-<id>` and are surfaced in Insights alongside scheduler / dashboard / router events. |

## 7. Audit hooks

| id                        | severity | what it enforces                                                                                               |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `app-db-orphan`           | warn     | Every `.claude/state/apps/<id>.db` corresponds to an app whose manifest exists. Catches DBs from removed apps. |
| `app-db-schema-non-empty` | warn     | If a manifest declares `db`, the schema string contains at least one valid `CREATE TABLE`                      |
| `app-db-stale`            | info     | An app DB hasn't been written to in > 30 days. Suggests the app is unused (not necessarily wrong).             |

Schema-drift detection (analogous to `events-db-schema-current`) is **not** implemented per-app — apps own their schemas and the additive-evolution rule keeps drift low. Add later if needed.

## 8. Backup, inspection, cleanup

| operation        | how                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Backup one app   | `cp .claude/state/apps/<id>.db <backup-location>`                                                                   |
| Inspect schema   | `sqlite3 .claude/state/apps/<id>.db '.schema'`                                                                      |
| Inspect data     | `sqlite3 .claude/state/apps/<id>.db 'SELECT …'`                                                                     |
| Clear cache      | Delete the DB file; restart the app; it rebuilds from source                                                        |
| Uninstall app    | Delete `apps/<id>/` (the manifest + source) AND `.claude/state/apps/<id>.db`. The app is gone with no orphan state. |
| List all app DBs | `ls .claude/state/apps/` or `node -e "import('./scripts/app-db.mjs').then(m => console.log(m.listAppDbs()))"`       |

All app DBs are gitignored under the existing `.claude/state/*` rule.

## 9. Relationship to events.db

App-DB and events.db serve different concerns:

| dimension      | App-DB                                             | events.db                                             |
| -------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Granularity    | Whatever schema the app declares (rows, tables)    | One row per OS action; fixed schema                   |
| Lifecycle      | Mutable per app's needs (cache invalidation, etc.) | Append-only                                           |
| Scope          | One app                                            | All OS actions, all apps                              |
| Query pattern  | App-specific                                       | Aggregate across kind/skill/model/time                |
| When apps emit | When caching / persisting prefs / queuing          | Whenever the app fires an action (record via wrapper) |

A PR review fires both:

- `recordEvent({ kind: 'app-pr-review', action: 'start-review', cost_usd, duration_ms, … })` → events.db (the "what happened")
- `db.prepare('UPDATE prs SET state = ? WHERE number = ?').run('reviewed', 1284)` → app-DB (the "current state of this PR")

The OS sees both in Insights (telemetry) + the app sees its own DB (state).

## 10. Quick reference — example sketches

### App that doesn't need persistence

```typescript
// apps/log-viewer/manifest.ts
export const manifest = {
  id: 'log-viewer',
  label: 'Logs',
  domain: 'meta',
  navGroup: 'utility',
  View: () => import('./View'),
  // no `db`, no `routes` — pure UI over events.db
};
```

The app reads events.db via the existing `/api/events-db` endpoint. No app-DB needed.

### App with cache + queries

```typescript
// apps/pr-review/manifest.ts
export const manifest = {
  id: 'pr-review',
  label: 'PR review',
  domain: 'development',
  navGroup: 'primary',
  View: () => import('./View'),
  routes: () => import('./routes'),
  db: {
    schema: `
      CREATE TABLE IF NOT EXISTS prs (
        number INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        review_path TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prs_state ON prs(state);
      CREATE INDEX IF NOT EXISTS prs_repo ON prs(repo);
    `,
  },
};
```

The shell creates `.claude/state/apps/pr-review.db` at boot. The app's `db.ts` calls `openAppDb('pr-review', { schema })` and exposes typed queries.

## See also

- [[standard-app-architecture]] — manifest contract that declares `db`; lifecycle that opens it
- [[standard-app-design]] — the visual layer; how persistence surfaces in the UI
- [[standard-event-store]] — events.db; what apps log there with `kind: app-<id>`
- [[concept-vault]] — vault as knowledge layer; rules out app-DB as a vault substitute
- [[meta-add-app]] — the scaffolder that handles the `needs_db?` input
