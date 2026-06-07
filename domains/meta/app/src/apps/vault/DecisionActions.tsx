// DecisionActions — Phase 4.1 polish. Surfaces accept + apply controls when
// the user is viewing a decision-archetype entry in the Vault.
//
// Renders three pieces:
//   - Status badge (proposed / accepted / validated / regressed / etc.)
//   - Accept button (when status is proposed) — surgically edits the
//     `status:` frontmatter line via /api/edit
//   - Apply button (when status is accepted AND implements_tuning_suggestions
//     is non-empty) — dispatches meta-apply-tuning-suggestion via the new
//     /api/tuning-suggestions/apply route, streams output in a modal
//
// Why a dedicated component rather than embedded in EditableMarkdown:
// EditableMarkdown is a generic renderer; decision-specific behavior would
// pollute its API. This component is rendered by the Vault View only when
// the entry's type is `decision`.

import { useMemo, useState } from 'react';
import { useDispatch } from '../../lib/dispatch';
import { Icons } from '../../shared';

interface ImplementsRef {
  audit_id: string;
  suggestion_index: number;
}

interface DecisionFrontmatter {
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded' | string;
  implements_tuning_suggestions?: ImplementsRef[];
  validation_result?: 'pending' | 'validated' | 'regressed' | 'inconclusive' | string;
  // Set by meta-apply-tuning-suggestion after a successful apply run. Used
  // to distinguish "accepted, ready to apply" from "accepted, already done."
  applied_at?: string;
  // Optional title — used in modal labels for clarity
  title?: string;
}

interface DecisionActionsProps {
  // Repo-relative path of the decision entry. Required for the surgical
  // frontmatter edit on Accept + as the `decision_entry_path` arg on Apply.
  path: string;
  // Raw file content — parsed by the component to extract frontmatter.
  // When the parent updates this (e.g. after Accept saved), we re-parse.
  content: string;
  // Fires after a successful Accept or Apply so the parent can refresh.
  onChanged?: () => void;
}

