// Projects — cross-repo work glue with reporting cadence.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'projects',
  label: 'Projects',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
