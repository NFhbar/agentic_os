// Vault — wiki/raw/output browser.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'vault',
  label: 'Vault',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
