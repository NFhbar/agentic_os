---
name: meta-add-app
description: Scaffold a new OS app — default is a dashboard module (a folder under domains/meta/app/src/apps/), standalone Vite+Fastify deployment available with --standalone for rare cases
user-invocable: true
version: 2
domain: meta
tags: [scaffold, evolution, app]
inputs:
  app_name:
    type: string
    required: true
    pattern: '^[a-z][a-z0-9-]*$'
    description: 'App id / folder name (lowercase kebab-case). Must be unique across all apps. Used as the events.db `kind: app-<id>`, app-DB filename, URL slug, sidebar key.'
  label:
    type: string
    required: true
    description: Human-readable display name shown in the dashboard sidebar.
  domain:
    type: string
    required: true
    description: 'Owning OS domain (must exist as `domains/<name>/`). Common values: `meta`, `development`, `research`.'
  shape:
    type: string
    required: false
    default: module
    enum: [module, standalone]
    description: 'STRICT ENUM: `module` (default — folder under the dashboard) or `standalone` (full Vite+Fastify deployable at its own port). Module is correct for ~90%+ of apps. Standalone requires explicit justification (different auth boundary, GPU-bound viz, etc.) — see standard-app-architecture.md § 1.'
  nav_group:
    type: string
    required: false
    default: primary
    enum: [primary, utility]
    description: 'Sidebar cluster: `primary` (top, daily workflow) or `utility` (below the divider, reference / diagnostic).'
  description:
    type: string
    required: false
    description: 'Optional free-form context. Used in the scaffolded README and the app''s initial View placeholder.'
  needs_db:
    type: boolean
    required: false
    default: false
    description: 'Whether the app needs SQLite persistence. When true, scaffold `db.ts` + populate `manifest.db.schema` with a starter table. See standard-app-persistence.md.'
  needs_routes:
    type: boolean
    required: false
    default: false
    description: 'Whether the app needs Fastify routes (e.g. for backend-driven endpoints). When true, scaffold `routes.ts` (mounted at /api/apps/<app_name>/) + populate `manifest.routes`.'
outputs:
  - kind: folder
    path: 'domains/meta/app/src/apps/{{input.app_name}}/  (module shape)'
  - kind: folder
    path: 'domains/{{input.domain}}/{{input.app_name}}/app/  (standalone shape)'
spawns: []
---

# meta-add-app

## Purpose

Scaffold a new OS app. **Default is a dashboard module** — a folder under `domains/meta/app/src/apps/<app_name>/` that the existing dashboard discovers and mounts via its manifest contract. Standalone apps (full Vite+Fastify deployments) remain supported for rare cases via `shape: standalone`.

The microkernel principle (see [[standard-app-architecture]]): apps consume OS services (skills, vault, events.db, audit, scheduler) and cannot run independently. Even standalone apps mount against the same OS substrate.

## Module shape (default)

### Procedure

