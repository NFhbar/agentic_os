// Global dispatch context — every callsite that previously instantiated
// <ActionRunner endpoint="/api/action"> now calls useDispatch().startSkillRun.
// The provider holds the run drawer's open/filter state, the cross-page poll
// of the runs list, and a small subscriber API (`useRunTerminal`) so pages
// can refresh when a run they care about reaches a terminal state.

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type RunFilter, type RunRecord, type RunTags, listRuns, startRun } from './runs';

const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled', 'died-after-writeback']);

interface DispatchContextValue {
  drawerOpen: boolean;
  setDrawerOpen: (v: boolean) => void;
  drawerFilter: RunFilter;
  setDrawerFilter: (f: RunFilter) => void;
  runs: RunRecord[];
  // Returns { run_id } on success or { blocked: true, blocking } when the
  // concurrency gate refused. Callers can surface a toast on blocked.
  startSkillRun: (
    prompt: string,
    title: string,
    tags?: RunTags,
    opts?: { force?: boolean },
  ) => Promise<
    | { run_id: string; blocked?: false }
    | { blocked: true; blocking: { run_id: string; skill: string | null } }
    | { error: string; refusal?: 'head-unchanged' }
  >;
}

const DispatchContext = createContext<DispatchContextValue | null>(null);

export function useDispatch(): DispatchContextValue {
  const ctx = useContext(DispatchContext);
  if (!ctx) {
    throw new Error('useDispatch must be called inside <DispatchProvider>');
  }
  return ctx;
}

interface ProviderProps {
  children: ReactNode;
  pollIntervalMs?: number;
}

export function DispatchProvider({ children, pollIntervalMs = 3000 }: ProviderProps) {
  // Persist drawer-open state across page reloads. Without this, every
  // `window.location.reload()` (Mark merged (local), Mark abandoned, etc.)
  // collapses the drawer — users lose visibility of recently-failed runs
  // and assume "failed runs disappear from the drawer."
  const DRAWER_OPEN_KEY = 'aos:run-drawer:open';
  const [drawerOpen, setDrawerOpenInternal] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DRAWER_OPEN_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const setDrawerOpen = useCallback((v: boolean) => {
    setDrawerOpenInternal(v);
    try {
      window.localStorage.setItem(DRAWER_OPEN_KEY, v ? 'true' : 'false');
    } catch {
      /* localStorage unavailable */
    }
  }, []);
  const [drawerFilter, setDrawerFilter] = useState<RunFilter>({});
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // Track previously-seen state per run id so we can fire terminal transitions
  // exactly once. Pages subscribed via useRunTerminal get a callback on the
  // edge — not on every poll tick.
  const prevStates = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const { runs } = await listRuns({ limit: 200 });
      setRuns(runs);
      // Detect terminal transitions and notify subscribers.
      const current = new Map<string, string>();
      const transitions: RunRecord[] = [];
      for (const r of runs) {
        current.set(r.id, r.state);
        const prev = prevStates.current.get(r.id);
        if (prev != null && !TERMINAL_STATES.has(prev) && TERMINAL_STATES.has(r.state)) {
          transitions.push(r);
        }
      }
      prevStates.current = current;
      for (const r of transitions) {
        for (const sub of terminalSubscribers.current) sub(r);
      }
    } catch {
      /* network blip — keep last snapshot */
    }
  }, []);

  // Subscribers for terminal-state transitions. Pages register a callback
  // they want fired whenever a run matching their filter goes terminal.
  const terminalSubscribers = useRef<Set<(r: RunRecord) => void>>(new Set());

  // External hook surface — see useRunTerminal below.
  const subscribeTerminal = useCallback((cb: (r: RunRecord) => void) => {
    terminalSubscribers.current.add(cb);
    return () => {
      terminalSubscribers.current.delete(cb);
    };
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(id);
  }, [refresh, pollIntervalMs]);

  const startSkillRun = useCallback<DispatchContextValue['startSkillRun']>(
    async (prompt, title, tags, opts) => {
      const res = await startRun({ prompt, title, tags, force: opts?.force });
      if (res.error === 'blocked' && res.blocking) {
        return { blocked: true as const, blocking: res.blocking };
      }
      if (res.error) {
        return { error: res.error, refusal: res.refusal };
      }
      if (!res.run_id) {
        return { error: 'unexpected response from /api/runs' };
      }
      // Open the drawer filtered to the most relevant tag the caller passed.
      // Prefer change_id > project > repo > skill.
      let filter: RunFilter = {};
      if (tags?.change_id) filter = { change_id: tags.change_id };
      else if (tags?.project) filter = { project: tags.project };
      else if (tags?.repo) filter = { repo: tags.repo };
      else if (tags?.skill) filter = { skill: tags.skill };
      setDrawerFilter(filter);
      setDrawerOpen(true);
      // Kick a refresh so the new run shows up immediately without waiting
      // the full poll interval.
      refresh();
      return { run_id: res.run_id };
    },
    [refresh],
  );

  // We use a module-level WeakMap to expose subscribeTerminal to the hook
  // helper without changing the public context shape. Cleaner than adding
  // it to the context value (where only useRunTerminal would consume it).
  registerSubscribeTerminal(subscribeTerminal);

  return (
    <DispatchContext.Provider
      value={{
        drawerOpen,
        setDrawerOpen,
        drawerFilter,
        setDrawerFilter,
        runs,
        startSkillRun,
      }}
    >
      {children}
    </DispatchContext.Provider>
  );
}

// -----------------------------------------------------------------------------
// useRunTerminal — fires `cb` whenever a run matching `filter` reaches a
// terminal state (done / failed / cancelled). Used by every page that today
// calls refresh() in ActionRunner's onClose handler.
// -----------------------------------------------------------------------------

let _subscribeTerminal: ((cb: (r: RunRecord) => void) => () => void) | null = null;
function registerSubscribeTerminal(fn: (cb: (r: RunRecord) => void) => () => void) {
  _subscribeTerminal = fn;
}

function matchesFilter(r: RunRecord, filter: RunFilter): boolean {
  if (filter.state && r.state !== filter.state) return false;
  if (filter.skill && r.skill !== filter.skill) return false;
  if (filter.change_id && r.change_id !== filter.change_id) return false;
  if (filter.project && r.project !== filter.project) return false;
  if (filter.repo && r.repo !== filter.repo) return false;
  if (filter.domain && r.domain !== filter.domain) return false;
  return true;
}

export function useRunTerminal(filter: RunFilter, cb: (r: RunRecord) => void) {
  // Keep the latest cb in a ref so the subscription doesn't churn on every
  // render — pages typically pass an inline arrow function.
  const cbRef = useRef(cb);
  cbRef.current = cb;
  // Same for filter (compare by JSON; pages usually pass a fresh object).
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    if (!_subscribeTerminal) return;
    const parsed = JSON.parse(filterKey) as RunFilter;
    const handler = (r: RunRecord) => {
      if (matchesFilter(r, parsed)) cbRef.current(r);
    };
    return _subscribeTerminal(handler);
  }, [filterKey]);
}
