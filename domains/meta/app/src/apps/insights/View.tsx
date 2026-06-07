// Insights — first app on the new design system. Uses shared/ primitives:
// .page wrapper, .card surfaces, .metric tiles, .tabs for the window selector,
// shared <Metric> component. See standard-app-design.md.
//
// audit-ignore: app-design-stepper — analytics view (events table + window
// selector), not a multi-stage lifecycle.
//
// The custom column-resizable events table is preserved; only its surrounding
// chrome was redesigned. Future iteration could lift the table into shared/
// if other apps need column resize.

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../lib/api';
import { useNavigation } from '../../lib/navigation';
import { formatLocal, formatRelative } from '../../lib/time';
import { useResizable } from '../../lib/useResizable';
import { Icons, Metric } from '../../shared';
import '../../shared/styles.css';

interface StatsResponse {
  window_days: number;
  since: string;
  total: number;
  errors: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  by_kind: Array<{ kind: string; n: number }>;
  top_skills: Array<{ skill: string; n: number }>;
  by_model: Array<{ model: string; n: number }>;
  slowest: Array<{
    id: number;
    ts: string;
    kind: string;
    action: string;
    skill: string | null;
    duration_ms: number;
  }>;
}

interface EventRow {
  id: number;
  ts: string;
  kind: string;
  action: string;
  source: string | null;
  skill: string | null;
  project: string | null;
  change_id: string | null;
  domain: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  exit_status: number | null;
  status: string | null;
  description: string | null;
  files_touched: string | null;
  prompt: string | null;
  stdout_preview: string | null;
  stderr: string | null;
}

interface EventsResponse {
  events: EventRow[];
}

const EVENTS_LIMIT = 50;

