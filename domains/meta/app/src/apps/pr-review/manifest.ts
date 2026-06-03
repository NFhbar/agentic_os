// PR Review — multi-agent code review over indexed repos.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'pr-review',
  label: 'PR Review',
  domain: 'development',
  navGroup: 'primary',
  View: () => import('./View'),
};
