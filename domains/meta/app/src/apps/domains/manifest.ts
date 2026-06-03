// Domains — list + detail playbook editor.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'domains',
  label: 'Domains',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
