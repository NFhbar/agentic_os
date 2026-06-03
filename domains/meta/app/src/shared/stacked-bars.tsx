// Stacked-bar primitives — SeverityBar (existing) + CountStackedBar (new).
// Locked by standard-app-design § 11.2.

import type React from 'react';

export const SeverityBar: React.FC<{
  bug: number;
  nit: number;
  suggestion: number;
  max?: number;
}> = ({ bug, nit, suggestion, max = 16 }) => {
  const total = bug + nit + suggestion;
  const w = (n: number) => `${(n / Math.max(max, total)) * 100}%`;
  return (
    <div
      style={{
        display: 'flex',
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        background: 'var(--panel-3)',
        minWidth: 90,
      }}
    >
      {bug > 0 && <i style={{ background: 'var(--danger)', width: w(bug) }} />}
      {nit > 0 && <i style={{ background: 'var(--warning)', width: w(nit) }} />}
      {suggestion > 0 && <i style={{ background: 'var(--accent)', width: w(suggestion) }} />}
    </div>
  );
};

export interface CountSegment {
  count: number;
  color: string;
  abbr: string;
  textColor?: string;
}

export const CountStackedBar: React.FC<{
  segments: CountSegment[];
  total: number;
}> = ({ segments, total }) => {
  if (total <= 0) {
    return (
      <span className="tiny" style={{ color: 'var(--subtle)' }}>
        —
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
      <div
        style={{
          display: 'flex',
          height: 5,
          borderRadius: 2.5,
          overflow: 'hidden',
          background: 'var(--panel-3)',
        }}
      >
        {segments.map(
          (seg, i) =>
            seg.count > 0 && (
              <i
                key={i}
                style={{ background: seg.color, width: `${(seg.count / total) * 100}%` }}
              />
            ),
        )}
      </div>
      <div
        className="tiny mono"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', color: 'var(--muted)' }}
      >
        <span>{total} total</span>
        {segments.map(
          (seg, i) =>
            seg.count > 0 && (
              <span key={i} style={seg.textColor ? { color: seg.textColor } : undefined}>
                · {seg.count}
                {seg.abbr}
              </span>
            ),
        )}
      </div>
    </div>
  );
};
