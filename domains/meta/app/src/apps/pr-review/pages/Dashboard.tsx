// Dashboard — hero submit + metrics + breakdown cards + top repos + recent reviews.

import { useEffect, useRef, useState } from 'react';
import { Icons, LangDot, ResultBadge, SeverityBar, Sparkline, StatusBadge } from '../../../shared';
import type { Repo, ReviewRow } from '../data';

// Color tokens used by the breakdown cards. Severity uses danger/warning/muted
// to match how the rest of the app surfaces those concepts; category uses a
// small palette of distinguishable hues — pure visual, no policy meaning.
const SEVERITY_COLORS: Record<string, string> = {
  bug: 'var(--danger, #d44)',
  blocker: 'var(--danger, #d44)',
  suggestion: 'var(--warning, #d90)',
  nit: 'var(--muted, #889)',
};
const CATEGORY_COLORS: Record<string, string> = {
  logic: '#5b8def',
  security: '#d44',
  performance: '#d90',
  style: '#9b6dff',
  tests: '#3aa970',
  docs: '#5b9a9a',
  other: '#889',
};
const SEVERITY_ORDER = ['bug', 'blocker', 'suggestion', 'nit'] as const;
const CATEGORY_ORDER = [
  'logic',
  'security',
  'performance',
  'style',
  'tests',
  'docs',
  'other',
] as const;

// Aggregated metrics returned by /api/pr-review/dashboard-metrics. Shape
// mirrors the route's MetricsPayload exactly.
interface DashboardMetrics {
  window: { days: number; from: string; to: string };
  reviews_count: number;
  reviews_count_delta: number;
  issues_found: number;
  issues_found_delta: number;
  avg_duration_seconds: number | null;
  avg_duration_seconds_delta: number | null;
  acceptance_rate: number | null;
  acceptance_rate_delta: number | null;
  cost_usd_total: number;
  cost_usd_total_delta: number;
  reviews_by_day: number[];
  issues_by_day: number[];
  severity_breakdown: Record<string, number>;
  category_breakdown: Record<string, number>;
  top_repos: Array<{ owner: string; repo: string; review_count: number }>;
}

