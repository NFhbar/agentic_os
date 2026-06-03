import type React from 'react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ResizeHandle } from './components/ResizeHandle';
import { RunDrawer } from './components/RunDrawer';
import { useDesktopNotifications } from './lib/desktop-notifications';
import { DispatchProvider, useDispatch } from './lib/dispatch';
import { NavigationContext, type ViewId } from './lib/navigation';
import { useResizable } from './lib/useResizable';
import { Icons } from './shared';
import type { DiscoveredApp } from './shell';
import { discoverApps } from './shell';

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ReactElement;
}

// Per-domain curated order for primary apps. Keys are manifest.domain values;
// values list the muscle-memory ordering for that domain. Domains not listed
// here get their apps in discovery (alphabetical) order. Apps inside a listed
// domain that aren't in the array fall in after — so adding a new app under
// apps/ "just works" without touching this file.
const DOMAIN_ORDER: Record<string, ViewId[]> = {
  meta: [
    'overview',
    'projects',
    'changes',
    'domains',
    'skills',
    'commands',
    'notifications',
    'schedules',
    'processes',
    'vault',
    'activity',
    'insights',
    'curation',
    'mcps',
  ],
};

// Order in which domain sections appear in the sidebar. Domains not listed
// fall to the bottom (still above the utility "Reference" section).
const DOMAIN_SECTION_ORDER = ['meta', 'development', 'research', 'ops'];

// Display labels for domain sidebar headers. Falls back to capitalized
// domain id when not listed.
const DOMAIN_LABELS: Record<string, string> = {
  meta: 'Workspace',
  development: 'Development',
};

const UTILITY_ORDER: ViewId[] = ['router', 'health', 'guide'];

const APP_ICONS: Record<string, React.ReactElement> = {
  overview: <Icons.Home size={15} />,
  projects: <Icons.Folder size={15} />,
  changes: <Icons.GitBranch size={15} />,
  'pr-review': <Icons.GitPullRequest size={15} />,
  research: <Icons.Search size={15} />,
  domains: <Icons.Database size={15} />,
  skills: <Icons.Zap size={15} />,
  commands: <Icons.Code size={15} />,
  notifications: <Icons.Bell size={15} />,
  schedules: <Icons.Clock size={15} />,
  processes: <Icons.Activity size={15} />,
  vault: <Icons.File size={15} />,
  activity: <Icons.Activity size={15} />,
  insights: <Icons.Sparkles size={15} />,
  curation: <Icons.Check size={15} />,
  mcps: <Icons.Cpu size={15} />,
  router: <Icons.ArrowRight size={15} />,
  health: <Icons.Shield size={15} />,
  guide: <Icons.Bug size={15} />,
};

const SIDEBAR_COLLAPSED_KEY = 'agentic-os/sidebar-collapsed';

// Manifest discovery — synchronous (eager) at module load. The full nav is
// derived from discovered app manifests; each manifest's View is lazy,
// wrapped in React.lazy for Suspense.
const DISCOVERED_APPS = discoverApps();
const APP_LAZY_VIEWS: Record<
  string,
  React.LazyExoticComponent<React.ComponentType>
> = Object.fromEntries(DISCOVERED_APPS.map(({ manifest }) => [manifest.id, lazy(manifest.View)]));

