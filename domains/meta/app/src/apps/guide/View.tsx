// Guide — orientation + reference. Migrated to apps/ + restyled with the
// prototype design system: .page-wide layout, .card per section, hero block,
// keyboard-style chips for quick-start, .btn-ghost for entry links.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MermaidDiagram } from '../../components/MermaidDiagram';
import { useNavigation } from '../../lib/navigation';
import { type Manifest, type ManifestEntry, fetchManifest } from '../../lib/vault';
import { Icons } from '../../shared';
import '../../shared/styles.css';

// Six-layer architecture diagram. Kept as a constant so the source is
// reviewable inline; rendered via the existing MermaidDiagram component.
const ARCHITECTURE_DIAGRAM = `graph TB
  subgraph L1["1 — Interface"]
    direction LR
    CLI["Claude Code CLI"]
    Dash["Dashboard (browser UI)"]
  end
  subgraph L2["2 — Dispatch"]
    Router["/os router skill"]
    OSmd["OS.md intent vocabulary"]
    Router -->|"reads"| OSmd
  end
  subgraph L3["3 — Skills (.claude/skills/)"]
    direction LR
    SMeta["meta-* (scaffold, evolve, brief)"]
    SDom["dev-*, research-*, ..."]
  end
  subgraph L4["4 — MCPs (mcps/ + .mcp.json)"]
    direction LR
    MCustom["OS-built (vault, ...)"]
    MHosted["Hosted (github, ...)"]
  end
  subgraph L5["5 — Domains"]
    direction LR
    DM["meta"]
    DD["development"]
    DR["research"]
  end
  subgraph L6["6 — Memory (Vault)"]
    direction LR
    VR["raw/ — ingest"]
    VW["wiki/ — structured"]
    VO["output/ — artifacts"]
    VR -.curate.-> VW
  end

  L1 ==>|"/os intent"| L2
  L2 ==>|"invokes"| L3
  L3 ==>|"calls tools"| L4
  L3 -.belongs to.-> L5
  L3 ==>|"read/write"| L6
  L4 ==>|"surface"| L6
  L5 -.path-mirrors.-> L6

  Hooks["Hooks (PostToolUse, SessionStart, ...)"] -.observes.-> L3
  Hooks -.observes.-> L6`;

interface Section {
  key: string;
  anchor: string;
  title: string;
  blurb: string;
  prefix: string;
  defaultOpen: boolean;
}

const SECTIONS: Section[] = [
  {
    key: 'walkthroughs',
    anchor: 'walkthroughs',
    title: 'Walkthroughs',
    blurb:
      'Step-by-step guides for the most common OS flows. Start here if you have a concrete task — ingest a repo, add a project, write a change — and want a concrete path through the system.',
    prefix: 'walkthrough-',
    defaultOpen: true,
  },
  {
    key: 'concepts',
    anchor: 'concepts',
    title: 'Core concepts',
    blurb:
      'The fundamentals — what a domain is, what a skill does, when to build an app, how memory works, how the router dispatches, what the primitives are.',
    prefix: 'concept-',
    defaultOpen: true,
  },
  {
    key: 'archetypes',
    anchor: 'archetypes',
    title: 'Memory archetypes',
    blurb:
      'The six entry types that structure your wiki. Pick the right archetype when promoting raw content into wiki/.',
    prefix: 'archetype-',
    defaultOpen: true,
  },
  {
    key: 'standards',
    anchor: 'standards',
    title: 'Standards',
    blurb:
      'Conventions every part of the OS follows — skill format, wiki format, app layout, log formats, scheduled jobs, ingestion. Reference material; you do not need to read these front-to-back.',
    prefix: 'standard-',
    defaultOpen: false,
  },
  {
    key: 'decisions',
    anchor: 'decisions',
    title: 'Architectural decisions',
    blurb:
      'Why the OS is shaped this way. Decisions captured during the build, with alternatives considered and consequences.',
    prefix: 'decision-',
    defaultOpen: false,
  },
];

const QUICK_START: Array<{ id: string; label: string }> = [
  // Tasks first — most users land on /guide wanting to do something.
  { id: 'walkthrough-ingest-repo', label: 'Ingest a repo' },
  { id: 'walkthrough-add-project', label: 'Add a project' },
  { id: 'walkthrough-write-change', label: 'Write a change' },
  // Concepts second — for when you need to understand a primitive first.
  { id: 'concept-domain', label: 'What is a domain?' },
];

const COLLAPSED_KEY = 'agentic-os/guide-collapsed-sections';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.filter((x): x is string => typeof x === 'string'));
      }
    }
  } catch {
    /* unavailable */
  }
  return new Set(SECTIONS.filter((s) => !s.defaultOpen).map((s) => s.key));
}

function shortDescription(snippet: string): string {
  if (!snippet) return '';
  const flat = snippet
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const sentenceEnd = flat.search(/\. [A-Z]/);
  if (sentenceEnd > 0 && sentenceEnd < 140) return flat.slice(0, sentenceEnd + 1);
  return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
}

