// Domains — split-pane list + playbook editor. Migrated to apps/ + restyled
// header chrome (h1 + .btn buttons + Icons). Split-pane structure preserved
// (uses existing dashboard CSS — full-bleed layouts aren't a prototype primitive).

import { useCallback, useEffect, useState } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { EditableMarkdown } from '../../components/EditableMarkdown';
import { RenameModal } from '../../components/RenameModal';
import { ResizeHandle } from '../../components/ResizeHandle';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { getJson } from '../../lib/api';
import { buildDeletePrompt, buildRenamePrompt, lastSegment } from '../../lib/destructive';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { formatRelative } from '../../lib/time';
import { useResizable } from '../../lib/useResizable';
import { fetchEntry } from '../../lib/vault';
import { Icons } from '../../shared';
import '../../shared/styles.css';

interface DomainNode {
  name: string;
  path: string;
  children: DomainNode[];
}

interface DomainsData {
  domains: DomainNode[];
}

type FormKind = 'add-domain' | 'add-app';
type Destructive = { kind: 'rename'; path: string } | { kind: 'delete'; path: string };

function siblingsOf(tree: DomainNode[], path: string): string[] {
  const parts = path.split('/');
  if (parts.length === 1) {
    return tree.map((n) => n.name);
  }
  let nodes: DomainNode[] = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    const parent = nodes.find((n) => n.name === parts[i]);
    if (!parent) return [];
    nodes = parent.children;
  }
  return nodes.map((n) => n.name);
}

const COLLAPSED_STORAGE_KEY = 'agentic-os/collapsed-domains';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* unavailable */
  }
  return new Set();
}

