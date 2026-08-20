// Ops → protocol list. One collapsible group per review protocol; the rows
// inside a group are that protocol's dated reports, newest first.
//
// Grouping by protocol rather than showing one flat report stream is
// deliberate: a verdict only means something against the contract that
// produced it, so reports from different protocols are not comparable and
// should never sit in the same sorted column.

import { useEffect, useMemo, useState } from 'react';
import { Empty, Icons } from '../../../shared';
import type { OpsProtocolSummary, OpsReportSummary } from '../data';
import {
  formatKpiValue,
  hasGaps,
  isContractUnset,
  kpiContractLine,
  verdictBadgeClass,
  verdictLabel,
} from '../data';

const EXPANDED_KEY = 'agentic-os/ops-expanded-protocols';

const COLUMNS = 7;

export interface ListPageProps {
  protocols: OpsProtocolSummary[];
  // Absent key = not fetched yet. The page requests it on expand.
  reportsByProtocol: Record<string, OpsReportSummary[]>;
  onNeedReports: (id: string) => void;
  dispatching: boolean;
  onOpenProtocol: (id: string) => void;
  onOpenReport: (id: string, file: string) => void;
  onNewProtocol: () => void;
  onRunReview: (id: string) => void;
}

// Explicit user choices only. A protocol with no stored choice falls back to
// the attention default in isExpanded — so a freshly-landed `action-needed`
// verdict opens itself without the user having to remember to look.
function readOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

// Module-level and pure so the memo below can declare honest dependencies:
// expansion is a function of the stored overrides plus the protocol's own
// verdict, nothing else.
function isExpanded(p: OpsProtocolSummary, overrides: Record<string, boolean>): boolean {
  const chosen = overrides[p.id];
  if (typeof chosen === 'boolean') return chosen;
  return p.last_verdict === 'action-needed';
}

