// Run supervision that does not depend on the dashboard server being alive.
//
// Detached children outlive the server; something still has to notice death,
// enforce the wall-time cap, and finalize rows. The per-minute LaunchAgent
// tick (scheduler-tick.mjs) calls superviseRuns(); the server calls
// sweepDeadRuns() on boot + a periodic interval as the fallback for installs
// without the scheduler. Both paths converge on runs-finalize.mjs, so a dead
// run is always finalized from its journal evidence rather than blanket-
// marked failed. Both paths also stamp a supervision heartbeat, which is what
// lets the audit notice that supervision itself has died.
//
// NOTE: no top-level runs-db / dispatch-claude imports — runs-db pulls
// node:sqlite, which vitest's resolver cannot load, and the decision logic
// here (PID ownership, the kill ladder, the heartbeat merge) is unit-tested.
// resolveDeps() imports them lazily; callers may inject the whole set instead,
// which skips the imports altogether. Same pattern as runs-finalize.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// A child spawns within moments of its row being written. Anything born more
// than this after the row's started_at cannot be that child — the number was
// recycled by the OS onto somebody else's process.
export const PID_OWNERSHIP_GRACE_MS = 5 * 60 * 1000;

// How long a `queued` row may sit with no pid and no journal before it is
// declared never-spawned. Generous relative to the real createRun→spawn window
// (milliseconds) because the cost of being early is finalizing a run that was
// about to start, and the cost of being late is a few extra minutes on a row
// that is already dead.
export const QUEUED_REAP_GRACE_MS = 2 * 60 * 1000;

export const HEARTBEAT_PATH = join(REPO_ROOT, '.claude', 'state', 'supervision-heartbeat.json');

// ---------------------------------------------------------------------------
// PID ownership — a live PID is not evidence the run's child is alive.
// ---------------------------------------------------------------------------

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// `ps -o etime=` elapsed time: [[DD-]HH:]MM:SS. Returns ms, or null when the
// field doesn't match (busybox variants pad differently on some builds).
export function parseEtimeMs(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(etime ?? '').trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
}

function ps(args) {
  // LC_ALL=C pins lstart's month/day names to the English form Date.parse
  // accepts — a French/German locale would otherwise produce an unparseable
  // string and silently degrade every ownership read.
  const r = spawnSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout ?? '').trim();
  return out || null;
}

// Process start time in epoch ms, or null when the read is degraded (no ps,
// ps failed, the process already exited, unparseable output).
//
// Two probes because the `ps` implementations we run on print different
// things: darwin + procps(linux) both support `lstart` (an absolute local
// timestamp Date.parse handles, e.g. "Thu Aug 20 13:37:16 2026"); the
// busybox/toybox builds that appear in slim containers do not, and `etime`
// (elapsed) is the only start signal they expose.
export function readProcStartMs(pid, nowMs = Date.now()) {
  const lstart = ps(['-o', 'lstart=', '-p', String(pid)]);
  const parsed = lstart ? Date.parse(lstart) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const elapsedMs = parseEtimeMs(ps(['-o', 'etime=', '-p', String(pid)]));
  return elapsedMs === null ? null : nowMs - elapsedMs;
}

// Pure half of the ownership decision. Degraded reads stay conservative:
// assume the PID is ours. Signalling our own child a pass late is
// recoverable; SIGTERMing a stranger that inherited the number is not.
export function ownsPid({ procStartMs, runStartedMs, graceMs = PID_OWNERSHIP_GRACE_MS }) {
  if (procStartMs === null || procStartMs === undefined) return true;
  if (!Number.isFinite(procStartMs) || !Number.isFinite(runStartedMs)) return true;
  return procStartMs <= runStartedMs + graceMs;
}

// Does the live process behind `pid` belong to the run that started at
// `startedAt`? False means the number was recycled — the run's own child is
// gone, so the row gets finalized and NO signal is sent.
export function pidBelongsToRun(pid, startedAt, deps = {}) {
  const nowMs = (deps.now ?? Date.now)();
  const read = deps.readProcStartMs ?? readProcStartMs;
  return ownsPid({
    procStartMs: read(pid, nowMs),
    runStartedMs: startedAt ? Date.parse(startedAt) : NaN,
  });
}

// ---------------------------------------------------------------------------
// Stranded queued rows — a row whose child was never born.
// ---------------------------------------------------------------------------

