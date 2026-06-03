// Research list view — full-width table with filter chips + URL-param sync.

import type React from 'react';
import { useMemo } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import { formatRelative } from '../../../lib/time';
import { ActionBanner, Icons } from '../../../shared';
import { REmpty, RReviewBadge, RStatusBadge, RecChangesCell } from '../components';
import type { ResearchReportSummary } from '../data';

type StatusChip = 'all' | 'draft' | 'awaiting' | 'approved' | 'updates';

const CHIPS: ReadonlyArray<{ id: StatusChip; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Draft' },
  { id: 'awaiting', label: 'Awaiting review' },
  { id: 'approved', label: 'Approved' },
  { id: 'updates', label: 'Has updates' },
];

function readChip(s: string | null): StatusChip {
  if (!s) return 'all';
  return CHIPS.find((c) => c.id === s)?.id ?? 'all';
}

export interface ListPageProps {
  reports: ResearchReportSummary[];
  projects: Array<{ id: string; name: string }>;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  onOpen: (id: string) => void;
  onAddReport: () => void;
}

export const ListPage: React.FC<ListPageProps> = ({
  reports,
  projects,
  searchParams,
  setSearchParams,
  onOpen,
  onAddReport,
}) => {
  const statusFilter = readChip(searchParams.get('status'));
  const projectFilter = searchParams.get('project') ?? 'all';
  const textFilter = searchParams.get('q') ?? '';

  const counts = useMemo(
    () => ({
      all: reports.length,
      draft: reports.filter((r) => r.status === 'draft').length,
      awaiting: reports.filter(
        (r) => r.review_status === 'pending' || r.review_status === 'request-changes',
      ).length,
      approved: reports.filter((r) => r.review_status === 'approved').length,
      updates: reports.filter((r) => r.has_updates_pending).length,
    }),
    [reports],
  );

  const filtered = useMemo(() => {
    const text = textFilter.toLowerCase();
    return reports.filter((r) => {
      if (statusFilter === 'draft' && r.status !== 'draft') return false;
      if (
        statusFilter === 'awaiting' &&
        !(r.review_status === 'pending' || r.review_status === 'request-changes')
      ) {
        return false;
      }
      if (statusFilter === 'approved' && r.review_status !== 'approved') return false;
      if (statusFilter === 'updates' && !r.has_updates_pending) return false;
      if (projectFilter !== 'all' && r.project !== projectFilter) return false;
      if (text) {
        const t = `${r.title} ${r.project ?? ''}`.toLowerCase();
        if (!t.includes(text)) return false;
      }
      return true;
    });
  }, [reports, statusFilter, projectFilter, textFilter]);

  const updatesPending = useMemo(() => reports.filter((r) => r.has_updates_pending), [reports]);

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === '' || (key === 'status' && value === 'all')) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="page" style={{ padding: 24 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 className="h1">Research</h1>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Durable research-reports per project. Ingest, review, revise, and feed approved findings
            into the scaffold pipeline.
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" onClick={onAddReport}>
          <Icons.Plus size={14} /> Add research report
        </button>
      </header>

      {updatesPending.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <ActionBanner
            tone="warning"
            icon={<Icons.Sparkles size={18} />}
            title={`${updatesPending.length} report${updatesPending.length === 1 ? '' : 's'} suggest${
              updatesPending.length === 1 ? 's' : ''
            } updates`}
            desc="An update trigger has fired since the last research-update — new materials, a completed milestone, or a merged change."
            actions={{
              primary: {
                label: 'View',
                onClick: () => updateParam('status', 'updates'),
                tooltip: 'Filter the list to reports with pending updates.',
              },
            }}
          />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 14,
        }}
      >
        {CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className="chip"
            aria-pressed={statusFilter === chip.id}
            onClick={() => updateParam('status', chip.id)}
            style={chipStyle(statusFilter === chip.id)}
          >
            {chip.id === 'updates' && <Icons.AlertTriangle size={12} />}
            {chip.label}
            <span style={countStyle(statusFilter === chip.id)}>{counts[chip.id]}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 10px',
            width: 260,
          }}
        >
          <Icons.Search size={14} style={{ color: 'var(--muted)' }} />
          <input
            type="text"
            placeholder="Filter by title or project…"
            value={textFilter}
            onChange={(e) => updateParam('q', e.target.value)}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 13,
              color: 'var(--text)',
            }}
          />
        </div>
        <select
          value={projectFilter}
          onChange={(e) => updateParam('project', e.target.value === 'all' ? null : e.target.value)}
          style={{ width: 200, height: 34, padding: '0 8px', fontSize: 13 }}
        >
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table
          className="table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
        >
          <thead>
            <tr style={{ background: 'var(--panel-2)' }}>
              <Th>Title</Th>
              <Th width={140}>Project</Th>
              <Th width={130}>Status</Th>
              <Th width={180}>Review</Th>
              <Th width={70}>Rev</Th>
              <Th width={220}>Recommended changes</Th>
              <Th width={130}>Updated</Th>
              <Th width={30} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                onClick={() => onOpen(r.id)}
                style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
              >
                <Td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {r.has_updates_pending && (
                      <span
                        title="Update trigger pending"
                        style={{ color: 'var(--warning-text)', display: 'inline-flex' }}
                      >
                        <Icons.AlertTriangle size={13} />
                      </span>
                    )}
                    <span style={{ fontWeight: 500 }}>{r.title}</span>
                  </div>
                </Td>
                <Td>
                  <code className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                    {r.project ?? '—'}
                  </code>
                </Td>
                <Td>
                  <RStatusBadge status={r.status} />
                </Td>
                <Td>
                  <RReviewBadge status={r.review_status} />
                </Td>
                <Td>
                  {r.report_revision && r.report_revision > 1 ? (
                    <code className="mono">rev {r.report_revision}</code>
                  ) : (
                    <span style={{ color: 'var(--subtle)' }}>—</span>
                  )}
                </Td>
                <Td>
                  <RecChangesCell report={r} />
                </Td>
                <Td>
                  <span
                    className="tiny mono"
                    style={{ color: 'var(--muted)' }}
                    title={r.updated ?? ''}
                  >
                    {r.updated ? formatRelative(r.updated) : '—'}
                  </span>
                </Td>
                <Td>
                  <Icons.ChevronRight size={14} style={{ color: 'var(--subtle)' }} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <REmpty
            title="No research reports yet"
            hint="Reports are durable artifacts — start one when a question is worth answering rigorously."
            icon={<Icons.Search size={28} />}
            cta={
              <button type="button" className="btn btn-primary" onClick={onAddReport}>
                <Icons.Plus size={13} /> Add research report
              </button>
            }
          />
        )}
      </div>
    </div>
  );
};

function Th({
  children,
  width,
}: {
  children?: React.ReactNode;
  width?: number;
}) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        fontSize: 11.5,
        fontWeight: 500,
        color: 'var(--muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        width,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: '10px 12px', verticalAlign: 'middle' }}>{children}</td>;
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    fontSize: 12.5,
    border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent-text)' : 'var(--text-2)',
    borderRadius: 999,
    cursor: 'pointer',
  };
}

function countStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    color: active ? 'var(--accent-text)' : 'var(--muted)',
    background: active ? 'var(--bg)' : 'var(--panel-2)',
    padding: '0 6px',
    borderRadius: 8,
  };
}
