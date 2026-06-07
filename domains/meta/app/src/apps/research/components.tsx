// Research app — local components. Shared primitives (ActionBanner, Stepper,
// CountStackedBar, MarkdownBlock, DispatchModal) live in shared/; this file
// holds the research-specific badges, modal compositions, and file-icon helpers.

import type React from 'react';
import { useMemo, useState } from 'react';
import { Icons } from '../../shared';
import { CountStackedBar } from '../../shared';
import { DispatchModal } from '../../shared';
import { isKnownRecChangeStatus } from './data';
import type { RecChangeStatus, ResearchReportSummary } from './data';

// ── Status badges ────────────────────────────────────────────────────────────

export const RStatusBadge: React.FC<{ status: string | null }> = ({ status }) => {
  const map: Record<string, { cls: string; label: string; dot: string }> = {
    draft: { cls: 'muted', label: 'Draft', dot: 'var(--muted)' },
    reviewed: { cls: 'warning', label: 'Reviewed', dot: 'var(--warning)' },
    approved: { cls: 'success', label: 'Approved', dot: 'var(--success)' },
    updated: { cls: 'accent', label: 'Updated', dot: 'var(--accent)' },
  };
  const m = (status && map[status]) || { cls: 'muted', label: status ?? '—', dot: 'var(--muted)' };
  return (
    <span className={`badge ${m.cls}`}>
      <span
        className="badge-dot"
        style={{
          background: m.dot,
          width: 6,
          height: 6,
          borderRadius: '50%',
          display: 'inline-block',
          marginRight: 4,
        }}
      />
      {m.label}
    </span>
  );
};

export const RReviewBadge: React.FC<{ status: string | null }> = ({ status }) => {
  if (status === 'pending') {
    return (
      <span className="badge muted">
        <Icons.Clock size={11} /> Pending review
      </span>
    );
  }
  if (status === 'request-changes') {
    return (
      <span className="badge warning">
        <Icons.AlertTriangle size={11} /> Changes requested
      </span>
    );
  }
  if (status === 'approved') {
    return (
      <span className="badge success">
        <Icons.Check size={11} /> Reviewer approved
      </span>
    );
  }
  if (status === 'overridden') {
    return <span className="badge">Overridden</span>;
  }
  return null;
};

export const RecChangeBadge: React.FC<{ status: string }> = ({ status }) => {
  if (!isKnownRecChangeStatus(status)) {
    return <span className="badge muted">{status}</span>;
  }
  const map: Record<RecChangeStatus, { cls: string; label: string; icon?: React.ReactNode }> = {
    proposed: { cls: 'accent', label: 'Proposed' },
    scaffolded: { cls: 'warning', label: 'Scaffolded' },
    merged: { cls: 'success', label: 'Merged', icon: <Icons.GitMerge size={11} /> },
    abandoned: { cls: 'muted', label: 'Abandoned' },
  };
  const m = map[status];
  return (
    <span className={`badge ${m.cls}`}>
      {m.icon}
      {m.label}
    </span>
  );
};

// ── RecChangesCell — list-view stacked bar ───────────────────────────────────

export const RecChangesCell: React.FC<{ report: ResearchReportSummary }> = ({ report }) => {
  // Segments rendered in canonical order: merged → scaffolded → proposed → abandoned.
  const segments = [
    {
      count: report.recommended_changes_merged,
      color: 'var(--success)',
      abbr: 'm',
      textColor: 'var(--success-text)',
    },
    {
      count: report.recommended_changes_scaffolded,
      color: 'var(--warning)',
      abbr: 's',
      textColor: 'var(--warning-text)',
    },
    {
      count: report.recommended_changes_proposed,
      color: 'var(--accent)',
      abbr: 'p',
      textColor: 'var(--accent-text)',
    },
    {
      count: report.recommended_changes_abandoned,
      color: 'var(--muted)',
      abbr: 'a',
      textColor: 'var(--subtle)',
    },
  ];
  return <CountStackedBar segments={segments} total={report.recommended_changes_count} />;
};

// ── REmpty — table/page empty state with optional CTA ────────────────────────

export const REmpty: React.FC<{
  title: string;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  cta?: React.ReactNode;
}> = ({ title, hint, icon, cta }) => (
  <div className="empty" style={{ padding: 32, textAlign: 'center' }}>
    {icon && (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginBottom: 12,
          color: 'var(--subtle)',
        }}
      >
        {icon}
      </div>
    )}
    <div className="h2">{title}</div>
    {hint && <div style={{ marginTop: 4, color: 'var(--muted)' }}>{hint}</div>}
    {cta && <div style={{ marginTop: 14 }}>{cta}</div>}
  </div>
);

