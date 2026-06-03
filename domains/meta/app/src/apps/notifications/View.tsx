// Notifications app — two surfaces under one nav item:
//   /notifications              → ActivityLog (default — what fired recently)
//   /notifications/rules        → Matrix (rule configuration grid)
//   /notifications/rules/new    → RuleEditor in create mode
//   /notifications/rules/:id    → RuleEditor in edit mode
// Header tabs let users switch between activity and rules without leaving the app.
//
// audit-ignore: app-design-stepper — settings/activity surfaces, not a lifecycle.

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ChannelId, RuleListItem } from './data';
import { listEventTypes, listRules, updateRule } from './data';
import { ActivityLog } from './pages/ActivityLog';
import { Matrix } from './pages/Matrix';
import { RuleEditor } from './pages/RuleEditor';

type View =
  | { kind: 'activity' }
  | { kind: 'rules-list' }
  | { kind: 'rules-new' }
  | { kind: 'rules-edit'; id: string };

function deriveView(splat: string): View {
  if (splat === '' || splat === '/') return { kind: 'activity' };
  if (splat === 'rules') return { kind: 'rules-list' };
  if (splat === 'rules/new') return { kind: 'rules-new' };
  if (splat.startsWith('rules/')) return { kind: 'rules-edit', id: splat.slice('rules/'.length) };
  return { kind: 'activity' };
}

export default function NotificationsApp() {
  const params = useParams<{ '*': string }>();
  const splat = params['*'] ?? '';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const view = deriveView(splat);
  const tab: 'activity' | 'rules' = view.kind === 'activity' ? 'activity' : 'rules';

  const [rules, setRules] = useState<RuleListItem[] | null>(null);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [r, et] = await Promise.all([listRules(), listEventTypes()]);
    setRules(r.rules);
    setEventTypes(et.event_types);
  }, []);

  useEffect(() => {
    if (tab === 'rules') refresh();
  }, [refresh, tab]);

  const onCellOpen = useCallback(
    (eventType: string, channel: ChannelId) => {
      navigate(
        `/notifications/rules/new?event_type=${encodeURIComponent(eventType)}&channel=${channel}`,
      );
    },
    [navigate],
  );

  const onRuleOpen = useCallback(
    (id: string) => {
      navigate(`/notifications/rules/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  const onToggleEnabled = useCallback(
    async (id: string, next: boolean) => {
      setBusy(true);
      try {
        await updateRule(id, { enabled: next });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const onSaved = useCallback(
    async (id: string) => {
      await refresh();
      navigate(`/notifications/rules/${encodeURIComponent(id)}`);
    },
    [refresh, navigate],
  );

  const onDeleted = useCallback(async () => {
    await refresh();
    navigate('/notifications/rules');
  }, [refresh, navigate]);

  const onCancel = useCallback(() => {
    navigate('/notifications/rules');
  }, [navigate]);

  const editorMode = view.kind === 'rules-edit' || view.kind === 'rules-new';

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Notifications</h1>
        <p className="subtle" style={{ margin: '4px 0 0', fontSize: 12 }}>
          {tab === 'activity'
            ? 'What fired recently. Click a rule to jump to its configuration.'
            : 'Per-(event, channel) routing rules. Each rule fires when an event matches and the rate-limit cap hasn’t been exceeded.'}
        </p>
      </header>

      <div
        role="tablist"
        style={{
          display: 'inline-flex',
          gap: 4,
          borderBottom: '1px solid var(--border)',
          paddingBottom: 0,
        }}
      >
        <NotificationsTab
          active={tab === 'activity'}
          label="Activity"
          onClick={() => navigate('/notifications')}
        />
        <NotificationsTab
          active={tab === 'rules'}
          label="Rules"
          onClick={() => navigate('/notifications/rules')}
        />
      </div>

      {tab === 'activity' ? (
        <ActivityLog onOpenRule={onRuleOpen} />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: editorMode ? '1fr 480px' : '1fr',
            gap: 18,
          }}
        >
          <div>
            {rules == null ? (
              <p className="subtle">Loading rules…</p>
            ) : (
              <Matrix
                rules={rules}
                eventTypes={eventTypes}
                onCellOpen={onCellOpen}
                onRuleOpen={onRuleOpen}
                onToggleEnabled={onToggleEnabled}
                busy={busy}
              />
            )}
          </div>
          {editorMode && (
            <div>
              <RuleEditor
                ruleId={view.kind === 'rules-edit' ? view.id : null}
                defaultEventType={
                  view.kind === 'rules-new' ? searchParams.get('event_type') ?? undefined : undefined
                }
                defaultChannel={
                  view.kind === 'rules-new'
                    ? ((searchParams.get('channel') ?? undefined) as ChannelId | undefined)
                    : undefined
                }
                defaultFilterProject={
                  view.kind === 'rules-new'
                    ? searchParams.get('filter_project') ?? undefined
                    : undefined
                }
                onSaved={onSaved}
                onDeleted={onDeleted}
                onCancel={onCancel}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const NotificationsTab: React.FC<{ active: boolean; label: string; onClick: () => void }> = ({
  active,
  label,
  onClick,
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    style={{
      background: 'transparent',
      border: 'none',
      borderBottom: active ? '2px solid var(--accent-text)' : '2px solid transparent',
      color: active ? 'var(--text)' : 'var(--text-2)',
      padding: '6px 14px',
      fontSize: 13,
      fontWeight: active ? 600 : 500,
      cursor: 'pointer',
      marginBottom: -1,
    }}
  >
    {label}
  </button>
);
