// MCPs — lists configured MCP servers (OS-built + third-party), shows status,
// surfaces add/scaffold action via meta-add-mcp.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'mcps',
  label: 'MCPs',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
