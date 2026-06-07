// PendingSuggestionsPanel — Phase 4.1 enhancement. Cross-audit roll-up of
// tuning suggestions that haven't been actioned yet (no decision cites them,
// no proposal file exists, no dismissal recorded). Sits on the Overseer
// Overview alongside the Decisions panel — the two surfaces have distinct
// lifecycle stages: this one is "needs authoring," that one is "needs
// accept/apply."
//
// Sort: most-recurring first, then high → medium → low confidence. Single-
// instance high-confidence suggestions surface above single-instance low-
// confidence noise.
//
// Actions per row: Propose (starts a tracked run in the drawer), Promote
// (vault-scaffold + open in vault), Dismiss (rationale textarea inline). All
// three call the existing /api/tuning-suggestions/* endpoints; on success
// the row disappears from the panel (filter excludes the now-actioned
// suggestion).

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getJson, postJson } from '../../lib/api';
import { useDispatch } from '../../lib/dispatch';
import { Icons } from '../../shared';

interface PendingSuggestion {
  audit_id: string;
  audit_completed_at: string | null;
  suggestion_index: number;
  skill: string;
  suggestion: string;
  confidence: 'low' | 'medium' | 'high' | string;
  evidence_summary: string;
  target_change: string;
  recurrence_count: number;
}

function confidenceBadgeStyle(c: string): React.CSSProperties {
  if (c === 'high') {
    return {
      background: 'var(--accent-bg, rgba(80,160,250,0.12))',
      color: 'var(--accent-text, #5aa0fa)',
      border: '1px solid var(--accent-border, rgba(80,160,250,0.35))',
    };
  }
  if (c === 'medium') {
    return {
      background: 'var(--warning-bg, rgba(250,200,80,0.1))',
      color: 'var(--warning-text, #e0a02a)',
      border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
    };
  }
  return {
    background: 'var(--bg-2, rgba(255,255,255,0.04))',
    color: 'var(--text-3)',
    border: '1px solid var(--border)',
  };
}

export function PendingSuggestionsPanel() {
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getJson<{ pending: PendingSuggestion[] }>('/api/tuning-suggestions/pending')
      .then((d) => setPending(d.pending))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Pending suggestions
        </h3>
        <div style={{ color: 'var(--danger-text)' }}>Failed to load: {error}</div>
      </section>
    );
  }
  if (!pending) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Pending suggestions
        </h3>
        <div className="subtle">Loading…</div>
      </section>
    );
  }
  if (pending.length === 0) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>
          Pending suggestions
        </h3>
        <div className="subtle">
          Inbox zero. Every tuning suggestion in the audit corpus has been promoted, proposed, or
          dismissed.
        </div>
      </section>
    );
  }

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <div>
          <h3 className="card-title">Pending suggestions</h3>
          <span className="tiny subtle">
            Tuning suggestions across audits that haven&apos;t been actioned (no decision, no
            proposal, no dismissal). Sorted by recurrence + confidence.
          </span>
        </div>
        <span className="badge muted" style={{ fontSize: 11 }}>
          {pending.length} pending
        </span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {pending.map((s) => (
          <PendingRow
            key={`${s.audit_id}::${s.suggestion_index}`}
            suggestion={s}
            onChanged={refresh}
            navigate={navigate}
          />
        ))}
      </ul>
    </section>
  );
}

