// Discover all installed apps at boot by scanning apps/*/manifest.ts.
//
// Vite's import.meta.glob does this at build time — every matching manifest
// becomes a module entry in the resulting bundle, so this is fully static
// despite being expressed as a runtime function call.

import type { AppManifest, DiscoveredApp } from './manifest-types';

/**
 * Returns every app whose folder under src/apps/ has a manifest.ts that exports
 * a valid `manifest` const. Sorted alphabetically by id for determinism.
 */
export function discoverApps(): DiscoveredApp[] {
  // `eager: true` resolves the manifests synchronously so we can build the
  // sidebar without an async boot dance. The View / routes inside each
  // manifest stay lazy.
  const modules = import.meta.glob<{ manifest: AppManifest }>('../apps/*/manifest.ts', {
    eager: true,
  });

  const apps: DiscoveredApp[] = [];
  for (const path in modules) {
    const mod = modules[path];
    if (!mod || typeof mod !== 'object' || !mod.manifest) {
      console.warn(`[discover] ${path} exports no \`manifest\` — skipping`);
      continue;
    }
    apps.push({ manifest: mod.manifest, path });
  }
  apps.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return apps;
}
