// Manifest contract for OS apps that live as dashboard modules.
// Locked by vault/wiki/_seed/meta/reference/standard-app-architecture.md § 3.
//
// Every app at domains/meta/app/src/apps/<id>/manifest.ts exports a `manifest`
// of this shape. The shell discovers them at boot via import.meta.glob.

import type React from 'react';

/** Where in the sidebar this app appears. */
export type NavGroup = 'primary' | 'utility';

/**
 * Context passed to the optional `badge` callback so the app can render a
 * dynamic indicator (count, error dot, etc.) on its sidebar entry without
 * subscribing to data inside the View.
 */
export interface BadgeContext {
  /** Number of in-flight long-running actions across all apps (e.g. running reviews). Surface from events.db. */
  runningCount?: number;
  /** Whether any recent errors were recorded. */
  hasErrors?: boolean;
}

/**
 * Declarative schema for the app's optional SQLite DB. The shell calls
 * openAppDb(manifest.id, manifest.db) at boot to apply it idempotently.
 * See standard-app-persistence.md for the broader pattern.
 */
export interface AppDbDeclaration {
  /** CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS statements only. Schema is the app's source of truth. */
  schema: string;
}

/**
 * A lazy ES-module loader. Used for View and routes so each app is code-split
 * and only loaded when actually focused.
 */
type LazyComponent = () => Promise<{ default: React.ComponentType }>;
type LazyModule = () => Promise<unknown>;

export interface AppManifest {
  /** Unique kebab-case id; must match the folder name. Used as events.db `kind: app-<id>`, app-DB filename, URL slug. */
  id: string;
  /** Display text in the sidebar. */
  label: string;
  /** Owning OS domain (e.g. `development`, `meta`, `research`). Must exist as a domains/<name>/ directory. */
  domain: string;
  /** Sidebar cluster placement. */
  navGroup: NavGroup;
  /** Optional sidebar icon. Lazy so unused apps don't pull their icons. Defaults to a neutral glyph. */
  icon?: LazyComponent;
  /** Optional dynamic badge content for the sidebar entry. */
  badge?: (ctx: BadgeContext) => string | number | null;
  /** REQUIRED — lazy import of the top-level view component (default export of View.tsx). */
  View: LazyComponent;
  /** OPTIONAL — lazy import of a Fastify plugin; auto-mounted under /api/apps/<id>/. */
  routes?: LazyModule;
  /** OPTIONAL — SQLite schema declaration. Shell opens the DB at boot. */
  db?: AppDbDeclaration;
}

/** Runtime form after discovery — the manifest plus where it was found. */
export interface DiscoveredApp {
  manifest: AppManifest;
  /** Absolute module path the manifest was loaded from (debugging / audit). */
  path: string;
}
