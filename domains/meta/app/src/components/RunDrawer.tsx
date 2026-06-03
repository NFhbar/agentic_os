// RunDrawer — bottom-docked terminal-style panel that lists runs matching
// `filter`. Driven by the dispatch provider's `runs` list (already polled
// cross-app) so the drawer is just a presentation layer over that state.
//
// The user can drag the top edge to resize the panel; height is persisted
// to localStorage so the layout survives reloads.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch } from '../lib/dispatch';
import type { RunFilter, RunRecord } from '../lib/runs';
import { RunRow } from './RunRow';

function describeFilter(f: RunFilter): string {
  if (f.change_id) return `Runs for change ${f.change_id}`;
  if (f.project) return `Runs for project ${f.project}`;
  if (f.repo) return `Runs for repo ${f.repo}`;
  if (f.skill) return `Runs for ${f.skill}`;
  if (f.state) return `Runs · ${f.state}`;
  return 'All runs';
}

function matchesFilter(r: RunRecord, f: RunFilter): boolean {
  if (f.state && r.state !== f.state) return false;
  if (f.skill && r.skill !== f.skill) return false;
  if (f.change_id && r.change_id !== f.change_id) return false;
  if (f.project && r.project !== f.project) return false;
  if (f.repo && r.repo !== f.repo) return false;
  if (f.domain && r.domain !== f.domain) return false;
  return true;
}

// Drawer-height bounds. Matches the CSS clamps in `.run-drawer` (min-height,
// max-height) so the drag handle can never push the panel outside what the
// stylesheet permits.
const MIN_HEIGHT_PX = 220;
const HEIGHT_KEY = 'agentic-os/run-drawer-height';
// Default sized to a reasonable terminal — ~40vh, clamped at 280px so a
// small viewport still has a usable panel even before the user drags.
function defaultHeightPx(): number {
  if (typeof window === 'undefined') return 320;
  return Math.max(MIN_HEIGHT_PX, Math.round(window.innerHeight * 0.4));
}
function maxHeightPx(): number {
  if (typeof window === 'undefined') return 1000;
  // Mirrors the CSS max-height: 70vh cap.
  return Math.round(window.innerHeight * 0.7);
}

export function RunDrawer() {
  const { drawerOpen, setDrawerOpen, drawerFilter, runs } = useDispatch();
  const filtered = useMemo(
    () => runs.filter((r) => matchesFilter(r, drawerFilter)),
    [runs, drawerFilter],
  );

  // Persisted drawer height (px). Lazy-init from localStorage; clamp on read
  // to the current viewport's bounds so a stale value can't overflow if the
  // user resized the window since last session.
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 320;
    try {
      const raw = window.localStorage.getItem(HEIGHT_KEY);
      const parsed = raw !== null ? Number(raw) : Number.NaN;
      if (Number.isFinite(parsed)) {
        return Math.min(Math.max(MIN_HEIGHT_PX, parsed), maxHeightPx());
      }
    } catch {
      /* unavailable */
    }
    return defaultHeightPx();
  });

  // Persist height changes. Debounce-free is fine here — setHeight only fires
  // on mouse move, which is already throttled by the browser to RAF cadence.
  useEffect(() => {
    try {
      window.localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      /* unavailable */
    }
  }, [height]);

  // Drag handler for the top-edge resize bar. The handle sits at the very
  // top of the panel; dragging UP grows the drawer, DOWN shrinks it.
  // Implementation note: capture startY + startHeight on mousedown, then
  // listen on the window so the drag continues even if the cursor leaves
  // the handle's box.
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStateRef.current = { startY: e.clientY, startHeight: height };

      function onMove(ev: MouseEvent) {
        const state = dragStateRef.current;
        if (!state) return;
        // Drag UP (decreasing clientY) → grow drawer.
        const delta = state.startY - ev.clientY;
        const next = Math.min(
          Math.max(MIN_HEIGHT_PX, state.startHeight + delta),
          maxHeightPx(),
        );
        setHeight(next);
      }
      function onUp() {
        dragStateRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height],
  );

  return (
    <aside
      className={`run-drawer${drawerOpen ? ' open' : ''}`}
      aria-hidden={!drawerOpen}
      style={{ height: `${height}px` }}
    >
      {/* Top-edge resize handle. Thin strip with a row-resize cursor; the
       * inner pill is a visual affordance only. */}
      <button
        type="button"
        className="run-drawer-resize"
        onMouseDown={startDrag}
        aria-label="Resize run drawer"
        title="Drag to resize"
      >
        <span className="run-drawer-resize-pill" />
      </button>
      <header className="run-drawer-head">
        <span className="run-drawer-title">{describeFilter(drawerFilter)}</span>
        <span className="tiny">{filtered.length}</span>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setDrawerOpen(false)}
          aria-label="Close drawer"
          title="Close"
        >
          ×
        </button>
      </header>
      <div className="run-drawer-body">
        {filtered.length === 0 ? (
          <p className="subtle">No runs match this view.</p>
        ) : (
          filtered.map((r) => <RunRow key={r.id} run={r} compact />)
        )}
      </div>
    </aside>
  );
}
