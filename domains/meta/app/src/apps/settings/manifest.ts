// Settings — per-install config + usage analytics.
//
// Two tabs to start:
//   - Effort & cost: project-wide effort dropdown + per-skill effort
//     overrides + inherited-vs-overridden indicator
//   - Usage analytics: mirrors Claude Code's /usage output (totals, by-skill,
//     by-model, by-day) sourced from events.db kind='session' rows
//
// Lives in the meta domain — workspace configuration belongs alongside
// Overview, Insights, Overseer, etc. Settings are PER-INSTALL: writes only
// land in .claude/settings.local.json (gitignored), never the team-tracked
// .claude/settings.json.

import type { AppManifest } from '../../shell/manifest-types';

export const manifest: AppManifest = {
  id: 'settings',
  label: 'Settings',
  domain: 'meta',
  navGroup: 'primary',
  View: () => import('./View'),
};
