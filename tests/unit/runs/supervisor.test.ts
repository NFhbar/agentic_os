// Run-supervisor hardening (scripts/runs-supervisor.mjs).
//
// A live PID is not evidence the run's child is alive — the OS recycles PIDs,
// and the pre-hardening supervisor would SIGTERM whatever innocent process had
// inherited the number. These tests pin the ownership contract (recycled PIDs
// are finalized WITHOUT signals, the grace boundary is inclusive, a degraded
// `ps` read stays conservative) and the supervision heartbeat both hosts stamp.
//
// The module is importable here because its sqlite-backed dependencies are
// resolved lazily — the fake `deps` below supplies every runtime key, so
// runs-db (and node:sqlite behind it) is never imported.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PID_OWNERSHIP_GRACE_MS,
  QUEUED_REAP_GRACE_MS,
  composeQueuedReapError,
  decideQueuedReap,
  ownsPid,
  parseEtimeMs,
  stampSupervisionHeartbeat,
  superviseRuns,
  sweepDeadRuns,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/runs-supervisor.mjs';

const RUN_START = '2026-08-20T12:00:00.000Z';
const RUN_START_MS = Date.parse(RUN_START);

type Row = {
  id: string;
  state: string;
  pid: number | null;
  started_at: string | null;
  skill?: string | null;
  error?: string | null;
};

function runningRow(over: Partial<Row> = {}): Row {
  return { id: 'run-1', state: 'running', pid: 4242, started_at: RUN_START, skill: 'dev-write-change', error: null, ...over };
}

// Fake dependency set — supplying all five runtime keys keeps resolveDeps from
// importing runs-db / dispatch-claude / runs-finalize.
function fakeDeps(rows: Row[], over: Record<string, unknown> = {}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  const finalized: Array<{ id: string; reason: string }> = [];
  const finished: Array<{ id: string; error: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];
  const deps = {
    listActiveRuns: () => rows,
    finishRun: (id: string, patch: { error: string }) => finished.push({ id, error: patch.error }),
    setRunError: (id: string, error: string) => errors.push({ id, error }),
    resolveWallTimeCapMs: async () => 25 * 60 * 1000,
    finalizeDeadRun: async (row: Row, opts: { reason: string }) =>
      finalized.push({ id: row.id, reason: opts.reason }),
    isPidAlive: () => true,
    // Default: the process started at the same instant as the row — owned.
    readProcStartMs: () => RUN_START_MS,
    kill: (pid: number, signal: string) => signals.push({ pid, signal }),
    now: () => RUN_START_MS + 60 * 60 * 1000, // one hour in: past any wall cap
    ...over,
  };
  return { deps, signals, finalized, finished, errors };
}

describe('parseEtimeMs — busybox fallback probe', () => {
  it('parses MM:SS, HH:MM:SS and DD-HH:MM:SS', () => {
    expect(parseEtimeMs('00:00')).toBe(0);
    expect(parseEtimeMs('01:30')).toBe(90_000);
    expect(parseEtimeMs('02:03:04')).toBe((2 * 3600 + 3 * 60 + 4) * 1000);
    expect(parseEtimeMs('1-02:03:04')).toBe((26 * 3600 + 3 * 60 + 4) * 1000);
    expect(parseEtimeMs('  01:30  ')).toBe(90_000);
  });

  it('returns null on anything it does not recognise', () => {
    expect(parseEtimeMs('')).toBeNull();
    expect(parseEtimeMs('nonsense')).toBeNull();
    expect(parseEtimeMs(null)).toBeNull();
  });
});

describe('ownsPid — grace boundary + degraded reads', () => {
  it('a process born before the row is owned', () => {
    expect(ownsPid({ procStartMs: RUN_START_MS - 1000, runStartedMs: RUN_START_MS })).toBe(true);
  });

  it('exactly at the grace boundary is still owned', () => {
    expect(
      ownsPid({ procStartMs: RUN_START_MS + PID_OWNERSHIP_GRACE_MS, runStartedMs: RUN_START_MS }),
    ).toBe(true);
  });

  it('one millisecond past the grace boundary cannot be ours', () => {
    expect(
      ownsPid({ procStartMs: RUN_START_MS + PID_OWNERSHIP_GRACE_MS + 1, runStartedMs: RUN_START_MS }),
    ).toBe(false);
  });

  it('degraded ps read (null) stays conservative — assume owned', () => {
    expect(ownsPid({ procStartMs: null, runStartedMs: RUN_START_MS })).toBe(true);
    expect(ownsPid({ procStartMs: undefined, runStartedMs: RUN_START_MS })).toBe(true);
    expect(ownsPid({ procStartMs: Number.NaN, runStartedMs: RUN_START_MS })).toBe(true);
  });

  it('unparseable run start stays conservative — assume owned', () => {
    expect(ownsPid({ procStartMs: RUN_START_MS + 10 * 60 * 1000, runStartedMs: Number.NaN })).toBe(true);
  });
});

