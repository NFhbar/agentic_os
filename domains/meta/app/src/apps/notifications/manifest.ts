// Notifications — settings UI for the per-(event, channel) rule matrix.
// Backed by the dispatcher's afterInsert hook + the rate-limiter + the
// three channel adapters (Slack / email / desktop).

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'notifications',
  label: 'Notifications',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
