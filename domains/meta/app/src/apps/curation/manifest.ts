// Curation — raw → wiki promotion queue.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'curation',
  label: 'Curation',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