// ── Tabbar ───────────────────────────────────────────────────────────────────

export interface TabDef {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

export const Tabbar: React.FC<{
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
}> = ({ tabs, active, onChange }) => (
  <div
    className="tabs"
    style={{
      display: 'flex',
      gap: 4,
      borderBottom: '1px solid var(--border)',
      marginBottom: 18,
    }}
  >
    {tabs.map((t) => {
      const isActive = t.id === active;
      return (
        <button
          key={t.id}
          type="button"
          className={isActive ? 'tab active' : 'tab'}
          aria-selected={isActive}
          onClick={() => onChange(t.id)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          {t.icon}
          {t.label}
          {t.count != null && (
            <span
              className="badge muted"
              style={{ marginLeft: 4, fontSize: 11, height: 16, padding: '0 6px' }}
            >
              {t.count}
            </span>
          )}
        </button>
      );
    })}
  </div>
);

// ── File-icon helper — file-type icons local to materials list ───────────────

const ImageIcon = (p: { size?: number }) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-5-5L5 21" />
  </svg>
);

const VideoIcon = (p: { size?: number }) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="5" width="14" height="14" rx="2" />
    <path d="m21 7-4 5 4 5V7Z" />
  </svg>
);

const PdfIcon = (p: { size?: number }) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M9 14v4M11 14h-2M11 16h-2" />
  </svg>
);

const CsvIcon = (p: { size?: number }) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="M7 14h2M7 17h2M11 14h2M11 17h2M15 14h2M15 17h2" />
  </svg>
);

const ArchiveIcon = (p: { size?: number }) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
);

export function fileIcon(name: string): React.ReactNode {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return <ImageIcon />;
  if (['mp4', 'mov', 'webm'].includes(ext)) return <VideoIcon />;
  if (ext === 'csv') return <CsvIcon />;
  if (ext === 'pdf') return <PdfIcon />;
  if (['zip', 'tar', 'gz'].includes(ext)) return <ArchiveIcon />;
  if (['md', 'txt'].includes(ext)) return <Icons.FileText size={14} />;
  return <Icons.File size={14} />;
}

// ── RunResearchUpdateModal — wraps shared DispatchModal ──────────────────────

export const RunResearchUpdateModal: React.FC<{
  report: ResearchReportSummary;
  newMaterials: Array<{ name: string; size: number }>;
  triggerSource: string;
  onConfirm: (args: { notes: string }) => void;
  onCancel: () => void;
}> = ({ report: _report, newMaterials, triggerSource, onConfirm, onCancel }) => {
  const autoDiff =
    newMaterials.length === 0 ? (
      <div className="tiny" style={{ padding: 14, color: 'var(--muted)' }}>
        No new materials — running an update without diff will re-analyze existing context.
      </div>
    ) : (
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--panel-2)',
          maxHeight: 160,
          overflow: 'auto',
        }}
      >
        {newMaterials.map((m, i) => (
          <div
            key={m.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              borderBottom: i < newMaterials.length - 1 ? '1px solid var(--border)' : 0,
            }}
          >
            <span style={{ color: 'var(--muted)' }}>{fileIcon(m.name)}</span>
            <span className="mono" style={{ fontSize: 12.5, flex: 1 }}>
              {m.name}
            </span>
            <span className="tiny mono" style={{ color: 'var(--muted)' }}>
              {formatSize(m.size)}
            </span>
          </div>
        ))}
      </div>
    );

  return (
    <DispatchModal
      title="Run research-update"
      triggerSource={triggerSource}
      autoDiff={autoDiff}
      autoDiffLabel={`Auto-detected diff vs last ingest (${newMaterials.length})`}
      autoDiffHint="These will be appended to the report's materials before re-running the analysis."
      additionalContextPlaceholder="Anything not captured in the materials drop…"
      confirmLabel="Run update"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
};

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── StagedFile — shared shape for file-staging UIs ──────────────────────────
//
// Used by pages/Add.tsx (the dedicated /research/new page that replaced the
// prior in-place AddResearchReportModal). Kept here as the canonical type
// rather than redefined per call site so the file-upload API's shape stays
// one source of truth.

export interface StagedFile {
  filename: string;
  size: number;
  content_base64: string;
}
