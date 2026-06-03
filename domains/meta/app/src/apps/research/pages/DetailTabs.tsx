// Research detail — per-tab bodies (Overview, Report, RecChanges, Materials,
// Reviews, Updates, Replay).

import type React from 'react';
import { useEffect, useState } from 'react';
import { formatLocal, formatRelative } from '../../../lib/time';
import { Icons, MarkdownBlock } from '../../../shared';
import { REmpty, RecChangeBadge, fileIcon } from '../components';
import { fetchEntry } from '../../../lib/vault';
import type {
  FileRef,
  MaterialRef,
  NoteRef,
  NoteSeverity,
  RecommendedChangeRef,
  ReplayTimelineEntry,
  ResearchReportSummary,
} from '../data';
import { NOTE_SEVERITIES, stateFor } from '../data';

// ── Overview ─────────────────────────────────────────────────────────────────

export const OverviewTab: React.FC<{
  report: ResearchReportSummary;
  body: string | null;
  recommendations: RecommendedChangeRef[];
  onGoTab: (id: 'report' | 'recommended' | 'materials' | 'reviews' | 'updates' | 'replay') => void;
  onScaffoldAll: () => void;
  onOpenProject: () => void;
}> = ({ report, body, recommendations, onGoTab, onScaffoldAll, onOpenProject }) => {
  const proposed = report.recommended_changes_proposed;
  const firstParas = firstParagraphs(body, 2);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
        gap: 18,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 style={{ margin: 0, fontSize: 14 }}>About this research</h3>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onGoTab('report')}
            >
              Open report <Icons.ArrowRight size={12} />
            </button>
          </div>
          <div style={{ padding: '12px 16px' }}>
            {firstParas ? (
              <MarkdownBlock text={firstParas} />
            ) : (
              <p className="subtle tiny" style={{ margin: 0 }}>
                The report body is empty — nothing has been written past frontmatter.
              </p>
            )}
            {body && (
              <div className="tiny" style={{ marginTop: 10, color: 'var(--subtle)' }}>
                {Math.round(body.length / 1000)}k chars · {body.split('\n## ').length} sections ·{' '}
                {body.includes('## Update') ? 'includes update sections' : 'no update sections yet'}
              </div>
            )}
          </div>
        </section>
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 style={{ margin: 0, fontSize: 14 }}>What's next</h3>
          </div>
          <div style={{ padding: '12px 16px' }}>
            <NextHint
              report={report}
              recommendations={recommendations}
              onScaffoldAll={onScaffoldAll}
              onGoTab={onGoTab}
            />
          </div>
        </section>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 style={{ margin: 0, fontSize: 14 }}>Quick stats</h3>
          </div>
          <div style={{ padding: '12px 16px' }}>
            <StatRow
              label="Materials ingested"
              value={(report.last_data_ingest ? '✓' : '—') + ` (${recommendations.length} recs)`}
            />
            <StatRow
              label="Recommended · proposed"
              value={String(report.recommended_changes_proposed)}
              color="var(--accent-text)"
            />
            <StatRow
              label="Recommended · scaffolded"
              value={String(report.recommended_changes_scaffolded)}
              color="var(--warning-text)"
            />
            <StatRow
              label="Recommended · merged"
              value={String(report.recommended_changes_merged)}
              color="var(--success-text)"
            />
            <StatRow label="Updates so far" value={String(report.update_count)} />
            <StatRow
              label="Last updated"
              value={report.updated ? formatRelative(report.updated) : '—'}
            />
          </div>
        </section>
        {report.project && (
          <section className="card" style={{ padding: 0 }}>
            <div className="card-header">
              <h3 style={{ margin: 0, fontSize: 14 }}>Owning project</h3>
            </div>
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <Icons.Folder size={14} style={{ color: 'var(--muted)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{report.project}</div>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenProject}>
                Open <Icons.External size={12} />
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

// What's next — mirrors stateFor()'s 6 states so the Overview hint stays in
// sync with the action banner above it. Drop-through to "nothing pending" is
// reserved for the truly-terminal approved-clean state (all recommendations
// scaffolded or beyond).
function NextHint({
  report,
  recommendations,
  onScaffoldAll,
  onGoTab,
}: {
  report: ResearchReportSummary;
  recommendations: RecommendedChangeRef[];
  onScaffoldAll: () => void;
  onGoTab: (id: 'report' | 'recommended' | 'materials' | 'reviews' | 'updates' | 'replay') => void;
}) {
  const state = stateFor(report, recommendations);
  if (state === 'awaiting-review') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icons.Eye size={20} style={{ color: 'var(--accent-text)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5 }}>
            <strong>Review the draft.</strong> Reviewer will check material coverage, evidence
            quality, and recommendation soundness.
          </div>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Click "Review research" in the banner above (or in the Reviews tab) to dispatch.
          </div>
        </div>
      </div>
    );
  }
  if (state === 'pre-revise') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icons.AlertTriangle size={20} style={{ color: 'var(--warning-text)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5 }}>
            <strong>Reviewer requested changes.</strong> Fold the findings into the report.
          </div>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Click "Revise research" in the banner — surgical re-write that preserves history.
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => onGoTab('reviews')}>
          See review
        </button>
      </div>
    );
  }
  if (state === 'post-revise') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icons.Refresh size={20} style={{ color: 'var(--accent-text)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5 }}>
            <strong>Plan was revised.</strong> Verdict below still describes the prior revision.
          </div>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Click "Re-review research" to get a fresh verdict against the revised report.
          </div>
        </div>
      </div>
    );
  }
  if (state === 'ready-to-scaffold') {
    const proposed = report.recommended_changes_proposed;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Icons.Lightbulb size={20} style={{ color: 'var(--accent-text)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5 }}>
            <strong>
              {proposed} proposed change{proposed === 1 ? '' : 's'}
            </strong>{' '}
            ready to feed into the scaffold pipeline.
          </div>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Scaffolding creates change-records the dev team can pick up.
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={onScaffoldAll}>
          <Icons.Send size={12} /> Scaffold all proposed
        </button>
      </div>
    );
  }
  // approved-clean OR idle — truly nothing pending.
  return (
    <div className="tiny" style={{ color: 'var(--muted)' }}>
      Nothing pending. Run an update when new materials arrive or a milestone completes.
    </div>
  );
}

function StatRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '6px 0',
        borderBottom: '1px solid var(--border)',
        fontSize: 12.5,
      }}
    >
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="mono" style={{ color: color ?? 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}

function firstParagraphs(body: string | null, n: number): string | null {
  if (!body) return null;
  const stripped = body.replace(/^#.*$/m, '').trim();
  const paras = stripped.split('\n\n').filter((p) => p.trim() && !p.startsWith('#'));
  if (paras.length === 0) return null;
  return paras.slice(0, n).join('\n\n');
}

// ── Report ──────────────────────────────────────────────────────────────────

export const ReportTab: React.FC<{
  body: string | null;
  report: ResearchReportSummary;
  onOpenEntry: (id: string) => void;
}> = ({ body, report, onOpenEntry }) => {
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <div>
          <h3 style={{ margin: 0, fontSize: 14 }}>
            Research report
            {report.report_revision ? ` · rev ${report.report_revision}` : ''}
          </h3>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Canonical markdown. Update sections rendered inline.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onOpenEntry(report.id)}
          title="Open the raw vault entry to edit in the markdown editor"
        >
          <Icons.Pencil size={12} /> Edit raw
        </button>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {body ? (
          <MarkdownBlock text={body} decorate="updates" />
        ) : (
          <p className="subtle tiny" style={{ margin: 0 }}>
            No body content past frontmatter yet.
          </p>
        )}
      </div>
    </section>
  );
};

// ── Recommended changes ─────────────────────────────────────────────────────

export const RecChangesTab: React.FC<{
  recommendations: RecommendedChangeRef[];
  onScaffoldOne: (rc: RecommendedChangeRef) => void;
  onScaffoldAll: () => void;
  onOpenChange: (id: string) => void;
}> = ({ recommendations, onScaffoldOne, onScaffoldAll, onOpenChange }) => {
  const proposed = recommendations.filter((rc) => rc.status === 'proposed');
  if (recommendations.length === 0) {
    return (
      <section className="card">
        <REmpty
          title="No recommended changes yet"
          hint="The reviewer hasn't extracted recommendations from this research. Re-run research-update to try again."
          icon={<Icons.Sparkles size={28} />}
        />
      </section>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <h3 className="h2" style={{ margin: 0 }}>
            Recommended changes
          </h3>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Findings ready to flow into the project scaffold pipeline.
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {proposed.length > 0 && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onScaffoldAll}>
            <Icons.Send size={12} /> Scaffold all proposed ({proposed.length})
          </button>
        )}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {recommendations.map((rc) => (
          <div
            key={rc.index}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 120px 80px 140px 130px',
              gap: 12,
              padding: '10px 14px',
              borderTop: '1px solid var(--border)',
              alignItems: 'center',
              opacity: rc.status === 'abandoned' ? 0.55 : 1,
              textDecoration: rc.status === 'abandoned' ? 'line-through' : 'none',
            }}
          >
            <div>
              <div style={{ fontSize: 13 }}>{rc.summary}</div>
              {rc.linked_change && (
                <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
                  <code className="mono">{rc.linked_change.id}</code>
                </div>
              )}
            </div>
            <code className="mono tiny" style={{ color: 'var(--text-2)' }}>
              {rc.domain ?? '—'}
            </code>
            <code className="mono tiny" style={{ color: 'var(--muted)' }}>
              {rc.size ?? '—'}
            </code>
            <div>
              <RecChangeBadge status={rc.status} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              {rc.status === 'proposed' && (
                <button type="button" className="btn btn-sm" onClick={() => onScaffoldOne(rc)}>
                  <Icons.Send size={11} /> Scaffold this
                </button>
              )}
              {(rc.status === 'scaffolded' || rc.status === 'merged') && rc.linked_change && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => onOpenChange(rc.linked_change?.id ?? '')}
                  style={rc.status === 'merged' ? { opacity: 0.75 } : undefined}
                >
                  Open change <Icons.ArrowRight size={11} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ── Materials ────────────────────────────────────────────────────────────────

export const MaterialsTab: React.FC<{
  report: ResearchReportSummary;
  materials: MaterialRef[];
  onReingest: () => void;
  onChanged: (msg: string) => void;
}> = ({ report, materials, onReingest, onChanged }) => {
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const newCount = materials.filter((m) => !m.ingested).length;

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const r = await fetch(`/api/research/${encodeURIComponent(report.id)}/materials`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'file',
            filename: file.name,
            content: b64,
            content_encoding: 'base64',
          }),
        });
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          onChanged(`Upload failed: ${file.name} — ${j.error ?? r.status}`);
        } else {
          onChanged(`Uploaded ${file.name}`);
        }
      } catch (err) {
        onChanged(`Upload error: ${(err as Error).message}`);
      }
    }
    setUploading(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <h3 className="h2" style={{ margin: 0 }}>
            Materials
          </h3>
          <div className="tiny mono" style={{ marginTop: 2, color: 'var(--muted)' }}>
            {report.materials_path ?? '(no materials path)'}
          </div>
        </div>
        {newCount > 0 && (
          <span className="badge warning">
            <Icons.AlertTriangle size={11} /> {newCount} new since last ingest
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm"
          onClick={onReingest}
          title="Opens the run-update modal pre-populated with a re-ingest rationale."
        >
          <Icons.Refresh size={12} /> Re-ingest
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {materials.length === 0 ? (
          <div style={{ padding: 18, color: 'var(--muted)', fontSize: 12.5 }}>
            No materials yet. Drop files below to seed the report.
          </div>
        ) : (
          materials.map((m, i) => (
            <div
              key={m.path}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr 80px 120px 30px',
                gap: 12,
                padding: '8px 14px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                alignItems: 'center',
              }}
            >
              <span style={{ color: 'var(--muted)' }}>{fileIcon(m.name)}</span>
              <span className="mono" style={{ fontSize: 12.5 }}>
                {m.name}
              </span>
              <span className="tiny mono" style={{ color: 'var(--muted)' }}>
                {formatSize(m.size)}
              </span>
              <span
                className="tiny mono"
                style={{ color: 'var(--muted)' }}
                title={formatLocal(m.mtime)}
              >
                {formatRelative(m.mtime)}
              </span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                {m.ingested ? (
                  <span title="Ingested" style={{ color: 'var(--success-text)' }}>
                    <Icons.Check size={13} />
                  </span>
                ) : (
                  <span title="New since last ingest" style={{ color: 'var(--warning-text)' }}>
                    <Icons.AlertTriangle size={13} />
                  </span>
                )}
              </span>
            </div>
          ))
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${over ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 8,
          padding: 24,
          textAlign: 'center',
          background: over ? 'var(--accent-soft)' : 'var(--bg-2)',
          color: 'var(--text-2)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <Icons.Sparkles size={22} />
        <strong>{uploading ? 'Uploading…' : 'Drop new materials here'}</strong>
        <span className="tiny">
          PDFs, markdown, URLs, screenshots, transcripts — anything contextual
        </span>
      </div>
    </div>
  );
};

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Reviews ─────────────────────────────────────────────────────────────────

export const ReviewsTab: React.FC<{
  review: FileRef | null;
  report: ResearchReportSummary;
}> = ({ review, report }) => {
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!review || !open || content != null) return;
    let cancelled = false;
    // Canonical entry fetch — `/api/vault/entry?path=…`. The prior code
    // here used a nonexistent `/api/entries/<path>` URL; fetch failed
    // silently and the tab fell back to the truncated 400-char preview.
    fetchEntry(review.path)
      .then((j) => {
        if (!cancelled && typeof j.content === 'string') setContent(j.content);
      })
      .catch(() => {
        /* network error — preview-fallback shows */
      });
    return () => {
      cancelled = true;
    };
  }, [review, open, content]);

  if (!review) {
    return (
      <REmpty
        title="No reviews yet"
        hint="Reviews appear when research-review runs against this revision."
        icon={<Icons.FileText size={28} />}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 0,
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          {open ? (
            <Icons.ChevronDown size={14} style={{ color: 'var(--muted)' }} />
          ) : (
            <Icons.ChevronRight size={14} style={{ color: 'var(--muted)' }} />
          )}
          <span style={{ fontWeight: 600 }}>Review of rev {report.report_revision ?? 1}</span>
          <span style={{ flex: 1 }} />
          {report.review_status === 'approved' ? (
            <span className="badge success">
              <Icons.Check size={11} /> Approved
            </span>
          ) : (
            <span className="badge warning">
              <Icons.AlertTriangle size={11} /> Request changes
            </span>
          )}
          <span
            className="tiny mono"
            style={{ color: 'var(--muted)' }}
            title={formatLocal(review.mtime)}
          >
            {formatRelative(review.mtime)}
          </span>
        </button>
        {open && (
          <div style={{ padding: '4px 22px 18px 42px', borderTop: '1px solid var(--border)' }}>
            {content == null ? (
              <pre
                className="mono"
                style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--text-2)' }}
              >
                {review.preview}
              </pre>
            ) : (
              <MarkdownBlock text={stripFrontmatter(content)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

// ── Updates ─────────────────────────────────────────────────────────────────

export const UpdatesTab: React.FC<{
  report: ResearchReportSummary;
  body: string | null;
  onRunUpdate: () => void;
}> = ({ report, body, onRunUpdate }) => {
  // Split the body on `## Update N` headings to render successive updates.
  const updates = extractUpdates(body);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <h3 className="h2" style={{ margin: 0 }}>
            Updates
          </h3>
          <div className="tiny" style={{ marginTop: 2, color: 'var(--muted)' }}>
            Successive research-update runs against this report.
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onRunUpdate}
          disabled={report.review_status !== 'approved'}
          title={
            report.review_status === 'approved'
              ? 'Dispatch research-update.'
              : 'Disabled — research-update only runs on approved reports.'
          }
        >
          <Icons.Refresh size={12} /> Run research-update
        </button>
      </div>
      {updates.length === 0 ? (
        <REmpty
          title="No updates yet"
          hint="This report hasn't been updated since approval."
          icon={<Icons.Sparkles size={28} />}
        />
      ) : (
        updates.map((u) => (
          <section key={u.n} className="card" style={{ padding: 0 }}>
            <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                className="badge"
                style={{
                  background: 'var(--accent-soft)',
                  border: '1px solid var(--accent-border)',
                  color: 'var(--accent-text)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <Icons.Sparkles size={11} /> Update {u.n}
              </span>
              {u.heading && <span style={{ fontSize: 13, fontWeight: 500 }}>{u.heading}</span>}
            </div>
            <div style={{ padding: '12px 16px' }}>
              <MarkdownBlock text={u.body} />
            </div>
          </section>
        ))
      )}
    </div>
  );
};

function extractUpdates(body: string | null): Array<{ n: number; heading: string; body: string }> {
  if (!body) return [];
  const updates: Array<{ n: number; heading: string; body: string }> = [];
  const re = /^##\s+Update\s+(\d+)\s*(?:[—-]\s*(.*))?$/gim;
  const matches: Array<{ idx: number; n: number; heading: string }> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-walk pattern
  while ((m = re.exec(body)) !== null) {
    matches.push({
      idx: m.index,
      n: Number.parseInt(m[1] ?? '0', 10),
      heading: (m[2] ?? '').trim(),
    });
  }
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : body.length;
    const lineEnd = body.indexOf('\n', start);
    const bodyText = body.slice(lineEnd + 1, end).trim();
    updates.push({ n: matches[i].n, heading: matches[i].heading, body: bodyText });
  }
  return updates;
}

// ── Replay ─────────────────────────────────────────────────────────────────

export const ReplayTab: React.FC<{ timeline: ReplayTimelineEntry[] }> = ({ timeline }) => {
  if (timeline.length === 0) {
    return (
      <REmpty
        title="No replay events yet"
        hint="Every event tagged to this report (runs, ingests, status transitions) lands here."
        icon={<Icons.Clock size={28} />}
      />
    );
  }
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h3 style={{ margin: 0, fontSize: 14 }}>Replay timeline</h3>
        <div className="tiny" style={{ color: 'var(--muted)' }}>
          Every event tagged to this report.
        </div>
      </div>
      <div style={{ padding: '8px 16px' }}>
        {timeline.map((entry) => {
          const ev = entry.event;
          const tone = replayTone(ev.skill, ev.action);
          return (
            <div
              key={ev.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                gap: 12,
                padding: '8px 0',
                borderBottom: '1px solid var(--border)',
                alignItems: 'baseline',
              }}
            >
              <span
                className="tiny mono"
                title={formatLocal(entry.ts)}
                style={{ color: 'var(--muted)' }}
              >
                {formatRelative(entry.ts)}
              </span>
              <span style={{ fontSize: 12.5 }}>
                <span style={{ color: tone, fontWeight: 500, marginRight: 6 }}>
                  {ev.skill ?? ev.action ?? 'event'}
                </span>
                <span className="tiny" style={{ color: 'var(--muted)' }}>
                  {ev.action ?? ''}
                </span>
              </span>
              <span className="tiny mono" style={{ color: 'var(--muted)' }}>
                {ev.cost_usd != null ? `$${ev.cost_usd.toFixed(4)}` : '—'}
                {ev.duration_ms != null ? ` · ${Math.round(ev.duration_ms / 1000)}s` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
};

function replayTone(skill: string | null, action: string | null): string {
  const s = (skill ?? action ?? '').toLowerCase();
  if (s.includes('review')) return 'var(--warning-text)';
  if (s.includes('approve') || s.includes('merge')) return 'var(--success-text)';
  if (s.includes('scaffold') || s.includes('change')) return 'var(--success-text)';
  return 'var(--accent-text)';
}

// ── Notes ─────────────────────────────────────────────────────────────────

function severityTone(s: NoteSeverity): { color: string; bg: string; label: string } {
  switch (s) {
    case 'blocker':
      return {
        color: 'var(--danger-text)',
        bg: 'var(--danger-bg, var(--bg-2))',
        label: 'blocker',
      };
    case 'warn':
      return { color: 'var(--warning-text)', bg: 'var(--warning-bg, var(--bg-2))', label: 'warn' };
    default:
      return { color: 'var(--accent-text)', bg: 'var(--bg-2)', label: 'info' };
  }
}

export const NotesTab: React.FC<{
  notes: NoteRef[];
  reportId: string;
  onAdded: () => void;
  toast: (msg: string) => void;
}> = ({ notes, reportId, onAdded, toast }) => {
  const [severity, setSeverity] = useState<NoteSeverity>('info');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/research/${encodeURIComponent(reportId)}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ severity, body: trimmed }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        toast(`Add note failed: ${j.error ?? 'unknown error'}`);
        return;
      }
      setBody('');
      setSeverity('info');
      onAdded();
    } catch (e) {
      toast(`Add note failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Add note</h3>
        <p className="tiny subtle" style={{ margin: 0, lineHeight: 1.5 }}>
          Notes are mid-lifecycle guidance for the research skills. <code>research-review</code>,{' '}
          <code>research-revise</code>, and <code>research-update</code> read unconsidered notes
          (those without a <code>considered_by</code> entry) at the start of each run and append to
          the considered_by list as they fold notes in. <strong>blocker</strong> severity = the
          skill must address or explain why it can't; <strong>warn</strong> = strong consideration;{' '}
          <strong>info</strong> = take into account.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as NoteSeverity)}
            disabled={busy}
            style={{ fontSize: 12 }}
          >
            {NOTE_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            placeholder="What should the next research skill run know?"
            style={{ flex: 1, minHeight: 60, fontSize: 13, padding: 6 }}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={busy || body.trim().length === 0}
          >
            <Icons.Plus size={11} /> Add note
          </button>
        </div>
      </section>

      {notes.length === 0 ? (
        <REmpty
          title="No notes yet"
          hint="Add guidance for the next research-review / -revise / -update run."
          icon={<Icons.Bell size={28} />}
        />
      ) : (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 style={{ margin: 0, fontSize: 14 }}>
              Notes <span className="subtle">({notes.length})</span>
            </h3>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {[...notes]
              .reverse() // newest-first reads better
              .map((n) => {
                const tone = severityTone(n.severity);
                const unconsidered = n.considered_by.length === 0;
                return (
                  <li
                    key={n.index}
                    style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: 6,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          color: tone.color,
                          background: tone.bg,
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                      >
                        {tone.label}
                      </span>
                      <span className="tiny subtle" title={n.ts}>
                        {formatRelative(n.ts)}
                      </span>
                      {unconsidered ? (
                        <span
                          className="tiny"
                          style={{
                            color: 'var(--warning-text)',
                            background: 'var(--warning-bg, var(--bg-2))',
                            padding: '2px 6px',
                            borderRadius: 3,
                            fontWeight: 500,
                          }}
                          title="No research skill has folded this note in yet."
                        >
                          unconsidered
                        </span>
                      ) : (
                        <span className="tiny subtle" title={n.considered_by.map((c) => `${c.skill} @ ${c.ts}`).join('\n')}>
                          considered by {n.considered_by.length} run
                          {n.considered_by.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                      {n.body}
                    </div>
                    {n.considered_by.length > 0 && (
                      <div className="tiny subtle" style={{ marginTop: 6 }}>
                        {n.considered_by.map((c, i) => (
                          <span key={i}>
                            {i > 0 ? ' · ' : ''}
                            {c.skill} <span title={c.ts}>({formatRelative(c.ts)})</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      )}
    </div>
  );
};