export function ListPage({
  protocols,
  reportsByProtocol,
  onNeedReports,
  dispatching,
  onOpenProtocol,
  onOpenReport,
  onNewProtocol,
  onRunReview,
}: ListPageProps) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>(readOverrides);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(overrides));
    } catch {
      /* private mode — expansion just doesn't persist */
    }
  }, [overrides]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return protocols;
    return protocols.filter((p) =>
      `${p.title} ${p.id} ${p.target ?? ''} ${p.owner ?? ''}`.toLowerCase().includes(q),
    );
  }, [protocols, filter]);

  // `overrides` is what changes expansion; `filtered` is what changes membership.
  const expandedIds = useMemo(
    () => filtered.filter((p) => isExpanded(p, overrides)).map((p) => p.id),
    [filtered, overrides],
  );

  // Fetch each expanded group's rows exactly once. Re-runs when the cache is
  // cleared (a finished review invalidates it), which is how new reports land.
  useEffect(() => {
    for (const id of expandedIds) {
      if (reportsByProtocol[id] === undefined) onNeedReports(id);
    }
  }, [expandedIds, reportsByProtocol, onNeedReports]);

  function toggle(id: string, next: boolean) {
    setOverrides((prev) => ({ ...prev, [id]: next }));
  }

  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 className="h1">Ops</h1>
          <div className="subtle" style={{ marginTop: 2 }}>
            Recurring health reviews. Every verdict is graded against its protocol's written
            contract — and every review is read-only against the system it looks at.
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={onNewProtocol}>
          <Icons.Plus size={14} /> New protocol
        </button>
      </div>

      {protocols.length > 0 && (
        <div className="filter-row" style={{ marginBottom: 12 }}>
          <div className="search-wrap">
            <Icons.Search size={14} />
            <input
              className="input"
              placeholder="Filter by protocol, target, owner…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
      )}

      {protocols.length === 0 && (
        <Empty
          title="No review protocols yet"
          hint="A protocol is the written contract a health review executes — sources, queries, the KPI, the failure taxonomy, and the gate each candidate monitor must clear. Create one to start measuring."
          icon={<Icons.Flag size={24} />}
        />
      )}

      {protocols.length > 0 && filtered.length === 0 && (
        <Empty title="No protocols match that filter" hint="Clear the filter to see them all." />
      )}

      {filtered.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '30%' }}>Report</th>
              <th>Verdict</th>
              <th>KPI</th>
              <th>Failures</th>
              <th>Tickets</th>
              <th>Monitors</th>
              <th>Gaps</th>
            </tr>
          </thead>
          {filtered.map((p) => {
            const expanded = isExpanded(p, overrides);
            const rows = reportsByProtocol[p.id];
            return (
              <tbody key={p.id}>
                <tr aria-expanded={expanded}>
                  <td colSpan={COLUMNS} style={{ background: 'var(--bg-2)' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => toggle(p.id, !expanded)}
                        aria-label={expanded ? `Collapse ${p.title}` : `Expand ${p.title}`}
                        title={expanded ? 'Collapse' : 'Expand'}
                      >
                        {expanded ? (
                          <Icons.ChevronDown size={14} />
                        ) : (
                          <Icons.ChevronRight size={14} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        style={{ padding: 0, fontWeight: 600 }}
                        onClick={() => onOpenProtocol(p.id)}
                      >
                        {p.title}
                      </button>
                      <span className={verdictBadgeClass(p.last_verdict)}>
                        <span className="badge-dot" />
                        {verdictLabel(p.last_verdict)}
                      </span>
                      <span className="tiny subtle">
                        {p.reports_count} report{p.reports_count === 1 ? '' : 's'}
                        {p.target ? ` · ${p.target}` : ''}
                        {p.owner ? ` · ${p.owner}` : ''}
                      </span>
                      {isContractUnset(p.kpi) && (
                        <span className="badge muted" title={kpiContractLine(p.kpi)}>
                          contract unset — measure first
                        </span>
                      )}
                      <span className="spacer" style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={dispatching}
                        onClick={() => onRunReview(p.id)}
                        title={
                          dispatching
                            ? 'An ops run is already in flight'
                            : 'Dispatch a health review against this protocol (read-only)'
                        }
                      >
                        <Icons.Play size={13} /> Run review
                      </button>
                    </div>
                  </td>
                </tr>

                {expanded && rows === undefined && (
                  <tr>
                    <td colSpan={COLUMNS} className="tiny subtle">
                      Loading reports…
                    </td>
                  </tr>
                )}

                {expanded && rows?.length === 0 && (
                  <tr>
                    <td colSpan={COLUMNS} className="tiny subtle">
                      No reviews yet. The first run establishes the measurement.
                    </td>
                  </tr>
                )}

                {expanded &&
                  rows?.map((r) => (
                    <tr
                      key={r.file}
                      className="clickable"
                      onClick={() => onOpenReport(p.id, r.file)}
                    >
                      <td>
                        <span className="mono">{r.date ?? r.file}</span>
                        {r.seq > 1 && <span className="tiny subtle"> · #{r.seq}</span>}
                      </td>
                      <td>
                        <span className={verdictBadgeClass(r.verdict)}>
                          <span className="badge-dot" />
                          {verdictLabel(r.verdict)}
                        </span>
                      </td>
                      <td>
                        <span className="mono">{formatKpiValue(r.kpi_value)}</span>
                        {r.window_overridden && (
                          <span className="tiny subtle" title="Window overridden for this run">
                            {' '}
                            · {r.window_days}d*
                          </span>
                        )}
                      </td>
                      <td className="tiny">
                        {r.failures_total ?? '—'}
                        {(r.failures_unclassified ?? 0) > 0 && (
                          <span className="subtle"> ({r.failures_unclassified} unclassified)</span>
                        )}
                      </td>
                      <td className="tiny">
                        {r.tickets_confirmed ?? 0}✓ / {r.tickets_pending ?? 0}⋯
                        {(r.tickets_contradicted ?? 0) > 0 && ` / ${r.tickets_contradicted}✗`}
                      </td>
                      <td className="tiny">
                        {(r.monitors_ready ?? 0) > 0 ? `${r.monitors_ready} ready to publish` : '—'}
                      </td>
                      <td className="tiny">
                        {hasGaps(r) ? (
                          <span
                            className="badge warning"
                            title="Sources this review could not reach — findings above are degraded"
                          >
                            <span className="badge-dot" />
                            {r.gaps}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            );
          })}
        </table>
      )}
    </div>
  );
}
