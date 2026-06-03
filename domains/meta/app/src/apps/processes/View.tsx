// Processes — global Processes page. Lists every skill run with filters by
// state, skill, change. Each row uses the same RunRow component the drawer
// uses, so live + historical runs share rendering + live SSE attach.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RunRow } from '../../components/RunRow';
import { useDispatch } from '../../lib/dispatch';
import { type RunRecord, type RunState, getRun } from '../../lib/runs';
import '../../shared/styles.css';

// URL filter taxonomy: /processes (all), /processes/running, /processes/done,
// /processes/failed, /processes/cancelled, /processes/skill/:skill,
// /processes/change/:change. Keep the splat parser tiny — anything else
// falls back to "all".
function parseFilter(splat: string | undefined): {
  state?: RunState;
  skill?: string;
  change?: string;
  label: string;
} {
  if (!splat || splat === '') return { label: 'All runs' };
  const STATE_FILTERS: Record<string, RunState> = {
    running: 'running',
    queued: 'queued',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  if (splat in STATE_FILTERS) {
    return { state: STATE_FILTERS[splat], label: `Runs · ${splat}` };
  }
  if (splat.startsWith('skill/')) {
    const skill = splat.slice('skill/'.length);
    return { skill, label: `Runs · ${skill}` };
  }
  if (splat.startsWith('change/')) {
    const change = splat.slice('change/'.length);
    return { change, label: `Runs · change ${change}` };
  }
  return { label: 'All runs' };
}

export default function ProcessesView() {
  const navigate = useNavigate();
  const params = useParams();
  const splat = params['*'];
  const { runs } = useDispatch();
  const filter = useMemo(() => parseFilter(splat), [splat]);

  // Auto-expand a row when its id is in the URL hash (#r_abc123). Used by
  // the drawer's "Open detail" button and the Automation timeline.
  const [expandedHashId, setExpandedHashId] = useState<string | null>(null);
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace(/^#/, '');
      setExpandedHashId(h || null);
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The cross-page poll only carries the most recent ~200 runs. If the
  // hash targets an older run, fetch it directly so the row can render +
  // expand. Cleared when the hash changes or the run is already in `runs`.
  const [hashRun, setHashRun] = useState<RunRecord | null>(null);
  useEffect(() => {
    if (!expandedHashId) {
      setHashRun(null);
      return;
    }
    if (runs.some((r) => r.id === expandedHashId)) {
      setHashRun(null);
      return;
    }
    let cancelled = false;
    getRun(expandedHashId)
      .then(({ run }) => {
        if (!cancelled) setHashRun(run);
      })
      .catch(() => {
        if (!cancelled) setHashRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedHashId, runs]);

  const filtered = useMemo(() => {
    const base = runs.filter((r) => {
      if (filter.state && r.state !== filter.state) return false;
      if (filter.skill && r.skill !== filter.skill) return false;
      if (filter.change && r.change_id !== filter.change) return false;
      return true;
    });
    // Pin the hash-targeted run at the top when it isn't already in view —
    // either because the active filter excludes it, or because it wasn't in
    // the last ~200-run poll window.
    if (expandedHashId && !base.some((r) => r.id === expandedHashId)) {
      const found = runs.find((r) => r.id === expandedHashId) ?? hashRun;
      if (found) return [found, ...base];
    }
    return base;
  }, [runs, filter, expandedHashId, hashRun]);

  // Scroll the hash-targeted row into view once it's rendered.
  useEffect(() => {
    if (!expandedHashId) return;
    const el = document.getElementById(expandedHashId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [expandedHashId, filtered]);

  const counts = useMemo(() => {
    const c = { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of runs) c[r.state] += 1;
    return c;
  }, [runs]);

  function FilterTab({ to, label, count }: { to: string; label: string; count?: number }) {
    const active = to === splat || (to === '' && !splat);
    return (
      <button
        type="button"
        className={`btn btn-sm${active ? ' btn-primary' : ''}`}
        onClick={() => navigate(`/processes${to ? `/${to}` : ''}`)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {label}
        {count != null && count > 0 && (
          <span
            className="badge"
            style={{
              fontSize: 10,
              padding: '0 5px',
              background: active ? 'rgba(255,255,255,0.25)' : 'var(--bg-2)',
              color: active ? 'inherit' : 'var(--muted)',
            }}
          >
            {count}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="placeholder" style={{ padding: '16px 22px', maxWidth: 'none' }}>
      <header style={{ marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 19 }}>{filter.label}</h2>
        <p className="subtle" style={{ margin: 0, fontSize: 12.5 }}>
          Every skill dispatch runs as a tracked process. Output persists in{' '}
          <code className="mono">.claude/state/runs/</code> + the <code className="mono">runs</code>{' '}
          table; this view is the authoritative inspector.
        </p>
      </header>
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          marginBottom: 14,
          paddingBottom: 14,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <FilterTab to="" label="All" count={runs.length} />
        <FilterTab to="running" label="Running" count={counts.running + counts.queued} />
        <FilterTab to="done" label="Done" count={counts.done} />
        <FilterTab to="failed" label="Failed" count={counts.failed} />
        <FilterTab to="cancelled" label="Cancelled" count={counts.cancelled} />
      </div>
      {filtered.length === 0 ? (
        <EmptyState filter={filter} totalRuns={runs.length} />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {filtered.map((r) => (
            <li key={r.id} id={r.id}>
              <RunRow run={r} defaultExpanded={r.id === expandedHashId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({
  filter,
  totalRuns,
}: {
  filter: ReturnType<typeof parseFilter>;
  totalRuns: number;
}) {
  if (totalRuns === 0) {
    return (
      <p className="subtle" style={{ fontSize: 13, lineHeight: 1.55 }}>
        No skill runs recorded yet. Dispatch one from any change / pr-review / overview page;
        you'll see it appear here in real time.
      </p>
    );
  }
  return (
    <p className="subtle" style={{ fontSize: 13, lineHeight: 1.55 }}>
      No runs match this filter. Total runs in store: <strong>{totalRuns}</strong>.
      {filter.state && (
        <>
          {' '}
          Switch to <strong>All</strong> above to see them.
        </>
      )}
    </p>
  );
}

// Keep a "view" alias for any code that imports `View` instead of default —
// none currently do, but the convention across other apps is to export named.
export { ProcessesView as View };
