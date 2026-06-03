// Layout primitives shared across apps.
// Locked by standard-app-design § 11.1 — canonical home of the ActionBanner pattern.

import type React from 'react';

export type ActionBannerTone = 'accent' | 'warning' | 'success' | 'muted';

export interface BannerAction {
  label: string;
  onClick: () => void;
  tooltip?: string;
  ghost?: boolean;
}

export interface ActionBannerProps {
  tone?: ActionBannerTone;
  icon?: React.ReactNode;
  title: React.ReactNode;
  desc?: React.ReactNode;
  actions?: {
    primary?: BannerAction;
    secondary?: BannerAction;
  };
  dispatching?: boolean;
}

function toneStyle(tone: ActionBannerTone): React.CSSProperties {
  switch (tone) {
    case 'warning':
      return {
        background: 'var(--warning-soft, rgba(190, 130, 30, 0.08))',
        border: '1px solid var(--warning-border, var(--warning-text))',
        color: 'var(--warning-text)',
      };
    case 'success':
      return {
        background: 'var(--success-soft, rgba(60, 160, 90, 0.08))',
        border: '1px solid var(--success-border, var(--success-text))',
        color: 'var(--success-text)',
      };
    case 'muted':
      return {
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        color: 'var(--text-2)',
      };
    default:
      return {
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-border)',
        color: 'var(--accent-text)',
      };
  }
}

export const ActionBanner: React.FC<ActionBannerProps> = ({
  tone = 'accent',
  icon,
  title,
  desc,
  actions,
  dispatching = false,
}) => {
  const style: React.CSSProperties = {
    ...toneStyle(tone),
    padding: '12px 14px',
    borderRadius: 'var(--radius)',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    flexWrap: 'wrap',
  };
  const { primary, secondary } = actions ?? {};
  return (
    <div className="card" style={style}>
      {icon && <span style={{ flexShrink: 0, display: 'inline-flex' }}>{icon}</span>}
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{title}</div>
        {desc && (
          <div className="tiny" style={{ marginTop: 4, color: 'var(--text-2)' }}>
            {desc}
          </div>
        )}
      </div>
      {(primary || secondary) && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {secondary && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={secondary.onClick}
              disabled={dispatching}
              title={
                dispatching && secondary.tooltip
                  ? `Disabled — dispatch in flight. ${secondary.tooltip}`
                  : secondary.tooltip
              }
            >
              {secondary.label}
            </button>
          )}
          {primary && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={primary.onClick}
              disabled={dispatching}
              title={
                dispatching && primary.tooltip
                  ? `Disabled — dispatch in flight. ${primary.tooltip}`
                  : primary.tooltip
              }
            >
              {dispatching ? 'Working…' : primary.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
