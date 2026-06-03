// Skills — list + detail SKILL.md editor.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'skills',
  label: 'Skills',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
