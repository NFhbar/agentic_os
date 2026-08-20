// Unit tests for planDriveOrder — the ordering decision `dev-drive-project`
// makes before it touches anything.
//
// The driver's whole safety story rests on two properties this function owns:
// it never selects a change whose `parent_change` chain is still in flight,
// and it refuses to guess when the chain is unreadable (cycle, duplicate id,
// a parent that resolves to nothing). v1 attempts no recovery, so "refuse"
// has to be a real return value rather than a prose aspiration.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations
import { planDriveOrder, isTerminalChangeStatus } from '../../../scripts/drive-order.mjs';

interface DriveRecord {
  id: string;
  status: string | null;
  parent_change: string | null;
  in_scope: boolean;
  terminal: boolean;
  blocked_by: { id: string; reason: string } | null;
}

interface DrivePlan {
  ordered: DriveRecord[];
  next: DriveRecord | null;
  remaining: number;
  stop: { reason: string; detail: string; ids: string[] } | null;
}

function plan(changes: unknown[]): DrivePlan {
  return planDriveOrder(changes) as DrivePlan;
}

const ids = (p: DrivePlan) => p.ordered.map((r) => r.id);

describe('isTerminalChangeStatus', () => {
  it('treats merged and abandoned as terminal', () => {
    expect(isTerminalChangeStatus('merged')).toBe(true);
    expect(isTerminalChangeStatus('abandoned')).toBe(true);
  });

  it('treats every other status — including unknown ones — as live work', () => {
    for (const s of ['planning', 'in-progress', 'in-review', 'shipped-ish', null, undefined]) {
      expect(isTerminalChangeStatus(s)).toBe(false);
    }
  });
});

