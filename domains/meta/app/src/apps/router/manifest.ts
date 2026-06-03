// Router — telemetry view for /os dispatches.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'router',
  label: 'Router',
  domain: 'meta',
  navGroup: 'utility',
  View: () => import('./View'),
};
