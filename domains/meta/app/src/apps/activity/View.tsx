// Activity — unified event feed (vault/raw/*.jsonl streams). Migrated to
// apps/<id>/ + restyled with the prototype design system.
// Source of truth for the design language: standard-app-design.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getJson } from '../../lib/api';
import { formatLocal, formatRelative } from '../../lib/time';
import { Icons } from '../../shared';
import '../../shared/styles.css';

type EventKind = 'router' | 'dashboard' | 'schedule' | 'unknown';

interface NormalizedEvent {
  ts: string;
  source: string;
  kind: EventKind;
  summary: string;
  // biome-ignore lint/suspicious/noExplicitAny: raw event payload varies
  raw: any;
}

interface EventsResponse {
  events: NormalizedEvent[];
  total: number;
  all_total: number;
  counts: Partial<Record<EventKind, number>>;
  sources: string[];
}

const KIND_LABELS: Record<EventKind, string> = {
  router: 'Router',
  dashboard: 'Dashboard',
  schedule: 'Schedule',
  unknown: 'Other',
};

const ALL_KINDS: EventKind[] = ['router', 'dashboard', 'schedule', 'unknown'];

export default function Activity() {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledKinds, setEnabledKinds] = useState<Set<EventKind>>(new Set(ALL_KINDS));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(200);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getJson<EventsResponse>(`/api/events?limit=${limit}`);
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function toggleKind(k: EventKind) {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.events.filter((e) => enabledKinds.has(e.kind));
  }, [data, enabledKinds]);

  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Activity</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={refresh} disabled={loading}>
          {loading ? (
            <>
              <Icons.Sparkles size={13} /> Loading…
            </>
          ) : (
            <>
              <Icons.Refresh size={13} /> Refresh
            </>
          )}
        </button>
      </header>

      <p className="subtle" style={{ marginBottom: 16 }}>
        Unified event feed — merges every <span className="mono">vault/raw/*.jsonl</span> stream in
        reverse chronological order. Click any row to view the raw event.
      </p>

      {error && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            marginBottom: 14,
            borderColor: 'var(--danger)',
            background: 'var(--danger-soft)',
            color: 'var(--danger-text)',
          }}
        >
          <strong>Failed to load events:</strong> {error}
        </div>
      )}

      {data && (
        <>
          <div className="filter-row" style={{ marginBottom: 14 }}>
            {ALL_KINDS.map((k) => {
              const count = data.counts[k] ?? 0;
              if (count === 0 && k === 'unknown') return null;
              const enabled = enabledKinds.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={`filter-chip ${enabled ? 'on' : 'off'} kind-${k}`}
                  onClick={() => toggleKind(k)}
                  title={`Toggle ${KIND_LABELS[k]} events`}
                >
                  <span className="dot" />
                  {KIND_LABELS[k]}
                  <span className="filter-count">{count}</span>
                </button>
              );
            })}
            <span className="tiny" style={{ marginLeft: 'auto' }}>
              showing {filtered.length} of {data.all_total} · sources: {data.sources.length}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center' }}>
              {data.all_total === 0 ? (
                <p className="subtle">
                  No events recorded yet. Use <span className="mono">/os &lt;intent&gt;</span>,
                  click dashboard actions, or wait for a scheduled job to fire.
                </p>
              ) : (
                <p className="subtle">
                  No events match the current filter. Enable more event kinds above.
                </p>
              )}
            </div>
          ) : (
            <div className="card">
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {filtered.map((e, i) => {
                  const key = `${e.ts}-${i}`;
                  const isOpen = expanded.has(key);
                  return (
                    <li
                      key={key}
                      style={{ borderBottom: '1px solid var(--border)' }}
                      className={`kind-${e.kind}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleExpanded(key)}
                        style={{
                          width: '100%',
                          display: 'grid',
                          gridTemplateColumns: '90px 100px 1fr 20px',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 16px',
                          background: 'transparent',
                          border: 0,
                          textAlign: 'left',
                          color: 'inherit',
                          font: 'inherit',
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          className="tiny mono"
                          title={formatLocal(e.ts)}
                          style={{ color: 'var(--muted)' }}
                        >
                          {formatRelative(e.ts)}
                        </span>
                        <span>
                          <span className={`badge kind-${e.kind}`} style={{ fontSize: 11 }}>
                            {KIND_LABELS[e.kind]}
                          </span>
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--text)' }}>{e.summary}</span>
                        <span style={{ color: 'var(--subtle)' }}>{isOpen ? '▾' : '▸'}</span>
                      </button>
                      {isOpen && (
                        <pre
                          className="mono"
                          style={{
                            margin: 0,
                            padding: '10px 16px 14px 16px',
                            background: 'var(--bg-2)',
                            fontSize: 11.5,
                            lineHeight: 1.6,
                            overflowX: 'auto',
                            color: 'var(--text-2)',
                            borderTop: '1px solid var(--border)',
                          }}
                        >
                          {JSON.stringify(e.raw, null, 2)}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {data.total > filtered.length && enabledKinds.size === ALL_KINDS.length && (
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setLimit((n) => n + 200)}
                disabled={loading}
              >
                Load 200 more (showing {data.events.length} of {data.all_total})
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
