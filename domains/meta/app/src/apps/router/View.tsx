// Router — /os dispatch telemetry view. Migrated to apps/ + restyled with
// the prototype design system: .page wrapper, <Metric> tiles for stats,
// .card per section, .table for recent dispatches, .badge for confidence.

import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../../lib/api';
import { Metric } from '../../shared';
import '../../shared/styles.css';

interface RouterEntry {
  ts: string;
  intent: string;
  matched_skill: string | null;
  confidence: 'high' | 'low' | 'miss';
  fallback: string | null;
}

interface RouterData {
  entries: RouterEntry[];
}

export default function Router() {
  const [data, setData] = useState<RouterData | null>(null);

  useEffect(() => {
    getJson<RouterData>('/api/router-log')
      .then(setData)
      .catch(() => setData({ entries: [] }));
  }, []);

  const stats = useMemo(() => {
    if (!data) return null;
    const total = data.entries.length;
    const misses = data.entries.filter((e) => e.confidence === 'miss').length;
    const lows = data.entries.filter((e) => e.confidence === 'low').length;
    const missRate = total > 0 ? (misses / total) * 100 : 0;

    const bySkill: Record<string, number> = {};
    for (const e of data.entries) {
      const k = e.matched_skill ?? '(miss)';
      bySkill[k] = (bySkill[k] || 0) + 1;
    }

    return { total, misses, lows, missRate, bySkill };
  }, [data]);

  if (!data || !stats) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  const recent = data.entries.slice(-30).reverse();

  return (
    <div className="page">
      <header style={{ marginBottom: 14 }}>
        <h1 className="h1">Router telemetry</h1>
      </header>

      <p className="subtle" style={{ marginBottom: 18 }}>
        Every <span className="mono">/os &lt;intent&gt;</span> dispatch is logged to{' '}
        <span className="mono">vault/raw/router-log.jsonl</span>. Misses indicate intents that
        didn't match any vocabulary row — they grow the vocabulary over time.
      </p>

      {/* Stats strip */}
      <div className="grid-metrics" style={{ marginBottom: 18 }}>
        <Metric label="Total dispatches" value={String(stats.total)} />
        <Metric
          label="Misses"
          value={String(stats.misses)}
          severity={stats.misses > 0 ? 'warn' : 'ok'}
        />
        <Metric label="Low confidence" value={String(stats.lows)} />
        <Metric label="Miss rate" value={`${stats.missRate.toFixed(1)}%`} />
      </div>

      {/* By skill */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <h3 className="card-title">By skill</h3>
          <span className="tiny">{Object.keys(stats.bySkill).length} unique</span>
        </div>
        <div className="card-body">
          {Object.keys(stats.bySkill).length === 0 ? (
            <p className="tiny">
              No dispatches yet. Try <span className="mono">/os brief</span> from Claude Code.
            </p>
          ) : (
            <ul className="kv-list">
              {Object.entries(stats.bySkill)
                .sort(([, a], [, b]) => b - a)
                .map(([skill, count]) => (
                  <li key={skill}>
                    <span className="mono">{skill}</span>
                    <span className="mono">{count}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>

      {/* Recent dispatches */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Recent dispatches</h3>
          <span className="tiny">last {recent.length}</span>
        </div>
        {recent.length === 0 ? (
          <div className="card-body">
            <p className="tiny">No history.</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Time</th>
                <th>Intent</th>
                <th style={{ width: '24%' }}>Skill</th>
                <th style={{ width: 110 }}>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={`${e.ts}-${e.intent}`}>
                  <td className="mono tiny" style={{ color: 'var(--muted)' }}>
                    {e.ts.slice(11, 19)}
                  </td>
                  <td>{e.intent}</td>
                  <td>
                    {e.matched_skill ? (
                      <span className="mono">{e.matched_skill}</span>
                    ) : (
                      <em className="tiny">—</em>
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        e.confidence === 'high'
                          ? 'badge success'
                          : e.confidence === 'low'
                            ? 'badge warning'
                            : 'badge danger'
                      }
                    >
                      <span className="badge-dot" />
                      {e.confidence}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