function orderApps(apps: DiscoveredApp[], order: ViewId[] | undefined): DiscoveredApp[] {
  const indexOf = new Map((order ?? []).map((id, i) => [id, i]));
  return [...apps].sort((a, b) => {
    const ai = indexOf.get(a.manifest.id as ViewId) ?? Number.MAX_SAFE_INTEGER;
    const bi = indexOf.get(b.manifest.id as ViewId) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

function domainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] ?? domain.charAt(0).toUpperCase() + domain.slice(1);
}

function toNavItem({ manifest }: DiscoveredApp): NavItem {
  return {
    id: manifest.id as ViewId,
    label: manifest.label,
    icon: APP_ICONS[manifest.id] ?? <Icons.File size={15} />,
  };
}

interface DomainSection {
  domain: string;
  label: string;
  items: NavItem[];
}

export function App() {
  useDesktopNotifications();
  // DispatchProvider wraps the rest of the app so every page can dispatch
  // skill runs via useDispatch(). Mount RunDrawer once at the dashboard root
  // so it can slide in from any page (its open/filter state lives in the
  // provider — toggling is just setDrawerOpen(true)).
  return (
    <DispatchProvider>
      <AppShell />
      <RunDrawer />
    </DispatchProvider>
  );
}

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  // Derive the active view from the URL's first path segment. `/changes/add-license`
  // → view = 'changes'. Falls back to 'overview' for `/` (which BrowserRouter also
  // redirects below via the <Navigate> route).
  const view: ViewId = useMemo(() => {
    const first = location.pathname.split('/').filter(Boolean)[0];
    return (first as ViewId) || 'overview';
  }, [location.pathname]);

  const [targetEntryId, setTargetEntryId] = useState<string | null>(null);
  const [targetSkillName, setTargetSkillName] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* localStorage may be unavailable */
    }
  }, [collapsed]);

  // setView is kept as a function shape (matches the legacy NavigationApi) so
  // existing callers don't need to learn react-router. Implementation just
  // routes to the app's root path. Per-app entity selection is handled by the
  // app's own internal use of useParams/useNavigate.
  const setView = useCallback(
    (v: ViewId) => {
      navigate(`/${v}`);
    },
    [navigate],
  );

  const navigateToEntry = useCallback(
    (id: string) => {
      // Set the transient signal AND navigate to the entry URL. The transient
      // signal still fires the Vault view's side effects (clear filters,
      // expand the relevant tree groups, surface missing-wikilink). The URL
      // is the source of truth for which entry is open.
      setTargetEntryId(id);
      navigate(`/vault/entries/${id}`);
    },
    [navigate],
  );

  const clearTargetEntry = useCallback(() => setTargetEntryId(null), []);

  const navigateToSkill = useCallback(
    (name: string) => {
      setTargetSkillName(name);
      navigate(`/skills/${name}`);
    },
    [navigate],
  );

  const clearTargetSkill = useCallback(() => setTargetSkillName(null), []);

  // Group primary apps by their manifest.domain into separate sidebar
  // sections. Domain section order respects DOMAIN_SECTION_ORDER; unknown
  // domains fall to the end. Utility apps remain a single "Reference" group
  // below all primary sections.
  const { sections, utility } = useMemo(() => {
    const primaryApps = DISCOVERED_APPS.filter((a) => a.manifest.navGroup !== 'utility');
    const utilityApps = DISCOVERED_APPS.filter((a) => a.manifest.navGroup === 'utility');

    const byDomain = new Map<string, DiscoveredApp[]>();
    for (const app of primaryApps) {
      const d = app.manifest.domain;
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)?.push(app);
    }

    const sectionOrderIdx = new Map(DOMAIN_SECTION_ORDER.map((d, i) => [d, i]));
    const sortedDomains = [...byDomain.keys()].sort((a, b) => {
      const ai = sectionOrderIdx.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bi = sectionOrderIdx.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });

    const sections: DomainSection[] = sortedDomains.map((domain) => ({
      domain,
      label: domainLabel(domain),
      items: orderApps(byDomain.get(domain) ?? [], DOMAIN_ORDER[domain]).map(toNavItem),
    }));

    return {
      sections,
      utility: orderApps(utilityApps, UTILITY_ORDER).map(toNavItem),
    };
  }, []);

  const sidebar = useResizable({
    storageKey: 'main-sidebar',
    defaultWidth: 232,
    min: 160,
    max: 480,
  });

  function renderItem(v: NavItem) {
    return (
      <NavLink
        key={v.id}
        to={`/${v.id}`}
        // NavLink defaults to end:false — `/changes` stays "active" for `/changes/add-license`,
        // which is the behavior we want for the sidebar item highlight. NavLink auto-sets
        // `aria-current="page"` when active, which the existing CSS already styles.
        className="sb-item"
        title={collapsed ? v.label : undefined}
      >
        <span className="sb-icon">{v.icon}</span>
        <span className="sb-label">{v.label}</span>
      </NavLink>
    );
  }

  const dashboardStyle = collapsed ? undefined : { gridTemplateColumns: `${sidebar.width}px 1fr` };

  return (
    <NavigationContext.Provider
      value={{
        view,
        setView,
        targetEntryId,
        navigateToEntry,
        clearTargetEntry,
        targetSkillName,
        navigateToSkill,
        clearTargetSkill,
      }}
    >
      <div
        className="dashboard"
        data-sidebar={collapsed ? 'collapsed' : undefined}
        style={dashboardStyle}
      >
        <aside className="sidebar">
          <div className="sb-head">
            <div className="sb-logo">OS</div>
            <div className="sb-titles" style={{ minWidth: 0 }}>
              <div className="sb-title">Agentic OS</div>
              <div className="sb-sub">self-extending workflow</div>
            </div>
          </div>
          <nav className="sb-nav">
            {sections.map((s) => (
              <div key={s.domain}>
                <div className="sb-section-label">{s.label}</div>
                {s.items.map(renderItem)}
              </div>
            ))}
            {utility.length > 0 && <div className="sb-section-label">Reference</div>}
            {utility.map(renderItem)}
          </nav>
          <div className="sb-foot">
            <RunsBadge collapsed={collapsed} />
            <button
              type="button"
              className="sb-collapse-btn"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <Icons.ChevronRight size={15} /> : <Icons.ChevronLeft size={15} />}
            </button>
          </div>
          {!collapsed && <ResizeHandle onMouseDown={sidebar.startDrag} />}
        </aside>
        <main className="content">
          <Suspense
            fallback={
              <div className="placeholder">
                <p>Loading…</p>
              </div>
            }
          >
            <Routes>
              {/* Root → overview. Replace (not push) so the back button skips it. */}
              <Route path="/" element={<Navigate to="/overview" replace />} />
              {/* One route per discovered app, with a wildcard suffix so each app
                  can manage its own sub-routes (e.g. /changes/:id, /pr-review/reviews/:id). */}
              {DISCOVERED_APPS.map(({ manifest }) => {
                const View = APP_LAZY_VIEWS[manifest.id];
                return <Route key={manifest.id} path={`/${manifest.id}/*`} element={<View />} />;
              })}
              <Route path="*" element={<Placeholder view={view} />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </NavigationContext.Provider>
  );
}

