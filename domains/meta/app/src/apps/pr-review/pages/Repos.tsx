// Repos — list, filter, add, remove, reindex.

import { useMemo, useState } from 'react';
import { Empty, Icons, LangDot, SharedModal, StatusBadge, Switch, Tooltip } from '../../../shared';
import type { Repo } from '../data';

export function Repos({
  repos,
  onAdd,
  onRemove,
  onReindex,
  onAnalyze,
  dispatching = false,
  pendingRepo = null,
  onShowOutput,
}: {
  repos: Repo[];
  onAdd: (r: Repo) => void;
  onRemove: (id: string) => void;
  onReindex: (id: string) => void;
  onAnalyze: (id: string) => void;
  // True when an ActionRunner is currently in-flight.
  dispatching?: boolean;
  // The repo currently being cached / analyzed (if a repo-skill dispatch is
  // in flight). When set, this row is decorated as "running" inline — either
  // overlaying an existing entry or as a synthetic row at the top — and the
  // normal action buttons are swapped for a single "View output" button.
  pendingRepo?: { owner: string; repo: string } | null;
  // Re-opens the ActionRunner modal (parent owns minimize state).
  onShowOutput?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const [confirm, setConfirm] = useState<Repo | null>(null);

  // Inject the in-flight dispatch as a table row so the user can see the run
  // without keeping a modal open. Two cases:
  //   1. A cached entry already exists for this <owner>/<repo> (re-index /
  //      re-analyze flow) — overlay the existing row with running state.
  //   2. No cached entry yet (first-time Add flow) — insert a synthetic row
  //      at the top with placeholder columns + running indicators.
  // The matching row's id is captured so the action-cell logic can swap the
  // normal buttons for a single "View output" button.
  const { augmented, pendingId } = useMemo(() => {
    if (!pendingRepo) return { augmented: repos, pendingId: null as string | null };
    const idx = repos.findIndex((r) => r.org === pendingRepo.owner && r.name === pendingRepo.repo);
    if (idx >= 0) {
      const copy = [...repos];
      copy[idx] = {
        ...copy[idx],
        status: 'indexing',
        knowledgeStatus: 'analyzing',
      };
      return { augmented: copy, pendingId: copy[idx].id };
    }
    const pendingRow: Repo = {
      id: `pending-${pendingRepo.owner}-${pendingRepo.repo}`,
      org: pendingRepo.owner,
      name: pendingRepo.repo,
      branch: '—',
      lang: 'unknown',
      files: 0,
      size: '—',
      indexed: 'now',
      status: 'indexing',
      reviews: 0,
      languages: [],
      analyzedAt: null,
      analyzerModel: null,
      knowledgeStatus: 'analyzing',
      knowledgeStale: false,
    };
    return { augmented: [pendingRow, ...repos], pendingId: pendingRow.id };
  }, [repos, pendingRepo]);

  const filtered = augmented.filter(
    (r) => !filter || `${r.name} ${r.org}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div>
          <h1 className="h1">Repos</h1>
          <div className="subtle" style={{ marginTop: 2 }}>
            Repos indexed locally so agents can pull context during review.
          </div>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setAdding(true)}
          disabled={dispatching}
          title={dispatching ? 'Run in progress — try again when it finishes' : undefined}
        >
          <Icons.Plus size={14} /> Add repo
        </button>
      </div>

      <div className="filter-row">
        <div className="search-wrap">
          <Icons.Search size={14} />
          <input
            className="input"
            placeholder="Filter repos…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <span className="spacer" />
        <div className="tiny">
          {repos.length} repos · {repos.reduce((s, r) => s + r.reviews, 0)} reviews total
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Repository</th>
              <th style={{ width: 130 }}>Default branch</th>
              <th style={{ width: 140 }}>Languages</th>
              <th style={{ width: 110 }}>Files</th>
              <th style={{ width: 130 }}>Last indexed</th>
              <th style={{ width: 150 }}>Cache</th>
              <th style={{ width: 140 }}>Knowledge</th>
              <th style={{ width: 90 }}>Reviews</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="repo-icon">
                      <LangDot lang={r.lang} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 500 }}>{r.name}</div>
                      <div className="tiny mono">
                        {r.org}/{r.name}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="mono" style={{ color: 'var(--text-2)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Icons.GitBranch size={13} style={{ color: 'var(--muted)' }} /> {r.branch}
                  </span>
                </td>
                <td>
                  <LangBar langs={r.languages} />
                </td>
                <td className="mono" style={{ color: 'var(--text-2)' }}>
                  {r.files.toLocaleString()}
                </td>
                <td className="mono" style={{ color: 'var(--muted)' }}>
                  {r.indexed}
                </td>
                <td>
                  {r.status === 'indexing' ? (
                    <div style={{ minWidth: 130 }}>
                      <StatusBadge status="indexing" />
                      <div className="progress running" style={{ marginTop: 6 }}>
                        <i style={{ width: `${r.progress ?? 50}%` }} />
                      </div>
                    </div>
                  ) : r.status === 'error' ? (
                    <div>
                      <StatusBadge status="error" />
                      <div className="tiny" style={{ marginTop: 3, color: 'var(--danger-text)' }}>
                        {r.error}
                      </div>
                    </div>
                  ) : (
                    <StatusBadge status={r.status} />
                  )}
                </td>
                <td>
                  <KnowledgeBadge repo={r} />
                </td>
                <td className="mono">{r.reviews}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    {pendingRepo && r.org === pendingRepo.owner && r.name === pendingRepo.repo ? (
                      <Tooltip tip="View output — open the streaming runner modal">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => onShowOutput?.()}
                          style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                        >
                          View output
                        </button>
                      </Tooltip>
                    ) : (
                      <>
                        <Tooltip
                          tip={
                            dispatching
                              ? 'Run in progress — finish that first'
                              : 'Re-index — git fetch + reset to latest origin/HEAD'
                          }
                        >
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => onReindex(r.id)}
                            disabled={dispatching}
                          >
                            <Icons.Refresh size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip
                          tip={
                            dispatching
                              ? 'Run in progress — finish that first'
                              : r.knowledgeStatus === 'missing'
                                ? 'Analyze — build the review-time knowledge doc'
                                : 'Re-analyze — rebuild conventions doc from current code'
                          }
                        >
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => onAnalyze(r.id)}
                            disabled={dispatching}
                          >
                            <Icons.Sparkles size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip tip="Remove — wipe cache dir + vault entries">
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => setConfirm(r)}
                            disabled={dispatching}
                          >
                            <Icons.Trash size={14} />
                          </button>
                        </Tooltip>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <Empty
            title="No repos match"
            hint="Try clearing the filter."
            icon={<Icons.Repo size={28} />}
          />
        )}
      </div>

      {adding && (
        <AddRepoModal
          onClose={() => setAdding(false)}
          onAdd={(repo) => {
            onAdd(repo);
            setAdding(false);
          }}
        />
      )}

      {confirm && (
        <SharedModal
          title="Remove repo?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  onRemove(confirm.id);
                  setConfirm(null);
                }}
              >
                <Icons.Trash size={13} /> Remove repo
              </button>
            </>
          }
        >
          <div style={{ marginBottom: 10 }}>
            Removing{' '}
            <strong>
              {confirm.org}/{confirm.name}
            </strong>{' '}
            will delete its local index and prevent agents from using it as context. Existing
            reviews remain readable.
          </div>
          <div className="tiny">This does not affect the remote repo.</div>
        </SharedModal>
      )}
    </div>
  );
}

function KnowledgeBadge({ repo }: { repo: Repo }) {
  const status = repo.knowledgeStatus ?? 'missing';
  if (status === 'missing') {
    return (
      <span className="tiny" style={{ color: 'var(--muted)' }}>
        Not analyzed
      </span>
    );
  }
  if (status === 'analyzing') {
    return (
      <div style={{ minWidth: 120 }}>
        <span className="tiny" style={{ color: 'var(--accent)' }}>
          Analyzing…
        </span>
        <div className="progress running" style={{ marginTop: 6 }}>
          <i style={{ width: '40%' }} />
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <span className="tiny" style={{ color: 'var(--danger-text)' }}>
        Analysis errored
      </span>
    );
  }
  // ready — show relative time + stale badge if drift detected
  const stale = repo.knowledgeStale === true;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="tiny mono" style={{ color: stale ? 'var(--warn-text)' : 'var(--text-2)' }}>
        {relativeTimeFromIso(repo.analyzedAt)}
      </span>
      {stale && (
        <span className="tiny" style={{ color: 'var(--warn-text)' }}>
          stale · re-analyze
        </span>
      )}
    </div>
  );
}

function relativeTimeFromIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function LangBar({ langs }: { langs: Array<[string, number]> }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          height: 6,
          borderRadius: 3,
          overflow: 'hidden',
          background: 'var(--panel-3)',
          minWidth: 110,
        }}
      >
        {langs.map(([l, pct]) => (
          <i
            key={`${l}-${pct}`}
            className={`lang-${l}`}
            title={`${l} ${pct}%`}
            style={{ background: langColor(l), width: `${pct}%` }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>
        {langs.slice(0, 2).map(([l]) => (
          <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <i
              style={{
                background: langColor(l),
                width: 6,
                height: 6,
                borderRadius: 999,
                display: 'inline-block',
              }}
            />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

function langColor(l: string): string {
  return (
    (
      {
        ts: '#3178c6',
        js: '#f7df1e',
        py: '#3776ab',
        go: '#00add8',
        rs: '#dea584',
        swift: '#f05138',
        css: '#a855f7',
        proto: '#6b7280',
        toml: '#9a6324',
        sh: '#89e051',
      } as Record<string, string>
    )[l] || '#71717a'
  );
}

function AddRepoModal({ onClose, onAdd }: { onClose: () => void; onAdd: (r: Repo) => void }) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [includePrivate, setIncludePrivate] = useState(true);

  function submit() {
    if (!url.trim()) return;
    const m = url.match(/[:/]([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
    const org = m?.[1] || 'acme';
    const name = (m?.[2] || url).replace(/\.git$/, '');
    onAdd({
      id: `r${Math.random().toString(36).slice(2, 7)}`,
      org,
      name,
      branch,
      lang: 'ts',
      files: 0,
      size: '—',
      indexed: 'queued',
      status: 'indexing',
      reviews: 0,
      progress: 4,
      languages: [['ts', 100]],
      analyzedAt: null,
      analyzerModel: null,
      knowledgeStatus: 'missing',
      knowledgeStale: false,
    });
  }

  return (
    <SharedModal
      title="Add repository"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!url.trim()}>
            <Icons.Plus size={13} /> Add &amp; ingest
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Repository URL" hint="HTTPS or SSH. We'll clone shallow + index locally.">
          <input
            className="input mono"
            placeholder="git@github.com:acme/new-service.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Default branch">
          <input
            className="input mono"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </Field>
        <div
          className="hstack"
          style={{
            padding: '10px 0',
            borderTop: '1px solid var(--border)',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontWeight: 500, fontSize: 13.5 }}>Include private files</div>
            <div className="tiny">
              Index .env.example, build configs, and other private-by-default files.
            </div>
          </div>
          <Switch on={includePrivate} onChange={setIncludePrivate} />
        </div>
        <div
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 12.5,
            color: 'var(--muted)',
          }}
        >
          <Icons.Database size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          Ingestion typically takes 1–4 minutes depending on repo size.
        </div>
      </div>
    </SharedModal>
  );
}

export function Field({
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
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && (
        <div className="tiny" style={{ marginTop: 4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
