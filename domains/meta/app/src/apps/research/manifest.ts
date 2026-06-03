// Research — durable research-reports per project, with lifecycle (write →
// review → revise → approve → scaffold → update).

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'research',
  label: 'Research',
  domain: 'research',
  navGroup: 'primary',
  View: () => import('./View'),
};
