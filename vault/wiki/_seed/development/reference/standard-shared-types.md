---
id: standard-shared-types
type: reference
domain: development
created: 2026-05-29T23:54:11Z
updated: 2026-05-29T23:54:11Z
tags: [standard, types, api, conventions]
source: vault/wiki/development/change/shared-types-sibling-pattern.md
private: false
title: Shared API types — sibling .types.ts pattern
url: internal://standard/shared-types
kind: doc
last_verified: 2026-05-29
---

# Shared API types — sibling .types.ts pattern

## Why

Server route files define response/request types internally; client `data.ts` or `View.tsx` files redefine the same shapes for their fetch calls. When the two drift, the bug is silent — the runtime payload doesn't match the static type, but TypeScript can't see the gap because the definitions are independent. The original `/api/projects/:id/replay` bug ("client expected `{ kind: 'run', skill, ... }`, server emitted `{ kind: 'event', event: {...} }`") is the canonical example.

This standard locks the pattern: each server route's wire-shape types live in a sibling `.types.ts` file that BOTH server and client import. One definition, two consumers, drift impossible.

## The pattern

```
domains/meta/app/server/routes/
  research.ts          ← endpoint logic (Fastify handlers, db queries)
  research.types.ts    ← type definitions only (no node:* imports, no runtime values)

domains/meta/app/src/apps/research/
  data.ts              ← re-exports server types + adds client-only enums/constants
  View.tsx             ← imports types from data.ts (existing client convention)
```

### Rules

1. **`X.types.ts` holds ONLY type definitions.** No `node:fs` imports, no Fastify imports, no runtime values (no `export const X = [...]`). Anything stateful belongs in the sibling `X.ts`. This keeps the .types.ts safely importable by browser-bundled client code.
2. **Server route file imports its own types from `.types.ts`** using `import type`. It MAY also re-export them (`export type { ... } from './X.types.js'`) for backward compatibility with existing consumers that `import { X } from './X.js'`.
3. **Client modules import types directly from the server path** via `import type { X } from '../../../server/routes/X.types'` (relative path; no need for tsconfig path aliases — the single tsconfig covers both `src` and `server`).
4. **Client-only enums + runtime constants stay client-side.** If the client needs `NOTE_SEVERITIES` (a tuple used to render select options), define it in `data.ts` — it's a runtime value, not a wire-shape type. Re-import the underlying type from the server `.types.ts` to keep the tuple in sync.
5. **Client-side narrowing is allowed.** If the server emits a loose `status: string` but the archetype guarantees four values, the client can declare `export type RecChangeStatus = 'proposed' | 'scaffolded' | 'merged' | 'abandoned'` in `data.ts` and narrow at the rendering boundary. The server `.types.ts` stays the wire-shape source of truth.

## Migration recipe

When migrating an existing route:

1. Create `server/routes/<X>.types.ts`. Copy every exported type from `<X>.ts` into it (drop runtime-only types that aren't on the wire).
2. In `<X>.ts`: replace the inline definitions with `import type { ... } from './X.types.js'`. Add `export type { ... } from './X.types.js'` to preserve existing import paths.
3. Find client modules that redefine the same shapes (`grep -rn "interface ResearchReportSummary"` etc.) and replace with `import type { ... } from '../../../server/routes/X.types'`.
4. `npx tsc --noEmit` to verify no drift introduced.

## What this standard does NOT cover

- **Runtime validation.** The pattern provides compile-time alignment only. Endpoints still need to validate inbound request bodies (existing manual `validateBody` patterns continue). A future `standard-api-validation` could wrap this with Zod / typebox if the cost/benefit shifts.
- **tRPC / typed RPC frameworks.** Eliminating the dual-definition problem entirely via RPC was considered and deferred — it's a bigger architectural shift than bootstrap-phase warrants. This pattern is the lighter-weight alternative.
- **Server-internal types.** Types that never appear on the wire (helper functions, internal rollup shapes that don't reach an HTTP response) stay inline in the route file. Only wire-shape types belong in `.types.ts`.

## Status of migration

As of 2026-05-30 the pattern is fully adopted — every route file with a client consumer that duplicates wire shapes now has a sibling `.types.ts`. No active drift surface remains.

High-traffic routes:

- ✅ `routes/changes.types.ts` — ChangeSummary, FileRef, StageStatus, LifecycleStage, RelatedEntities, ChangeRollup
- ✅ `routes/research.types.ts` — ResearchReportSummary, ResearchReportDetail, RecommendedChangeRef, MaterialRef, UpdateTrigger, ReplayTimelineEntry, NoteRef + family
- ✅ `routes/notifications.types.ts` — RuleListItem + sub-shapes (filter/delivery/rate_limit), EventCatalogEntry, NotificationEvent, SlackMode, channel/severity/urgency enums + as-const tuples
- ✅ `routes/projects.types.ts` — Milestone, Reporting, ChangeAggregate, ProjectRollup, ProjectSummary, BacklinkRef, BacklinkGroup, ProjectScheduleRef, StatusReportRef, OwnedChangeRef, ProjectDetail
- ✅ `routes/runs.types.ts` — RunRecord (formerly RunRow), RunTags, RunFilter, RunState, StartRunInput, StartRunResult
- ✅ `routes/audit.types.ts` — AuditFinding, AuditResult, AuditResponse, AuditSeverity

Smaller routes (closed 2026-05-30):

- ✅ `routes/pr-review-config.types.ts` — PrReviewConfig, PrReviewConfigUpdateBody, CommentStyle, ContextStrategy
- ✅ `routes/schedules.types.ts` — ScheduleSummary, RunEntry, ScheduleStatus, SchedulesListResponse
- ✅ `routes/curation.types.ts` — CurationItem, CurationListResponse
- ✅ `routes/mcps.types.ts` — McpKind, ManifestTool, ManifestFile, McpServerEntry, McpConfig, McpRow, McpsListResponse
- ✅ `routes/reviews.types.ts` — Severity, ReviewRow, ReviewComment, PassStats, ReviewPass, ReviewDetail, RecentRun, LinkedChange, PassStatus, CommentState
- ✅ `routes/repos.types.ts` — Repo, KnowledgeSummary, ReposListResponse

Routes without typed client duplication (no migration needed): `health.ts` (ProposedAction/ActionItem are server-side scoped; client renders inline), `pr-review-metrics.ts` (ReviewArgs/MetricsPayload are server-internal), `skills.ts`, `vault.ts` (no exported types).

The "notifications special case" (server-permissive vs. client-strict) was resolved on 2026-05-30 by adopting the strict shape as canonical and casting at the parseFrontmatter boundary — see `notifications-shared-types-migration` change for the design rationale.

The "client-only optional fields" tension (e.g. `Repo.progress`, `ReviewPass.progress` for in-flight UI state the server never emits) was resolved on 2026-05-30 by including them on the canonical type as optional, with a comment marking them as client-only — see `smaller-routes-shared-types-migrations` change.

## Why "sibling" instead of a central `shared/api-types.ts` barrel

A barrel forces every type addition through one file — coordination overhead grows with team and route count. Sibling co-location means each route is self-contained: adding a new endpoint is `<endpoint>.ts` + `<endpoint>.types.ts`, no need to thread the type into a central registry. Imports become slightly longer (`../../../server/routes/X.types`) but discovery is improved — you find a route's types next to its handlers, not in a separate index.
