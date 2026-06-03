// Slide-in drawer listing rules for one (event_type, channel) cell. Replaces
// the per-cell inline <details> expansion that didn't scale past 2-3 rules.
// The drawer is owned by Matrix; this component is presentational + delegates
// every mutation back via callbacks.

import { useEffect, type CSSProperties, type FC } from 'react';
import { Icons } from '../../../shared';
import type { ChannelId, RuleListItem } from '../data';

interface Props {
  eventType: string;
  channel: ChannelId;
  rules: RuleListItem[];
  onClose: () => void;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onToggleEnabled: (id: string, next: boolean) => void;
  busy?: boolean;
}

function describeRateLimit(r: RuleListItem): string {
  const cap = r.rate_limit?.cap_per_day;
  if (cap == null) return 'default';
  return `${cap}/day`;
}

function projectLabel(r: RuleListItem): { kind: 'project' | 'global'; label: string } {
  const p = r.filter.project;
  if (typeof p === 'string' && p.length > 0) return { kind: 'project', label: p };
  return { kind: 'global', label: 'global' };
}

// Flat-button reset for the rule title link — same pattern as Matrix's cell
// pills. `link-inline` is only styled inside `.entry-list`; outside, browser
// default button chrome leaks through as a gray block.
const titleLinkStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 13,
  color: 'var(--accent)',
  cursor: 'pointer',
  textAlign: 'left',
};

export const MatrixCellDrawer: FC<Props> = ({
  eventType,
  channel,
  rules,
  onClose,
  onAdd,
  onEdit,
  onToggleEnabled,
  busy,
}) => {
  // Esc to close. Bind on mount; unbind on close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* Scrim — click to close */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          border: 0,
          padding: 0,
          cursor: 'pointer',
          zIndex: 99,
        }}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label={`Rules for ${eventType} on ${channel}`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(680px, 92vw)',
          background: 'var(--panel)',
          borderLeft: '1px solid var(--border)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.35)',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="tiny subtle" style={{ marginBottom: 2 }}>
              Notification rules
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <code
                className="mono"
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}
              >
                {eventType}
              </code>
              <span className="subtle">→</span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  textTransform: 'capitalize',
                  color: 'var(--text)',
                }}
              >
                {channel}
              </span>
              <span className="badge muted tiny">
                {rules.length} rule{rules.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onAdd}
            title={`Add a new rule for ${eventType} → ${channel}`}
          >
            <Icons.Plus size={11} /> Add rule
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <Icons.X size={12} />
          </button>
        </header>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 4px 18px' }}>
          {rules.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <p className="subtle" style={{ margin: 0, fontSize: 13 }}>
                No rules yet for this event × channel combination. Click <strong>+ Add rule</strong>{' '}
                above to create one.
              </p>
            </div>
          ) : (
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 60, textAlign: 'center' }}>Enabled</th>
                  <th>Title</th>
                  <th style={{ width: 160 }}>Project</th>
                  <th style={{ width: 110 }}>Rate limit</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => {
                  const proj = projectLabel(r);
                  return (
                    <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.55 }}>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={(e) => onToggleEnabled(r.id, e.target.checked)}
                          disabled={busy}
                          title={r.enabled ? 'Click to disable' : 'Click to enable'}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => onEdit(r.id)}
                          style={titleLinkStyle}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.textDecoration = 'underline';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.textDecoration = 'none';
                          }}
                          title="Click to edit rule"
                        >
                          {r.title}
                        </button>
                        {!r.enabled && (
                          <span className="badge muted tiny" style={{ marginLeft: 6 }}>
                            disabled
                          </span>
                        )}
                      </td>
                      <td>
                        {proj.kind === 'project' ? (
                          <span className="badge muted tiny mono">{proj.label}</span>
                        ) : (
                          <span className="tiny subtle" style={{ fontStyle: 'italic' }}>
                            global
                          </span>
                        )}
                      </td>
                      <td className="tiny subtle">{describeRateLimit(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer hint */}
        <footer
          style={{
            padding: '10px 18px',
            borderTop: '1px solid var(--border)',
            fontSize: 11.5,
            color: 'var(--subtle)',
          }}
        >
          Click a rule title to edit. Toggle the checkbox to enable/disable. Esc or click the scrim
          to close.
        </footer>
      </aside>
    </>
  );
};
