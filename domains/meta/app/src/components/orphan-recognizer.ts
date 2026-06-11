// Pure helpers for recognizing died-but-likely-succeeded run failures + the
// entity-link target on those runs. Extracted from RunRow.tsx so unit tests
// can exercise them without pulling React. Same separation pattern as
// automation-state-machine.ts and lifecycle-state.ts.

import type { RunRecord } from '../lib/runs';

// Recognize known "died-but-likely-succeeded" failure modes from the run's
// error field. Both orphan-sweep (PID not alive detection) and the
// wall-time-cap watchdog land here — skill side effects (commits, vault
// writes, GitHub calls) often complete before the subprocess actually
// terminates. Surfacing this distinguishably tells operators "go verify
// the entity" instead of assuming total failure. See Task #398 + #418.
export function recognizeOrphanLike(run: RunRecord): {
  kind: 'orphan-sweep' | 'wall-time-cap' | 'died-after-writeback';
  label: string;
  hint: string;
} | null {
  // Since durable-runs, the finalizer encodes the "verify the entity"
  // judgment itself: a death with no result event but a verifiably-updated
  // linked entity lands as state='died-after-writeback' (automation already
  // advanced). The banner is informational, not a call to action.
  if (run.state === 'died-after-writeback') {
    return {
      kind: 'died-after-writeback',
      label: 'Died after writeback',
      hint:
        'The subprocess died without reporting a result, but the linked entity was updated after the run ' +
        'started — the work landed. Automation treated this as a success; spot-check the entity if it matters.',
    };
  }
  if (run.state !== 'failed') return null;
  const err = run.error ?? '';
  // Both the server sweep ('orphan-sweep:', 'server restart:') and the
  // scheduler-tick supervisor ('supervisor:') use the same PID-not-alive
  // phrasing.
  if (err.startsWith('orphan-sweep:') || err.includes('PID not alive')) {
    return {
      kind: 'orphan-sweep',
      label: 'Subprocess died unexpectedly',
      hint:
        'The subprocess terminated without a clean exit (likely OS-level kill — OOM, sleep, or external signal). ' +
        'Skill side effects often land before death — verify the linked entity to check what completed.',
    };
  }
  if (err.startsWith('killed: wall-time cap exceeded')) {
    return {
      kind: 'wall-time-cap',
      label: 'Wall-time cap exceeded',
      hint:
        'The subprocess ran longer than the configured cap and was terminated. ' +
        'Partial work may have landed before SIGTERM — verify the linked entity to check what completed.',
    };
  }
  return null;
}

// Pick the most relevant linked-entity destination from a run's tags.
// Preference: change_id > project. Returns null when neither is set —
// the row still renders the orphan banner, just without a link button.
export function entityLink(run: RunRecord): { href: string; label: string } | null {
  if (run.change_id) return { href: `/changes/${run.change_id}`, label: `change ${run.change_id}` };
  if (run.project) return { href: `/projects/${run.project}`, label: `project ${run.project}` };
  return null;
}
