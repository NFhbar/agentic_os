// Shared component primitives for OS apps. Originally lifted from a
// hand-written PR-review prototype (JSX) and ported to TypeScript + ES modules.
//
// Source of truth for visual primitives — see standard-app-design.md for the
// design system, standard-app-architecture.md for how apps consume this module.

import type React from 'react';
import { useRef, useState } from 'react';

// ── Collapsed sections ───────────────────────────────────────────────────────
// Terminal/completed items (merged changes, completed projects, …) render
// behind a collapsed-by-default toggle so active work owns the viewport.
// Persisted per surface in localStorage; pass a stable storageKey.

export function useCollapsedFlag(
  storageKey: string,
  defaultCollapsed = true,
): [boolean, () => void] {
  const key = `agentic-os/section-collapsed:${storageKey}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? defaultCollapsed : raw === '1';
    } catch {
      return defaultCollapsed;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(key, c ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !c;
    });
  };
  return [collapsed, toggle];
}

// In-table section toggle — replaces the old static "Terminal" divider rows.
// Same visual weight as the divider it succeeds; click expands/collapses the
// rows that follow it (callers render those conditionally).
export function SectionToggleRow({
  colSpan,
  label,
  count,
  collapsed,
  onToggle,
}: {
  colSpan: number;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <tr aria-expanded={!collapsed}>
      <td colSpan={colSpan} style={{ padding: 0, borderTop: '1px solid var(--border)' }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 12px',
            fontSize: 10.5,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            background: 'var(--bg-2)',
            border: 'none',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          {collapsed ? '▸' : '▾'} {label} ({count})
        </button>
      </td>
    </tr>
  );
}

// ── Icon ─────────────────────────────────────────────────────────────────────
// Lucide-style: 24x24 viewBox, 1.5 stroke, currentColor. Default render is 16px.

interface IconProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'size'> {
  size?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  d?: string;
  children?: React.ReactNode;
}

export const Icon: React.FC<IconProps> = ({
  d,
  size = 16,
  fill = 'none',
  stroke = 'currentColor',
  strokeWidth = 1.5,
  children,
  ...rest
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={stroke}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

type IconComponent = React.FC<Omit<IconProps, 'd' | 'children'>>;

export const Icons: Record<string, IconComponent> = {
  Home: (p) => (
    <Icon {...p}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-6h4v6" />
    </Icon>
  ),
  Repo: (p) => (
    <Icon {...p}>
      <path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 1-2-2V5Z" />
      <path d="M4 16h14" />
      <path d="M9 7h6" />
    </Icon>
  ),
  Reviews: (p) => (
    <Icon {...p}>
      <path d="M4 5h16v10H7l-3 4V5Z" />
      <path d="M8 9h8" />
      <path d="M8 12h5" />
    </Icon>
  ),
  Settings: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a7.5 7.5 0 0 0 0-5l2-1.2-2-3.5-2.3.8a7.4 7.4 0 0 0-4.3-2.5L12 0H8l-.8 2.3A7.4 7.4 0 0 0 2.9 4.8L0.6 4l-2 3.5 2 1.2a7.5 7.5 0 0 0 0 5l-2 1.2 2 3.5 2.3-.8a7.4 7.4 0 0 0 4.3 2.5L8 22h4l.8-2.3a7.4 7.4 0 0 0 4.3-2.5l2.3.8 2-3.5-2-1.2Z" />
    </Icon>
  ),
  Plus: (p) => (
    <Icon {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  Search: (p) => (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  ),
  Refresh: (p) => (
    <Icon {...p}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </Icon>
  ),
  Trash: (p) => (
    <Icon {...p}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </Icon>
  ),
  ArrowRight: (p) => (
    <Icon {...p}>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </Icon>
  ),
  ChevronRight: (p) => (
    <Icon {...p}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  ),
  ChevronDown: (p) => (
    <Icon {...p}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  ),
  ChevronLeft: (p) => (
    <Icon {...p}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  ),
  External: (p) => (
    <Icon {...p}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </Icon>
  ),
  Play: (p) => (
    <Icon {...p} fill="currentColor" stroke="none">
      <path d="M6 4v16l14-8L6 4Z" />
    </Icon>
  ),
  Send: (p) => (
    <Icon {...p}>
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </Icon>
  ),
  Check: (p) => (
    <Icon {...p}>
      <path d="m5 12 5 5 9-11" />
    </Icon>
  ),
  X: (p) => (
    <Icon {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  ),
  Bug: (p) => (
    <Icon {...p}>
      <path d="M8 4a4 4 0 0 1 8 0" />
      <rect x="6" y="6" width="12" height="14" rx="6" />
      <path d="M3 12h3M18 12h3M3 18l3-1M18 17l3 1M3 8l3 1M18 9l3-1M12 10v8" />
    </Icon>
  ),
  Sparkles: (p) => (
    <Icon {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </Icon>
  ),
  GitPullRequest: (p) => (
    <Icon {...p}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <circle cx="18" cy="18" r="3" />
    </Icon>
  ),
  GitBranch: (p) => (
    <Icon {...p}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Icon>
  ),
  GitCommit: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <line x1="3" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="21" y2="12" />
    </Icon>
  ),
  Code: (p) => (
    <Icon {...p}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </Icon>
  ),
  File: (p) => (
    <Icon {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </Icon>
  ),
  Folder: (p) => (
    <Icon {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </Icon>
  ),
  Database: (p) => (
    <Icon {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6a9 3 0 0 0 18 0V5" />
      <path d="M3 11v6a9 3 0 0 0 18 0v-6" />
    </Icon>
  ),
  Clock: (p) => (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  ),
  Zap: (p) => (
    <Icon {...p}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </Icon>
  ),
  AlertTriangle: (p) => (
    <Icon {...p}>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  ),
  Shield: (p) => (
    <Icon {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </Icon>
  ),
  Activity: (p) => (
    <Icon {...p}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </Icon>
  ),
  PanelLeft: (p) => (
    <Icon {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </Icon>
  ),
  Filter: (p) => (
    <Icon {...p}>
      <path d="M3 4h18l-7 9v6l-4 2v-8L3 4Z" />
    </Icon>
  ),
  Bell: (p) => (
    <Icon {...p}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </Icon>
  ),
  More: (p) => (
    <Icon {...p}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </Icon>
  ),
  Star: (p) => (
    <Icon {...p}>
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6L12 17l-5.4 2.8 1-6L3.2 9.5l6.1-.9L12 3Z" />
    </Icon>
  ),
  Cpu: (p) => (
    <Icon {...p}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </Icon>
  ),
  Eye: (p) => (
    <Icon {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  ),
  Copy: (p) => (
    <Icon {...p}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  ),
  Lightbulb: (p) => (
    <Icon {...p}>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12c1 1 2 2 2 4h4c0-2 1-3 2-4a7 7 0 0 0-4-12Z" />
    </Icon>
  ),
  Pencil: (p) => (
    <Icon {...p}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Icon>
  ),
  Upload: (p) => (
    <Icon {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </Icon>
  ),
  Flag: (p) => (
    <Icon {...p}>
      <path d="M4 22V4" />
      <path d="M4 4h13l-2 4 2 4H4" />
    </Icon>
  ),
  GitMerge: (p) => (
    <Icon {...p}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V8" />
      <path d="M15 18a9 9 0 0 1-9-9" />
    </Icon>
  ),
  FileText: (p) => (
    <Icon {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h4" />
    </Icon>
  ),
};

// ── Severity helpers ─────────────────────────────────────────────────────────

export type Severity = 'bug' | 'nit' | 'suggestion' | 'info';
export type SkillAgent = 'security' | 'style' | 'logic' | 'performance' | 'tests' | 'docs';

export const sevClass = (s: Severity): string => `badge severity-${s}`;

export const sevIcon = (s: Severity, size = 12): React.ReactElement => {
  if (s === 'bug') return <Icons.Bug size={size} />;
  if (s === 'nit') return <Icons.AlertTriangle size={size} />;
  if (s === 'suggestion') return <Icons.Sparkles size={size} />;
  return <Icons.Activity size={size} />;
};

export const sevLabel = (s: Severity): string =>
  ({ bug: 'Bug', nit: 'Nit', suggestion: 'Suggestion', info: 'Info' })[s] || s;

// ── Agent chip ───────────────────────────────────────────────────────────────

export const AgentChip: React.FC<{ agent: SkillAgent }> = ({ agent }) => {
  const letter =
    ({ security: 'S', style: 'St', logic: 'L', performance: 'P', tests: 'T', docs: 'D' } as const)[
      agent
    ] || '?';
  const label =
    (
      {
        security: 'Security',
        style: 'Style',
        logic: 'Logic',
        performance: 'Performance',
        tests: 'Tests',
        docs: 'Docs',
      } as const
    )[agent] || agent;
  return (
    <span className="agent-chip">
      <span className={`agent-icon ${agent}`}>{letter}</span>
      {label}
    </span>
  );
};

// ── Badges ───────────────────────────────────────────────────────────────────

export type Status =
  | 'running'
  | 'completed'
  | 'failed'
  | 'queued'
  | 'indexed'
  | 'indexing'
  | 'stale'
  | 'error';

export const StatusBadge: React.FC<{ status: Status | string }> = ({ status }) => {
  if (status === 'running')
    return (
      <span className="badge accent">
        <span className="dot running" />
        Running
      </span>
    );
  if (status === 'completed')
    return (
      <span className="badge">
        <span className="badge-dot" />
        Completed
      </span>
    );
  if (status === 'failed')
    return (
      <span className="badge danger">
        <span className="badge-dot" />
        Failed
      </span>
    );
  if (status === 'queued')
    return (
      <span className="badge muted">
        <span className="badge-dot" />
        Queued
      </span>
    );
  if (status === 'indexed')
    return (
      <span className="badge success">
        <span className="badge-dot" />
        Indexed
      </span>
    );
  if (status === 'indexing')
    return (
      <span className="badge accent">
        <span className="dot running" />
        Indexing
      </span>
    );
  if (status === 'stale')
    return (
      <span className="badge warning">
        <span className="badge-dot" />
        Needs re-index
      </span>
    );
  if (status === 'error')
    return (
      <span className="badge danger">
        <span className="badge-dot" />
        Error
      </span>
    );
  return <span className="badge muted">{status}</span>;
};

export type ResultKind = 'approve' | 'changes' | 'block' | null;

export const ResultBadge: React.FC<{ result: ResultKind }> = ({ result }) => {
  if (result === 'approve')
    return (
      <span className="badge success">
        <Icons.Check size={11} />
        Approve
      </span>
    );
  if (result === 'changes')
    return (
      <span className="badge warning">
        <Icons.AlertTriangle size={11} />
        Changes
      </span>
    );
  if (result === 'block')
    return (
      <span className="badge danger">
        <Icons.X size={11} />
        Block
      </span>
    );
  return <span className="badge muted">—</span>;
};

// ── Sparkline ────────────────────────────────────────────────────────────────

export const Sparkline: React.FC<{
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}> = ({ data, color = 'var(--accent)', width = 96, height = 32 }) => {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map<[number, number]>((v, i) => [
    i * step,
    height - ((v - min) / range) * (height - 4) - 2,
  ]);
  const path = pts
    .map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1))
    .join(' ');
  const area = path + ` L${width},${height} L0,${height} Z`;
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  return (
    <svg
      width={width}
      height={height}
      className="metric-spark"
      role="img"
      aria-label="Trend sparkline"
    >
      <title>Trend sparkline</title>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
};

// ── Switch ───────────────────────────────────────────────────────────────────

export const Switch: React.FC<{ on: boolean; onChange: (next: boolean) => void }> = ({
  on,
  onChange,
}) => (
  <button
    type="button"
    className="switch"
    data-on={on ? 'true' : 'false'}
    role="switch"
    aria-checked={!!on}
    onClick={() => onChange(!on)}
  >
    <i />
  </button>
);

// ── Language dot ─────────────────────────────────────────────────────────────

export const LangDot: React.FC<{ lang: string }> = ({ lang }) => (
  <span className={`lang-dot lang-${lang}`} title={lang} />
);

// ── Code line + pane ─────────────────────────────────────────────────────────

export type CodeLineKind = 'add' | 'remove' | 'highlight' | 'context';

export interface CodeLineData {
  n: number;
  t: string;
  kind?: CodeLineKind;
}

// Tiny tokenizer for go/ts/python-ish highlighting flavor.
// Order matters; not robust. Intentional — we just want visual flavor.
export function hl(line: string): string {
  let s = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // strings (double + backtick)
  s = s.replace(/("([^"\\]|\\.)*")/g, '<span class="tok-str">$1</span>');
  s = s.replace(/(`([^`\\]|\\.)*`)/g, '<span class="tok-str">$1</span>');
  // line comments
  s = s.replace(/(\/\/[^\n]*)/g, '<span class="tok-co">$1</span>');
  // numbers
  s = s.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
  // keywords
  const kws = [
    'func',
    'return',
    'if',
    'else',
    'for',
    'range',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    'package',
    'import',
    'defer',
    'go',
    'select',
    'switch',
    'case',
    'break',
    'continue',
    'nil',
    'true',
    'false',
    'map',
    'chan',
  ];
  s = s.replace(new RegExp(`\\b(${kws.join('|')})\\b`, 'g'), '<span class="tok-kw">$1</span>');
  // function call name
  s = s.replace(/\b([A-Za-z_][\w]*)\s*\(/g, '<span class="tok-fn">$1</span>(');
  return s;
}

export const CodeLine: React.FC<CodeLineData> = ({ n, t, kind }) => {
  const cls =
    'code-line' +
    (kind === 'add'
      ? ' add'
      : kind === 'remove'
        ? ' remove'
        : kind === 'highlight'
          ? ' highlight'
          : '');
  const marker = kind === 'add' ? '+' : kind === 'remove' ? '-' : ' ';
  return (
    <div className={cls}>
      <span className="code-ln">{n}</span>
      <span className="code-marker">{marker}</span>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: token-level syntax highlighting; input is escaped first via hl() */}
      <span className="code-content" dangerouslySetInnerHTML={{ __html: hl(t) }} />
    </div>
  );
};

