// Vault — wiki/raw/output browser. Migrated to apps/ + restyled header chrome
// and tabs with the prototype design system. Split-pane structure preserved
// (uses existing dashboard CSS).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ActionRunner } from '../../components/ActionRunner';
import { ConfirmModal } from '../../components/ConfirmModal';
import { EditableMarkdown, Rendered } from '../../components/EditableMarkdown';
import { RawDropzone } from '../../components/RawDropzone';
import { RenameModal } from '../../components/RenameModal';
import { ResizeHandle } from '../../components/ResizeHandle';
import { getJson } from '../../lib/api';
import { buildDeletePrompt, buildRenamePrompt, lastSegment } from '../../lib/destructive';
import { useNavigation } from '../../lib/navigation';
import { formatRelative } from '../../lib/time';
import { useResizable } from '../../lib/useResizable';
import { type Manifest, type ManifestEntry, fetchEntry, fetchManifest } from '../../lib/vault';
import { Icons } from '../../shared';
import '../../shared/styles.css';

const EXPANDED_GROUPS_KEY = 'agentic-os/expanded-wiki-groups';

function loadExpandedWikiGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_GROUPS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* unavailable */
  }
  return new Set();
}

type TabId = 'wiki' | 'raw' | 'output';

// URL scheme (mounted at /vault/* by App.tsx):
//   ''                      → wiki tab (default)
//   'wiki'                  → wiki tab
//   'wiki/entries/<id>'     → wiki tab + entry selected (by manifest id)
//   'entries/<id>'          → legacy alias for above (App.tsx navigateToEntry
//                             still uses this; preserved for compatibility)
//   'raw'                   → raw tab
//   'raw/<path>'            → raw tab + file selected (path under vault/raw/)
//   'output'                → output tab
//   'output/<path>'         → output tab + file selected (path under vault/output/)
//
// Tab + selection are derived from splat — back/forward and direct links
// work without local state. The "Open in Vault" affordance on the Changes
// app's Plan tab uses this to deep-link to the specific output file.
function parseVaultRoute(splat: string): { tab: TabId; subpath: string } {
  if (!splat || splat === 'wiki' || splat.startsWith('wiki/') || splat.startsWith('entries/')) {
    // wiki tab; subpath is whatever follows the prefix (or empty)
    const rest = splat.startsWith('wiki/')
      ? splat.slice('wiki/'.length)
      : splat === 'wiki'
        ? ''
        : splat;
    return { tab: 'wiki', subpath: rest };
  }
  if (splat === 'raw' || splat.startsWith('raw/')) {
    return { tab: 'raw', subpath: splat === 'raw' ? '' : splat.slice('raw/'.length) };
  }
  if (splat === 'output' || splat.startsWith('output/')) {
    return { tab: 'output', subpath: splat === 'output' ? '' : splat.slice('output/'.length) };
  }
  // Unknown prefix — default to wiki tab.
  return { tab: 'wiki', subpath: '' };
}

