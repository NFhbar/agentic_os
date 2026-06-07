// DecisionsPanel — Phase 4.1. Lists every Phase 4 decision (i.e. has
// implements_tuning_suggestions populated) with inline accept + apply
// controls so the user doesn't have to fish in the Vault. Sits on the
// Overseer Overview tab as a peer of "Top recurring tuning suggestions."
//
// Data source: GET /api/decisions (server-side: walks vault/wiki/meta/decision/).
// Action flows:
//   - Accept → surgical frontmatter edit via /api/edit (same as DecisionActions in Vault)
//   - Apply  → startSkillRun via useDispatch, drawer opens, run streams there
//   - Click  → navigate to /vault/entries/<decision-id> for the full body view

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getJson } from '../../lib/api';
import { useDispatch } from '../../lib/dispatch';
import { formatRelative } from '../../lib/time';
import { Icons } from '../../shared';

interface ImplementsRef {
  audit_id: string;
  suggestion_index: number;
}

interface TargetMetric {
  type: string;
  name: string;
  baseline: number;
  target: number;
  scope: string;
  window_audits: number;
}

interface DecisionSummary {
  id: string;
  path: string;
  title: string;
  status: string;
  validation_result: 'pending' | 'validated' | 'regressed' | 'inconclusive' | null;
  implements_tuning_suggestions: ImplementsRef[];
  target_metric: TargetMetric | null;
  validation_observations_count: number;
  validation_window: number | null;
  applied_at: string | null;
  created: string | null;
  updated: string | null;
}

function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === 'accepted') {
    return {
      background: 'var(--accent-bg, rgba(80,160,250,0.12))',
      color: 'var(--accent-text, #5aa0fa)',
      border: '1px solid var(--accent-border, rgba(80,160,250,0.35))',
    };
  }
  if (status === 'validated') {
    return {
      background: 'var(--success-bg, rgba(80,200,120,0.12))',
      color: 'var(--success-text, #4caf80)',
      border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
    };
  }
  if (status === 'regressed' || status === 'deprecated') {
    return {
      background: 'var(--danger-bg, rgba(250,80,80,0.1))',
      color: 'var(--danger-text, #e05050)',
      border: '1px solid var(--danger-border, rgba(250,80,80,0.4))',
    };
  }
  // proposed (default)
  return {
    background: 'var(--warning-bg, rgba(250,200,80,0.1))',
    color: 'var(--warning-text, #e0a02a)',
    border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
  };
}

export function DecisionsPanel() {
  const navigate = useNavigate();
  const [decisions, setDecisions] = useState<DecisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getJson<{ decisions: DecisionSummary[] }>('/api/decisions')
      .then((d) => setDecisions(d.decisions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Decisions
        </h3>
        <div style={{ color: 'var(--danger-text)' }}>Failed to load: {error}</div>
      </section>
    );
  }
  if (!decisions) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Decisions
        </h3>
        <div className="subtle">Loading…</div>
      </section>
    );
  }
  if (decisions.length === 0) {
    return null; // empty state suppressed — no decisions yet means no panel
  }

  const proposedCount = decisions.filter((d) => d.status === 'proposed').length;

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <div>
          <h3 className="card-title">Decisions</h3>
          <span className="tiny subtle">
            Phase 4 skill-tuning decisions — accept + apply directly from here.
          </span>
        </div>
        {proposedCount > 0 && (
          <span
            className="badge"
            style={{
              fontSize: 11,
              background: 'var(--warning-bg, rgba(250,200,80,0.1))',
              color: 'var(--warning-text, #e0a02a)',
              border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
            }}
            title="Decisions awaiting your action — flip status: proposed → accepted, then Apply"
          >
            {proposedCount} proposed
          </span>
        )}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {decisions.map((d) => (
          <DecisionRow key={d.id} decision={d} onChanged={refresh} navigate={navigate} />
        ))}
      </ul>
    </section>
  );
}