// Dispatch writes the run row BEFORE it spawns the child, so the per-change
// concurrency gate is armed from the instant a dispatch is admitted. The cost
// of that ordering is a window: between the row and the spawn the row is
// `queued` with no pid. Anything that ends the dispatching process inside that
// window — a restart, a crash, a tree-kill — leaves the row there permanently.
// Nothing else can clear it: there is no pid to watch die, no journal to
// finalize from, and cancel has no process to signal. The change's gate stays
// held, so every later dispatch for that change is refused, forever.
//
// Three facts separate that row from a healthy one:
//   - no pid            — markRunning never ran
//   - no journal        — the child never wrote a byte, so it never started
//                         (a journal means a live child re-parented to PID 1
//                         and outlived its dispatcher: an orphan to ADOPT via
//                         the normal finalize-from-evidence path, never to
//                         reap here)
//   - older than grace  — past any plausible in-flight createRun→spawn gap
//
// Pure decision; the caller supplies the facts and applies the verdict. Every
// `no` carries its own reason so a pass that reaps nothing still says why.
export function decideQueuedReap({
  pid = null,
  journalExists = false,
  ageMs = 0,
  graceMs = QUEUED_REAP_GRACE_MS,
} = {}) {
  if (pid) return { reap: false, reason: 'has-pid' };
  // A journal means a child exists (or existed) — it is not this rule's case.
  if (journalExists) return { reap: false, reason: 'journal-exists' };
  // A zero grace means the caller already knows the dispatcher is gone (boot),
  // so age adds nothing — including when the row's stamp is unreadable.
  if (graceMs > 0) {
    if (!Number.isFinite(ageMs)) return { reap: false, reason: 'age-unknown' };
    if (ageMs < graceMs) return { reap: false, reason: 'within-grace' };
  }
  return { reap: true, reason: 'never-spawned' };
}

// The honest error for a reaped row. Names what is known (nothing ran) rather
// than guessing a cause, and says what to do about it.
export function composeQueuedReapError(ageMs) {
  const age = Number.isFinite(ageMs) ? `${Math.max(1, Math.round(ageMs / 60000))}m` : 'indefinitely';
  return `env-failure: never spawned — queued ${age} with no pid and no journal; the dispatching process died between creating the row and starting the child. Nothing ran; re-dispatch`;
}

// ---------------------------------------------------------------------------
// Supervision heartbeat — who watches the watchers.
// ---------------------------------------------------------------------------

// Merge `{ <source>: <ISO now> }` into .claude/state/supervision-heartbeat.json.
// Every supervision host stamps its own source ('scheduler-tick', 'api-server')
// after a completed pass; audit.mjs's supervision-stale check reads the file
// and flags a source that has gone quiet past its window. A corrupt or
// non-object file is rebuilt from scratch rather than propagated — a broken
// heartbeat must not be able to break supervision.
export function stampSupervisionHeartbeat(source, { path = HEARTBEAT_PATH, now = Date.now } = {}) {
  let state = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch {
    /* missing or unparseable — rebuild */
  }
  state[source] = new Date(now()).toISOString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
  return state;
}

// ---------------------------------------------------------------------------
// Dependency resolution.
// ---------------------------------------------------------------------------

const RUNTIME_DEP_KEYS = [
  'listActiveRuns',
  'finishRun',
  'setRunError',
  'resolveWallTimeCapMs',
  'finalizeDeadRun',
];

// Build the dependency set for one supervision pass. Callers that supply every
// runtime key (tests) never touch the sqlite-backed modules; production callers
// supply nothing and get the lazy imports.
export async function resolveDeps(overrides = {}) {
  const deps = {
    isPidAlive,
    readProcStartMs,
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => Date.now(),
    journalExists: (path) => typeof path === 'string' && path !== '' && existsSync(path),
    ...overrides,
  };
  if (RUNTIME_DEP_KEYS.every((k) => typeof deps[k] === 'function')) return deps;
  const [db, dispatch, finalize] = await Promise.all([
    import('./runs-db.mjs'),
    import('./dispatch-claude.mjs'),
    import('./runs-finalize.mjs'),
  ]);
  return {
    listActiveRuns: db.listActiveRuns,
    finishRun: db.finishRun,
    setRunError: db.setRunError,
    resolveWallTimeCapMs: dispatch.resolveWallTimeCapMs,
    finalizeDeadRun: finalize.finalizeDeadRun,
    ...deps,
  };
}

