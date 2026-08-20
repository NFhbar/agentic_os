// Unit tests for the Drive affordance's decision core — the module the
// project screen's Drive control and POST /api/projects/:id/drive both read.
//
// Three invariants carry real weight here:
//   1. the control and the endpoint agree, because they call one evaluator —
//      so the cases below are simultaneously "what the button shows" and
//      "what the endpoint refuses";
//   2. a live drive is always surfaced and never dispatched over;
//   3. the composed prompt carries no `change:` line. That one is not
//      cosmetic: `startRun` lifts `change_id` out of prompt text, and a driver
//      run wearing a change id gets its own dispatches refused by the
//      change-scoped concurrency gate — a silent failure with no error to read.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations
import { TERMINAL_CHANGE_STATUSES as RESOLVER_TERMINAL } from '../../../scripts/drive-order.mjs';
import {
  DRIVER_SKILL,
  type DriveRunLike,
  TERMINAL_CHANGE_STATUSES,
  buildDriveProjectPrompt,
  evaluateDriveAffordance,
  findActiveDriverRun,
  findLatestDriverRun,
} from '../../../domains/meta/app/server/lib/drive-affordance.js';

function run(overrides: Partial<DriveRunLike> = {}): DriveRunLike {
  return {
    id: 'r_1',
    skill: DRIVER_SKILL,
    project: 'ship-it',
    state: 'running',
    started_at: '2026-07-09T10:00:00Z',
    ...overrides,
  };
}

describe('terminal-status mirror', () => {
  it('matches the resolver the driver itself runs', () => {
    // drive-order.mjs owns the definition; this module mirrors it because it
    // is bundled into the browser and that file reads node:fs at module top.
    expect([...TERMINAL_CHANGE_STATUSES]).toEqual([...(RESOLVER_TERMINAL as string[])]);
  });
});

describe('findActiveDriverRun', () => {
  it('finds a queued or running driver run for the project', () => {
    const runs = [run({ id: 'r_q', state: 'queued' })];
    expect(findActiveDriverRun(runs, 'ship-it')?.id).toBe('r_q');
    expect(findActiveDriverRun([run({ id: 'r_r', state: 'running' })], 'ship-it')?.id).toBe('r_r');
  });

  it('ignores terminal runs, other projects, and other skills', () => {
    const runs = [
      run({ id: 'r_done', state: 'done' }),
      run({ id: 'r_failed', state: 'failed' }),
      run({ id: 'r_cancelled', state: 'cancelled' }),
      run({ id: 'r_dead', state: 'died-after-writeback' }),
      run({ id: 'r_other_project', project: 'something-else' }),
      run({ id: 'r_other_skill', skill: 'dev-write-change' }),
    ];
    expect(findActiveDriverRun(runs, 'ship-it')).toBeNull();
  });

  it('picks the newest when more than one is live', () => {
    const runs = [
      run({ id: 'r_old', started_at: '2026-07-09T09:00:00Z' }),
      run({ id: 'r_new', started_at: '2026-07-09T11:00:00Z' }),
    ];
    expect(findActiveDriverRun(runs, 'ship-it')?.id).toBe('r_new');
  });

  it('returns null for an empty project id rather than matching null-project rows', () => {
    expect(findActiveDriverRun([run({ project: null })], '')).toBeNull();
  });
});

describe('findLatestDriverRun', () => {
  it('returns the newest driver run in any state', () => {
    const runs = [
      run({ id: 'r_old', state: 'done', started_at: '2026-07-08T10:00:00Z' }),
      run({ id: 'r_recent', state: 'failed', started_at: '2026-07-09T10:00:00Z' }),
      run({ id: 'r_other', skill: 'dev-close-change', started_at: '2026-07-09T23:00:00Z' }),
    ];
    expect(findLatestDriverRun(runs, 'ship-it')?.id).toBe('r_recent');
  });

  it('returns null when the project has never been driven', () => {
    expect(findLatestDriverRun([run({ skill: 'dev-write-change' })], 'ship-it')).toBeNull();
  });
});

