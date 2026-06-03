---
id: standard-app-architecture
type: reference
domain: meta
created: 2026-05-22T02:16:32Z
updated: 2026-05-22T02:16:32Z
tags: [standard, app, architecture, microkernel, dashboard]
source: manual
private: false
title: App architecture standard
url: internal://standard/app-architecture
kind: doc
last_verified: 2026-05-22
---

# App architecture standard

How OS apps are structured, discovered, and integrated. Locks the microkernel pattern: apps **consume OS services** (skills, vault, events.db, audit, scheduler, settings) and **cannot run independently**. Without the OS, an app has nothing to render and nothing to talk to.

Consumed by [[meta-add-app]] (scaffolds new apps following this standard), the OS dashboard's boot sequence (discovers + mounts apps), and every app's manifest.

> See also: [[standard-app-design]] for the visual layer, [[standard-app-persistence]] for per-app data, [[concept-app]] for the plain-language overview.

## 1. Two app shapes

Every app is one of two shapes. **Module is the default**; standalone is rare.

| shape          | what it is                                                                                                                                                        | when to use                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **module**     | A registered tab/view inside the OS dashboard. Shares the dashboard's Vite bundle, Fastify server, auth, vault routes, AI bridge, audit logging, settings, theme. | Default. ~90%+ of apps. PR review, log viewers, status dashboards, command palettes, anything markdown-rendering / button-triggering / list-with-detail.                                                                          |
| **standalone** | A full Vite + Fastify deployable at its own port (the current `domains/meta/app/` itself, plus any future apps that legitimately need this).                      | Rare. Requires explicit justification per [[meta-add-app]]. Examples: a public stakeholder dashboard with different auth, a GPU-bound visualization, a cross-machine bridge, a mobile-first PWA needing different bundler config. |

The OS dashboard at `domains/meta/app/` is the canonical standalone — it IS the shell modules mount into. Everything else defaults to module unless there's a written justification.

## 2. Apps directory layout (module shape)

```
domains/meta/app/                         ← THE shell (one standalone, the dashboard)
  src/
    shared/                               ← cross-app primitives (icons, badges, code pane, sparkline,
                                            severity bar, trend chart, switch, toast, modal). See
                                            standard-app-design.md for what belongs here.
    shell/                                ← navigation, layout, theme, settings — NOT an app.
                                            Owned by the dashboard itself.
    apps/                                 ← every module lives here, one folder per app
      overview/                           ← built-ins (over time, current top-level views move here)
        manifest.ts
        View.tsx
      vault/
        manifest.ts
        View.tsx
        routes.ts
        db.ts
      pr-review/                          ← NEW apps go here, same shape
        manifest.ts
        View.tsx                          ← top-level view; renders its own sub-nav
        tabs/                             ← optional, when the app has multiple sub-pages
          dashboard.tsx
          reviews.tsx
          review-detail.tsx
          repos.tsx
          settings.tsx
        routes.ts                         ← optional Fastify plugin (when the app needs server logic)
        db.ts                             ← optional app-DB helper (when the app needs SQLite cache)
        types.ts                          ← optional shared types within the app
    main.tsx                              ← discovers manifests + wires routing + sidebar
  server/
    index.ts                              ← core server; auto-mounts each app's routes plugin
    core/                                 ← shared services consumed by all apps (vault, skills proxy,
                                            events.db wrapper, settings, auth)
```

**Discovery**: at boot, `main.tsx` scans `apps/*/manifest.ts` (Vite supports this via `import.meta.glob`); `server/index.ts` scans `apps/*/routes.ts` similarly. Adding an app = adding a folder. No central registry to edit.

## 3. The manifest contract

Every app exports a `manifest` from `apps/<id>/manifest.ts`:

```typescript
import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'pr-review',                       // unique, kebab-case; must match folder name
  label: 'PR review',                    // sidebar display name
  domain: 'development',                 // owning OS domain (must exist)
  navGroup: 'primary',                   // 'primary' | 'utility'  (sidebar cluster)
  icon: () => import('./icon'),          // optional; defaults to a generic app glyph
  badge: (ctx) => ctx.runningCount,      // optional; small number/dot/status in sidebar
  View: () => import('./View'),          // LAZY — code-split per app
  routes: () => import('./routes'),      // OPTIONAL — Fastify plugin, lazy
  db: {                                  // OPTIONAL — declares the app's SQLite schema
    schema: `
      CREATE TABLE IF NOT EXISTS prs (
        number INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        reviewed_at TEXT,
        review_path TEXT,
        fetched_at TEXT NOT NULL,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS prs_state ON prs(state);
    `,
  },
};
```

### Field semantics

| field      | required | meaning                                                                                                                                                                                                                                |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | yes      | Kebab-case; must match the folder name; must be unique across all apps. Used as the events.db `kind: app-<id>` namespace, the app-DB filename, the URL slug, the audit-event attribution.                                              |
| `label`    | yes      | Sidebar display text. Short.                                                                                                                                                                                                           |
| `domain`   | yes      | OS domain that owns this app (e.g. `development`, `meta`, `research`). Must exist as a `domains/<name>/` directory. Used by audit to verify the app's owning domain is valid.                                                          |
| `navGroup` | yes      | `primary` (top sidebar cluster) or `utility` (below the divider).                                                                                                                                                                      |
| `icon`     | no       | Lazy import of an icon component. Defaults to a neutral app glyph from `shared/icons`. Use `shared/icons` exports rather than inlining SVG.                                                                                            |
| `badge`    | no       | Function receiving global context (`{ runningCount, errorCount, … }`) returning a number, string, or null. The shell renders the result next to the label.                                                                             |
| `View`     | yes      | LAZY import of the app's top-level view component. The shell calls it when the app is first focused; React Suspense handles the loading state.                                                                                         |
| `routes`   | no       | LAZY import of a Fastify plugin. The plugin's exported default function is registered with the prefix `/api/apps/<id>/`. Plugin can mount any routes under that prefix.                                                                |
| `db`       | no       | Object declaring the app's SQLite schema. The shell calls `openAppDb(id, { schema })` at boot, creating/opening `.claude/state/apps/<id>.db` and applying the schema idempotently. The app's `db.ts` calls the helper for runtime ops. |

### What's deliberately NOT in the manifest

- **Route paths inside the dashboard**: the shell owns top-level routing. Each app gets a slot at `/<id>`; what happens inside is the app's responsibility.
- **Settings keys, env vars, secrets**: settings come from the dashboard's central settings panel, surfaced to apps via React context.
- **Auth boundaries**: every app inherits the dashboard's auth (currently single-user local-only). Apps don't declare per-app auth.
- **App version, dependencies**: the dashboard is one bundle; per-app versioning would imply hot-swap, which isn't a v1 concern.

## 4. Lifecycle (what the shell does for each app)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        SHELL BOOT SEQUENCE                                 │
│                                                                            │
│  1. Vite scans src/apps/*/manifest.ts via import.meta.glob                 │
│  2. For each manifest:                                                     │
│       a. Register sidebar entry { id, label, icon, navGroup, domain }      │
│       b. If db is declared: openAppDb(id, { schema }) — schema applied     │
│       c. If routes is declared: server auto-mounts under /api/apps/<id>/   │
│       d. Register lazy View at /<id> for the dashboard's router            │
│  3. Group primary apps by manifest.domain into labeled sidebar sections    │
│     ('meta' → "Workspace", 'dev' → "Development", etc.). Utility apps      │
│     collapse into a single "Reference" section below all primary groups.   │
│  4. Render shell + sidebar; the active app loads on first focus            │
└────────────────────────────────────────────────────────────────────────────┘

When the user clicks the app's sidebar entry:
  - React Suspense fires; manifest.View() resolves
  - The app's top-level <View /> mounts inside the dashboard's content area
  - The app renders its own sub-navigation (tabs) if any
  - Sub-navigation state lives in the app — the shell doesn't track it
```

**Unmount**: when the user navigates away, the app's React tree unmounts; its open DB connection stays alive (the helper caches it). The app's tab/sub-state is gone unless persisted to the app-DB or vault.

## 5. Sub-navigation within an app

Each app owns its own sub-routing. Style: a **tabbed header inside the app's content area**, just below the dashboard's main topbar:

```
┌─ DASHBOARD SHELL ────────────────────────────────────────────────────────────┐
│ [sidebar]    [topbar: search, theme toggle, breadcrumbs]                     │
│                                                                              │
│              ┌─ APP CONTENT AREA ─────────────────────────────────────────┐  │
│              │ [app tabs: Dashboard | Reviews | Repos | Settings]         │  │
│              │                                                            │  │
│              │ <active tab's content>                                     │  │
│              └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

The tab bar is part of the app, not the shell. Apps with a single view skip it entirely.

State management: the app picks. Common pattern is a single `useState` for the active tab plus per-tab components. URL state for tabs is optional (shell exposes a hook `useAppRoute()` if the app wants `/pr-review/reviews` etc., but it's not required).

## 6. Theme system

**One global theme**, set at the dashboard level. **The only user-facing customization is light/dark mode.** No per-app accents, severity schemes, or tweaks panels.

| concern                                    | who owns it                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Color palette (accent, severity, semantic) | The dashboard's `shared/theme.css`. All apps use the same CSS variables.                     |
| Light/dark toggle                          | Dashboard topbar control. Apps respond automatically via `data-theme` attribute on `<html>`. |
| Per-app accent                             | NOT supported. If a future need surfaces, raise at the OS level — apps don't override.       |
| Density, font size, etc.                   | NOT user-customizable in v1. Fixed by the design system. Reassess at v2.                     |

Prototype-style "tweaks panels" are explicitly **not shipped**. The PR-review prototype's tweaks panel is a prototyping tool, not a production feature.

## 7. Cross-app concerns

Apps don't talk to each other directly. When two apps need to share data, the data lives in OS-level surfaces:

| concern                               | shared via                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knowledge artifacts                   | Vault (`vault/wiki/`, `vault/output/`)                                                                                                                                    |
| Telemetry / what happened across apps | events.db; each app's actions land with `kind: app-<id>` and are queryable in Insights                                                                                    |
| Triggers / invocations                | Apps invoke skills via the existing `/api/action` AI bridge. Apps DO NOT spawn `claude -p` directly, embed API keys, or call Anthropic.                                   |
| Per-app cache / derived state         | App-DB (`.claude/state/apps/<id>.db`) — see [[standard-app-persistence]]. Other apps cannot read this directly; if cross-app sharing is needed, raise to vault/events.db. |
| User settings (light/dark, etc.)      | Dashboard settings, surfaced to apps via context.                                                                                                                         |
| Search across apps                    | (Future) Shell-level search reads vault manifest + events.db; apps don't implement their own search.                                                                      |

The forcing function: **if you `rm -rf .claude/state/apps/<id>.db` the app should still function**, just losing its cache. Source-of-truth data lives in vault or events.db (which are OS services), not in the app.

## 8. Scaffolding (the `meta-add-app` skill)

The skill's behavior changes under this standard:

```
/os add app
  inputs:
    name             (required, kebab-case)
    label            (required)
    domain           (required, must exist)
    shape            (default: module; --standalone for the rare case)
    description?     (free-form context for auto-drafted README)
    nav_group        (default: primary)
    needs_db?        (boolean; if true, scaffold db.ts + manifest db field)
    needs_routes?    (boolean; if true, scaffold routes.ts + manifest routes field)
```

For `module` shape (the default):

- Creates `domains/meta/app/src/apps/<name>/` with:
  - `manifest.ts` populated from inputs
  - `View.tsx` (stub using shared primitives)
  - `db.ts` (only if needs_db; references `openAppDb` helper)
  - `routes.ts` (only if needs_routes; Fastify plugin stub)
- No npm install. No new port. No new server.
- Audit-records via the dual-write wrapper.

For `standalone` shape (rare):

- Current behavior: creates a full Vite+Fastify project at `domains/<domain>/<name>/app/`.
- The skill MUST require the user to confirm the rationale ("Why isn't this a module?") and embed the answer in the new app's README.

## 9. Audit hooks

| id                          | severity | what it enforces                                                                                                                      |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `app-manifest-required`     | error    | Every `apps/<id>/` directory has a `manifest.ts` whose default export validates against `AppManifest`                                 |
| `app-id-matches-dir`        | error    | `manifest.id` equals the folder name                                                                                                  |
| `app-domain-exists`         | error    | `manifest.domain` corresponds to a real `domains/<name>/` directory                                                                   |
| `app-navgroup-enum`         | error    | `manifest.navGroup` is one of `primary`, `utility`                                                                                    |
| `app-db-schema-present`     | warn     | If `manifest.db` is declared, the schema string is non-empty and contains at least one `CREATE TABLE IF NOT EXISTS`                   |
| `app-routes-prefix-correct` | warn     | If `routes` is declared and a Fastify plugin is auto-mounted, its first registered route prefix is `/api/apps/<id>/`                  |
| `standalone-justified`      | info     | Standalone apps (anything not in `apps/`) have a `STANDALONE.md` adjacent to their package.json explaining why module wasn't suitable |

## 10. Migration plan (the dashboard refactor that proves this standard)

The current dashboard at `domains/meta/app/` has top-level views (Vault, Skills, Commands, Schedules, Projects, Changes, Activity, Insights, Curation, Router, Health, Guide, Overview). These are baked into `App.tsx`'s `PRIMARY_VIEWS` + `UTILITY_VIEWS`.

Migration sequence:

1. Build `shell/` + `shared/` directories. Move icons, primitives there.
2. Move ONE view (e.g. Insights) to `apps/insights/` with a manifest. Validate end-to-end that the shell discovers + mounts it correctly.
3. Iterate. Surface and fix any contract gaps.
4. Migrate the rest of the views one at a time.
5. Delete `PRIMARY_VIEWS` / `UTILITY_VIEWS` arrays from `App.tsx`. Sidebar is now fully manifest-driven.
6. Update `meta-add-app` skill to the new scaffold.
7. Refactor `standard-app-layout` (or retire it in favor of this standard).

Once migrated, the **PR review app** becomes the first NEW app on the proven contract.

## See also

- [[standard-app-design]] — visual language + component primitives + page archetypes
- [[standard-app-persistence]] — per-app SQLite DB pattern + vault/events.db/app-db decision rubric
- [[concept-app]] — plain-language overview
- [[concept-vault]] — distinguishes vault (knowledge) from app-DB (per-app cache)
- [[standard-event-store]] — events.db usage; apps emit `kind: app-<id>` events here
- [[meta-add-app]] — the skill this standard governs
- [[meta-dashboard]] — the shell apps mount into