export default function Vault() {
  const navigate = useNavigate();
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const { tab, subpath } = parseVaultRoute(splat);
  const setTab = useCallback(
    (t: TabId) => {
      navigate(t === 'wiki' ? '/vault' : `/vault/${t}`);
    },
    [navigate],
  );
  const [rawRefreshKey, setRawRefreshKey] = useState(0);

  return (
    <div
      className="view vault"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '20px 24px 0',
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Vault</h1>
      </header>
      <div
        className="tabs"
        style={{
          padding: '12px 24px 0',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 4,
        }}
      >
        <TabButton id="wiki" current={tab} onClick={setTab} />
        <TabButton id="raw" current={tab} onClick={setTab} />
        <TabButton id="output" current={tab} onClick={setTab} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'wiki' && <WikiBrowser />}
        {tab === 'raw' && (
          <>
            <div style={{ padding: '16px 24px 0' }}>
              <RawDropzone onUploaded={() => setRawRefreshKey((k) => k + 1)} />
            </div>
            <FileLister
              listEndpoint="/api/vault/raw"
              urlPrefix="raw"
              filePath={subpath || null}
              onSelectFile={(p) => navigate(p ? `/vault/raw/${p}` : '/vault/raw')}
              refreshKey={rawRefreshKey}
            />
          </>
        )}
        {tab === 'output' && (
          <FileLister
            listEndpoint="/api/vault/output"
            urlPrefix="output"
            filePath={subpath || null}
            onSelectFile={(p) => navigate(p ? `/vault/output/${p}` : '/vault/output')}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  id,
  current,
  onClick,
}: {
  id: TabId;
  current: TabId;
  onClick: (t: TabId) => void;
}) {
  return (
    <button
      type="button"
      className={id === current ? 'tab active' : 'tab'}
      onClick={() => onClick(id)}
    >
      {id.charAt(0).toUpperCase() + id.slice(1)}
    </button>
  );
}

type Destructive = { kind: 'rename'; path: string } | { kind: 'delete'; path: string };

function WikiBrowser() {
  const nav = useNavigation();
  const picker = useResizable({
    storageKey: 'vault-picker',
    defaultWidth: 300,
    min: 200,
    max: 600,
  });
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [archetype, setArchetype] = useState<string>('all');
  const [domain, setDomain] = useState<string>('all');
  const [search, setSearch] = useState<string>('');

  // URL-backed selection (mounted at /vault/* by App.tsx).
  //   ''               → no entry selected
  //   'entries/<id>'   → that entry's path resolved via the manifest
  // The id is stable across renames; we look up the file path from the
  // manifest each render so renames don't break shareable links.
  const navigate = useNavigate();
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const selectedEntryId = splat.startsWith('entries/') ? splat.slice('entries/'.length) : null;
  const selected = useMemo<string | null>(() => {
    if (!selectedEntryId || !manifest) return null;
    return manifest.entries.find((e) => e.id === selectedEntryId)?.path ?? null;
  }, [selectedEntryId, manifest]);
  const setSelected = useCallback(
    (path: string | null) => {
      if (!path) {
        navigate('/vault');
        return;
      }
      const entry = manifest?.entries.find((e) => e.path === path);
      navigate(entry ? `/vault/entries/${entry.id}` : '/vault');
    },
    [manifest, navigate],
  );

  const [content, setContent] = useState<string>('');
  const [missingWikilink, setMissingWikilink] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => loadExpandedWikiGroups());

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...expandedGroups]));
    } catch {
      /* unavailable */
    }
  }, [expandedGroups]);

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const [destructive, setDestructive] = useState<Destructive | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingTitle, setPendingTitle] = useState<string>('Working…');

  const refresh = useCallback(() => {
    fetchManifest()
      .then(setManifest)
      .catch(() => setManifest({ version: 1, generated: null, entries: [] }));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Side effects when arriving at the Vault view via nav.navigateToEntry(id)
  // — e.g. a wikilink click. URL routing already drives the selection (see
  // selectedEntryId above); this effect just clears filters and expands the
  // relevant tree groups so the target entry is visible in the picker.
  useEffect(() => {
    if (!manifest || !nav.targetEntryId) return;
    const id = nav.targetEntryId;
    const hit = manifest.entries.find((e) => e.id === id);
    if (hit) {
      setArchetype('all');
      setDomain('all');
      setSearch('');
      setMissingWikilink(null);
      const d = (hit.domain ?? '(no domain)') as string;
      const a = (hit.type ?? '(no archetype)') as string;
      setExpandedGroups((prev) => {
        const next = new Set(prev);
        next.add(d);
        next.add(`${d}/${a}`);
        return next;
      });
    } else {
      setMissingWikilink(id);
    }
    nav.clearTargetEntry();
  }, [manifest, nav.targetEntryId, nav.clearTargetEntry]);

  const archetypes = useMemo(() => {
    if (!manifest) return [];
    return Array.from(new Set(manifest.entries.map((e) => e.type ?? 'unknown')))
      .filter((x): x is string => typeof x === 'string')
      .sort();
  }, [manifest]);

  const domains = useMemo(() => {
    if (!manifest) return [];
    return Array.from(new Set(manifest.entries.map((e) => e.domain ?? 'unknown')))
      .filter((x): x is string => typeof x === 'string')
      .sort();
  }, [manifest]);

  const filtered = useMemo(() => {
    if (!manifest) return [];
    const q = search.toLowerCase();
    return manifest.entries.filter((e) => {
      if (archetype !== 'all' && e.type !== archetype) return false;
      if (domain !== 'all' && e.domain !== domain) return false;
      if (q) {
        const hay = `${e.title ?? ''} ${e.id ?? ''} ${e.snippet}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [manifest, archetype, domain, search]);

  const hasActiveFilter = archetype !== 'all' || domain !== 'all' || search.trim().length > 0;

  const grouped = useMemo(() => {
    const byDomain = new Map<string, Map<string, ManifestEntry[]>>();
    for (const entry of filtered) {
      const d = (entry.domain ?? '(no domain)') as string;
      const a = (entry.type ?? '(no archetype)') as string;
      if (!byDomain.has(d)) byDomain.set(d, new Map());
      const inner = byDomain.get(d);
      if (!inner) continue;
      if (!inner.has(a)) inner.set(a, []);
      inner.get(a)?.push(entry);
    }
    return byDomain;
  }, [filtered]);

  function isExpanded(key: string): boolean {
    if (hasActiveFilter) return true;
    return expandedGroups.has(key);
  }

  useEffect(() => {
    if (!selected) return;
    fetchEntry(selected)
      .then((e) => setContent(e.content))
      .catch(() => setContent('(could not read entry)'));
  }, [selected]);

  if (!manifest) {
    return (
      <div style={{ padding: 24 }}>
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  const selectedEntry = selected ? manifest.entries.find((e) => e.path === selected) : null;
  const siblingSlugs = selected
    ? manifest.entries
        .filter((e) => {
          const dirA = e.path.substring(0, e.path.lastIndexOf('/'));
          const dirB = selected.substring(0, selected.lastIndexOf('/'));
          return dirA === dirB && e.path !== selected;
        })
        .map((e) => lastSegment(e.path))
    : [];

  function runRename(newName: string) {
    if (!destructive || destructive.kind !== 'rename') return;
    setPendingTitle(`Renaming entry → ${newName}…`);
    setPendingPrompt(buildRenamePrompt('wiki-entry', destructive.path, newName));
    setDestructive(null);
  }

  function runDelete() {
    if (!destructive || destructive.kind !== 'delete') return;
    setPendingTitle('Deleting entry…');
    setPendingPrompt(buildDeletePrompt('wiki-entry', destructive.path));
    setDestructive(null);
  }

  return (
    <div
      className="wiki-browser"
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      {missingWikilink && (
        <div
          className="card"
          style={{
            margin: '16px 24px 0',
            padding: '10px 14px',
            background: 'var(--warning-bg)',
            borderColor: 'var(--warning-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ flex: 1, fontSize: 13 }}>
            No wiki entry found with id <code className="mono">{missingWikilink}</code>. The link
            may point to a skill, domain, or an entry that hasn't been created yet.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setMissingWikilink(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 24px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <select
          value={archetype}
          onChange={(e) => setArchetype(e.target.value)}
          style={{
            background: 'var(--bg-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 12.5,
          }}
        >
          <option value="all">All archetypes</option>
          {archetypes.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          style={{
            background: 'var(--bg-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 12.5,
          }}
        >
          <option value="all">All domains</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search title or snippet…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: 'var(--bg-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12.5,
            minWidth: 220,
            flex: 1,
            maxWidth: 320,
          }}
        />
        <span className="tiny" style={{ marginLeft: 'auto' }}>
          {filtered.length} / {manifest.entries.length}
        </span>
      </div>
      <div
        className="split"
        style={{ gridTemplateColumns: `${picker.width}px 1fr`, flex: 1, minHeight: 0 }}
      >
        <div className="picker-column">
          <ul className="picker tall grouped">
            {[...grouped.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([domainName, archetypesMap]) => {
                const archetypeEntries = [...archetypesMap.entries()].sort(([a], [b]) =>
                  a.localeCompare(b),
                );
                const totalInDomain = archetypeEntries.reduce(
                  (acc, [, arr]) => acc + arr.length,
                  0,
                );
                const isDomainExpanded = isExpanded(domainName);
                return (
                  <li className="skill-group" key={domainName}>
                    <button
                      type="button"
                      className="skill-group-header"
                      onClick={() => toggleGroup(domainName)}
                    >
                      <span className="tree-chevron-inline">{isDomainExpanded ? '▼' : '▶'}</span>
                      <span className="skill-group-label">{domainName}</span>
                      <span className="skill-group-count">{totalInDomain}</span>
                    </button>
                    {isDomainExpanded && (
                      <ul className="skill-group-items">
                        {archetypeEntries.map(([archetypeName, entries]) => {
                          const groupKey = `${domainName}/${archetypeName}`;
                          const isArchetypeExpanded = isExpanded(groupKey);
                          return (
                            <li className="skill-group" key={groupKey}>
                              <button
                                type="button"
                                className="skill-group-header skill-group-header-sub"
                                onClick={() => toggleGroup(groupKey)}
                              >
                                <span className="tree-chevron-inline">
                                  {isArchetypeExpanded ? '▼' : '▶'}
                                </span>
                                <span className="skill-group-label">{archetypeName}</span>
                                <span className="skill-group-count">{entries.length}</span>
                              </button>
                              {isArchetypeExpanded && (
                                <ul className="skill-group-items">
                                  {entries.map((e) => (
                                    <li key={e.path}>
                                      <button
                                        type="button"
                                        className={e.path === selected ? 'active' : ''}
                                        onClick={() => setSelected(e.path)}
                                      >
                                        <div className="row1">
                                          <span className="name">{e.title ?? e.id}</span>
                                        </div>
                                        <div className="desc">{e.snippet.slice(0, 100)}…</div>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            {filtered.length === 0 && (
              <li className="subtle" style={{ padding: 12, fontSize: 12.5 }}>
                No entries match.
              </li>
            )}
          </ul>
          <ResizeHandle onMouseDown={picker.startDrag} />
        </div>
        <div className="detail">
          {selected ? (
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
              <EditableMarkdown path={selected} content={content} onSaved={setContent} />
              {selectedEntry &&
                (selectedEntry.type === 'change' || selectedEntry.type === 'pr-review') && (
                  <RecentActivityPanel
                    entryId={selectedEntry.id as string}
                    entryType={selectedEntry.type as 'change' | 'pr-review'}
                  />
                )}
            </>
          ) : (
            <p className="subtle" style={{ padding: 18 }}>
              Pick an entry to read.
            </p>
          )}
        </div>
      </div>

      {destructive?.kind === 'rename' && (
        <RenameModal
          title="Rename wiki entry"
          currentName={(selectedEntry?.id as string) ?? lastSegment(destructive.path)}
          targetPath={destructive.path}
          taken={siblingSlugs}
          onCancel={() => setDestructive(null)}
          onConfirm={runRename}
        />
      )}

      {destructive?.kind === 'delete' && (
        <ConfirmModal
          title="Delete wiki entry?"
          message={
            <>
              <p>
                This will permanently delete <code>{destructive.path}</code>.
              </p>
              <p className="subtle">
                <code>[[{(selectedEntry?.id as string) ?? lastSegment(destructive.path)}]]</code>{' '}
                references in other entries will become dangling links.
              </p>
            </>
          }
          requireType={(selectedEntry?.id as string) ?? lastSegment(destructive.path)}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDestructive(null)}
          onConfirm={runDelete}
        />
      )}

      {pendingPrompt && (
        <ActionRunner
          title={pendingTitle}
          prompt={pendingPrompt}
          onClose={() => {
            setPendingPrompt(null);
            setSelected(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function FileLister({
  listEndpoint,
  urlPrefix,
  filePath,
  onSelectFile,
  refreshKey = 0,
}: {
  listEndpoint: string;
  // URL prefix the parent uses ("raw" or "output"). Used to derive the
  // file-path slug — files in the API are returned as full paths like
  // "vault/raw/...". The URL carries just the part after the tab prefix.
  urlPrefix: string;
  // Currently-selected file path (URL-driven). Format matches the URL slug:
  // the portion after the tab prefix (e.g. "foo/bar.md" for /vault/raw/foo/bar.md).
  // The component prefixes back to the full path for fetching.
  filePath: string | null;
  // Called when a row is clicked. Pass the URL slug (no prefix), or null
  // to deselect. Parent updates the URL.
  onSelectFile: (slug: string | null) => void;
  refreshKey?: number;
}) {
  const picker = useResizable({
    storageKey: 'vault-picker',
    defaultWidth: 300,
    min: 200,
    max: 600,
  });
  const [files, setFiles] = useState<string[]>([]);
  const [content, setContent] = useState<string>('');
  // For markdown files: render formatted by default. The "Raw" toggle drops
  // back to the <pre> view for users who want to inspect raw markdown.
  const [showRaw, setShowRaw] = useState(false);

  // Resolve URL slug → full vault-relative path. Files are stored under
  // vault/<urlPrefix>/... so the slug carries everything after that root.
  const selectedFull = filePath ? `vault/${urlPrefix}/${filePath}` : null;
  const isMarkdown = selectedFull?.endsWith('.md') ?? false;

  useEffect(() => {
    getJson<{ files: string[] }>(listEndpoint)
      .then((d) => setFiles(d.files))
      .catch(() => setFiles([]));
  }, [listEndpoint, refreshKey]);

  useEffect(() => {
    if (!selectedFull) {
      setContent('');
      return;
    }
    fetchEntry(selectedFull)
      .then((e) => setContent(e.content))
      .catch(() => setContent('(could not read)'));
  }, [selectedFull]);

  return (
    <div
      className="split"
      style={{ gridTemplateColumns: `${picker.width}px 1fr`, flex: 1, minHeight: 0 }}
    >
      <div className="picker-column">
        <ul className="picker tall">
          {files.map((f) => {
            // f is the full vault-relative path (e.g. "vault/output/foo.md");
            // the URL slug is what follows vault/<urlPrefix>/.
            const slug = f.replace(new RegExp(`^vault/${urlPrefix}/`), '');
            const isActive = f === selectedFull;
            return (
              <li key={f}>
                <button
                  type="button"
                  className={isActive ? 'active' : ''}
                  onClick={() => onSelectFile(slug)}
                >
                  {f}
                </button>
              </li>
            );
          })}
          {files.length === 0 && (
            <li className="subtle" style={{ padding: 12, fontSize: 12.5 }}>
              (empty)
            </li>
          )}
        </ul>
        <ResizeHandle onMouseDown={picker.startDrag} />
      </div>
      <div className="detail">
        {selectedFull ? (
          <>
            {isMarkdown && (
              <div className="detail-toolbar">
                <button
                  type="button"
                  className={showRaw ? '' : 'primary'}
                  onClick={() => setShowRaw(false)}
                  title="Render markdown with headings, lists, code blocks, etc."
                >
                  Rendered
                </button>
                <button
                  type="button"
                  className={showRaw ? 'primary' : ''}
                  onClick={() => setShowRaw(true)}
                  title="Show the raw markdown source"
                >
                  Raw
                </button>
              </div>
            )}
            {isMarkdown && !showRaw ? (
              <Rendered content={content} />
            ) : (
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 18,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--text-2)',
                }}
              >
                {content}
              </pre>
            )}
          </>
        ) : (
          <p className="subtle" style={{ padding: 18 }}>
            Pick a file.
          </p>
        )}
      </div>
    </div>
  );
}

// Collapsible "Recent activity" panel rendered below a change or pr-review
// entry's content. Reads from /api/events-db filtered by change_id (for
// change entries) or review_id (for pr-review entries — matches against
// json_extract(raw, '$.args.review')). Doesn't mutate the entry body —
// the body stays human-curated intent; the events.db is the action log.
interface ActivityEvent {
  id: number;
  ts: string;
  action: string;
  skill: string | null;
  status: string | null;
  duration_ms: number | null;
}
function RecentActivityPanel({
  entryId,
  entryType,
}: {
  entryId: string;
  entryType: 'change' | 'pr-review';
}) {
  const [open, setOpen] = useState(true);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const param = entryType === 'change' ? 'change_id' : 'review_id';
    const url = `/api/events-db?${param}=${encodeURIComponent(entryId)}&limit=50`;
    getJson<{ events: ActivityEvent[] }>(url)
      .then((r) => {
        if (!cancelled) setEvents(r.events);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, entryType]);

  const count = events?.length ?? 0;

  return (
    <div
      className="card"
      style={{ marginTop: 18, padding: 0, fontSize: 13 }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="card-header"
        style={{
          background: 'transparent',
          border: 0,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        {open ? (
          <Icons.ChevronDown size={14} style={{ color: 'var(--muted)' }} />
        ) : (
          <Icons.ChevronRight size={14} style={{ color: 'var(--muted)' }} />
        )}
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Recent activity</h4>
        <span className="tiny" style={{ color: 'var(--muted)' }}>
          {loading ? 'loading…' : `${count} event${count !== 1 ? 's' : ''}`}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 14px' }}>
          {!loading && count === 0 && (
            <p className="subtle" style={{ margin: 0, fontSize: 12.5 }}>
              No events recorded for this entry yet.
            </p>
          )}
          {count > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {events?.map((e) => {
                const ok = e.status === 'success' || e.status === null;
                const color = ok ? 'var(--text-2)' : 'var(--danger-text)';
                return (
                  <li
                    key={e.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr 1fr',
                      gap: 12,
                      padding: '6px 0',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 12.5,
                      alignItems: 'center',
                    }}
                  >
                    <span
                      className="mono"
                      style={{ color: 'var(--muted)' }}
                      title={e.ts}
                    >
                      {formatRelative(e.ts)}
                    </span>
                    <span className="mono" style={{ color, fontWeight: 500 }}>
                      {e.action}
                    </span>
                    <span className="tiny" style={{ color: 'var(--muted)' }}>
                      {e.skill ? `via ${e.skill}` : ''}
                      {e.duration_ms != null && e.duration_ms > 0
                        ? `${e.skill ? ' · ' : ''}${(e.duration_ms / 1000).toFixed(1)}s`
                        : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
