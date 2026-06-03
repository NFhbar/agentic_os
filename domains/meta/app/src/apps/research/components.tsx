// Research app — local components. Shared primitives (ActionBanner, Stepper,
// CountStackedBar, MarkdownBlock, DispatchModal) live in shared/; this file
// holds the research-specific badges, modal compositions, and file-icon helpers.

import type React from 'react';
import { useMemo, useState } from 'react';
import { Icons, SharedModal } from '../../shared';
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

// ── AddResearchReportModal — local, single-use ───────────────────────────────

export interface StagedFile {
  filename: string;
  size: number;
  content_base64: string;
}

export const AddResearchReportModal: React.FC<{
  projects: Array<{ id: string; name: string }>;
  // Optional pre-selection. When set, the Project dropdown initializes to
  // this id instead of the first project alphabetically. Used by the
  // Projects-app's "Add research report" button to deep-link with the
  // owning project already chosen (Task #390).
  initialProject?: string | null;
  onCancel: () => void;
  onConfirm: (args: {
    project: string;
    report_topic: string;
    notes: string;
    materials: { urls: string[]; wikilinks: string[]; files: StagedFile[] };
  }) => void;
}> = ({ projects, initialProject, onCancel, onConfirm }) => {
  // Validate the initial project against the dropdown list — if the caller
  // passed a stale/unknown id, fall back to the first project. Without this
  // the dropdown would render empty and submission would fail with
  // "Select a project".
  const initialProjectValid =
    initialProject && projects.some((p) => p.id === initialProject) ? initialProject : null;
  const [project, setProject] = useState(initialProjectValid ?? projects[0]?.id ?? '');
  const [reportTopic, setReportTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [urlsText, setUrlsText] = useState('');
  const [wikilinksText, setWikilinksText] = useState('');
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const materialsPath = useMemo(() => {
    if (!project || !reportTopic) return '';
    return `vault/raw/project-research/${project}/${reportTopic}/`;
  }, [project, reportTopic]);

  const slugSafe = useMemo(() => /^[a-z0-9][a-z0-9-]*$/.test(reportTopic), [reportTopic]);

  function submit() {
    if (!project) {
      setError('Select a project');
      return;
    }
    if (!reportTopic) {
      setError('Enter a report topic');
      return;
    }
    if (!slugSafe) {
      setError('Report topic must be lowercase, alphanumeric, with hyphens (no spaces)');
      return;
    }
    const urls = urlsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const wikilinks = wikilinksText
      .split('\n')
      .map((s) => s.trim().replace(/^\[\[|\]\]$/g, ''))
      .filter(Boolean);
    onConfirm({
      project,
      report_topic: reportTopic,
      notes,
      materials: { urls, wikilinks, files: stagedFiles },
    });
  }

  async function ingestBrowserFiles(fileList: FileList | null) {
    if (!fileList) return;
    const FILE_SIZE_CAP = 5 * 1024 * 1024;
    const FILENAME_RE = /^[A-Za-z0-9._-]+$/;
    const additions: StagedFile[] = [];
    const errors: string[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > FILE_SIZE_CAP) {
        errors.push(`${file.name}: exceeds 5 MB cap`);
        continue;
      }
      if (!FILENAME_RE.test(file.name) || file.name.startsWith('.') || file.name.includes('..')) {
        errors.push(`${file.name}: filename rejected (must match [A-Za-z0-9._-]+, no leading dot)`);
        continue;
      }
      try {
        const buf = await file.arrayBuffer();
        // Browser-safe base64 encode of an ArrayBuffer.
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const content_base64 = btoa(binary);
        additions.push({ filename: file.name, size: file.size, content_base64 });
      } catch (e) {
        errors.push(`${file.name}: read failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (additions.length > 0) {
      setStagedFiles((prev) => [...prev, ...additions]);
    }
    if (errors.length > 0) {
      setError(`File staging issues:\n${errors.join('\n')}`);
    }
  }

  function removeStagedFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <SharedModal
      title="Add research report"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!project || !reportTopic || !slugSafe}
          >
            <Icons.Send size={12} /> Dispatch research-write
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Project">
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', fontSize: 13 }}
          >
            <option value="" disabled>
              Select a project…
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Report topic"
          hint="Slug-safe (lowercase, alphanumeric, hyphens). The full id will be <project>-<topic>."
        >
          <input
            type="text"
            value={reportTopic}
            onChange={(e) => setReportTopic(e.target.value)}
            placeholder="e.g. retry-backoff-survey"
            style={{ width: '100%', padding: '6px 10px', fontSize: 13 }}
          />
        </Field>
        {materialsPath && (
          <Field label="Materials path (auto-derived)">
            <div
              className="mono"
              style={{
                padding: '8px 10px',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--text-2)',
              }}
            >
              {materialsPath}
            </div>
          </Field>
        )}
        <Field
          label="Initial URLs (one per line, optional)"
          hint="URLs will be enqueued for ingest under the materials path."
        >
          <textarea
            rows={3}
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            placeholder="https://…"
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
            }}
          />
        </Field>
        <Field
          label="Initial wiki entries (one per line, optional)"
          hint="Existing vault entry ids to include — e.g. note/retry-strategies. Brackets are optional."
        >
          <textarea
            rows={2}
            value={wikilinksText}
            onChange={(e) => setWikilinksText(e.target.value)}
            placeholder="note/retry-strategies"
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
            }}
          />
        </Field>
        <Field
          label="Initial files (optional)"
          hint="Drag-drop or pick files (PDFs, markdown, text, …). Max 5 MB each. Files upload to the materials path above when you dispatch."
        >
          <div
            onDragEnter={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void ingestBrowserFiles(e.dataTransfer.files);
            }}
            style={{
              padding: '12px',
              border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
              background: dragOver ? 'var(--accent-soft)' : 'var(--bg-2)',
              borderRadius: 6,
              textAlign: 'center',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <p className="tiny subtle" style={{ margin: 0 }}>
              Drag files here, or
            </p>
            <label
              className="btn btn-sm"
              style={{ marginTop: 6, cursor: 'pointer', display: 'inline-flex' }}
            >
              <Icons.Plus size={11} /> Choose files
              <input
                type="file"
                multiple
                onChange={(e) => {
                  void ingestBrowserFiles(e.target.files);
                  e.target.value = ''; // allow re-picking the same file
                }}
                style={{ display: 'none' }}
              />
            </label>
          </div>
          {stagedFiles.length > 0 && (
            <ul
              style={{
                listStyle: 'none',
                margin: '8px 0 0',
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {stagedFiles.map((f, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable for this lifecycle
                  key={`${f.filename}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    background: 'var(--bg-2)',
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  <span style={{ flex: 1, fontFamily: 'inherit' }}>{f.filename}</span>
                  <span className="tiny subtle">{Math.ceil(f.size / 1024)} KB</span>
                  <button
                    type="button"
                    onClick={() => removeStagedFile(i)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--danger-text)',
                      padding: 0,
                    }}
                    title="Remove from upload list"
                  >
                    <Icons.X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Notes (optional)">
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the writer should know about the framing…"
            style={{
              width: '100%',
              padding: '6px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
            }}
          />
        </Field>
        {error && (
          <div className="tiny" style={{ color: 'var(--danger-text)' }}>
            {error}
          </div>
        )}
      </div>
    </SharedModal>
  );
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && (
        <div className="tiny" style={{ marginTop: 4, color: 'var(--muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
