// Overseer — the dashboard surface for lifecycle-audit entries produced by
// the meta-overseer-review skill. Phase 2 of the Overseer arc (Phase 1c shipped
// the skinny slice as an Insights tab; this is the dedicated app).
//
// Lives in the meta domain — self-introspection of OS quality is meta's
// responsibility. Sibling to Insights (telemetry) + Health (audit findings).
// Alphabetical ordering by id places it between Notifications and PR-Review
// in the sidebar's meta-primary group.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'overseer',
  label: 'Overseer',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
  // No DB or routes — Overseer reads from the existing /api/audits family.
};
