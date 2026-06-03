// Overview — landing dashboard: stats, health, recent activity, brief.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'overview',
  label: 'Overview',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