export const CodePane: React.FC<{
  file: string;
  lang?: string;
  lines: CodeLineData[];
}> = ({ file, lang, lines }) => (
  <div className="code-pane">
    <div className="code-head">
      <Icons.File size={13} />
      <span>{file}</span>
      <span className="spacer" />
      {lang && <span className="code-lang">{lang}</span>}
    </div>
    <div className="code-body">
      {lines.map((l) => (
        <CodeLine key={l.n} n={l.n} t={l.t} kind={l.kind} />
      ))}
    </div>
  </div>
);

// ── Trend chart (stacked bars) ───────────────────────────────────────────────

export interface TrendDatum {
  d: string;
  reviews: number;
  bugs: number;
  nits: number;
}

export const TrendChart: React.FC<{ data: TrendDatum[]; height?: number }> = ({
  data,
  height = 200,
}) => {
  const W = 720;
  const H = height;
  const pad = { l: 32, r: 12, t: 14, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const max = Math.max(...data.map((d) => d.reviews));
  const yMax = Math.ceil(max / 5) * 5;
  const bw = innerW / data.length;
  const yTicks = [0, yMax / 2, yMax];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      preserveAspectRatio="none"
      role="img"
      aria-label="Trend chart"
    >
      <title>Trend chart</title>
      {yTicks.map((y) => {
        const yy = pad.t + innerH - (y / yMax) * innerH;
        return (
          <g key={y}>
            <line x1={pad.l} x2={W - pad.r} y1={yy} y2={yy} stroke="var(--border)" />
            <text
              x={pad.l - 6}
              y={yy + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--muted)"
              fontFamily="var(--font-mono)"
            >
              {y}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const cx = pad.l + bw * i + bw / 2;
        const totalH = (d.reviews / yMax) * innerH;
        const bugsH = (d.bugs / yMax) * innerH;
        const nitsH = (d.nits / yMax) * innerH;
        const cleanH = totalH - bugsH - nitsH;
        const barW = Math.min(22, bw - 8);
        const x = cx - barW / 2;
        const y = pad.t + innerH - totalH;
        return (
          <g key={`${d.d}-${i}`}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(1, cleanH)}
              fill="var(--accent)"
              rx="2"
            />
            <rect
              x={x}
              y={y + cleanH}
              width={barW}
              height={Math.max(1, nitsH)}
              fill="var(--warning)"
              rx="0"
            />
            <rect
              x={x}
              y={y + cleanH + nitsH}
              width={barW}
              height={Math.max(1, bugsH)}
              fill="var(--danger)"
              rx="0"
            />
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--muted)"
              fontFamily="var(--font-mono)"
            >
              {d.d.slice(0, 1)}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ── Severity bar ─────────────────────────────────────────────────────────────
// Source moved to shared/stacked-bars.tsx per standard-app-design § 11.2.
// Re-exported here for back-compat with existing call sites.
export { SeverityBar } from './stacked-bars';

// ── Empty state ──────────────────────────────────────────────────────────────

export const Empty: React.FC<{ title: string; hint?: string; icon?: React.ReactNode }> = ({
  title,
  hint,
  icon,
}) => (
  <div className="empty">
    {icon && (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginBottom: 12,
          color: 'var(--subtle)',
        }}
      >
        {icon}
      </div>
    )}
    <div className="h2">{title}</div>
    {hint && <div style={{ marginTop: 4 }}>{hint}</div>}
  </div>
);

// ── Modal ────────────────────────────────────────────────────────────────────

export const SharedModal: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}> = ({ title, onClose, children, footer }) => {
  // Click-outside-to-close that ignores drags: only fire close when BOTH
  // mousedown and mouseup happen on the scrim. A textarea-resize drag starts
  // mousedown inside the dialog, then crosses the scrim on release —
  // tracking mousedown origin prevents the bogus close. (Reported during
  // mull-version-2 dogfooding while writing a research report's notes.)
  const scrimMouseDownRef = useRef(false);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        scrimMouseDownRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (scrimMouseDownRef.current && e.target === e.currentTarget) {
          onClose();
        }
        scrimMouseDownRef.current = false;
      }}
      role="presentation"
    >
      <dialog className="modal" open aria-modal="true">
        <div className="modal-head">
          <div className="h2">{title}</div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icons.X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </dialog>
    </div>
  );
};

