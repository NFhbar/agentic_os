// Usage analytics panel — mirrors Claude Code's /usage output.
//
// Reads from /api/usage which queries events.db kind='session' rows.
// Window toggle: 24h / 7d / 30d (matches /usage's d/w shortcuts plus a longer
// 30d view for trend context). Sync button runs import-session-usage.mjs --all
// server-side to pull the latest session-transcript data into events.db.
//
// Layout mirrors /usage: totals at top, then by-skill / by-model breakdowns
// side by side, then the per-day series below.

import { useCallback, useEffect, useState } from 'react';
import { getJson, postJson } from '../../lib/api';

type WindowSpec = '24h' | '7d' | '30d';

interface BySkillRow {
  skill: string;
  turns: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

interface ByModelRow {
  model: string;
  turns: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

interface ByDayRow {
  day: string;
  turns: number;
  cost_usd: number;
}

interface Totals {
  turns: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  duration_ms: number;
}

interface UsageResponse {
  window: WindowSpec;
  since: string;
  totals: Totals;
  by_skill: BySkillRow[];
  by_model: ByModelRow[];
  by_day: ByDayRow[];
  sample_count: number;
  truncated: boolean;
}

interface SyncResponse {
  ok: boolean;
  exit_code: number;
  parsed: {
    buckets: number;
    inserted: number;
    deduped: number;
    no_cost: number;
  } | null;
  stdout_tail: string;
  stderr: string;
  error?: string;
}

function fmtMoney(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function UsagePanel() {
  const [window, setWindow] = useState<WindowSpec>('24h');
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);

  const refresh = useCallback(() => {
    getJson<UsageResponse>(`/api/usage?window=${window}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [window]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function sync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = await postJson<SyncResponse>('/api/usage/sync', {});
      setSyncResult(r);
      refresh();
    } catch (e) {
      setSyncResult({
        ok: false,
        exit_code: -1,
        parsed: null,
        stdout_tail: '',
        stderr: '',
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSyncing(false);
    }
  }

  if (error) {
    return (
      <div
        className="card"
        style={{
          padding: '10px 14px',
          borderColor: 'var(--danger)',
          background: 'var(--danger-soft)',
          color: 'var(--danger-text)',
        }}
      >
        <strong>Failed to load usage:</strong> {error}
      </div>
    );
  }
  if (!data) {
    return <p className="subtle">Loading usage…</p>;
  }

  const { totals, by_skill, by_model, by_day, sample_count, truncated, since } = data;
  const maxDayCost = Math.max(...by_day.map((d) => d.cost_usd), 0.0001);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tabs" role="tablist" aria-label="Window">
          {(['24h', '7d', '30d'] as const).map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={window === w}
              className="tab"
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="tiny subtle" style={{ fontSize: 11 }}>
          {sample_count} turn{sample_count !== 1 ? 's' : ''} in window
          {truncated && ' (truncated — older turns excluded)'}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={sync}
          disabled={syncing}
          title="Pull the latest session-transcript data into events.db (runs import-session-usage.mjs --all)"
        >
          {syncing ? 'Syncing…' : 'Sync from transcripts'}
        </button>
      </div>

      {syncResult && (
        <div
          className="card"
          style={{
            padding: '8px 12px',
            fontSize: 12,
            background: syncResult.ok ? 'var(--bg-2)' : 'var(--danger-soft)',
            color: syncResult.ok ? 'var(--text-2)' : 'var(--danger-text)',
          }}
        >
          {syncResult.ok && syncResult.parsed ? (
            <>
              ✓ Synced — {syncResult.parsed.inserted} new turn
              {syncResult.parsed.inserted !== 1 ? 's' : ''} imported, {syncResult.parsed.deduped}{' '}
              already known, {syncResult.parsed.no_cost} without cost (unknown model)
            </>
          ) : syncResult.error ? (
            <>✗ {syncResult.error}</>
          ) : (
            <pre style={{ margin: 0, fontSize: 11 }}>{syncResult.stdout_tail}</pre>
          )}
        </div>
      )}

      {/* Totals block — mirrors /usage's session header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 16,
        }}
      >
        <TotalTile label="Total cost" value={fmtMoney(totals.cost_usd)} />
        <TotalTile label="Turns" value={String(totals.turns)} />
        <TotalTile label="Tokens in" value={fmtTokens(totals.tokens_in)} />
        <TotalTile label="Tokens out" value={fmtTokens(totals.tokens_out)} />
        <TotalTile
          label="Cache reads"
          value={fmtTokens(totals.tokens_cache_read)}
          sub="cheap, recycled context"
        />
        <TotalTile
          label="Cache writes"
          value={fmtTokens(totals.tokens_cache_write)}
          sub="initial 1h cache"
        />
        <TotalTile
          label="Wall duration"
          value={fmtDuration(totals.duration_ms)}
          sub="summed across turns"
        />
      </div>

      {totals.turns === 0 ? (
        <div className="card" style={{ padding: 24 }}>
          <h3 className="card-title" style={{ marginBottom: 8 }}>
            No session data in this window
          </h3>
          <div className="subtle" style={{ marginBottom: 12 }}>
            events.db has no <code className="mono">kind='session'</code> rows since{' '}
            {new Date(since).toLocaleString()}. Click <strong>Sync from transcripts</strong> above
            to import the latest data from{' '}
            <code className="mono">~/.claude/projects/&lt;slug&gt;/*.jsonl</code>.
          </div>
        </div>
      ) : (
        <>
          {/* By-skill + by-model side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <section className="card" style={{ padding: 0 }}>
              <div className="card-header">
                <h3 className="card-title">By skill</h3>
                <span className="tiny subtle">slash-command attribution</span>
              </div>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th style={{ width: 60 }}>Turns</th>
                    <th style={{ width: 80 }}>Cost</th>
                    <th style={{ width: 80 }}>In / Out</th>
                  </tr>
                </thead>
                <tbody>
                  {by_skill.map((s) => (
                    <tr key={s.skill}>
                      <td>
                        <code
                          className="mono"
                          style={{
                            fontSize: 12,
                            color: s.skill === '(interactive)' ? 'var(--text-3)' : 'inherit',
                          }}
                        >
                          {s.skill}
                        </code>
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        {s.turns}
                      </td>
                      <td className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
                        {fmtMoney(s.cost_usd)}
                      </td>
                      <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {fmtTokens(s.tokens_in)} / {fmtTokens(s.tokens_out)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card" style={{ padding: 0 }}>
              <div className="card-header">
                <h3 className="card-title">By model</h3>
                <span className="tiny subtle">where the spend lands</span>
              </div>
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th style={{ width: 60 }}>Turns</th>
                    <th style={{ width: 80 }}>Cost</th>
                    <th style={{ width: 80 }}>In / Out</th>
                  </tr>
                </thead>
                <tbody>
                  {by_model.map((m) => (
                    <tr key={m.model}>
                      <td>
                        <code className="mono" style={{ fontSize: 12 }}>
                          {m.model}
                        </code>
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        {m.turns}
                      </td>
                      <td className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
                        {fmtMoney(m.cost_usd)}
                      </td>
                      <td className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {fmtTokens(m.tokens_in)} / {fmtTokens(m.tokens_out)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {/* Per-day series — small bar chart */}
          {by_day.length > 1 && (
            <section className="card" style={{ padding: 16 }}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>
                Per-day cost
              </h3>
              <div className="tiny subtle" style={{ marginBottom: 12 }}>
                Spotting runaway days. Bars scale to the max in this window.
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 6,
                  height: 80,
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: 4,
                }}
              >
                {by_day.map((d) => {
                  const h = Math.max(2, (d.cost_usd / maxDayCost) * 76);
                  return (
                    <div
                      key={d.day}
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 4,
                      }}
                      title={`${d.day}: ${fmtMoney(d.cost_usd)} · ${d.turns} turn${d.turns !== 1 ? 's' : ''}`}
                    >
                      <div
                        style={{
                          height: h,
                          width: '100%',
                          background: 'var(--accent-text, #5aa0fa)',
                          borderRadius: '2px 2px 0 0',
                          opacity: 0.85,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {by_day.map((d) => (
                  <div
                    key={d.day}
                    className="tiny subtle"
                    style={{
                      flex: 1,
                      textAlign: 'center',
                      fontSize: 10,
                      color: 'var(--text-3)',
                    }}
                  >
                    {d.day.slice(5)}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <div className="tiny subtle" style={{ padding: '0 4px', fontSize: 11 }}>
        Window starts at {new Date(since).toLocaleString()}. Local-machine totals only — does not
        reflect usage from other devices or claude.ai. For authoritative billing, see{' '}
        <code className="mono">platform.claude.com/usage</code>.
      </div>
    </div>
  );
}

function TotalTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div
        className="tiny subtle"
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
      {sub && (
        <div className="tiny subtle" style={{ fontSize: 10, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