describe('sweepDeadRuns — recycled PIDs', () => {
  it('a live-but-recycled PID finalizes the row and sends NO signals', async () => {
    const rows = [runningRow()];
    const { deps, signals, finalized } = fakeDeps(rows, {
      // Born an hour after the row — cannot be our child.
      readProcStartMs: () => RUN_START_MS + 60 * 60 * 1000,
    });
    const swept = await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps);
    expect(swept).toBe(1);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].reason).toContain('recycled');
    expect(signals).toEqual([]);
  });

  it('a live, genuinely-owned PID is left alone', async () => {
    const { deps, signals, finalized } = fakeDeps([runningRow()]);
    expect(await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps)).toBe(0);
    expect(finalized).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('a dead PID still finalizes with the plain reason', async () => {
    const { deps, finalized } = fakeDeps([runningRow()], { isPidAlive: () => false });
    expect(await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps)).toBe(1);
    expect(finalized[0].reason).toBe('supervisor: PID not alive');
  });

  it('boot mode still fails queued rows that never spawned', async () => {
    const { deps, finished } = fakeDeps([runningRow({ state: 'queued', pid: null })]);
    expect(await sweepDeadRuns('server restart: PID not alive', 'boot', deps)).toBe(1);
    expect(finished[0].error).toContain('never spawned');
  });
});

// A run row is written BEFORE its child is spawned, because the per-change
// concurrency gate reads rows. Anything that ends the dispatching process in
// that window leaves a `queued` row with no pid — and nothing else can ever
// clear it: no pid to watch die, no journal to finalize from, no process for
// cancel to signal. The change's gate stays held and every later dispatch for
// it is refused. This is the rule that frees it, and the three facts it turns
// on: no pid, no journal, older than the grace window.
describe('decideQueuedReap — the pid-less queued row', () => {
  const OLD = QUEUED_REAP_GRACE_MS + 1;

  it('pid-less, journal-less and past the grace window is reaped', () => {
    expect(decideQueuedReap({ pid: null, journalExists: false, ageMs: OLD })).toEqual({
      reap: true,
      reason: 'never-spawned',
    });
  });

  it('a young row is left alone — it may be milliseconds from its spawn', () => {
    expect(decideQueuedReap({ pid: null, journalExists: false, ageMs: 1000 })).toEqual({
      reap: false,
      reason: 'within-grace',
    });
  });

  it('exactly at the grace boundary is reapable; one millisecond short is not', () => {
    expect(
      decideQueuedReap({ pid: null, journalExists: false, ageMs: QUEUED_REAP_GRACE_MS }).reap,
    ).toBe(true);
    expect(
      decideQueuedReap({ pid: null, journalExists: false, ageMs: QUEUED_REAP_GRACE_MS - 1 }).reap,
    ).toBe(false);
  });

  it('a journal means a live orphan to adopt, never a row to reap', () => {
    // The child re-parents to PID 1 and outlives its dispatcher. Bytes on disk
    // prove it started; finalizing the row here would abandon a running run.
    expect(decideQueuedReap({ pid: null, journalExists: true, ageMs: OLD })).toEqual({
      reap: false,
      reason: 'journal-exists',
    });
  });

  it('a pid short-circuits everything — that row has a child to supervise', () => {
    expect(decideQueuedReap({ pid: 4242, journalExists: false, ageMs: OLD })).toEqual({
      reap: false,
      reason: 'has-pid',
    });
  });

  it('an unreadable age stays conservative while a grace window applies', () => {
    expect(decideQueuedReap({ pid: null, journalExists: false, ageMs: Number.NaN })).toEqual({
      reap: false,
      reason: 'age-unknown',
    });
  });

  it('a zero grace (boot: the dispatcher is provably gone) reaps regardless of age', () => {
    expect(
      decideQueuedReap({ pid: null, journalExists: false, ageMs: 0, graceMs: 0 }).reap,
    ).toBe(true);
    expect(
      decideQueuedReap({ pid: null, journalExists: false, ageMs: Number.NaN, graceMs: 0 }).reap,
    ).toBe(true);
  });

  it('but a zero grace still yields to a journal', () => {
    expect(
      decideQueuedReap({ pid: null, journalExists: true, ageMs: OLD, graceMs: 0 }).reason,
    ).toBe('journal-exists');
  });
});

describe('composeQueuedReapError', () => {
  it('says nothing ran, in one line, with the age', () => {
    const msg = composeQueuedReapError(5 * 60 * 1000);
    expect(msg.startsWith('env-failure:')).toBe(true);
    expect(msg).toContain('never spawned');
    expect(msg).toContain('5m');
    expect(msg).toContain('Nothing ran');
    expect(msg.includes('\n')).toBe(false);
  });

  it('degrades honestly when the row carries no readable age', () => {
    expect(composeQueuedReapError(Number.NaN)).toContain('indefinitely');
  });
});

