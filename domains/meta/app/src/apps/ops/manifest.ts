// Ops — recurring health reviews. One group per review protocol; rows are the
// dated reports it has produced, with the verdict and KPI read from report
// frontmatter.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'ops',
  label: 'Ops',
  domain: 'ops',
  navGroup: 'primary',
  View: () => import('./View'),
};
