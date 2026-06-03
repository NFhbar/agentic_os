// Changes — atomic code-work unit (single repo, branch, PR).

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'changes',
  label: 'Changes',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