function PendingRow({
  suggestion: s,
  onChanged,
  navigate,
}: {
  suggestion: PendingSuggestion;
  onChanged: () => void;
  navigate: (path: string) => void;
}) {
  const [proposing, setProposing] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissRationale, setDismissRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { startSkillRun } = useDispatch();

  const isWeak = s.confidence === 'low' && s.recurrence_count === 1;

  async function propose() {
    if (proposing) return;
    setProposing(true);
    setError(null);
    setToast(null);
    try {
      const prompt =
        `/os apply tuning suggestion audit=${s.audit_id} ` +
        `suggestion_index=${s.suggestion_index} mode=propose`;
      const result = await startSkillRun(prompt, `Propose: ${s.suggestion.slice(0, 50)}`, {
        skill: 'meta-apply-tuning-suggestion',
      });
      if ('error' in result && result.error) throw new Error(result.error);
      if ('blocked' in result && result.blocked) throw new Error('Propose blocked');
      if ('run_id' in result && result.run_id) {
        setToast(`Run ${result.run_id.slice(0, 10)}… — drawer open`);
        // Re-check after a delay; the row should disappear once the proposal
        // file lands in vault/output/meta/tuning-proposals/.
        setTimeout(onChanged, 4000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
    }
  }

  async function promote() {
    if (promoting) return;
    setPromoting(true);
    setError(null);
    setToast(null);
    try {
      const r = await postJson<{
        ok: boolean;
        decision_id?: string;
        decision_path?: string;
        error?: string;
        existing_path?: string;
      }>('/api/tuning-suggestions/promote', {
        audit_id: s.audit_id,
        suggestion_index: s.suggestion_index,
      });
      if (!r.ok) {
        throw new Error(r.error ?? 'promote failed');
      }
      if (r.decision_id) {
        setToast(`Decision scaffolded — opening in Vault`);
        setTimeout(() => navigate(`/vault/entries/${r.decision_id}`), 600);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPromoting(false);
    }
  }

  async function dismiss() {
    if (dismissing) return;
    setDismissing(true);
    setError(null);
    setToast(null);
    try {
      const r = await postJson<{ ok: boolean; error?: string }>(
        '/api/tuning-suggestions/dismiss',
        {
          audit_id: s.audit_id,
          suggestion_index: s.suggestion_index,
          rationale: dismissRationale || null,
        },
      );
      if (!r.ok) throw new Error(r.error ?? 'dismiss failed');
      setDismissOpen(false);
      setDismissRationale('');
      setToast('Dismissed');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDismissing(false);
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
        <span className="badge" style={{ fontSize: 11, ...confidenceBadgeStyle(s.confidence) }}>
          {s.confidence}
        </span>
        {s.recurrence_count > 1 && (
          <span
            className="badge"
            style={{
              fontSize: 11,
              background: 'var(--accent-bg, rgba(80,160,250,0.18))',
              color: 'var(--accent-text)',
              border: '1px solid var(--accent-border)',
            }}
            title={`Same suggestion appears in ${s.recurrence_count} audits — strong pattern`}
          >
            {s.recurrence_count}×
          </span>
        )}
        <code className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
          {s.skill}
        </code>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={propose} disabled={proposing}>
          {proposing ? '…' : 'Propose'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={promote}
          disabled={promoting}
        >
          <Icons.Plus size={11} /> {promoting ? '…' : 'Promote'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setDismissOpen((v) => !v)}
        >
          Dismiss
        </button>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        {s.suggestion.length > 280 ? `${s.suggestion.slice(0, 280)}…` : s.suggestion}
      </div>
      <div className="tiny subtle" style={{ fontSize: 11 }}>
        ← from{' '}
        <button
          type="button"
          onClick={() => navigate(`/overseer/audits/${s.audit_id}`)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent-text)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            padding: 0,
          }}
        >
          {s.audit_id}
        </button>{' '}
        · suggestion #{s.suggestion_index}
        {isWeak && (
          <span style={{ color: 'var(--warning-text)', marginLeft: 10 }}>
            ⚠ single-instance, low confidence — consider waiting for corroboration
          </span>
        )}
      </div>

      {dismissOpen && (
        <div
          style={{
            marginTop: 6,
            padding: 10,
            background: 'var(--bg-2)',
            borderRadius: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <label className="tiny subtle" style={{ fontSize: 11 }}>
            Why dismiss? (optional but recommended)
          </label>
          <textarea
            value={dismissRationale}
            onChange={(e) => setDismissRationale(e.target.value)}
            rows={2}
            placeholder="e.g. Already shipped as task #428. Or: single instance, low value — defer."
            style={{
              width: '100%',
              padding: 6,
              fontFamily: 'inherit',
              fontSize: 12,
              border: '1px solid var(--border)',
              borderRadius: 3,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDismissOpen(false);
                setDismissRationale('');
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={dismiss}
              disabled={dismissing}
            >
              {dismissing ? 'Dismissing…' : 'Confirm dismiss'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="tiny" style={{ color: 'var(--danger-text)', fontSize: 11 }}>
          ✗ {error}
        </div>
      )}
      {toast && !error && (
        <div className="tiny" style={{ color: 'var(--accent-text)', fontSize: 11 }}>
          ✓ {toast}
        </div>
      )}
    </li>
  );
}
