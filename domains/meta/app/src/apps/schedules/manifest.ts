// Schedules — scheduled runbooks list with manual run-now action.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'schedules',
  label: 'Schedules',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
