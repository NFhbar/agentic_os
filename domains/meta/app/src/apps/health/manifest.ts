// Health — OS audit findings drill-down.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'health',
  label: 'Health',
  domain: 'meta',
  navGroup: 'utility',
  View: () => import('./View'),
};
