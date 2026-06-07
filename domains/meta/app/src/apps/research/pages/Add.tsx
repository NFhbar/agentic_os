// Research → Add page. Replaces the prior AddResearchReportModal with a
// dedicated route at /research/new so the form gets real estate, can show
// context alongside the inputs, and avoids the modal-edge-case bug class
// (textarea resize drag, focus jumps, narrow viewport, etc).
//
// Reached two ways:
//   - From the Research list page's "+ Add research report" button (no
//     pre-selection)
//   - From a Project page's "Add research report" button as
//     /research/new?project=<id> (project pre-selected)
//
// On dispatch, navigates back to /research with a toast — same UX as the
// prior modal-confirm flow.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from '../../../shared';
import type { StagedFile } from '../components';

interface ProjectChip {
  id: string;
  name: string;
}

export interface AddPageProps {
  projects: ProjectChip[];
  // Called when the user submits a valid form. Caller handles the API call,
  // toast, and navigation back to /research.
  onSubmit: (args: {
    project: string;
    report_topic: string;
    notes: string;
    materials: { urls: string[]; wikilinks: string[]; files: StagedFile[] };
  }) => void;
  onCancel: () => void;
  // Toast surface for the page's own warnings (file staging issues, etc).
  toast: (msg: string) => void;
}