// ---------------------------------------------------------------------------
// Passes.
// ---------------------------------------------------------------------------

// Sweep dead runs. `mode`:
//   - 'boot'     — the process that would have spawned any queued row's child
//                  is provably gone, so the grace window collapses to zero
//   - 'periodic' — a queued row may be milliseconds from its spawn; only rows
//                  past QUEUED_REAP_GRACE_MS are eligible
// Both modes run the same decideQueuedReap rule, which is what keeps a live
// orphan (journal present, dispatcher gone) out of the reaper's reach in
// either mode — that row belongs to the finalize-from-evidence path below.
// Returns the number of rows finalized.
export async function sweepDeadRuns(reason = 'PID not alive', mode = 'periodic', overrides) {
  const deps = await resolveDeps(overrides);
  const nowMs = deps.now();
  let swept = 0;
  for (const row of deps.listActiveRuns()) {
    if (row.state === 'queued') {
      const startedMs = row.started_at ? Date.parse(row.started_at) : Number.NaN;
      const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : Number.NaN;
      const verdict = decideQueuedReap({
        pid: row.pid,
        journalExists: deps.journalExists(row.output_path),
        ageMs,
        graceMs: mode === 'boot' ? 0 : QUEUED_REAP_GRACE_MS,
      });
      if (!verdict.reap) continue;
      deps.finishRun(row.id, {
        state: 'failed',
        exit_status: null,
        duration_ms: null,
        error: composeQueuedReapError(ageMs),
      });
      swept += 1;
      continue;
    }
    if (!row.pid) {
      // A non-queued row with no pid predates markRunning's contract. Boot
      // still clears it; a periodic pass leaves it for the next boot.
      if (mode === 'boot') {
        deps.finishRun(row.id, {
          state: 'failed',
          exit_status: null,
          duration_ms: null,
          error: `${reason} (never spawned)`,
        });
        swept += 1;
      }
      continue;
    }
    if (deps.isPidAlive(row.pid)) {
      if (pidBelongsToRun(row.pid, row.started_at, deps)) continue;
      // The number is alive but the process behind it was born long after the
      // row — the OS recycled the PID onto a stranger. Our child is dead:
      // finalize from journal evidence exactly as if the PID were gone, and
      // send nothing.
      await deps.finalizeDeadRun(row, {
        reason: `${reason} — pid ${row.pid} was recycled onto another process`,
      });
      swept += 1;
      continue;
    }
    await deps.finalizeDeadRun(row, { reason });
    swept += 1;
  }
  return swept;
}

// Full supervision pass: reap dead runs + enforce the per-skill wall-time
// cap on living ones (frontmatter > history-derived > 25m floor — see
// dispatch-claude.mjs resolveWallTimeCapMs). SIGTERM on first breach
// (marker written to the row's error column), SIGKILL escalation on the
// next pass if the process is still alive. Returns counters for logging.
export async function superviseRuns(overrides) {
  const deps = await resolveDeps(overrides);
  const reaped = await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps);
  let terminated = 0;
  let escalated = 0;
  const now = deps.now();
  for (const row of deps.listActiveRuns()) {
    if (row.state !== 'running' || !row.pid || !deps.isPidAlive(row.pid)) continue;
    const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
    if (!Number.isFinite(startedMs)) continue;
    // Defense in depth: the sweep above already finalized recycled-PID rows,
    // but re-check before signalling. The kill ladder is the one place where
    // being wrong costs somebody else their process.
    if (!pidBelongsToRun(row.pid, row.started_at, deps)) continue;
    const capMs = await deps.resolveWallTimeCapMs(row.skill ?? null);
    if (now - startedMs <= capMs) continue;
    if (row.error?.startsWith('killed:')) {
      // Already SIGTERM'd on a prior pass — escalate.
      try {
        deps.kill(row.pid, 'SIGKILL');
        escalated += 1;
      } catch {
        /* died between checks — next sweep finalizes */
      }
      continue;
    }
    const minutes = Math.floor(capMs / 60000);
    deps.setRunError(row.id, `killed: wall-time cap exceeded (${minutes}m)`);
    try {
      deps.kill(row.pid, 'SIGTERM');
      terminated += 1;
    } catch {
      /* died between checks — next sweep finalizes */
    }
  }
  return { reaped, terminated, escalated };
}