function Placeholder({ view }: { view: ViewId }) {
  return (
    <div className="placeholder">
      <h2>{view.charAt(0).toUpperCase() + view.slice(1)}</h2>
      <p>Coming soon.</p>
    </div>
  );
}

// Sidebar foot button — shows the count of currently-running skill runs and
// toggles the global run drawer. Driven entirely by the DispatchProvider's
// polled `runs` list, so no extra fetching here.
function RunsBadge({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const { runs, drawerOpen, setDrawerOpen, setDrawerFilter } = useDispatch();
  const running = runs.filter((r) => r.state === 'running' || r.state === 'queued').length;
  return (
    <button
      type="button"
      className="sb-runs-btn"
      onClick={() => {
        if (running === 0) {
          // No active runs → take the user to the Processes page (history).
          navigate('/processes');
          return;
        }
        // Drop any per-page filter and pop the drawer so the user sees
        // everything that's running.
        setDrawerFilter({ state: 'running' });
        setDrawerOpen(!drawerOpen);
      }}
      title={
        running > 0
          ? `${running} skill run${running !== 1 ? 's' : ''} in flight — click to open the run drawer`
          : 'Open the Processes page (history of recent runs)'
      }
      aria-label={`Open runs (${running} active)`}
    >
      <Icons.Activity size={14} />
      {!collapsed && <span className="sb-runs-label">Runs</span>}
      {running > 0 && <span className="sb-runs-count">{running}</span>}
    </button>
  );
}