describe('sweepDeadRuns — stranded queued rows', () => {
  function queuedRow(over: Partial<Row> = {}): Row {
    return { id: 'run-q', state: 'queued', pid: null, started_at: RUN_START, error: null, ...over };
  }

  it('reaps a pid-less journal-less queued row once it is past the grace window', async () => {
    // fakeDeps' clock sits one hour past the row.
    const { deps, finished } = fakeDeps([queuedRow()], { journalExists: () => false });
    expect(await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps)).toBe(1);
    expect(finished).toHaveLength(1);
    expect(finished[0].error).toContain('never spawned');
  });

  it('leaves a young queued row for the next pass', async () => {
    const { deps, finished } = fakeDeps([queuedRow()], {
      journalExists: () => false,
      now: () => RUN_START_MS + 1000,
    });
    expect(await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps)).toBe(0);
    expect(finished).toEqual([]);
  });

  it('leaves a queued row whose child is already writing a journal', async () => {
    const { deps, finished, finalized } = fakeDeps([queuedRow()], { journalExists: () => true });
    expect(await sweepDeadRuns('supervisor: PID not alive', 'periodic', deps)).toBe(0);
    expect(finished).toEqual([]);
    expect(finalized).toEqual([]);
  });
});

describe('superviseRuns — the kill ladder only fires on owned PIDs', () => {
  it('SIGTERMs an overdue owned run and marks the row', async () => {
    const { deps, signals, errors } = fakeDeps([runningRow()]);
    const out = await superviseRuns(deps);
    expect(signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    expect(errors[0].error).toContain('killed: wall-time cap exceeded');
    expect(out).toMatchObject({ terminated: 1, escalated: 0 });
  });

  it('escalates to SIGKILL on the next pass once the kill marker is set', async () => {
    const { deps, signals } = fakeDeps([
      runningRow({ error: 'killed: wall-time cap exceeded (25m)' }),
    ]);
    const out = await superviseRuns(deps);
    expect(signals).toEqual([{ pid: 4242, signal: 'SIGKILL' }]);
    expect(out).toMatchObject({ terminated: 0, escalated: 1 });
  });

  it('an overdue run whose PID was recycled is reaped, never signalled', async () => {
    const { deps, signals, finalized } = fakeDeps([runningRow()], {
      readProcStartMs: () => RUN_START_MS + 60 * 60 * 1000,
    });
    const out = await superviseRuns(deps);
    expect(signals).toEqual([]);
    expect(finalized).toHaveLength(1);
    expect(out).toMatchObject({ reaped: 1, terminated: 0, escalated: 0 });
  });

  it('a degraded ps read still lets the ladder fire (conservative ownership)', async () => {
    const { deps, signals } = fakeDeps([runningRow()], { readProcStartMs: () => null });
    await superviseRuns(deps);
    expect(signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
  });
});

describe('stampSupervisionHeartbeat', () => {
  function withTmp<T>(fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'supervision-hb-'));
    try {
      return fn(join(dir, 'nested', 'supervision-heartbeat.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('creates the file (and its directory) on first stamp', () => {
    withTmp((path) => {
      const state = stampSupervisionHeartbeat('scheduler-tick', { path, now: () => RUN_START_MS });
      expect(state).toEqual({ 'scheduler-tick': RUN_START });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'scheduler-tick': RUN_START });
    });
  });

  it('merges a second source instead of replacing the first', () => {
    withTmp((path) => {
      stampSupervisionHeartbeat('scheduler-tick', { path, now: () => RUN_START_MS });
      const state = stampSupervisionHeartbeat('api-server', { path, now: () => RUN_START_MS + 1000 });
      expect(state).toEqual({
        'scheduler-tick': RUN_START,
        'api-server': new Date(RUN_START_MS + 1000).toISOString(),
      });
    });
  });

  it('re-stamping a source advances only that source', () => {
    withTmp((path) => {
      stampSupervisionHeartbeat('scheduler-tick', { path, now: () => RUN_START_MS });
      stampSupervisionHeartbeat('api-server', { path, now: () => RUN_START_MS });
      const state = stampSupervisionHeartbeat('scheduler-tick', {
        path,
        now: () => RUN_START_MS + 60_000,
      });
      expect(state['scheduler-tick']).toBe(new Date(RUN_START_MS + 60_000).toISOString());
      expect(state['api-server']).toBe(RUN_START);
    });
  });

  it('rebuilds from scratch when the file is corrupt', () => {
    withTmp((path) => {
      stampSupervisionHeartbeat('api-server', { path, now: () => RUN_START_MS });
      writeFileSync(path, '{not json at all');
      const state = stampSupervisionHeartbeat('scheduler-tick', { path, now: () => RUN_START_MS });
      expect(state).toEqual({ 'scheduler-tick': RUN_START });
    });
  });

  it('rebuilds when the file parses but is not an object', () => {
    withTmp((path) => {
      stampSupervisionHeartbeat('api-server', { path, now: () => RUN_START_MS });
      writeFileSync(path, '["scheduler-tick"]');
      const state = stampSupervisionHeartbeat('scheduler-tick', { path, now: () => RUN_START_MS });
      expect(state).toEqual({ 'scheduler-tick': RUN_START });
    });
  });
});
