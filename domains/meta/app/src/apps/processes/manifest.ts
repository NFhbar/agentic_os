// Processes — global run inspector for every skill dispatch.
// Backed by events.db's runs table + .claude/state/runs/<id>.jsonl.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'processes',
  label: 'Processes',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