1. Validate `inputs.app_name` against `^[a-z][a-z0-9-]*$`. Reject if invalid.
2. Confirm `domains/<input.domain>/` exists. If not, reject and suggest `/os add-domain` first.
3. Target dir: `domains/meta/app/src/apps/<input.app_name>/`. If it exists, abort with `app "<name>" already exists` (deliberate; don't overwrite).
4. Verify `domains/meta/app/src/shared/` exists (the design system). If missing, reject with "shared/ design system not present — run install first."
5. Create the target directory: `mkdir -p domains/meta/app/src/apps/<input.app_name>`.
6. **Write `manifest.ts`** at `domains/meta/app/src/apps/<input.app_name>/manifest.ts`. Use this shape:

   ```typescript
   import type { AppManifest } from '../../shell/manifest-types';

   export const manifest: AppManifest = {
     id: '<input.app_name>',
     label: '<input.label>',
     domain: '<input.domain>',
     navGroup: '<input.nav_group>',
     View: () => import('./View'),
     // Add { routes: () => import('./routes') } below if inputs.needs_routes
     // Add { db: { schema: '...' } } below if inputs.needs_db
   };
   ```

   If `inputs.needs_routes`: add the `routes:` line.

   If `inputs.needs_db`: add a `db: { schema: '...' }` block. Default starter schema:

   ```sql
   CREATE TABLE IF NOT EXISTS items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at TEXT NOT NULL,
     payload TEXT
   );
   ```

7. **Write `View.tsx`** at `domains/meta/app/src/apps/<input.app_name>/View.tsx`. Default stub:

   ```tsx
   import { Card, Empty, Icons } from '../../shared';

   export default function View() {
     return (
       <div className="page">
         <h1 className="h1"><input.label></h1>
         <Card>
           <Empty
             title="<input.label> — not implemented yet"
             hint="<input.description or 'This app is scaffolded but has no behavior yet.'>"
             icon={<Icons.Sparkles size={24} />}
           />
         </Card>
       </div>
     );
   }
   ```

   The default export is required — the manifest's `View: () => import('./View')` resolves to it.

8. **If `inputs.needs_db`**: write `db.ts`:

   ```typescript
   // App-DB helper — calls openAppDb under the hood.
   // Schema is declared in manifest.ts; the shell applies it at boot.
   // See standard-app-persistence.md.

   import type { DatabaseSync } from 'node:sqlite';
   import { openAppDb } from '../../../../../scripts/app-db.mjs';

   let _db: DatabaseSync | null = null;

   export function db(): DatabaseSync {
     if (_db) return _db;
     _db = openAppDb('<input.app_name>');
     return _db;
   }

   // Add typed query functions here as the app needs them.
   ```

9. **If `inputs.needs_routes`**: write `routes.ts`:

   ```typescript
   import type { FastifyPluginAsync } from 'fastify';

   export const routes: FastifyPluginAsync = async (fastify) => {
     fastify.get('/health', async () => ({ ok: true, app: '<input.app_name>' }));
     // Add more routes here. They auto-mount under /api/apps/<input.app_name>/.
   };

   export default routes;
   ```

10. **Record the audit event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action add-app \
      --skill meta-add-app \
      --args '{"name":"<input.app_name>","domain":"<input.domain>","shape":"module","nav_group":"<input.nav_group>","needs_db":<input.needs_db>,"needs_routes":<input.needs_routes>}' \
      --files-touched '["domains/meta/app/src/apps/<input.app_name>/manifest.ts","domains/meta/app/src/apps/<input.app_name>/View.tsx"]'
    ```

11. **Print confirmation**:

    ```
    ✓ Module app created: <input.label>
      id:        <input.app_name>
      path:      domains/meta/app/src/apps/<input.app_name>/
      nav:       <input.nav_group>
      db:        <yes/no>
      routes:    <yes/no>
      next:      open the dashboard (the app auto-discovers); edit View.tsx to add behavior
    ```

### Output for module shape

- `domains/meta/app/src/apps/<app_name>/manifest.ts`
- `domains/meta/app/src/apps/<app_name>/View.tsx`
- `domains/meta/app/src/apps/<app_name>/db.ts` (if `needs_db`)
- `domains/meta/app/src/apps/<app_name>/routes.ts` (if `needs_routes`)
- No new npm install, no new port, no launch skill.

The dashboard discovers the new app at next boot (Vite picks it up via `import.meta.glob`).

## Standalone shape (rare)

Use when there's an explicit reason the app can't live inside the dashboard. The reason MUST be captured.

### Procedure

1. **Require justification.** Reject the request unless the user has provided a clear reason in `inputs.description`. The reason MUST be one of: different auth boundary, GPU-bound runtime, cross-machine bridge, mobile-first PWA, or a free-form explanation. Surface the question explicitly via AskUserQuestion if not provided.
2. Validate inputs. Verify `domains/<input.domain>/` exists.
3. Target: `domains/<input.domain>/<input.app_name>/app/`. If it exists, ask before overwriting.
4. Walk `_templates/app/` recursively. For each file:
   - Read content
   - Substitute placeholders: `{{domain}}`, `{{app_name}}`, `{{display_name}}`, `{{datetime}}`
   - Compute destination path by stripping the `.tmpl` suffix
   - Ensure parent dir exists, write file
5. **Write `STANDALONE.md`** at the new app's root with the user's justification (per the `standalone-justified` audit check).
6. Run `npm install --silent` in the new app directory. If it fails, report but leave the scaffold in place.
7. Compute the launch skill name: replace `/` with `-` in domain, then `<domain-flat>-<app_name>-app`.
8. Create `.claude/skills/<launch-skill-name>/SKILL.md` modeled on `meta-dashboard/SKILL.md`. The frontmatter MUST include `user-invocable: true`. The skill should:
   - Run `npm run dev` in the new app's directory
   - Use distinct ports (compute from `.claude/state/app-ports.json`)
   - Open the browser
9. Append a line to the domain's playbook `## Apps` section.
10. Record the audit event with `--args '{...,"shape":"standalone"}'`.

### Output for standalone shape

- Full app folder at `domains/<input.domain>/<input.app_name>/app/`
- `STANDALONE.md` justifying the choice (load-bearing for the `standalone-justified` audit check)
- Installed node_modules
- New launch skill at `.claude/skills/<launch-skill-name>/SKILL.md`
- Updated domain playbook Apps section
- Updated `.claude/state/app-ports.json`

## Errors

- Domain missing → suggest `/os add-domain` first
- App name collision → abort, don't overwrite
- For module: `shared/` design system not present → abort with install hint
- For standalone: justification not provided → AskUserQuestion to collect it (don't proceed without)
- For standalone: `npm install` fails → keep scaffold, report error
- For standalone: port conflict → pick the next available port automatically

## See also

- [[standard-app-architecture]] — the manifest contract this skill produces
- [[standard-app-design]] — the design system the scaffolded View imports from
- [[standard-app-persistence]] — the persistence pattern `db: { schema }` follows
- [[concept-app]] — plain-language overview
- [[meta-dashboard]] — the shell modules mount into (for module shape)
