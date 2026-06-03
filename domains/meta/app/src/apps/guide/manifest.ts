// Guide — orientation + reference, auto-aggregated from vault/wiki/_seed/meta/.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'guide',
  label: 'Guide',
  domain: 'meta',
  navGroup: 'utility',
  View: () => import('./View'),
};