function DecisionRow({
  decision: d,
  onChanged,
  navigate,
}: {
  decision: DecisionSummary;
  onChanged: () => void;
  navigate: (path: string) => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowToast, setRowToast] = useState<string | null>(null);
  const { startSkillRun } = useDispatch();

  const canAccept = d.status === 'proposed';
  const canApply = d.status === 'accepted' && d.implements_tuning_suggestions.length > 0;
  const alreadyApplied = canApply && !!d.applied_at;

  async function accept() {
    if (!canAccept || accepting) return;
    setAccepting(true);
    setRowError(null);
    try {
      // Fetch current file content, flip status, write back. Same pattern
      // as DecisionActions in the Vault — duplicated rather than shared so
      // each surface keeps its own state-machine clean.
      const fetchR = await fetch(`/api/vault/entry?path=${encodeURIComponent(d.path)}`);
      if (!fetchR.ok) throw new Error(`vault fetch: HTTP ${fetchR.status}`);
      const { content } = (await fetchR.json()) as { content: string };
      const newContent = content.replace(/^status:\s*.+$/m, 'status: accepted');
      if (newContent === content) throw new Error('no status: line found');
      const r = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: d.path, content: newContent }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `edit: HTTP ${r.status}`);
      }
      setRowToast('Accepted');
      onChanged();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccepting(false);
    }
  }

  async function apply() {
    if (!canApply || applying) return;
    const target = d.implements_tuning_suggestions[0];
    setApplying(true);
    setRowError(null);
    setRowToast(null);
    try {
      const prompt =
        `/os apply tuning suggestion audit=${target.audit_id} ` +
        `suggestion_index=${target.suggestion_index} mode=apply ` +
        `decision_entry_path=${d.path}`;
      const result = await startSkillRun(prompt, `Apply: ${d.title.slice(0, 60)}`, {
        skill: 'meta-apply-tuning-suggestion',
      });
      if ('error' in result && result.error) throw new Error(result.error);
      if ('blocked' in result && result.blocked) {
        throw new Error('Apply blocked — another run holds the lock');
      }
      if ('run_id' in result && result.run_id) {
        setRowToast(`Run ${result.run_id.slice(0, 10)}… — watching in drawer`);
      }
    } catch (e) {
      setRowError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <li
      style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="badge" style={{ fontSize: 11, ...statusBadgeStyle(d.status) }}>
          {d.status}
        </span>
        {d.validation_result && d.validation_result !== 'pending' && (
          <span className="badge muted" style={{ fontSize: 10 }}>
            validation: {d.validation_result}
          </span>
        )}
        {alreadyApplied && d.applied_at && (
          <span
            className="badge"
            style={{
              fontSize: 10,
              background: 'var(--success-bg, rgba(80,200,120,0.12))',
              color: 'var(--success-text, #4caf80)',
              border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
            }}
            title={`Applied at ${new Date(d.applied_at).toLocaleString()}`}
          >
            ✓ applied {formatRelative(d.applied_at)}
          </span>
        )}
        <button
          type="button"
          onClick={() => navigate(`/vault/entries/${d.id}`)}
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: 0,
            font: 'inherit',
            fontWeight: 500,
            fontSize: 13,
            textAlign: 'left',
            flex: 1,
            minWidth: 0,
          }}
          title="Open the full decision body in the Vault"
        >
          {d.title}
        </button>
        {canAccept && (
          <button type="button" className="btn btn-sm" onClick={accept} disabled={accepting}>
            {accepting ? '…' : 'Accept'}
          </button>
        )}
        {canApply && (
          <button
            type="button"
            className={alreadyApplied ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
            onClick={apply}
            disabled={applying}
            title={
              alreadyApplied
                ? 'Already applied — click to re-run (idempotent: the skill no-ops if the file already contains the proposed text).'
                : 'Start an apply run — opens the runs drawer to watch progress.'
            }
          >
            <Icons.Send size={11} /> {applying ? '…' : alreadyApplied ? 'Re-apply' : 'Apply'}
          </button>
        )}
      </div>
      <div className="tiny subtle" style={{ fontSize: 11, lineHeight: 1.5 }}>
        implements {d.implements_tuning_suggestions.length} suggestion
        {d.implements_tuning_suggestions.length !== 1 ? 's' : ''}
        {d.target_metric && (
          <>
            {' · '}metric:{' '}
            <code className="mono" style={{ fontSize: 11 }}>
              {d.target_metric.name}
            </code>
            {' · '}
            {d.validation_observations_count} / {d.target_metric.window_audits} qualifying audit
            {d.target_metric.window_audits !== 1 ? 's' : ''} observed
          </>
        )}
      </div>
      {rowError && (
        <div
          className="tiny"
          style={{
            color: 'var(--danger-text)',
            fontSize: 11,
            padding: '2px 0',
          }}
        >
          ✗ {rowError}
        </div>
      )}
      {rowToast && !rowError && (
        <div
          className="tiny"
          style={{
            color: 'var(--accent-text)',
            fontSize: 11,
            padding: '2px 0',
          }}
        >
          ✓ {rowToast}
        </div>
      )}
    </li>
  );
}