export default function Domains() {
  const picker = useResizable({
    storageKey: 'domains-picker',
    defaultWidth: 280,
    min: 180,
    max: 560,
  });

  const [tree, setTree] = useState<DomainNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());

  const [formKind, setFormKind] = useState<FormKind | null>(null);
  const [formSkill, setFormSkill] = useState<SkillSummary | null>(null);
  const [formInitial, setFormInitial] = useState<Record<string, string>>({});
  const [destructive, setDestructive] = useState<Destructive | null>(null);
  const { startSkillRun } = useDispatch();

  async function dispatch(prompt: string, title: string, skill: string) {
    const res = await startSkillRun(prompt, title, { skill, domain: 'meta' });
    if ('blocked' in res && res.blocked) {
      alert(
        `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`,
      );
    } else if ('error' in res && res.error) {
      alert(`Dispatch failed: ${res.error}`);
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* unavailable */
    }
  }, [collapsed]);

  function toggleCollapse(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const refresh = useCallback(async () => {
    const d = await getJson<DomainsData>('/api/domains');
    setTree(d.domains);
    if (!selected && d.domains.length) setSelected(d.domains[0].path);
  }, [selected]);

  useEffect(() => {
    refresh();
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetchEntry(`domains/${selected}/playbook.md`)
      .then((e) => setContent(e.content))
      .catch(() => setContent('(playbook not found)'))
      .finally(() => setLoading(false));
  }, [selected]);

  async function openForm(kind: FormKind) {
    const skillName = kind === 'add-domain' ? 'meta-add-domain' : 'meta-add-app';
    let skill = await findSkill(skillName);
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill(skillName);
    }
    if (!skill) {
      alert(`${skillName} skill not found in .claude/skills/`);
      return;
    }
    setFormSkill(skill);
    setFormKind(kind);
    setFormInitial(kind === 'add-app' && selected ? { domain: selected } : {});
  }

  function runRename(newName: string) {
    if (!destructive || destructive.kind !== 'rename') return;
    dispatch(
      buildRenamePrompt('domain', `domains/${destructive.path}`, newName),
      `Renaming ${destructive.path} → ${newName}…`,
      'meta-rename',
    );
    setDestructive(null);
  }

  function runDelete() {
    if (!destructive || destructive.kind !== 'delete') return;
    dispatch(
      buildDeletePrompt('domain', `domains/${destructive.path}`),
      `Deleting ${destructive.path}…`,
      'meta-delete',
    );
    setDestructive(null);
  }

  // Refetch domain tree whenever any meta-* run terminates — the rename or
  // delete may have moved/removed entries; the add forms may have created
  // new ones.
  useRunTerminal({ domain: 'meta' }, () => {
    setSelected(null);
    refresh();
  });

  return (
    <div
      className="view domains"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {/* Header — design-system chrome */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Domains</h1>
        {selected && <span className="badge muted">{selected}</span>}
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => openForm('add-domain')}>
          <Icons.Plus size={13} /> New Domain
        </button>
        {selected && (
          <button
            type="button"
            className="btn"
            onClick={() => openForm('add-app')}
            title={`Add an app to ${selected}`}
          >
            <Icons.Plus size={13} /> App to {selected}
          </button>
        )}
      </header>

      <div
        className="split"
        style={{ gridTemplateColumns: `${picker.width}px 1fr`, flex: 1, minHeight: 0 }}
      >
        <div className="picker-column">
          <DomainTree
            nodes={tree}
            selected={selected}
            onSelect={setSelected}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
          />
          <ResizeHandle onMouseDown={picker.startDrag} />
        </div>
        <div className="detail">
          {loading ? (
            <em className="subtle">loading…</em>
          ) : selected ? (
            <>
              <div
                className="detail-toolbar"
                style={{
                  display: 'flex',
                  gap: 6,
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setDestructive({ kind: 'rename', path: selected })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setDestructive({ kind: 'delete', path: selected })}
                >
                  <Icons.Trash size={11} /> Delete
                </button>
              </div>
              <DomainRollupCard domainPath={selected} />
              <EditableMarkdown
                path={`domains/${selected}/playbook.md`}
                content={content}
                onSaved={setContent}
              />
            </>
          ) : (
            <p className="subtle">Pick a domain.</p>
          )}
        </div>
      </div>

      {formKind && formSkill && (
        <ScaffoldForm
          skill={formSkill}
          title={formKind === 'add-domain' ? 'Add Domain' : `Add App to ${selected}`}
          initialValues={formInitial}
          onCancel={() => setFormKind(null)}
          onSubmit={(prompt) => {
            const kind = formKind;
            const skill = formSkill?.name ?? 'unknown';
            setFormKind(null);
            dispatch(prompt, kind === 'add-domain' ? 'Adding domain…' : 'Adding app…', skill);
          }}
        />
      )}

      {destructive?.kind === 'rename' && (
        <RenameModal
          title={`Rename domain ${destructive.path}`}
          currentName={lastSegment(destructive.path)}
          targetPath={`domains/${destructive.path}`}
          taken={siblingsOf(tree, destructive.path)}
          onCancel={() => setDestructive(null)}
          onConfirm={runRename}
        />
      )}

      {destructive?.kind === 'delete' && (
        <ConfirmModal
          title={`Delete domain ${destructive.path}?`}
          message={
            <>
              <p>
                This will permanently delete <code>domains/{destructive.path}/</code> and all of its
                contents (sub-domains, apps, playbook).
              </p>
              <ul>
                <li>
                  <code>vault/wiki/{destructive.path}/</code> (if present)
                </li>
                <li>
                  <code>vault/output/{destructive.path}/</code> (if present)
                </li>
                <li>OS.md Domains table entry</li>
                <li>Parent playbook Sub-domains listing (if a sub-domain)</li>
              </ul>
              <p className="subtle">
                Wiki entries in other domains that reference this one will become dangling links.
              </p>
            </>
          }
          requireType={lastSegment(destructive.path)}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDestructive(null)}
          onConfirm={runDelete}
        />
      )}

    </div>
  );
}

