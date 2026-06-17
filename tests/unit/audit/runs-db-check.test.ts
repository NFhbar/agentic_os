// Unit coverage for the runs-origin audit decision table
// (scripts/audit-runs-origin.mjs). The impure half — checkRunsDb in
// scripts/audit.mjs — does the PRAGMA + COUNT reads and maps each decision
// `kind` to a finding id; it can't be imported here because audit.mjs pulls
// node:sqlite at module top (vitest's resolver can't load it). These tests
// lock the branch → severity contract the reviewer asked to pin: NULL stays
// info, an out-of-vocabulary origin is an error, a missing origin column is a
// hard error that short-circuits, and generic schema drift is a distinct warn.

import { describe, expect, it } from 'vitest';
import { classifyRunsOrigin } from '../../../scripts/audit-runs-origin.mjs';

const EXPECTED = ['id', 'started_at', 'origin', 'hooks_fired_at'];
const ORIGINS = ['human', 'automation', 'scheduler', 'driver'];

function classify(over: Partial<Parameters<typeof classifyRunsOrigin>[0]> = {}) {
  return classifyRunsOrigin({
    columns: EXPECTED,
    expectedColumns: EXPECTED,
    validOrigins: ORIGINS,
    legacyNullCount: 0,
    invalidCount: 0,
    ...over,
  });
}

describe('classifyRunsOrigin — runs-origin audit decision table', () => {
  it('no runs table (empty columns) → no findings', () => {
    expect(classify({ columns: [] })).toEqual([]);
  });

  it('clean table (origin present, no legacy/invalid rows) → no findings', () => {
    expect(classify()).toEqual([]);
  });

  it('missing origin column → single error decision, short-circuits', () => {
    const out = classify({
      columns: ['id', 'started_at', 'hooks_fired_at'],
      // legacy/invalid counts must be ignored once the column is absent
      legacyNullCount: 5,
      invalidCount: 3,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'origin-column-missing', severity: 'error' });
  });

  it('NULL-origin rows stay info-level', () => {
    const out = classify({ legacyNullCount: 7 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'legacy-null', severity: 'info' });
    expect(out[0].message).toContain('7');
  });

  it('out-of-vocabulary origin is an error', () => {
    const out = classify({ invalidCount: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'invalid-origin', severity: 'error' });
    expect(out[0].message).toContain('human | automation | scheduler | driver');
  });

  it('generic schema drift is a distinct warn (not folded into origin)', () => {
    // origin present, but another expected column is gone.
    const out = classify({ columns: ['id', 'started_at', 'origin'] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'schema-drift', severity: 'warn' });
    expect(out[0].message).toContain('hooks_fired_at');
  });

  it('legacy NULL + invalid origin co-occur → both decisions, in order', () => {
    const out = classify({ legacyNullCount: 1, invalidCount: 1 });
    expect(out.map((d) => d.kind)).toEqual(['legacy-null', 'invalid-origin']);
    expect(out.map((d) => d.severity)).toEqual(['info', 'error']);
  });
});
