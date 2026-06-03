// Activity — unified event feed across vault/raw/*.jsonl streams.
// Migrated to apps/<id>/ as the second proof of the contract.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'activity',
  label: 'Activity',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