function DomainTree({
  nodes,
  selected,
  onSelect,
  collapsed,
  onToggleCollapse,
  depth = 0,
}: {
  nodes: DomainNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  collapsed: Set<string>;
  onToggleCollapse: (path: string) => void;
  depth?: number;
}) {
  const isTop = depth === 0;
  return (
    <ul className={`picker tree${depth > 0 ? ' nested' : ''}`}>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isCollapsed = collapsed.has(node.path);
        const isActive = node.path === selected;
        return (
          <li key={node.path} className={isTop ? 'tree-top' : undefined}>
            <div
              className={`tree-row${isTop ? ' tree-row-top' : ''}`}
              style={{ paddingLeft: 4 + depth * 14 }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="tree-chevron"
                  onClick={() => onToggleCollapse(node.path)}
                  aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                  title={isCollapsed ? 'Expand sub-domains' : 'Collapse sub-domains'}
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
              ) : (
                <span className="tree-chevron-spacer" aria-hidden />
              )}
              <button
                type="button"
                className={
                  isTop
                    ? `tree-name tree-name-top${isActive ? ' active' : ''}`
                    : `tree-name${isActive ? ' active' : ''}`
                }
                onClick={() => onSelect(node.path)}
              >
                <span className="tree-name-text">{node.name}</span>
                {hasChildren && <span className="tree-count">{node.children.length}</span>}
              </button>
            </div>
            {hasChildren && !isCollapsed && (
              <DomainTree
                nodes={node.children}
                selected={selected}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                depth={depth + 1}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Domain rollup card ──────────────────────────────────────────────────
// Per-domain stat strip: total cost / wall-time / billable runs from
// events.db (filtered by domain column) + content rollup (entries by
// archetype, changes/projects by status) from the vault wiki walk.
//
// Renders above the playbook on the selected-domain detail. Refetches
// when `domainPath` changes; failure surfaces a subtle inline message.

interface DomainRollupResponse {
  ok: true;
  domain: string;
  content: {
    entries_by_archetype: Record<string, number>;
    changes_by_status: Record<string, number>;
    projects_by_status: Record<string, number>;
    total_entries: number;
    latest_activity: string | null;
  };
  rollup: {
    cost_usd: number;
    duration_ms: number;
    skill_count: number;
    by_skill: Array<{
      skill: string;
      count: number;
      cost_usd: number;
      duration_ms: number;
    }>;
    ai_prompt_runs: number;
    failed_runs: number;
  };
}

function DomainRollupCard({ domainPath }: { domainPath: string }) {
  const [data, setData] = useState<DomainRollupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/domains/rollup?path=${encodeURIComponent(domainPath)}`)
      .then((r) => r.json())
      .then((j: DomainRollupResponse | { ok: false; error?: string }) => {
        if (cancelled) return;
        if ('ok' in j && j.ok) setData(j as DomainRollupResponse);
        else setError(('error' in j && j.error) || 'load failed');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [domainPath]);

  if (error) {
    return (
      <p
        className="tiny subtle"
        style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)' }}
      >
        Rollup unavailable: {error}
      </p>
    );
  }
  if (!data) {
    return (
      <p
        className="tiny subtle"
        style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)' }}
      >
        Loading rollup…
      </p>
    );
  }

  const minutes = Math.round(data.rollup.duration_ms / 60000);
  const inFlight =
    (data.content.changes_by_status['planning'] ?? 0) +
    (data.content.changes_by_status['in-progress'] ?? 0) +
    (data.content.changes_by_status['in-review'] ?? 0);

  return (
    <section
      style={{
        padding: '14px 18px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Top row — runtime cost/time */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        <DomainStat label="Total cost" value={`$${data.rollup.cost_usd.toFixed(2)}`} />
        <DomainStat label="Wall-time" value={`${minutes}m`} />
        <DomainStat label="Billable runs" value={`${data.rollup.ai_prompt_runs}`} />
        <DomainStat label="Skills" value={`${data.rollup.skill_count}`} />
        {data.rollup.failed_runs > 0 && (
          <DomainStat
            label="Failed runs"
            value={`${data.rollup.failed_runs}`}
            tone="warn"
          />
        )}
      </div>
      {/* Bottom row — content */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        <DomainStat label="Entries" value={`${data.content.total_entries}`} />
        {(data.content.changes_by_status['merged'] ?? 0) > 0 && (
          <DomainStat
            label="Changes merged"
            value={`${data.content.changes_by_status['merged']}`}
          />
        )}
        {inFlight > 0 && (
          <DomainStat label="Changes in flight" value={`${inFlight}`} tone="accent" />
        )}
        {(data.content.projects_by_status['active'] ?? 0) > 0 && (
          <DomainStat
            label="Active projects"
            value={`${data.content.projects_by_status['active']}`}
          />
        )}
        {data.content.latest_activity && (
          <DomainStat
            label="Latest activity"
            value={formatRelative(data.content.latest_activity)}
          />
        )}
      </div>
      {data.rollup.by_skill.length > 0 && (
        <details>
          <summary className="tiny subtle" style={{ cursor: 'pointer' }}>
            Per-skill breakdown ({data.rollup.by_skill.length})
          </summary>
          <table className="data-table" style={{ marginTop: 8, width: '100%' }}>
            <thead>
              <tr>
                <th>Skill</th>
                <th>Runs</th>
                <th>Cost</th>
                <th>Wall-time</th>
              </tr>
            </thead>
            <tbody>
              {data.rollup.by_skill.map((s) => (
                <tr key={s.skill}>
                  <td className="mono tiny">{s.skill}</td>
                  <td>{s.count}</td>
                  <td>${s.cost_usd.toFixed(4)}</td>
                  <td>{Math.round(s.duration_ms / 1000)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

function DomainStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'accent';
}) {
  const color =
    tone === 'warn'
      ? 'var(--warn-text)'
      : tone === 'accent'
        ? 'var(--accent-text)'
        : 'var(--text)';
  return (
    <div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color,
        }}
      >
        {value}
      </div>
      <div
        className="tiny subtle"
        style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        {label}
      </div>
    </div>
  );
}
