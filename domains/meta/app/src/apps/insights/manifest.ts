// Insights — first app on the new manifest contract.
// Migrated from src/views/Insights.tsx as the proof-of-contract for the
// apps/ layout. See standard-app-architecture.md.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'insights',
  label: 'Insights',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
  // No db, no routes — Insights is pure UI over the existing /api/events-db endpoint.
};