describe('planDriveOrder — ordering', () => {
  it('orders a parent_change chain ahead of the input order', () => {
    // Deliberately reversed on input: the chain, not the list, is the order.
    const p = plan([
      { id: 'c', status: 'planning', parent_change: 'b' },
      { id: 'b', status: 'planning', parent_change: 'a' },
      { id: 'a', status: 'planning', parent_change: null },
    ]);
    expect(ids(p)).toEqual(['a', 'b', 'c']);
    expect(p.next?.id).toBe('a');
    expect(p.stop).toBeNull();
  });

  it('keeps input order between changes that do not depend on each other', () => {
    const p = plan([
      { id: 'first', status: 'planning', parent_change: null },
      { id: 'second', status: 'planning', parent_change: null },
      { id: 'third', status: 'planning', parent_change: null },
    ]);
    expect(ids(p)).toEqual(['first', 'second', 'third']);
    expect(p.next?.id).toBe('first');
  });

  it('interleaves independent changes by input order while respecting chains', () => {
    const p = plan([
      { id: 'a1', status: 'planning', parent_change: null },
      { id: 'b1', status: 'planning', parent_change: null },
      { id: 'a2', status: 'planning', parent_change: 'a1' },
    ]);
    expect(ids(p)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('planDriveOrder — selection', () => {
  it('skips terminal changes and selects the first live one', () => {
    const p = plan([
      { id: 'a', status: 'merged', parent_change: null },
      { id: 'b', status: 'abandoned', parent_change: 'a' },
      { id: 'c', status: 'in-review', parent_change: 'b' },
    ]);
    expect(p.next?.id).toBe('c');
    expect(p.remaining).toBe(1);
    expect(p.stop).toBeNull();
  });

  it('selects the pending parent, never the child waiting on it', () => {
    const p = plan([
      { id: 'parent', status: 'in-progress', parent_change: null },
      { id: 'child', status: 'planning', parent_change: 'parent' },
    ]);
    expect(p.next?.id).toBe('parent');
    const child = p.ordered.find((r) => r.id === 'child');
    expect(child?.blocked_by).toEqual({ id: 'parent', reason: 'blocked-pending-parent' });
  });

  it('looks past a terminal parent to a still-live grandparent', () => {
    const p = plan([
      { id: 'gp', status: 'in-review', parent_change: null, in_scope: false },
      { id: 'mid', status: 'merged', parent_change: 'gp' },
      { id: 'leaf', status: 'planning', parent_change: 'mid' },
    ]);
    expect(p.next).toBeNull();
    expect(p.stop?.reason).toBe('blocked-out-of-scope');
    expect(p.stop?.detail).toContain('gp');
  });

  it('reports done — no next, no stop — when every in-scope change is terminal', () => {
    const p = plan([
      { id: 'a', status: 'merged', parent_change: null },
      { id: 'b', status: 'merged', parent_change: 'a' },
    ]);
    expect(p.next).toBeNull();
    expect(p.stop).toBeNull();
    expect(p.remaining).toBe(0);
  });

  it('never selects an out-of-scope record even when it is the only live one', () => {
    const p = plan([
      { id: 'external', status: 'planning', parent_change: null, in_scope: false },
      { id: 'mine', status: 'merged', parent_change: null },
    ]);
    expect(p.next).toBeNull();
    expect(p.stop).toBeNull();
    expect(p.remaining).toBe(0);
  });
});

describe('planDriveOrder — honest stops', () => {
  it('stops on a parent id that resolves to no record', () => {
    const p = plan([{ id: 'a', status: 'planning', parent_change: 'ghost' }]);
    expect(p.next).toBeNull();
    expect(p.stop?.reason).toBe('unresolved-parent');
    expect(p.stop?.detail).toContain('ghost');
    expect(p.remaining).toBe(1);
  });

  it('stops on a live out-of-project parent rather than driving around it', () => {
    const p = plan([
      { id: 'upstream', status: 'in-review', parent_change: null, in_scope: false },
      { id: 'mine', status: 'planning', parent_change: 'upstream' },
    ]);
    expect(p.next).toBeNull();
    expect(p.stop?.reason).toBe('blocked-out-of-scope');
    expect(p.stop?.ids).toEqual(['mine']);
  });

  it('proceeds once the out-of-project parent is terminal', () => {
    const p = plan([
      { id: 'upstream', status: 'merged', parent_change: null, in_scope: false },
      { id: 'mine', status: 'planning', parent_change: 'upstream' },
    ]);
    expect(p.next?.id).toBe('mine');
    expect(p.stop).toBeNull();
  });

  it('stops on a parent_change cycle and names every member', () => {
    const p = plan([
      { id: 'a', status: 'planning', parent_change: 'b' },
      { id: 'b', status: 'planning', parent_change: 'a' },
      { id: 'loner', status: 'planning', parent_change: null },
    ]);
    expect(p.stop?.reason).toBe('dependency-cycle');
    expect(p.stop?.ids.sort()).toEqual(['a', 'b']);
    expect(p.next).toBeNull();
  });

  it('stops on a self-referencing parent_change', () => {
    const p = plan([{ id: 'a', status: 'planning', parent_change: 'a' }]);
    expect(p.stop?.reason).toBe('dependency-cycle');
  });

  it('stops on duplicate ids rather than picking one', () => {
    const p = plan([
      { id: 'dup', status: 'planning', parent_change: null },
      { id: 'dup', status: 'merged', parent_change: null },
    ]);
    expect(p.stop?.reason).toBe('duplicate-id');
    expect(p.stop?.ids).toEqual(['dup']);
    expect(p.next).toBeNull();
  });

  it('stops on a record with no id', () => {
    const p = plan([{ status: 'planning', parent_change: null }]);
    expect(p.stop?.reason).toBe('malformed-record');
  });

  it('reports an empty plan as done, not as a stop', () => {
    const p = plan([]);
    expect(p.ordered).toEqual([]);
    expect(p.next).toBeNull();
    expect(p.stop).toBeNull();
  });

  it('throws on a non-array input — that is a caller bug, not a data condition', () => {
    expect(() => planDriveOrder(null)).toThrow(TypeError);
  });
});

describe('planDriveOrder — mixed-mode re-derivation', () => {
  it('advances to the next change once an operator hand-merges the current one', () => {
    const before = plan([
      { id: 'one', status: 'in-review', parent_change: null },
      { id: 'two', status: 'planning', parent_change: 'one' },
    ]);
    expect(before.next?.id).toBe('one');

    // Same call, re-derived from frontmatter an operator advanced by hand.
    const after = plan([
      { id: 'one', status: 'merged', parent_change: null },
      { id: 'two', status: 'planning', parent_change: 'one' },
    ]);
    expect(after.next?.id).toBe('two');
    expect(after.stop).toBeNull();
  });
});