export function AddPage({ projects, onSubmit, onCancel, toast }: AddPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // `?project=<id>` pre-selects when present + valid. Stale or unknown ids
  // fall back to the first project alphabetically (same as the prior modal).
  const initialProject = useMemo(() => {
    const fromUrl = searchParams.get('project');
    if (fromUrl && projects.some((p) => p.id === fromUrl)) return fromUrl;
    return projects[0]?.id ?? '';
  }, [searchParams, projects]);

  const [project, setProject] = useState(initialProject);
  const [reportTopic, setReportTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [urlsText, setUrlsText] = useState('');
  const [wikilinksText, setWikilinksText] = useState('');
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Update selected project if the URL changes (e.g. user picks a different
  // project from a deep-link in another tab and navigates here). Only runs
  // when initialProject derivation produces a *different* result.
  useEffect(() => {
    if (initialProject && initialProject !== project && !reportTopic) {
      setProject(initialProject);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProject]);

  const materialsPath = useMemo(() => {
    if (!project || !reportTopic) return '';
    return `vault/raw/project-research/${project}/${reportTopic}/`;
  }, [project, reportTopic]);

  const slugSafe = useMemo(() => /^[a-z0-9][a-z0-9-]*$/.test(reportTopic), [reportTopic]);
  const fullReportId = useMemo(
    () => (project && slugSafe ? `${project}-${reportTopic}` : ''),
    [project, reportTopic, slugSafe],
  );

  function submit() {
    if (submitting) return;
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
    setError(null);
    setSubmitting(true);
    const urls = urlsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const wikilinks = wikilinksText
      .split('\n')
      .map((s) => s.trim().replace(/^\[\[|\]\]$/g, ''))
      .filter(Boolean);
    onSubmit({
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
      toast(`File staging issues: ${errors.join('; ')}`);
    }
  }

  function removeStagedFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  // Form is invalid when required fields are missing/malformed. Disables
  // the submit button so users don't burn a click on an error toast.
  const submitDisabled = !project || !reportTopic || !slugSafe || submitting;

  return (
    <div className="page page-wide">
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            onCancel();
            navigate('/research');
          }}
        >
          <Icons.ArrowRight size={11} style={{ transform: 'rotate(180deg)' }} /> Back
        </button>
        <div>
          <h1 className="h1" style={{ marginBottom: 2 }}>
            Add research report
          </h1>
          <div className="tiny subtle">
            Captures materials + dispatches <code className="mono">research-write</code> to author
            the report.
          </div>
        </div>
      </header>

      {/* Two-column layout — form on the left, context preview on the right.
          On narrow viewports falls back to single column via auto-fit. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)',
          gap: 20,
          alignItems: 'start',
        }}
      >
        {/* Form column */}
        <main style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Identity section */}
          <section className="card" style={{ padding: 16 }}>
            <h3 className="card-title" style={{ marginBottom: 12 }}>
              Identity
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Project" required>
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
                required
                hint="Slug-safe (lowercase, alphanumeric, hyphens). Full id = <project>-<topic>."
              >
                <input
                  type="text"
                  value={reportTopic}
                  onChange={(e) => setReportTopic(e.target.value)}
                  placeholder="e.g. retry-backoff-survey"
                  style={{ width: '100%', padding: '6px 10px', fontSize: 13 }}
                />
              </Field>
            </div>
          </section>

          {/* Materials section */}
          <section className="card" style={{ padding: 16 }}>
            <h3 className="card-title" style={{ marginBottom: 12 }}>
              Materials
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field
                label="URLs (one per line)"
                hint="Enqueued for ingest under the materials path on dispatch."
              >
                <textarea
                  rows={5}
                  value={urlsText}
                  onChange={(e) => setUrlsText(e.target.value)}
                  placeholder="https://…"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 12.5,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  }}
                />
              </Field>
              <Field
                label="Existing wiki entries (one per line)"
                hint="Vault entry ids — e.g. note/retry-strategies. Brackets optional."
              >
                <textarea
                  rows={3}
                  value={wikilinksText}
                  onChange={(e) => setWikilinksText(e.target.value)}
                  placeholder="note/retry-strategies"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 12.5,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  }}
                />
              </Field>
              <Field
                label="Files"
                hint="Drag-drop or pick. PDFs, markdown, text. Max 5 MB each. Uploads to the materials path on dispatch."
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
                    padding: '20px 12px',
                    border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--border)'}`,
                    background: dragOver ? 'var(--accent-soft)' : 'var(--bg-2)',
                    borderRadius: 6,
                    textAlign: 'center',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                >
                  <p className="tiny subtle" style={{ margin: '0 0 8px' }}>
                    Drag files here, or
                  </p>
                  <label
                    className="btn btn-sm"
                    style={{ cursor: 'pointer', display: 'inline-flex' }}
                  >
                    <Icons.Plus size={11} /> Choose files
                    <input
                      type="file"
                      multiple
                      onChange={(e) => {
                        void ingestBrowserFiles(e.target.files);
                        e.target.value = '';
                      }}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
                {stagedFiles.length > 0 && (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: '10px 0 0',
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
                          padding: '6px 10px',
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
                          aria-label={`Remove ${f.filename}`}
                        >
                          <Icons.X size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
            </div>
          </section>

          {/* Notes section */}
          <section className="card" style={{ padding: 16 }}>
            <h3 className="card-title" style={{ marginBottom: 12 }}>
              Notes for the writer
            </h3>
            <Field
              label=""
              hint="Optional context the research-write skill should know about framing, scope, or constraints."
            >
              <textarea
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the writer should know about the framing…"
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
              />
            </Field>
          </section>

          {/* Error banner — inline above actions when validation fails */}
          {error && (
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--danger-soft, rgba(250,80,80,0.1))',
                color: 'var(--danger-text)',
                border: '1px solid var(--danger-border, rgba(250,80,80,0.4))',
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          {/* Action row */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              paddingTop: 4,
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={() => {
                onCancel();
                navigate('/research');
              }}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={submitDisabled}
            >
              <Icons.Send size={12} />
              {submitting ? 'Dispatching…' : 'Dispatch research-write'}
            </button>
          </div>
        </main>

        {/* Context column — sticky preview of what dispatch will produce */}
        <aside style={{ position: 'sticky', top: 24 }}>
          <section className="card" style={{ padding: 16 }}>
            <h3 className="card-title" style={{ marginBottom: 12 }}>
              Preview
            </h3>
            <div
              className="tiny subtle"
              style={{
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                marginBottom: 4,
              }}
            >
              Report id
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                padding: '6px 8px',
                background: 'var(--bg-2)',
                borderRadius: 4,
                marginBottom: 14,
                color: fullReportId ? 'var(--text)' : 'var(--text-3)',
                wordBreak: 'break-all',
              }}
            >
              {fullReportId || '<project>-<report_topic>'}
            </div>

            <div
              className="tiny subtle"
              style={{
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                marginBottom: 4,
              }}
            >
              Materials path
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                padding: '6px 8px',
                background: 'var(--bg-2)',
                borderRadius: 4,
                marginBottom: 14,
                color: materialsPath ? 'var(--text)' : 'var(--text-3)',
                wordBreak: 'break-all',
              }}
            >
              {materialsPath || 'vault/raw/project-research/<project>/<report_topic>/'}
            </div>

            <div
              className="tiny subtle"
              style={{
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                marginBottom: 6,
              }}
            >
              Will dispatch
            </div>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <li>
                <code className="mono">research-write</code> against the named project
              </li>
              {stagedFiles.length > 0 && (
                <li>
                  Uploads <strong>{stagedFiles.length}</strong> file
                  {stagedFiles.length !== 1 ? 's' : ''} (
                  {Math.ceil(stagedFiles.reduce((a, f) => a + f.size, 0) / 1024)} KB total)
                </li>
              )}
              {urlsText.trim() && (
                <li>
                  Enqueues <strong>{urlsText.split('\n').filter((s) => s.trim()).length}</strong>{' '}
                  URL
                  {urlsText.split('\n').filter((s) => s.trim()).length !== 1 ? 's' : ''} for ingest
                </li>
              )}
              {wikilinksText.trim() && (
                <li>
                  Includes{' '}
                  <strong>{wikilinksText.split('\n').filter((s) => s.trim()).length}</strong>{' '}
                  existing wiki entr
                  {wikilinksText.split('\n').filter((s) => s.trim()).length !== 1 ? 'ies' : 'y'}
                </li>
              )}
              {notes.trim() && (
                <li>
                  Passes <strong>{notes.trim().length}</strong> char
                  {notes.trim().length !== 1 ? 's' : ''} of context notes to the writer
                </li>
              )}
            </ul>

            <div
              className="tiny subtle"
              style={{
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              The dispatched run lands as a research-report entry at{' '}
              <code className="mono">vault/wiki/research/research-report/</code>. It then enters the
              review lifecycle — `dev-review-change` peer-reviews it before any recommendations fan
              out into changes.
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

// Lightweight form field wrapper — mirrors the modal's Field component but
// scoped to this page (no need to export). Renders the label, optional hint,
// and the children input.
function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label && (
        <label
          className="tiny"
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: 'var(--text-2)',
          }}
        >
          {label}
          {required && <span style={{ color: 'var(--danger-text)', marginLeft: 4 }}>*</span>}
        </label>
      )}
      {children}
      {hint && (
        <div className="tiny subtle" style={{ fontSize: 11, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