export default function Guide() {
  const nav = useNavigation();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());

  useEffect(() => {
    fetchManifest()
      .then(setManifest)
      .catch(() => setManifest({ version: 1, generated: null, entries: [] }));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* unavailable */
    }
  }, [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const grouped = useMemo(() => {
    if (!manifest) return null;
    const out: Record<string, ManifestEntry[]> = {};
    for (const section of SECTIONS) {
      out[section.key] = manifest.entries
        .filter((e) => e.id?.startsWith(section.prefix))
        .sort((a, b) => (a.title ?? a.id ?? '').localeCompare(b.title ?? b.id ?? ''));
    }
    return out;
  }, [manifest]);

  function jumpTo(anchor: string) {
    const el = document.getElementById(`guide-${anchor}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (!manifest || !grouped) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 28 }}>
        {/* Main column */}
        <main style={{ minWidth: 0 }}>
          {/* Hero */}
          <div
            className="card"
            style={{
              padding: '28px 32px',
              marginBottom: 18,
              background:
                'linear-gradient(135deg, var(--panel) 0%, color-mix(in oklab, var(--accent) 6%, var(--panel)) 100%)',
            }}
          >
            <h1 className="h1" style={{ marginBottom: 8 }}>
              Guide
            </h1>
            <p className="subtle" style={{ marginBottom: 14, maxWidth: 640 }}>
              A self-extending workflow OS built on Claude Code. Reference and orientation material
              lives here — content is auto-aggregated from{' '}
              <span className="mono">vault/wiki/_seed/meta/</span> so newly-added concepts,
              archetypes, standards, or decisions appear automatically.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="tiny" style={{ marginRight: 6 }}>
                Start here:
              </span>
              {QUICK_START.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => nav.navigateToEntry(q.id)}
                >
                  {q.label}
                  <Icons.ArrowRight size={12} />
                </button>
              ))}
            </div>
          </div>

          {/* Architecture diagram */}
          <div id="guide-architecture" className="card" style={{ marginBottom: 18 }}>
            <div className="card-header">
              <h3 className="card-title">Architecture overview</h3>
            </div>
            <div className="card-body">
              <p className="subtle" style={{ marginBottom: 16 }}>
                The OS works in six layers — like a traditional operating system. You type at the
                top (Interface); the Router dispatches; Skills do the work, calling typed tools via
                MCPs when they need structured access to external services or internal subsystems;
                Skills belong to Domains; and everything reads from / writes to the Memory layer
                (Vault). Hooks observe lifecycle events across layers.
              </p>
              <MermaidDiagram source={ARCHITECTURE_DIAGRAM} />
            </div>
          </div>

          {/* Collapsible sections */}
          {SECTIONS.map((section) => {
            const entries = grouped[section.key];
            if (entries.length === 0) return null;
            const isCollapsed = collapsed.has(section.key);
            return (
              <div
                key={section.key}
                id={`guide-${section.anchor}`}
                className="card"
                style={{ marginBottom: 14 }}
              >
                <div className="card-header" style={{ cursor: 'pointer' }}>
                  <button
                    type="button"
                    onClick={() => toggle(section.key)}
                    aria-expanded={!isCollapsed}
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      color: 'inherit',
                      font: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ color: 'var(--muted)', fontSize: 12 }} aria-hidden>
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                    <h3 className="card-title">{section.title}</h3>
                  </button>
                  <span className="badge muted">{entries.length}</span>
                </div>
                {!isCollapsed && (
                  <div className="card-body">
                    <p className="subtle" style={{ marginBottom: 14 }}>
                      {section.blurb}
                    </p>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {entries.map((e) => (
                        <li key={e.path} style={{ marginBottom: 4 }}>
                          <button
                            type="button"
                            onClick={() => nav.navigateToEntry(e.id ?? '')}
                            style={{
                              width: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              gap: 3,
                              padding: '10px 12px',
                              background: 'transparent',
                              border: '1px solid transparent',
                              borderRadius: 'var(--radius-sm)',
                              color: 'inherit',
                              font: 'inherit',
                              textAlign: 'left',
                              cursor: 'pointer',
                              transition: 'background .12s, border-color .12s',
                            }}
                            onMouseEnter={(ev) => {
                              ev.currentTarget.style.background = 'var(--hover)';
                              ev.currentTarget.style.borderColor = 'var(--border)';
                            }}
                            onMouseLeave={(ev) => {
                              ev.currentTarget.style.background = 'transparent';
                              ev.currentTarget.style.borderColor = 'transparent';
                            }}
                          >
                            <span style={{ fontSize: 13.5, fontWeight: 500 }}>
                              {e.title ?? e.id}
                            </span>
                            <span className="tiny">{shortDescription(e.snippet)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </main>

        {/* TOC sidebar */}
        <aside style={{ position: 'relative' }}>
          <div
            style={{
              position: 'sticky',
              top: 24,
              padding: '14px 0',
            }}
          >
            <div
              className="tiny"
              style={{
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 10,
                color: 'var(--subtle)',
                fontWeight: 600,
              }}
            >
              On this page
            </div>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <li>
                <button
                  type="button"
                  onClick={() => jumpTo('architecture')}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 0,
                    padding: '6px 10px',
                    color: 'var(--muted)',
                    font: 'inherit',
                    fontSize: 12.5,
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--hover)';
                    e.currentTarget.style.color = 'var(--text)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--muted)';
                  }}
                >
                  Architecture
                </button>
              </li>
              {SECTIONS.map((section) => {
                const count = grouped[section.key].length;
                if (count === 0) return null;
                return (
                  <li key={section.key}>
                    <button
                      type="button"
                      onClick={() => jumpTo(section.anchor)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        background: 'transparent',
                        border: 0,
                        padding: '6px 10px',
                        color: 'var(--muted)',
                        font: 'inherit',
                        fontSize: 12.5,
                        borderRadius: 'var(--radius-sm)',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--hover)';
                        e.currentTarget.style.color = 'var(--text)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--muted)';
                      }}
                    >
                      <span>{section.title}</span>
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--subtle)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {count}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
