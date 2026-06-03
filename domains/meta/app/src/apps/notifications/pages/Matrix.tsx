// Matrix: rows = distinct event_types, columns = channels (slack/email/desktop).
// Each cell maps to the set of rules with that (event_type, channel) key.
// Project facet at the top filters rules to: all, global-only (no filter.project),
// or a specific project (which includes its scoped rules + globals).

import type React from 'react';
import { useMemo, useState } from 'react';
import { Icons } from '../../../shared';
import type { ChannelId, RuleListItem } from '../data';
import { VALID_CHANNELS } from '../data';
import { MatrixCellDrawer } from './MatrixCellDrawer';

interface Props {
  rules: RuleListItem[];
  eventTypes: string[];
  onCellOpen: (eventType: string, channel: ChannelId) => void;
  onRuleOpen: (id: string) => void;
  onToggleEnabled: (id: string, next: boolean) => void;
  busy?: boolean;
}

// Project facet special values. Empty string = "any project" (no filter);
// __global__ = "rules without filter.project only".
const ANY = '';
const GLOBAL_ONLY = '__global__';

export const Matrix: React.FC<Props> = ({
  rules,
  eventTypes,
  onCellOpen,
  onRuleOpen,
  onToggleEnabled,
  busy,
}) => {
  const [projectFacet, setProjectFacet] = useState<string>(ANY);
  // Open-drawer state — null = no drawer. Holds the (event_type, channel) of
  // the cell whose rules the drawer is showing. Mutations (toggle, edit, add)
  // delegate back through onCellOpen / onRuleOpen / onToggleEnabled so the
  // parent's data refresh + navigation stays canonical.
  const [openCell, setOpenCell] = useState<{ eventType: string; channel: ChannelId } | null>(null);

  // Derive project ids from rules themselves — the facet only needs to list
  // projects that have at least one rule scoped to them.
  const projectsInRules = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rules) {
      const p = r.filter.project;
      if (typeof p === 'string' && p.length > 0) ids.add(p);
    }
    return Array.from(ids).sort();
  }, [rules]);
  const hasGlobalRules = useMemo(() => rules.some((r) => !r.filter.project), [rules]);

  // Apply facet filter. "any" keeps everything; "global only" keeps rules
  // without filter.project; a specific project keeps its scoped rules + the
  // globals (since globals do fire for that project too).
  const visibleRules = useMemo(() => {
    if (projectFacet === ANY) return rules;
    if (projectFacet === GLOBAL_ONLY) return rules.filter((r) => !r.filter.project);
    return rules.filter((r) => !r.filter.project || r.filter.project === projectFacet);
  }, [rules, projectFacet]);

  // Index visible rules by (event_type, channel) for O(1) cell lookup.
  const cellMap = new Map<string, RuleListItem[]>();
  for (const r of visibleRules) {
    const k = `${r.event_type}::${r.channel}`;
    const arr = cellMap.get(k) ?? [];
    arr.push(r);
    cellMap.set(k, arr);
  }

  const allEventTypes = Array.from(
    new Set([...eventTypes, ...visibleRules.map((r) => r.event_type)]),
  ).sort();

  const showFacet = projectsInRules.length > 0 || hasGlobalRules;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {showFacet && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
          }}
        >
          <span className="subtle">Project:</span>
          <select
            value={projectFacet}
            onChange={(e) => setProjectFacet(e.target.value)}
            style={{ fontSize: 12 }}
          >
            <option value={ANY}>any</option>
            {hasGlobalRules && <option value={GLOBAL_ONLY}>global only (no project filter)</option>}
            {projectsInRules.map((pid) => (
              <option key={pid} value={pid}>
                {pid}
              </option>
            ))}
          </select>
          {projectFacet !== ANY && projectFacet !== GLOBAL_ONLY && hasGlobalRules && (
            <span className="tiny subtle">
              · global rules also fire for this project
            </span>
          )}
        </div>
      )}

      {allEventTypes.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <p className="subtle" style={{ margin: 0 }}>
            {projectFacet === ANY
              ? 'No event types yet. Run something first, then come back to configure rules.'
              : 'No rules match this project filter.'}
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Event type</th>
                {VALID_CHANNELS.map((ch) => (
                  <th
                    key={ch}
                    style={{ width: 160, textAlign: 'center', textTransform: 'capitalize' }}
                  >
                    {ch}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allEventTypes.map((et) => (
                <tr key={et}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {et}
                  </td>
                  {VALID_CHANNELS.map((ch) => {
                    const cellRules = cellMap.get(`${et}::${ch}`) ?? [];
                    return (
                      <td key={ch} style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                        <Cell
                          eventType={et}
                          channel={ch}
                          cellRules={cellRules}
                          onAdd={() => onCellOpen(et, ch)}
                          onOpenDrawer={() => setOpenCell({ eventType: et, channel: ch })}
                          busy={busy}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openCell && (
        <MatrixCellDrawer
          eventType={openCell.eventType}
          channel={openCell.channel}
          rules={cellMap.get(`${openCell.eventType}::${openCell.channel}`) ?? []}
          onClose={() => setOpenCell(null)}
          onAdd={() => {
            const cell = openCell;
            setOpenCell(null);
            onCellOpen(cell.eventType, cell.channel);
          }}
          onEdit={(id) => {
            setOpenCell(null);
            onRuleOpen(id);
          }}
          onToggleEnabled={onToggleEnabled}
          busy={busy}
        />
      )}
    </div>
  );
};

function projectBadge(r: RuleListItem): string | null {
  const p = r.filter.project;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

interface CellProps {
  eventType: string;
  channel: ChannelId;
  cellRules: RuleListItem[];
  onAdd: () => void;
  onOpenDrawer: () => void;
  busy?: boolean;
}

const Cell: React.FC<CellProps> = ({ eventType, channel, cellRules, onAdd, onOpenDrawer, busy }) => {
  if (cellRules.length === 0) {
    return (
      <button
        type="button"
        className="btn btn-sm"
        onClick={onAdd}
        disabled={busy}
        style={{ opacity: 0.5 }}
        title={`Add a rule for ${eventType} → ${channel}`}
      >
        <Icons.Plus size={11} />
      </button>
    );
  }
  // Any non-empty cell becomes a pill that opens the drawer. The pill shows
  // the rule title (truncated) when there's exactly one; a count + scope hint
  // for two or more. Click anywhere on the pill opens the drawer where
  // enable/disable + edit + add live.
  if (cellRules.length === 1) {
    const r = cellRules[0];
    const badge = projectBadge(r);
    const truncated = r.title.length > 22 ? `${r.title.slice(0, 20)}…` : r.title;
    return (
      <button
        type="button"
        onClick={onOpenDrawer}
        disabled={busy}
        style={{
          ...cellPillStyle,
          opacity: r.enabled ? 1 : 0.55,
        }}
        onMouseEnter={(e) => applyHover(e.currentTarget, true)}
        onMouseLeave={(e) => applyHover(e.currentTarget, false)}
        title={`${r.title}${badge ? ` — scoped to project: ${badge}` : ''} · Click to manage`}
      >
        <span style={{ color: 'var(--accent)' }}>{truncated}</span>
        {badge && <span className="badge muted tiny">{badge}</span>}
        {!r.enabled && <span className="badge muted tiny">off</span>}
      </button>
    );
  }
  const distinctProjects = new Set(cellRules.map((r) => r.filter.project ?? null));
  const multiProject = distinctProjects.size > 1;
  return (
    <button
      type="button"
      onClick={onOpenDrawer}
      disabled={busy}
      style={cellPillStyle}
      onMouseEnter={(e) => applyHover(e.currentTarget, true)}
      onMouseLeave={(e) => applyHover(e.currentTarget, false)}
      title={
        multiProject
          ? 'Rules scoped to different projects (or a mix of project + global). Click to manage.'
          : 'Click to manage rules for this event × channel'
      }
    >
      <span style={{ color: 'var(--accent)' }}>
        {cellRules.length} rules
      </span>
      {multiProject && <span className="tiny subtle">· multi-project</span>}
    </button>
  );
};

// Shared pill style for non-empty cell triggers — flat, no default button
// chrome. `link-inline` is only styled inside `.entry-list` so we inline the
// reset here. Hover reveals a faint underline + slightly darker accent.
const cellPillStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '4px 6px',
  fontSize: 12,
  font: 'inherit',
  cursor: 'pointer',
  color: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  borderRadius: 'var(--radius-sm, 4px)',
  transition: 'background 0.12s',
};

function applyHover(el: HTMLButtonElement, on: boolean): void {
  el.style.background = on ? 'var(--hover, rgba(127,127,127,0.08))' : 'transparent';
  const accentSpan = el.querySelector('span') as HTMLSpanElement | null;
  if (accentSpan) accentSpan.style.textDecoration = on ? 'underline' : 'none';
}