function formatDurationSeconds(s: number | null): string {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

function formatPercent(rate: number | null): string {
  if (rate === null || rate === undefined) return '—';
  return `${Math.round(rate * 100)}%`;
}

function formatDeltaInt(d: number): string {
  if (d === 0) return '0';
  return d > 0 ? `+${d}` : `${d}`;
}

function formatDeltaSec(d: number | null): string {
  if (d === null) return '—';
  if (d === 0) return '0s';
  return d > 0 ? `+${d}s` : `${d}s`;
}

function formatDeltaPp(d: number | null): string {
  if (d === null) return '—';
  const pp = (d * 100).toFixed(1);
  return d >= 0 ? `+${pp}pp` : `${pp}pp`;
}

export function Dashboard({
  reviews,
  repos,
  onSubmitPR,
  onOpenReview,
  onNavigate,
  dispatching = false,
}: {
  reviews: ReviewRow[];
  repos: Repo[];
  onSubmitPR: (url: string) => void;
  onOpenReview: (id: string) => void;
  onNavigate: (tab: 'reviews' | 'repos') => void;
  // True when an ActionRunner is currently dispatching/streaming. Disables the
  // submit form so impatient re-clicks during a long-running review don't
  // spawn parallel duplicates (the StrictMode dedupe only catches sub-second
  // re-fires, not human re-clicks 30s+ later).
  dispatching?: boolean;
}) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch dashboard metrics on mount. Refetches when reviews count changes so
  // newly completed reviews update the tiles without a page reload. We
  // intentionally key on `reviews.length` rather than the full array so a
  // reference change without a count change doesn't cause spurious refetches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reviews.length is the meaningful change
  useEffect(() => {
    let cancelled = false;
    fetch('/api/pr-review/dashboard-metrics?window=7')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((j: DashboardMetrics) => {
        if (!cancelled) setMetrics(j);
      })
      .catch(() => {
        /* leave previous metrics on error — banner not needed for non-fatal failure */
      });
    return () => {
      cancelled = true;
    };
  }, [reviews.length]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!url.trim()) {
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setTimeout(() => {
      onSubmitPR(url.trim());
      setSubmitting(false);
      setUrl('');
    }, 350);
  }

  const recent = reviews.slice(0, 5);
  const topRepos = [...repos].sort((a, b) => b.reviews - a.reviews).slice(0, 4);

  return (
    <div className="page">
      <div className="hero">
        <div className="hero-inner">
          <h1>Review a pull request</h1>
          <p>
            Paste a PR URL and the agent fleet will analyse it against your indexed repos. Reviews
            land in <em>Reviews</em> when ready, usually under five minutes.
          </p>
          <form className="hero-form" onSubmit={submit}>
            <Icons.GitPullRequest size={16} style={{ marginLeft: 8, color: 'var(--muted)' }} />
            <input
              ref={inputRef}
              className="input"
              placeholder="https://github.com/acme/backend-api/pull/1284"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={submitting || dispatching}>
              {dispatching ? (
                <>
                  <Icons.Sparkles size={14} /> Run in progress…
                </>
              ) : submitting ? (
                <>
                  <Icons.Sparkles size={14} /> Queuing…
                </>
              ) : (
                <>
                  <Icons.Play size={13} /> Start review
                </>
              )}
            </button>
          </form>
          <div className="hero-suggest">
            <span className="lbl">Try</span>
            <button type="button" onClick={() => setUrl('github.com/acme/backend-api/pull/1284')}>
              acme/backend-api#1284
            </button>
            <button type="button" onClick={() => setUrl('github.com/acme/web-client/pull/882')}>
              acme/web-client#882
            </button>
            <button type="button" onClick={() => setUrl('github.com/acme/data-pipeline/pull/318')}>
              acme/data-pipeline#318
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 22 }} className="grid-metrics">
        <MetricTile
          label="Reviews · 7d"
          value={metrics ? String(metrics.reviews_count) : '…'}
          delta={metrics ? formatDeltaInt(metrics.reviews_count_delta) : undefined}
          up={metrics ? metrics.reviews_count_delta > 0 : undefined}
          down={metrics ? metrics.reviews_count_delta < 0 : undefined}
          spark={metrics?.reviews_by_day}
        />
        <MetricTile
          label="Issues found"
          value={metrics ? String(metrics.issues_found) : '…'}
          delta={metrics ? formatDeltaInt(metrics.issues_found_delta) : undefined}
          up={metrics ? metrics.issues_found_delta > 0 : undefined}
          down={metrics ? metrics.issues_found_delta < 0 : undefined}
          spark={metrics?.issues_by_day}
          color="var(--warning)"
        />
        <MetricTile
          label="Avg duration"
          value={formatDurationSeconds(metrics?.avg_duration_seconds ?? null)}
          delta={
            metrics?.avg_duration_seconds_delta !== undefined
              ? formatDeltaSec(metrics.avg_duration_seconds_delta)
              : undefined
          }
          up={
            metrics?.avg_duration_seconds_delta !== null &&
            metrics?.avg_duration_seconds_delta !== undefined
              ? metrics.avg_duration_seconds_delta > 0
              : undefined
          }
          down={
            metrics?.avg_duration_seconds_delta !== null &&
            metrics?.avg_duration_seconds_delta !== undefined
              ? metrics.avg_duration_seconds_delta < 0
              : undefined
          }
          color="var(--success)"
          invertDelta
        />
        <MetricTile
          label="Acceptance rate"
          value={formatPercent(metrics?.acceptance_rate ?? null)}
          delta={
            metrics?.acceptance_rate_delta !== undefined
              ? formatDeltaPp(metrics.acceptance_rate_delta)
              : undefined
          }
          up={
            metrics?.acceptance_rate_delta !== null && metrics?.acceptance_rate_delta !== undefined
              ? metrics.acceptance_rate_delta > 0
              : undefined
          }
          down={
            metrics?.acceptance_rate_delta !== null && metrics?.acceptance_rate_delta !== undefined
              ? metrics.acceptance_rate_delta < 0
              : undefined
          }
          color="var(--accent)"
        />
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <BreakdownCard
          title="Severity breakdown"
          subtitle={`Comments by severity · last ${metrics?.window.days ?? 7}d`}
          data={metrics?.severity_breakdown}
          order={[...SEVERITY_ORDER]}
          colors={SEVERITY_COLORS}
        />
        <BreakdownCard
          title="Category breakdown"
          subtitle={`Comments by focus area · last ${metrics?.window.days ?? 7}d`}
          data={metrics?.category_breakdown}
          order={[...CATEGORY_ORDER]}
          colors={CATEGORY_COLORS}
        />
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-header">
          <h3 className="card-title">Top repos</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onNavigate('repos')}
          >
            View all <Icons.ArrowRight size={13} />
          </button>
        </div>
        <div style={{ padding: 6 }}>
          {topRepos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onNavigate('repos')}
              style={{
                width: '100%',
                background: 'transparent',
                border: 0,
                padding: '10px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                borderRadius: 8,
                textAlign: 'left',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <div className="repo-icon">
                <LangDot lang={r.lang} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>
                  {r.name}
                </div>
                <div className="tiny" style={{ marginTop: 1 }}>
                  {r.reviews} reviews · {r.files.toLocaleString()} files · {r.size}
                </div>
              </div>
              <StatusBadge status={r.status} />
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-header">
          <div>
            <h3 className="card-title">Recent reviews</h3>
            <div className="tiny" style={{ marginTop: 2 }}>
              Tap a row to open the full report
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onNavigate('reviews')}
          >
            View all <Icons.ArrowRight size={13} />
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>PR</th>
              <th>Title</th>
              <th style={{ width: 140 }}>Repo</th>
              <th style={{ width: 130 }}>Result</th>
              <th style={{ width: 130 }}>Severity</th>
              <th style={{ width: 100 }}>Duration</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {recent.map((rv) => (
              <tr
                key={rv.id}
                className="clickable"
                onClick={() => onOpenReview(rv.id)}
                style={{ cursor: 'pointer' }}
              >
                <td className="mono" style={{ color: 'var(--text-2)' }}>
                  {rv.pr}
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {rv.status === 'running' && <span className="dot running" />}
                    <span style={{ fontWeight: 500 }}>{rv.title}</span>
                  </div>
                  <div className="tiny mono" style={{ marginTop: 2 }}>
                    {rv.branch}
                  </div>
                </td>
                <td className="mono" style={{ color: 'var(--text-2)' }}>
                  {rv.repo}
                </td>
                <td>
                  {rv.status === 'running' ? (
                    <StatusBadge status="running" />
                  ) : rv.status === 'failed' ? (
                    <StatusBadge status="failed" />
                  ) : (
                    <ResultBadge result={rv.result} />
                  )}
                </td>
                <td>
                  <SeverityCounts s={rv.severity} />
                </td>
                <td className="mono" style={{ color: 'var(--muted)' }}>
                  {rv.duration}
                </td>
                <td>
                  <Icons.ChevronRight size={14} style={{ color: 'var(--subtle)' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Per-row horizontal bar inside a BreakdownCard. The bar is sized as a
// fraction of `max` (the largest count in the set) so the longest row fills
// the column — readable even when totals are small.
function BreakdownRow({
  label,
  count,
  max,
  color,
}: {
  label: string;
  count: number;
  max: number;
  color: string;
}) {
  const pct = max === 0 ? 0 : (count / max) * 100;
  const dimmed = count === 0;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '100px 1fr 40px',
        gap: 10,
        alignItems: 'center',
        padding: '6px 0',
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      <span className="tiny mono" style={{ color: 'var(--text-2)' }}>
        {label}
      </span>
      <div
        style={{
          height: 8,
          background: 'var(--panel-3)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: color,
            borderRadius: 4,
            transition: 'width 0.25s ease',
          }}
        />
      </div>
      <span
        className="tiny mono"
        style={{ color: 'var(--text-2)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
      >
        {count}
      </span>
    </div>
  );
}

function BreakdownCard({
  title,
  subtitle,
  data,
  order,
  colors,
}: {
  title: string;
  subtitle: string;
  data: Record<string, number> | undefined;
  order: string[];
  colors: Record<string, string>;
}) {
  const total = data ? order.reduce((sum, k) => sum + (data[k] ?? 0), 0) : 0;
  const max = data ? Math.max(...order.map((k) => data[k] ?? 0), 0) : 0;
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">{title}</h3>
          <div className="tiny" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        </div>
        <div className="tiny mono" style={{ color: 'var(--muted)' }}>
          {data ? `${total} total` : '…'}
        </div>
      </div>
      <div style={{ padding: '8px 16px 14px' }}>
        {!data && (
          <div className="tiny" style={{ color: 'var(--muted)', padding: '14px 0' }}>
            Loading…
          </div>
        )}
        {data && total === 0 && (
          <div className="tiny" style={{ color: 'var(--muted)', padding: '14px 0' }}>
            No reviews in this window yet — bars populate once dev-pr-review fires.
          </div>
        )}
        {data &&
          total > 0 &&
          order.map((key) => (
            <BreakdownRow
              key={key}
              label={key}
              count={data[key] ?? 0}
              max={max}
              color={colors[key] ?? 'var(--muted)'}
            />
          ))}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  delta,
  up,
  down,
  spark,
  color = 'var(--accent)',
  invertDelta = false,
}: {
  label: string;
  value: string;
  delta?: string;
  up?: boolean;
  down?: boolean;
  spark?: number[];
  color?: string;
  invertDelta?: boolean;
}) {
  const cls = (up && !invertDelta) || (down && invertDelta) ? 'up' : 'down';
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta && (
        <div className={`metric-delta ${cls}`}>
          {up ? '▲' : '▼'} {delta}
          <span style={{ color: 'var(--muted)' }}> vs prev</span>
        </div>
      )}
      {spark && <Sparkline data={spark} color={color} />}
    </div>
  );
}

export function SeverityCounts({ s }: { s: { bug: number; nit: number; suggestion: number } }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <SeverityBar bug={s.bug} nit={s.nit} suggestion={s.suggestion} />
      <span className="tiny mono" style={{ minWidth: 0 }}>
        {s.bug > 0 && <span style={{ color: 'var(--danger-text)' }}>{s.bug}b </span>}
        {s.nit > 0 && <span style={{ color: 'var(--warning-text)' }}>{s.nit}n </span>}
        {s.suggestion > 0 && <span style={{ color: 'var(--accent-text)' }}>{s.suggestion}s</span>}
        {s.bug + s.nit + s.suggestion === 0 && <span style={{ color: 'var(--muted)' }}>none</span>}
      </span>
    </div>
  );
}