const WINDOWS = [
  { days: 1, label: '1d' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

function fmtCost(n: number) {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDuration(ms: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// Trim the bracketed context-window suffix many model IDs carry
// (e.g. "claude-opus-4-7[1m]" → "claude-opus-4-7") so the table column
// stays narrow. Falls through unchanged when no suffix is present.
function shortModel(m: string | null): string {
  if (!m) return '—';
  return m.replace(/\[[^\]]+\]$/, '');
}

function parseFilesTouched(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [raw];
  }
}

// Per-column resize state for the Recent events table. Each column persists
// its own width to localStorage via useResizable so layout survives reloads.
const EVENT_COLS = [
  {
    key: 'time',
    label: 'time',
    storageKey: 'insights-evt-time',
    defaultWidth: 90,
    min: 60,
    max: 200,
  },
  {
    key: 'kind',
    label: 'kind',
    storageKey: 'insights-evt-kind',
    defaultWidth: 90,
    min: 60,
    max: 160,
  },
  {
    key: 'skill',
    label: 'skill',
    storageKey: 'insights-evt-skill',
    defaultWidth: 200,
    min: 80,
    max: 500,
  },
  {
    key: 'action',
    label: 'action',
    storageKey: 'insights-evt-action',
    defaultWidth: 140,
    min: 60,
    max: 320,
  },
  {
    key: 'model',
    label: 'model',
    storageKey: 'insights-evt-model',
    defaultWidth: 130,
    min: 60,
    max: 280,
  },
  {
    key: 'duration',
    label: 'dur',
    storageKey: 'insights-evt-duration',
    defaultWidth: 70,
    min: 50,
    max: 140,
  },
  {
    key: 'cost',
    label: 'cost',
    storageKey: 'insights-evt-cost',
    defaultWidth: 80,
    min: 50,
    max: 160,
  },
  {
    key: 'status',
    label: 'status',
    storageKey: 'insights-evt-status',
    defaultWidth: 90,
    min: 60,
    max: 200,
  },
] as const;
const EXPAND_COL_WIDTH = 28;

// View modes — Insights has two top-level surfaces: the original telemetry
// view (events from events.db, the OS's own runtime metrics) and the new
// audits view (lifecycle audits produced by meta-overseer-review — quality
// signal across the work the OS has done). They share the page chrome but
// query different backends.
type ViewMode = 'telemetry' | 'audits';

export default function Insights() {
  const [viewMode, setViewMode] = useState<ViewMode>('telemetry');
  const [windowDays, setWindowDays] = useState(30);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { navigateToSkill } = useNavigation();

  // One useResizable per column. Hook order is fixed (matches EVENT_COLS).
  const colTime = useResizable(EVENT_COLS[0]);
  const colKind = useResizable(EVENT_COLS[1]);
  const colSkill = useResizable(EVENT_COLS[2]);
  const colAction = useResizable(EVENT_COLS[3]);
  const colModel = useResizable(EVENT_COLS[4]);
  const colDur = useResizable(EVENT_COLS[5]);
  const colCost = useResizable(EVENT_COLS[6]);
  const colStatus = useResizable(EVENT_COLS[7]);
  const columns = [colTime, colKind, colSkill, colAction, colModel, colDur, colCost, colStatus];
  const gridTemplate = columns.map((c) => `${c.width}px`).join(' ') + ` ${EXPAND_COL_WIDTH}px`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sinceIso = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();
    try {
      const [statsRes, eventsRes] = await Promise.all([
        getJson<StatsResponse>(`/api/events-db/stats?window=${windowDays}`),
        getJson<EventsResponse>(
          `/api/events-db/?since=${encodeURIComponent(sinceIso)}&limit=${EVENTS_LIMIT}`,
        ),
      ]);
      setStats(statsRes);
      setEvents(eventsRes.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="page">
      {/* Header: title + window tabs + refresh */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Insights</h1>
        {/* View-mode tabs: Telemetry (events.db runtime metrics) vs Audits
            (lifecycle-audit entries from meta-overseer-review). Two distinct
            data substrates that share the page chrome. */}
        <div className="tabs" role="tablist" aria-label="Insights view">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'telemetry'}
            className="tab"
            onClick={() => setViewMode('telemetry')}
          >
            Telemetry
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'audits'}
            className="tab"
            onClick={() => setViewMode('audits')}
          >
            Audits
          </button>
        </div>
        <span className="spacer" />
        {viewMode === 'telemetry' && (
          <div className="tabs" role="tablist" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                role="tab"
                aria-selected={windowDays === w.days}
                className="tab"
                onClick={() => setWindowDays(w.days)}
              >
                {w.label}
              </button>
            ))}
          </div>
        )}
        {viewMode === 'telemetry' && (
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
        )}
      </header>

      {viewMode === 'audits' && <AuditsView />}
      {viewMode === 'telemetry' && (
        <>
          <TelemetryBody
            stats={stats}
            events={events}
            expanded={expanded}
            toggleExpand={toggleExpand}
            loading={loading}
            error={error}
            columns={columns}
            gridTemplate={gridTemplate}
            navigateToSkill={navigateToSkill}
          />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TelemetryBody — preserved current behavior. Lifted into a sub-component
// to keep the top-level Insights() cleaner with the new view-mode split.

interface TelemetryBodyProps {
  stats: StatsResponse | null;
  events: EventRow[] | null;
  expanded: Set<number>;
  toggleExpand: (id: number) => void;
  loading: boolean;
  error: string | null;
  columns: ReturnType<typeof useResizable>[];
  gridTemplate: string;
  navigateToSkill: (skill: string) => void;
}

function TelemetryBody({
  stats,
  events,
  expanded,
  toggleExpand,
  loading,
  error,
  columns,
  gridTemplate,
  navigateToSkill,
}: TelemetryBodyProps) {
  return (
    <>

      <p className="subtle" style={{ marginBottom: 6 }}>
        Telemetry from <span className="mono">.claude/state/events.db</span>. Counts every router
        dispatch, dashboard action, edit, and scheduler fire. See{' '}
        <span className="mono">standard-event-store</span> for the vault-vs-telemetry separation.
      </p>
      <p className="tiny" style={{ marginBottom: 18 }}>
        Rows tagged <span className="mono">audit-only</span> had no{' '}
        <span className="mono">claude -p</span> subprocess to meter (router dispatches, skill-body
        audit logs) — these record that the action happened but carry no model / duration / cost.
        Full metrics are captured for scheduler fires and dashboard <strong>Run</strong> buttons.
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
          <strong>Failed to load:</strong> {error}
        </div>
      )}

      {stats && (
        <>
          {/* Metric strip */}
          <div className="grid-metrics" style={{ marginBottom: 18 }}>
            <Metric
              label="Events"
              value={String(stats.total)}
              hint={`window: ${stats.window_days}d`}
            />
            <Metric
              label="Errors"
              value={String(stats.errors)}
              hint={stats.errors > 0 ? 'check Activity' : 'clean'}
              severity={stats.errors > 0 ? 'warn' : 'ok'}
            />
            <Metric label="Total cost" value={fmtCost(stats.cost_usd)} hint="captured ai-prompts" />
            <Metric
              label="Tokens"
              value={`${fmtTokens(stats.tokens_in)} → ${fmtTokens(stats.tokens_out)}`}
              hint="in → out"
            />
          </div>

          {/* 2x2 panel grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 14,
              marginBottom: 18,
            }}
          >
            <PanelCard title="By kind">
              {stats.by_kind.length === 0 ? (
                <p className="tiny">No events yet.</p>
              ) : (
                <ul className="bar-list">
                  {(() => {
                    const max = Math.max(...stats.by_kind.map((b) => b.n));
                    return stats.by_kind.map((b) => (
                      <li key={b.kind}>
                        <span className="bar-label">{b.kind}</span>
                        <span className="bar-track">
                          <span
                            className={`bar-fill kind-${b.kind}`}
                            style={{ width: `${(b.n / max) * 100}%` }}
                          />
                        </span>
                        <span className="bar-value">{b.n}</span>
                      </li>
                    ));
                  })()}
                </ul>
              )}
            </PanelCard>

            <PanelCard title="Top skills" subtitle={`up to ${stats.top_skills.length}`}>
              {stats.top_skills.length === 0 ? (
                <p className="tiny">
                  No skill-attributed events in this window. Skills get attributed automatically
                  when invoked via the dashboard or scheduler.
                </p>
              ) : (
                <ul className="bar-list">
                  {(() => {
                    const max = Math.max(...stats.top_skills.map((b) => b.n));
                    return stats.top_skills.map((b) => (
                      <li key={b.skill}>
                        <button
                          type="button"
                          className="bar-label bar-link"
                          onClick={() => navigateToSkill(b.skill)}
                          title={`Open ${b.skill}`}
                        >
                          {b.skill}
                        </button>
                        <span className="bar-track">
                          <span className="bar-fill" style={{ width: `${(b.n / max) * 100}%` }} />
                        </span>
                        <span className="bar-value">{b.n}</span>
                      </li>
                    ));
                  })()}
                </ul>
              )}
            </PanelCard>

            <PanelCard title="By model">
              {stats.by_model.length === 0 ? (
                <p className="tiny">No model-attributed events yet.</p>
              ) : (
                <ul className="kv-list">
                  {stats.by_model.map((b) => (
                    <li key={b.model}>
                      <span className="mono">{b.model}</span>
                      <span className="mono">{b.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelCard>

            <PanelCard title="Slowest 5">
              {stats.slowest.length === 0 ? (
                <p className="tiny">No timed events yet.</p>
              ) : (
                <ul className="slowest-list">
                  {stats.slowest.map((s) => (
                    <li key={s.id}>
                      <span className="slowest-duration">{fmtDuration(s.duration_ms)}</span>
                      <span className="slowest-meta">
                        <span className={`badge kind-${s.kind}`}>{s.kind}</span>
                        {s.skill && (
                          <button
                            type="button"
                            className="bar-link"
                            onClick={() => navigateToSkill(s.skill as string)}
                          >
                            {s.skill}
                          </button>
                        )}
                        <span className="tiny">{s.action}</span>
                      </span>
                      <span className="tiny" title={formatLocal(s.ts)}>
                        {formatLocal(s.ts).replace(/:\d\d\s/, ' ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelCard>
          </div>

          {/* Recent events — preserved custom resizable table inside a card */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">Recent events</h3>
                <div className="tiny" style={{ marginTop: 2 }}>
                  showing {events?.length ?? 0} most recent (limit {EVENTS_LIMIT})
                </div>
              </div>
            </div>
            {events == null || events.length === 0 ? (
              <div style={{ padding: 18 }}>
                <p className="tiny">No events in this window.</p>
              </div>
            ) : (
              <ul className="events-table">
                <li
                  className="events-table-header"
                  aria-hidden
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {EVENT_COLS.map((col, i) => (
                    <span key={col.key} className={`col-${col.key} col-header-cell`}>
                      {col.label}
                      <ColumnResizeHandle onMouseDown={columns[i].startDrag} />
                    </span>
                  ))}
                  <span aria-hidden />
                </li>
                {events.map((e) => {
                  const isOpen = expanded.has(e.id);
                  const status = e.status ?? (e.exit_status === 0 ? 'success' : null);
                  const files = parseFilesTouched(e.files_touched);
                  const isAuditOnly =
                    e.model == null && e.duration_ms == null && e.cost_usd == null;
                  return (
                    <li key={e.id} className={`events-table-row kind-${e.kind}`}>
                      <div
                        className="events-table-grid"
                        style={{ gridTemplateColumns: gridTemplate }}
                      >
                        <span className="col-time" title={formatLocal(e.ts)}>
                          {formatRelative(e.ts)}
                        </span>
                        <span className="col-kind">
                          <span className={`badge kind-${e.kind}`}>{e.kind}</span>
                        </span>
                        <span className="col-skill">
                          {e.skill ? (
                            <button
                              type="button"
                              className="bar-link"
                              onClick={() => navigateToSkill(e.skill as string)}
                              title={`Open ${e.skill}`}
                            >
                              {e.skill}
                            </button>
                          ) : (
                            <span className="tiny">—</span>
                          )}
                        </span>
                        <span className="col-action tiny">{e.action}</span>
                        <span className="col-model tiny" title={e.model ?? ''}>
                          {e.model ? (
                            shortModel(e.model)
                          ) : isAuditOnly ? (
                            <span
                              className="audit-pill"
                              title="Audit-only event — no claude -p subprocess to meter"
                            >
                              audit-only
                            </span>
                          ) : (
                            '—'
                          )}
                        </span>
                        <span className="col-duration">{fmtDuration(e.duration_ms)}</span>
                        <span className="col-cost">
                          {e.cost_usd == null ? (
                            <span className="tiny">—</span>
                          ) : (
                            fmtCost(e.cost_usd)
                          )}
                        </span>
                        <span className="col-status">
                          {status ? (
                            <span className={`status-pill status-${status}`}>{status}</span>
                          ) : (
                            <span className="tiny">—</span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="col-expand"
                          onClick={() => toggleExpand(e.id)}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? 'Collapse row' : 'Expand row'}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      </div>
                      {isOpen && (
                        <div className="events-table-expand">
                          {e.description && (
                            <div className="ee-row">
                              <span className="ee-label">description</span>
                              <span>{e.description}</span>
                            </div>
                          )}
                          {(e.tokens_in != null || e.tokens_out != null) && (
                            <div className="ee-row">
                              <span className="ee-label">tokens</span>
                              <span>
                                in={e.tokens_in ?? 0} · out={e.tokens_out ?? 0}
                              </span>
                            </div>
                          )}
                          {files.length > 0 && (
                            <div className="ee-row">
                              <span className="ee-label">files</span>
                              <ul className="ee-files">
                                {files.map((f) => (
                                  <li key={f}>
                                    <code>{f}</code>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {e.prompt && (
                            <div className="ee-row">
                              <span className="ee-label">prompt</span>
                              <pre className="ee-pre">{e.prompt}</pre>
                            </div>
                          )}
                          {e.stderr && (
                            <div className="ee-row">
                              <span className="ee-label">stderr</span>
                              <pre className="ee-pre ee-stderr">{e.stderr}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  );
}

// Card wrapper for the 2x2 panel grid. Uses prototype's .card primitives.
function PanelCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">{title}</h3>
        {subtitle && <span className="tiny">{subtitle}</span>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function ColumnResizeHandle({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return <div className="col-resize-handle" onMouseDown={onMouseDown} aria-hidden />;
}

// ─────────────────────────────────────────────────────────────────────────
// AuditsView — list of lifecycle-audit entries with click-through to the
// existing Vault entry renderer for detail.
//
// Phase 1c skinny slice: no filters yet (defer to Phase 2 dedicated app),
// no charts, no by-skill drill-in. Just a sortable list grouped by recency.
// The detail surface reuses the Vault app — clicking a row routes to
// /vault/entries/<audit-id> which already renders the audit's markdown.

interface AuditSummaryRow {
  id: string;
  path: string;
  title: string;
  audited_change_id: string;
  audited_change_path: string;
  project: string;
  audit_status: 'pending' | 'provisional' | 'final';
  verdict_overall: 'good' | 'mixed' | 'poor' | null;
  scores: { correctness: number; completeness: number; efficiency: number } | null;
  overseer_completed_at: string | null;
  rubric_version: string;
  audit_cost_usd: number | null;
  tag_count: number;
  tuning_suggestions_count: number;
  has_human_override: boolean;
  has_followups: boolean;
}

interface AuditsListResponse {
  audits: AuditSummaryRow[];
}

function verdictBadgeStyle(verdict: AuditSummaryRow['verdict_overall']) {
  if (verdict === 'good') {
    return {
      background: 'var(--success-bg, rgba(80,200,120,0.12))',
      color: 'var(--success-text, #4caf80)',
      border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
    };
  }
  if (verdict === 'mixed') {
    return {
      background: 'var(--warning-bg, rgba(250,200,80,0.1))',
      color: 'var(--warning-text, #e0a02a)',
      border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
    };
  }
  if (verdict === 'poor') {
    return {
      background: 'var(--danger-bg, rgba(250,80,80,0.1))',
      color: 'var(--danger-text, #e05050)',
      border: '1px solid var(--danger-border, rgba(250,80,80,0.4))',
    };
  }
  // null/unknown — pending audit
  return {
    background: 'var(--bg-2, rgba(255,255,255,0.04))',
    color: 'var(--text-3)',
    border: '1px solid var(--border)',
  };
}

function AuditsView() {
  const nav = useNavigation();
  const [audits, setAudits] = useState<AuditSummaryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<AuditsListResponse>('/api/audits')
      .then((r) => {
        if (cancelled) return;
        setAudits(r.audits);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <p className="subtle" style={{ padding: '20px 4px' }}>
        Loading audits…
      </p>
    );
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
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  if (!audits || audits.length === 0) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          No audits yet
        </h3>
        <p className="subtle" style={{ marginBottom: 12 }}>
          The Overseer (
          <code className="mono">meta-overseer-review</code>) produces a structured assessment of
          each completed change's lifecycle. Aggregated across many audits, the signal drives
          skill improvement.
        </p>
        <p className="subtle" style={{ marginBottom: 12 }}>
          Audits are <strong>opt-in per project</strong>. Add the following to a project's
          frontmatter to enable auto-fire on <code className="mono">change-automation-complete</code>
          :
        </p>
        <pre
          className="mono"
          style={{
            fontSize: 12,
            padding: 10,
            background: 'var(--bg-2)',
            borderRadius: 4,
            overflowX: 'auto',
          }}
        >
{`audit:
  enabled: true
  mode: on-complete   # or: sampled (with sample_rate: N) | manual`}
        </pre>
        <p className="subtle" style={{ fontSize: 12, marginTop: 12 }}>
          Or run a one-off retrospective audit manually:{' '}
          <code className="mono">/os audit lifecycle &lt;change-id&gt;</code>. See{' '}
          <code className="mono">archetype-lifecycle-audit</code> for the rubric + tag vocabulary.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h3 className="card-title">{audits.length} audit{audits.length !== 1 ? 's' : ''}</h3>
        <span className="tiny subtle">click any row to open the full audit entry</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 90 }}>Verdict</th>
            <th>Change audited</th>
            <th style={{ width: 130 }}>Project</th>
            <th style={{ width: 180 }}>Scores (C / Cm / E)</th>
            <th style={{ width: 80 }}>Tags</th>
            <th style={{ width: 110 }}>Suggestions</th>
            <th style={{ width: 110 }}>Audited</th>
          </tr>
        </thead>
        <tbody>
          {audits.map((a) => (
            <tr
              key={a.id}
              className="clickable"
              onClick={() => nav.navigateToEntry(a.id)}
              style={{ cursor: 'pointer' }}
              title={`Open audit ${a.id} in the Vault`}
            >
              <td>
                <span
                  className="badge"
                  style={{ fontSize: 11, ...verdictBadgeStyle(a.verdict_overall) }}
                >
                  {a.verdict_overall ?? a.audit_status}
                </span>
              </td>
              <td>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{a.title}</div>
                <div
                  className="tiny mono"
                  style={{ marginTop: 2, color: 'var(--muted)' }}
                  title={a.audited_change_id}
                >
                  → {a.audited_change_id}
                </div>
              </td>
              <td className="mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>
                {a.project}
              </td>
              <td className="mono" style={{ fontSize: 12 }}>
                {a.scores
                  ? `${a.scores.correctness.toFixed(1)} / ${a.scores.completeness.toFixed(1)} / ${a.scores.efficiency.toFixed(1)}`
                  : '—'}
              </td>
              <td className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {a.tag_count}
              </td>
              <td className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {a.tuning_suggestions_count > 0 ? (
                  <strong style={{ color: 'var(--accent-text)' }}>
                    {a.tuning_suggestions_count}
                  </strong>
                ) : (
                  '—'
                )}
              </td>
              <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                {a.overseer_completed_at ? formatRelative(a.overseer_completed_at) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="tiny subtle"
        style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}
      >
        Scores: <code className="mono">Correctness / Completeness / Efficiency</code> (means
        across per-skill findings, 1-5 scale).{' '}
        <code className="mono">Suggestions</code> highlighted when the Overseer raised concrete
        skill-tuning recommendations.
      </div>
    </div>
  );
}
