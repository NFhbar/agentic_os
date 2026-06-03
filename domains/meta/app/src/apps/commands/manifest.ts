// Commands — the /os intent vocabulary mapped to skills, grouped by domain.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'commands',
  label: 'Commands',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