describe('evaluateDriveAffordance', () => {
  const live = [{ status: 'planning' }, { status: 'merged' }];

  it('is ready for an active project with live changes', () => {
    const d = evaluateDriveAffordance({ project_status: 'active', changes: live });
    expect(d.state).toBe('ready');
    expect(d.visible).toBe(true);
    expect(d.enabled).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.drivable_count).toBe(1);
  });

  it('counts an unrecognized status as live work, never as done', () => {
    const d = evaluateDriveAffordance({
      project_status: 'active',
      changes: [{ status: 'some-future-status' }, { status: null }, {}],
    });
    expect(d.drivable_count).toBe(3);
    expect(d.enabled).toBe(true);
  });

  it('shows the live run instead of offering a second dispatch', () => {
    const d = evaluateDriveAffordance({
      project_status: 'active',
      changes: live,
      active_run_id: 'r_live',
    });
    expect(d.state).toBe('driving');
    expect(d.visible).toBe(true);
    expect(d.enabled).toBe(false);
    expect(d.active_run_id).toBe('r_live');
    expect(d.reason).toContain('r_live');
  });

  it('surfaces a live run even on a project that was closed under it', () => {
    const d = evaluateDriveAffordance({
      project_status: 'completed',
      changes: live,
      active_run_id: 'r_live',
    });
    expect(d.state).toBe('driving');
    expect(d.visible).toBe(true);
  });

  it('hides on a completed or cancelled project', () => {
    for (const status of ['completed', 'cancelled']) {
      const d = evaluateDriveAffordance({ project_status: status, changes: live });
      expect(d.state).toBe('project-closed');
      expect(d.visible).toBe(false);
      expect(d.enabled).toBe(false);
      expect(d.reason).toContain(status);
    }
  });

  it('refuses a paused project but says which flip unblocks it', () => {
    const d = evaluateDriveAffordance({ project_status: 'paused', changes: live });
    expect(d.state).toBe('project-paused');
    expect(d.visible).toBe(true);
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain('paused');
  });

  it('hides when nothing is scaffolded yet', () => {
    const d = evaluateDriveAffordance({ project_status: 'active', changes: [] });
    expect(d.state).toBe('no-changes');
    expect(d.visible).toBe(false);
    expect(d.enabled).toBe(false);
    expect(d.drivable_count).toBe(0);
  });

  it('refuses, visibly, when every change is terminal', () => {
    const d = evaluateDriveAffordance({
      project_status: 'active',
      changes: [{ status: 'merged' }, { status: 'abandoned' }],
    });
    expect(d.state).toBe('nothing-drivable');
    expect(d.visible).toBe(true);
    expect(d.enabled).toBe(false);
    expect(d.drivable_count).toBe(0);
  });

  it('treats a null project status as drivable — only the named states refuse', () => {
    expect(evaluateDriveAffordance({ project_status: null, changes: live }).state).toBe('ready');
  });
});

describe('buildDriveProjectPrompt', () => {
  const base = { project: 'ship-it' };

  it('names the skill, its file, and the project input', () => {
    const p = buildDriveProjectPrompt(base);
    expect(p).toContain(`Run the ${DRIVER_SKILL} skill for project "ship-it"`);
    expect(p).toContain(`.claude/skills/${DRIVER_SKILL}/SKILL.md`);
    expect(p).toContain('- project: "ship-it"');
  });

  it('carries no change attribution — not as a field, not as a value', () => {
    const p = buildDriveProjectPrompt({ ...base, max_changes: 3 });
    // The exact field `startRun`'s extractor reads. `max_changes:` must not
    // trip it, which is why the assertion is on the literal field name.
    expect(/\bchange:\s/.test(p)).toBe(false);
    expect(p).toContain('- max_changes: 3');
  });

  it('declares the headless contract', () => {
    const p = buildDriveProjectPrompt(base);
    expect(p).toContain('Do NOT use AskUserQuestion');
    expect(p).toContain('headless');
  });

  it('threads the optional driver inputs only when supplied', () => {
    const bare = buildDriveProjectPrompt(base);
    expect(bare).not.toContain('max_changes');
    expect(bare).not.toContain('spend_cap_usd');
    expect(bare).not.toContain('dry_run');
    expect(bare).not.toContain('api_port');

    const full = buildDriveProjectPrompt({
      project: 'ship-it',
      max_changes: 2,
      spend_cap_usd: 12.5,
      dry_run: true,
      api_port: 5199,
    });
    expect(full).toContain('- max_changes: 2');
    expect(full).toContain('- spend_cap_usd: 12.5');
    expect(full).toContain('- dry_run: true');
    expect(full).toContain('- api_port: 5199');
  });

  it('omits dry_run when it is false rather than asserting the default', () => {
    expect(buildDriveProjectPrompt({ ...base, dry_run: false })).not.toContain('dry_run');
  });
});