// ── Toast ────────────────────────────────────────────────────────────────────

export const Toast: React.FC<{ msg: string | null }> = ({ msg }) =>
  msg ? (
    <output
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        boxShadow: 'var(--shadow-lg)',
        fontSize: 13,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Icons.Check size={14} style={{ color: 'var(--success)' }} />
      {msg}
    </output>
  ) : null;

// ── Metric card ──────────────────────────────────────────────────────────────
//
// Versatile metric tile. Three shapes coexist:
//   - delta + spark         (analytics: "+18%, sparkline")
//   - hint (no delta/spark) (status: "window: 30d", "clean")
//   - severity tint         (state: warn/err background)
// Apps mix and match. Insights uses hint+severity; PR-review uses delta+spark.

export type MetricSeverity = 'ok' | 'warn' | 'err';

export const Metric: React.FC<{
  label: string;
  value: string;
  hint?: string;
  delta?: string;
  up?: boolean;
  down?: boolean;
  invertDelta?: boolean;
  spark?: number[];
  color?: string;
  severity?: MetricSeverity;
}> = ({
  label,
  value,
  hint,
  delta,
  up,
  down,
  spark,
  color = 'var(--accent)',
  invertDelta = false,
  severity = 'ok',
}) => {
  const cls = (up && !invertDelta) || (down && invertDelta) ? 'up' : 'down';
  return (
    <div className={`metric severity-${severity}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {delta && (
        <div className={`metric-delta ${cls}`}>
          {up ? '▲' : '▼'} {delta}
          <span style={{ color: 'var(--muted)' }}> vs prev</span>
        </div>
      )}
      {hint && !delta && <div className="metric-hint">{hint}</div>}
      {spark && <Sparkline data={spark} color={color} />}
    </div>
  );
};
