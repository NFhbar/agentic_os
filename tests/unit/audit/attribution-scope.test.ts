// Unit coverage for the telemetry-attribution scoping rules
// (scripts/audit-attribution-scope.mjs). The impure half — the three
// check*Attribution functions in scripts/audit.mjs — runs the SELECT and
// renders the finding; it can't be imported here because audit.mjs pulls
// node:sqlite at module top (vitest's resolver can't load it).
//
// What's pinned: the row classes that legitimately carry no attribution are
// excluded (ai-prompt envelopes, router/route rows, explicit-null args), and
// nothing else is — a real writer bug must still surface, or the checks stop
// being worth running.

import { describe, expect, it } from 'vitest';
import {
  ARGS_JSON_TYPE_SQL,
  isAttributionExempt,
  tallyUnattributed,
} from '../../../scripts/audit-attribution-scope.mjs';

// A row a writer genuinely should have tagged: lifecycle action, real args.
const REAL_MISS = {
  skill: 'dev-write-change',
  kind: 'dashboard',
  action: 'write-change-execute',
  args_json_type: 'object',
};

describe('isAttributionExempt', () => {
  it('a lifecycle row with a real args payload is in scope', () => {
    expect(isAttributionExempt(REAL_MISS)).toBe(false);
  });

  it('ai-prompt dispatch envelopes are exempt (skill is backfilled from the prompt)', () => {
    expect(isAttributionExempt({ ...REAL_MISS, action: 'ai-prompt' })).toBe(true);
  });

  it('router rows are exempt by kind AND by action', () => {
    expect(isAttributionExempt({ kind: 'router', action: 'route' })).toBe(true);
    expect(isAttributionExempt({ kind: 'router', action: 'anything' })).toBe(true);
    expect(isAttributionExempt({ kind: 'cli', action: 'route' })).toBe(true);
  });

  it('args explicitly recorded as null are exempt — there was nothing to lift', () => {
    expect(isAttributionExempt({ ...REAL_MISS, args_json_type: 'null' })).toBe(true);
  });

  it('an absent $.args path is NOT the explicit null case', () => {
    // json_type returns SQL NULL (→ null/undefined here) when the path is
    // missing; only the literal string 'null' means "recorded as null".
    expect(isAttributionExempt({ ...REAL_MISS, args_json_type: null })).toBe(false);
    expect(isAttributionExempt({ ...REAL_MISS, args_json_type: undefined })).toBe(false);
  });

  it('tolerates a bare/empty row', () => {
    expect(isAttributionExempt({})).toBe(false);
    expect(isAttributionExempt()).toBe(false);
  });
});

describe('tallyUnattributed', () => {
  it('drops exempt rows and groups the rest by skill, biggest first', () => {
    expect(
      tallyUnattributed([
        REAL_MISS,
        REAL_MISS,
        { ...REAL_MISS, skill: 'dev-open-pr' },
        { ...REAL_MISS, skill: 'research-write', action: 'ai-prompt' },
        { skill: 'dev-pr-review', kind: 'router', action: 'route' },
        { ...REAL_MISS, skill: 'dev-close-change', args_json_type: 'null' },
      ]),
    ).toEqual([
      { skill: 'dev-write-change', n: 2 },
      { skill: 'dev-open-pr', n: 1 },
    ]);
  });

  it('an all-exempt population yields no finding at all', () => {
    expect(
      tallyUnattributed([
        { skill: 'research-write', kind: 'dashboard', action: 'ai-prompt' },
        { skill: 'research-review', kind: 'dashboard', action: 'ai-prompt' },
        { skill: 'dev-write-change', kind: 'router', action: 'route' },
      ]),
    ).toEqual([]);
  });

  it('ties break on skill name so the rendered breakdown is stable', () => {
    const out = tallyUnattributed([
      { ...REAL_MISS, skill: 'dev-open-pr' },
      { ...REAL_MISS, skill: 'dev-close-change' },
    ]);
    expect(out.map((r) => r.skill)).toEqual(['dev-close-change', 'dev-open-pr']);
  });

  it('skips rows with no skill and tolerates empty input', () => {
    expect(tallyUnattributed([{ skill: null, kind: 'dashboard', action: 'edit' }])).toEqual([]);
    expect(tallyUnattributed([])).toEqual([]);
    expect(tallyUnattributed(undefined)).toEqual([]);
  });
});

describe('ARGS_JSON_TYPE_SQL', () => {
  it('projects the alias the predicate reads, guarded by json_valid', () => {
    expect(ARGS_JSON_TYPE_SQL).toContain('json_valid(raw)');
    expect(ARGS_JSON_TYPE_SQL).toContain("json_type(raw, '$.args')");
    expect(ARGS_JSON_TYPE_SQL).toContain('AS args_json_type');
  });
});
