// ActivityLog: recent notification dispatch records. The default surface
// for /notifications — what actually fired, what was suppressed, what failed.
// Rule configuration lives one tab over at /notifications/rules.

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type NotificationEvent, listNotificationEvents } from '../data';

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function actionLabel(action: string, isTest: boolean): { text: string; color: string } {
  if (isTest) return { text: 'test-send', color: 'var(--accent-text)' };
  switch (action) {
    case 'sent':
      return { text: 'sent', color: 'var(--success-text)' };
    case 'suppressed-rate-limit':
      return { text: 'suppressed (rate-limit)', color: 'var(--warning-text)' };
    case 'failed':
      return { text: 'failed', color: 'var(--danger-text)' };
    default:
      return { text: action, color: 'var(--text-2)' };
  }
}

interface Props {
  onOpenRule: (id: string) => void;
}

export const ActivityLog: React.FC<Props> = ({ onOpenRule }) => {
  const navigate = useNavigate();
  const [events, setEvents] = useState<NotificationEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listNotificationEvents({ limit });
      setEvents(r.events);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div
        className="card"
        style={{ padding: 16, color: 'var(--danger-text)', borderColor: 'var(--danger-border)' }}
      >
        Failed to load notification events: {error}
      </div>
    );
  }

  if (events == null) {
    return <p className="subtle">Loading activity…</p>;
  }

  if (events.length === 0) {
    return (
      <div className="card" style={{ padding: 18 }}>
        <p className="subtle" style={{ margin: 0 }}>
          No notifications dispatched yet. Configure a rule under{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => navigate('/notifications/rules')}
            style={{ padding: 0 }}
          >
            Rules
          </button>{' '}
          and fire its event (or use Test-send) to see activity here.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '8px 12px' }}>When</th>
            <th style={{ textAlign: 'left', padding: '8px 12px' }}>Event</th>
            <th style={{ textAlign: 'left', padding: '8px 12px' }}>Rule</th>
            <th style={{ textAlign: 'left', padding: '8px 12px' }}>Channel</th>
            <th style={{ textAlign: 'left', padding: '8px 12px' }}>Outcome</th>
            <th style={{ textAlign: 'left', padding: '8px 12px' }}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => {
            const a = actionLabel(ev.action, ev.is_test);
            return (
              <tr key={ev.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
                  {formatTs(ev.ts)}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <code className="tiny">{ev.event_type ?? '—'}</code>
                  {ev.project && <div className="tiny subtle">project: {ev.project}</div>}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  {ev.rule_id ? (
                    ev.rule_exists ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onOpenRule(ev.rule_id as string)}
                        style={{ padding: 0, textAlign: 'left' }}
                        title={ev.rule_title ?? undefined}
                      >
                        {ev.rule_title ?? ev.rule_id}
                      </button>
                    ) : (
                      <span className="tiny" style={{ color: 'var(--warning-text)' }}>
                        {ev.rule_id} (orphan)
                      </span>
                    )
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </td>
                <td style={{ padding: '8px 12px' }}>{ev.channel ?? '—'}</td>
                <td style={{ padding: '8px 12px', color: a.color, fontWeight: 500 }}>{a.text}</td>
                <td style={{ padding: '8px 12px', color: 'var(--text-2)', fontSize: 12 }}>
                  {ev.description ?? ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {events &&
        (total > events.length ? (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setLimit((n) => n + 200)}
              disabled={loading}
            >
              Load 200 more (showing {events.length} of {total})
            </button>
          </div>
        ) : (
          <p className="subtle" style={{ marginTop: 14, textAlign: 'center', fontSize: 11.5 }}>
            Showing all {events.length} deliveries.
          </p>
        ))}
    </div>
  );
};