// Parse the frontmatter block from raw markdown. Extracts the fields we
// care about. Returns null when the file has no frontmatter at all (in
// which case the component renders nothing — defensive guard, decision
// entries always have frontmatter).
function parseDecisionFrontmatter(content: string): {
  fm: DecisionFrontmatter;
  fmRaw: string;
  body: string;
} | null {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fmRaw = m[1];
  const body = m[2];

  // Cheap YAML-ish line parser. We only need: status, implements_tuning_suggestions, validation_result, title.
  // Real YAML parsing would pull in js-yaml — overkill for these four fields.
  const fm: DecisionFrontmatter = { status: 'proposed' };
  for (const line of fmRaw.split('\n')) {
    const statusM = line.match(/^status:\s*(.+?)\s*$/);
    if (statusM) {
      fm.status = statusM[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const titleM = line.match(/^title:\s*(.+?)\s*$/);
    if (titleM) {
      fm.title = titleM[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const valM = line.match(/^validation_result:\s*(.+?)\s*$/);
    if (valM) {
      fm.validation_result = valM[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const appliedM = line.match(/^applied_at:\s*(.+?)\s*$/);
    if (appliedM) {
      fm.applied_at = appliedM[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    // implements_tuning_suggestions is the load-bearing one. Two shapes:
    //   - JSON-flat single line: implements_tuning_suggestions: [{"audit_id":"...","suggestion_index":N}, ...]
    //   - YAML block:
    //       implements_tuning_suggestions:
    //         - audit_id: ...
    //           suggestion_index: N
    // The Phase 4 promote handler emits the flat-JSON shape; manual authors
    // may use either. We handle the flat form here; YAML block form falls
    // through to undefined (acceptable for v1 — the manual case is rare).
    const implM = line.match(/^implements_tuning_suggestions:\s*(\[.+\])\s*$/);
    if (implM) {
      try {
        const parsed = JSON.parse(implM[1]);
        if (Array.isArray(parsed)) {
          fm.implements_tuning_suggestions = parsed.filter((x: unknown): x is ImplementsRef => {
            if (!x || typeof x !== 'object') return false;
            const o = x as Record<string, unknown>;
            return typeof o.audit_id === 'string' && typeof o.suggestion_index === 'number';
          });
        }
      } catch {
        /* malformed — leave undefined */
      }
    }
  }

  return { fm, fmRaw, body };
}

// Surgical edit of the `status:` frontmatter line. Returns the new file
// content. If no `status:` line exists, returns the original (no-op rather
// than corrupting the file by adding one in an unknown location).
function flipStatus(content: string, newStatus: string): string {
  return content.replace(/^status:\s*.+$/m, `status: ${newStatus}`);
}

function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === 'accepted')
    return {
      background: 'var(--accent-bg, rgba(80,160,250,0.12))',
      color: 'var(--accent-text, #5aa0fa)',
      border: '1px solid var(--accent-border, rgba(80,160,250,0.4))',
    };
  if (status === 'validated')
    return {
      background: 'var(--success-bg, rgba(80,200,120,0.12))',
      color: 'var(--success-text, #4caf80)',
      border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
    };
  if (status === 'regressed' || status === 'deprecated')
    return {
      background: 'var(--danger-bg, rgba(250,80,80,0.1))',
      color: 'var(--danger-text, #e05050)',
      border: '1px solid var(--danger-border, rgba(250,80,80,0.4))',
    };
  if (status === 'superseded')
    return {
      background: 'var(--bg-2, rgba(255,255,255,0.04))',
      color: 'var(--text-3)',
      border: '1px solid var(--border)',
    };
  // proposed (default)
  return {
    background: 'var(--warning-bg, rgba(250,200,80,0.1))',
    color: 'var(--warning-text, #e0a02a)',
    border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
  };
}

export function DecisionActions({ path, content, onChanged }: DecisionActionsProps) {
  const parsed = useMemo(() => parseDecisionFrontmatter(content), [content]);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyToast, setApplyToast] = useState<string | null>(null);
  const { startSkillRun } = useDispatch();

  if (!parsed) return null;
  const { fm } = parsed;

  const hasImplements = (fm.implements_tuning_suggestions?.length ?? 0) > 0;
  const canAccept = fm.status === 'proposed';
  const canApply = fm.status === 'accepted' && hasImplements;
  const alreadyApplied = canApply && !!fm.applied_at;

  async function accept() {
    if (!canAccept || accepting) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      const newContent = flipStatus(content, 'accepted');
      if (newContent === content) {
        throw new Error('no status: line found in frontmatter');
      }
      const r = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content: newContent }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      onChanged?.();
    } catch (e) {
      setAcceptError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccepting(false);
    }
  }

  // Apply via the dashboard's run-tracking dispatch — not a bespoke SSE
  // route. The run becomes a first-class citizen in the runs drawer:
  // observable post-hoc, cancellable, attributed in events.db. Click →
  // startSkillRun → drawer opens automatically → run streams there.
  async function apply() {
    if (!canApply || applying) return;
    const target = fm.implements_tuning_suggestions?.[0];
    if (!target) {
      setApplyError('decision is accepted but implements_tuning_suggestions is empty');
      return;
    }
    setApplying(true);
    setApplyError(null);
    setApplyToast(null);
    try {
      // Decision id used in the runs-drawer title — gives a scannable label
      // ("Apply: dev-revise-plan-...") vs a raw run uuid.
      const shortLabel = (fm.title ?? '').slice(0, 60);
      const prompt =
        `/os apply tuning suggestion audit=${target.audit_id} ` +
        `suggestion_index=${target.suggestion_index} mode=apply ` +
        `decision_entry_path=${path}`;
      const result = await startSkillRun(prompt, `Apply: ${shortLabel || 'decision'}`, {
        skill: 'meta-apply-tuning-suggestion',
      });
      if ('error' in result && result.error) {
        throw new Error(result.error);
      }
      if ('blocked' in result && result.blocked) {
        throw new Error('Apply blocked — another run holds the lock; see runs drawer');
      }
      if ('run_id' in result && result.run_id) {
        setApplyToast(
          `Apply started (run ${result.run_id.slice(0, 10)}…). Watch progress in the runs drawer.`,
        );
        // Re-fetch the decision after a beat so any post-apply frontmatter
        // changes (none today, but possible later) reflect in the UI.
        setTimeout(() => onChanged?.(), 1500);
      }
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <div
        style={{
          padding: '12px 16px',
          marginBottom: 14,
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span
          className="tiny"
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: 'var(--muted)',
            fontWeight: 600,
          }}
        >
          Decision
        </span>
        <span className="badge" style={{ fontSize: 12, ...statusBadgeStyle(fm.status) }}>
          {fm.status}
        </span>
        {fm.validation_result && fm.validation_result !== 'pending' && (
          <span className="badge muted" style={{ fontSize: 11 }}>
            validation: {fm.validation_result}
          </span>
        )}
        {alreadyApplied && fm.applied_at && (
          <span
            className="badge"
            style={{
              fontSize: 11,
              background: 'var(--success-bg, rgba(80,200,120,0.12))',
              color: 'var(--success-text, #4caf80)',
              border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
            }}
            title={`Applied at ${new Date(fm.applied_at).toLocaleString()}`}
          >
            ✓ applied
          </span>
        )}
        {hasImplements && (
          <span className="tiny subtle" style={{ fontSize: 11 }}>
            implements {fm.implements_tuning_suggestions?.length} tuning suggestion
            {(fm.implements_tuning_suggestions?.length ?? 0) !== 1 ? 's' : ''}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {canAccept && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={accept}
            disabled={accepting}
            title="Flip status: proposed → accepted. Editable directly via the markdown editor if you want a different value."
          >
            {accepting ? 'Accepting…' : 'Accept'}
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
                : 'Dispatch meta-apply-tuning-suggestion against the first implemented tuning suggestion. Run streams in the drawer; SKILL.md edit lands on completion.'
            }
          >
            <Icons.Send size={11} />{' '}
            {applying ? 'Starting…' : alreadyApplied ? 'Re-apply' : 'Apply'}
          </button>
        )}
        {fm.status === 'accepted' && !hasImplements && (
          <span
            className="tiny subtle"
            style={{ fontSize: 11, color: 'var(--warning-text)' }}
            title="Decision accepted but does not cite any tuning suggestions. Apply requires implements_tuning_suggestions to be populated."
          >
            (apply unavailable — no implements_tuning_suggestions)
          </span>
        )}
      </div>

      {acceptError && (
        <div
          style={{
            padding: '8px 14px',
            marginBottom: 14,
            background: 'var(--danger-soft, rgba(250,80,80,0.1))',
            color: 'var(--danger-text)',
            border: '1px solid var(--danger-border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          Accept failed: {acceptError}
        </div>
      )}

      {applyError && (
        <div
          style={{
            padding: '8px 14px',
            marginBottom: 14,
            background: 'var(--danger-soft, rgba(250,80,80,0.1))',
            color: 'var(--danger-text)',
            border: '1px solid var(--danger-border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          Apply failed to start: {applyError}
        </div>
      )}

      {applyToast && !applyError && (
        <div
          style={{
            padding: '8px 14px',
            marginBottom: 14,
            background: 'var(--accent-bg, rgba(80,160,250,0.10))',
            color: 'var(--accent-text)',
            border: '1px solid var(--accent-border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          ✓ {applyToast}
        </div>
      )}
    </>
  );
}
