// Auto-fallback hook (scripts/runs-finalize.mjs maybeRedispatchModelFallback).
//
// The hook is the impure half of the availability policy: it reads the live
// skill tree for the posture, the run's on-disk evidence for the class, and
// launches at most one more leg. The launcher is injected here — the default
// one dynamically imports runs-db (node:sqlite), which vitest's resolver
// cannot load, and which is exactly why that import is dynamic.
//
// Fixtures are synthetic dead runs pointed at REAL skills, so the tests also
// fail if the 3.3 posture regresses out of the frontmatter.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeRedispatchModelFallback } from '../../../scripts/runs-finalize.mjs';

const TMP_BASE = join(tmpdir(), 'model-fallback-hook-test');

// A failed run row with journal + stderr evidence on disk.
function deadRun(
  overrides: Record<string, unknown> = {},
  { stderr = 'Credit balance is too low\n' }: { stderr?: string } = {},
): Record<string, unknown> {
  const id = `r_${Math.random().toString(36).slice(2)}`;
  mkdirSync(TMP_BASE, { recursive: true });
  const output_path = join(TMP_BASE, `${id}.raw.jsonl`);
  writeFileSync(output_path, '');
  writeFileSync(join(TMP_BASE, `${id}.stderr.log`), stderr);
  return {
    id,
    state: 'failed',
    skill: 'research-write', // fallback-allowed: claude-opus-4-8
    model: 'claude-fable-5',
    title: 'research-write for project x',
    prompt: 'Run research-write for report "r".',
    change_id: null,
    project: 'proj-x',
    repo: null,
    domain: 'research',
    output_path,
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('maybeRedispatchModelFallback', () => {
  it('re-dispatches the same prompt once on the declared fallback', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, run_id: 'r_leg2' }));
    const row = deadRun();
    const out = await maybeRedispatchModelFallback(row, { dispatch });

    expect(out).toMatchObject({ redispatch: true, model: 'claude-opus-4-8', reason: 'ok' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      prompt: row.prompt,
      title: 'fallback(claude-opus-4-8): research-write',
      tags: {
        skill: 'research-write',
        change_id: null,
        project: 'proj-x',
        repo: null,
        domain: 'research',
      },
      origin: 'automation',
      model_override: 'claude-opus-4-8',
      // The effort pin travels with the model pin — the leg drops to `high`.
      effort_override: 'high',
    });
  });

  it('LOOP GUARD: a leg already on the fallback model is not re-dispatched again', async () => {
    const dispatch = vi.fn();
    const out = await maybeRedispatchModelFallback(deadRun({ model: 'claude-opus-4-8' }), {
      dispatch,
    });
    expect(out).toMatchObject({ redispatch: false, reason: 'loop-guard' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('LOOP GUARD: a run titled fallback(...) never spawns a third leg', async () => {
    const dispatch = vi.fn();
    const out = await maybeRedispatchModelFallback(
      deadRun({ model: 'claude-opus-4-8-20260101', title: 'fallback(claude-opus-4-8): research-write' }),
      { dispatch },
    );
    expect(out).toMatchObject({ redispatch: false, reason: 'fallback-leg' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a required-tier gate parks — it is never auto-downgraded', async () => {
    const dispatch = vi.fn();
    expect(
      await maybeRedispatchModelFallback(deadRun({ skill: 'dev-pr-review' }), { dispatch }),
    ).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an ordinary (unclassified) failure gets no second leg', async () => {
    const dispatch = vi.fn();
    const out = await maybeRedispatchModelFallback(
      deadRun({}, { stderr: 'Error: 3 tests failed\n' }),
      { dispatch },
    );
    expect(out).toMatchObject({ redispatch: false, reason: 'not-classified' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('non-failed terminal states never re-dispatch', async () => {
    const dispatch = vi.fn();
    for (const state of ['done', 'cancelled', 'died-after-writeback']) {
      expect(await maybeRedispatchModelFallback(deadRun({ state }), { dispatch })).toBeNull();
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an unknown skill has no policy → no fallback', async () => {
    const dispatch = vi.fn();
    expect(await maybeRedispatchModelFallback(deadRun({ skill: null }), { dispatch })).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a launcher that throws does not break the finalization that called it', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('spawn exploded');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await maybeRedispatchModelFallback(deadRun(), { dispatch });
    expect(out).toMatchObject({ redispatch: true, dispatched: null });
    err.mockRestore();
  });

  it('accepts a pre-computed class, skipping the tail read', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    // No evidence on disk at all — the caller already classified.
    const row = deadRun({}, { stderr: '' });
    expect(await maybeRedispatchModelFallback(row, { cls: null, dispatch })).toMatchObject({
      reason: 'not-classified',
    });
    expect(
      await maybeRedispatchModelFallback(row, { cls: 'auth', dispatch }),
    ).toMatchObject({ redispatch: true, model: 'claude-opus-4-8' });
  });
});
