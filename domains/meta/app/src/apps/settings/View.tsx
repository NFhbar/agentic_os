// Settings app — tab router. Two tabs: effort + usage. Internal navigation
// via URL splat (parseRoute) so deep-link / back-forward work without local
// state — same pattern as Overseer, Vault, PR Review.

import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EffortPanel } from './EffortPanel';
import { UsagePanel } from './UsagePanel';

type TabId = 'effort' | 'usage';

function parseTab(splat: string): TabId {
  if (splat === 'usage' || splat.startsWith('usage/')) return 'usage';
  return 'effort';
}

export default function Settings() {
  const navigate = useNavigate();
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const tab = parseTab(splat);

  const setTab = useCallback(
    (t: TabId) => {
      navigate(t === 'effort' ? '/settings' : `/settings/${t}`);
    },
    [navigate],
  );

  return (
    <div className="page page-wide">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 className="h1" style={{ marginBottom: 2 }}>
            Settings
          </h1>
          <div className="tiny subtle">
            Per-install workspace configuration. Writes land in{' '}
            <code className="mono">.claude/settings.local.json</code> (gitignored) — the
            team-tracked baseline stays clean.
          </div>
        </div>
        <span className="spacer" />
        {/* audit-ignore: app-design-stepper — tabs are independent surfaces
            (Effort & cost vs Usage analytics), not a sequential workflow. */}
        <div className="tabs" role="tablist" aria-label="Settings section">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'effort'}
            className="tab"
            onClick={() => setTab('effort')}
          >
            Effort &amp; cost
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'usage'}
            className="tab"
            onClick={() => setTab('usage')}
          >
            Usage analytics
          </button>
        </div>
      </header>

      {tab === 'effort' && <EffortPanel />}
      {tab === 'usage' && <UsagePanel />}
    </div>
  );
}
