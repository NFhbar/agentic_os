// Run supervision that does not depend on the dashboard server being alive.
//
// Detached children outlive the server; something still has to notice death,
// enforce the wall-time cap, and finalize rows. The per-minute LaunchAgent
// tick (scheduler-tick.mjs) calls superviseRuns(); the server calls
// sweepDeadRuns() on boot + a periodic interval as the fallback for installs
// without the scheduler. Both paths converge on runs-finalize.mjs, so a dead
// run is always finalized from its journal evidence rather than blanket-
// marked failed.

import { resolveWallTimeCapMs } from './dispatch-claude.mjs';
import { finalizeDeadRun } from './runs-finalize.mjs';
import { finishRun, listActiveRuns, setRunError } from './runs-db.mjs';

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sweep dead runs. `mode`:
//   - 'boot'     — also fails queued rows without a PID (the prior process
//                  died before spawning; nothing will ever pick them up)
//   - 'periodic' — leaves queued-without-PID rows alone (mid-spawn race)
// Returns the number of rows finalized.
export async function sweepDeadRuns(reason = 'PID not alive', mode = 'periodic') {
  let swept = 0;
  for (const row of listActiveRuns()) {
    if (row.state === 'queued' || !row.pid) {
      if (mode === 'boot') {
        finishRun(row.id, {
          state: 'failed',
          exit_status: null,
          duration_ms: null,
          error: `${reason} (never spawned)`,
        });
        swept += 1;
      }
      continue;
    }
    if (isPidAlive(row.pid)) continue;
    await finalizeDeadRun(row, { reason });
    swept += 1;
  }
  return swept;
}

// Full supervision pass: reap dead runs + enforce the per-skill wall-time
// cap on living ones (frontmatter > history-derived > 25m floor — see
// dispatch-claude.mjs resolveWallTimeCapMs). SIGTERM on first breach
// (marker written to the row's error column), SIGKILL escalation on the
// next pass if the process is still alive. Returns counters for logging.
export async function superviseRuns() {
  const reaped = await sweepDeadRuns('supervisor: PID not alive', 'periodic');
  let terminated = 0;
  let escalated = 0;
  const now = Date.now();
  for (const row of listActiveRuns()) {
    if (row.state !== 'running' || !row.pid || !isPidAlive(row.pid)) continue;
    const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
    if (!Number.isFinite(startedMs)) continue;
    const capMs = await resolveWallTimeCapMs(row.skill ?? null);
    if (now - startedMs <= capMs) continue;
    if (row.error?.startsWith('killed:')) {
      // Already SIGTERM'd on a prior pass — escalate.
      try {
        process.kill(row.pid, 'SIGKILL');
        escalated += 1;
      } catch {
        /* died between checks — next sweep finalizes */
      }
      continue;
    }
    const minutes = Math.floor(capMs / 60000);
    setRunError(row.id, `killed: wall-time cap exceeded (${minutes}m)`);
    try {
      process.kill(row.pid, 'SIGTERM');
      terminated += 1;
    } catch {
      /* died between checks — next sweep finalizes */
    }
  }
  return { reaped, terminated, escalated };
}
