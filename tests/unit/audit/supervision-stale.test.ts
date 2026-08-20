// Unit coverage for the supervision-stale decision table
// (scripts/audit-supervision.mjs). The impure half — checkSupervisionStale in
// scripts/audit.mjs — reads the heartbeat file plus the live `running` count
// and maps each decision onto the `supervision-stale` finding id; it can't be
// imported here because audit.mjs pulls node:sqlite at module top.
//
// The contract these pin: a source that never stamped is silent (the
// LaunchAgent may not be installed), a source that went quiet is surfaced, and
// severity escalates only when runs are actually in flight — supervision death
// matters precisely when there is something to supervise.

import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_WINDOWS_MS,
  classifySupervisionStaleness,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../../scripts/audit-supervision.mjs';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function classify(over: Record<string, unknown> = {}) {
  return classifySupervisionStaleness({ heartbeat: {}, nowMs: NOW, runningRuns: 0, ...over });
}

describe('classifySupervisionStaleness — windows', () => {
  it('declares 10m for the scheduler tick and 15m for the api server', () => {
    expect(SUPERVISION_WINDOWS_MS).toEqual({
      'scheduler-tick': 10 * 60 * 1000,
      'api-server': 15 * 60 * 1000,
    });
  });

  it('fresh stamps produce no findings', () => {
    expect(
      classify({
        heartbeat: { 'scheduler-tick': minutesAgo(9), 'api-server': minutesAgo(14) },
      }),
    ).toEqual([]);
  });

  it('each source uses its own window', () => {
    const out = classify({
      heartbeat: { 'scheduler-tick': minutesAgo(12), 'api-server': minutesAgo(12) },
    });
    expect(out.map((d: { source: string }) => d.source)).toEqual(['scheduler-tick']);
  });

  it('a future stamp (clock skew) reads as fresh, not stale', () => {
    expect(classify({ heartbeat: { 'scheduler-tick': minutesAgo(-30) } })).toEqual([]);
  });

  it('an unknown source in the file is ignored', () => {
    expect(classify({ heartbeat: { 'some-other-host': minutesAgo(600) } })).toEqual([]);
  });

  it('a source that has NEVER stamped is silent', () => {
    // Only the tick has ever run here — a missing api-server key is not drift.
    expect(classify({ heartbeat: { 'scheduler-tick': minutesAgo(1) } })).toEqual([]);
  });

  it('an unparseable stamp warns and points at the rebuild', () => {
    const out = classify({ heartbeat: { 'api-server': 'yesterday-ish' } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'unparseable', source: 'api-server', severity: 'warn' });
  });
});

describe('classifySupervisionStaleness — escalation', () => {
  it('stale with nothing running is info', () => {
    const out = classify({ heartbeat: { 'scheduler-tick': minutesAgo(45) } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'stale', source: 'scheduler-tick', severity: 'info' });
    expect(out[0].message).toContain('45m ago');
    expect(out[0].message).not.toContain('unsupervised');
  });

  it('stale with runs in flight escalates severity AND message', () => {
    const out = classify({ heartbeat: { 'scheduler-tick': minutesAgo(45) }, runningRuns: 3 });
    expect(out[0]).toMatchObject({ severity: 'warn' });
    expect(out[0].message).toContain('3 run(s)');
    expect(out[0].message).toContain('unsupervised');
  });

  it('both sources stale reports both, in window order', () => {
    const out = classify({
      heartbeat: { 'scheduler-tick': minutesAgo(45), 'api-server': minutesAgo(45) },
    });
    expect(out.map((d: { source: string }) => d.source)).toEqual(['scheduler-tick', 'api-server']);
  });
});

describe('classifySupervisionStaleness — no heartbeat file', () => {
  it('is silent on a clone where supervision never ran', () => {
    expect(classify({ heartbeat: null })).toEqual([]);
    expect(classify({ heartbeat: undefined })).toEqual([]);
  });

  it('warns when runs are in flight and nothing has ever supervised', () => {
    const out = classify({ heartbeat: null, runningRuns: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'absent', source: null, severity: 'warn' });
    expect(out[0].message).toContain('2 run(s)');
  });
});
