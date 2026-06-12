// Wiring tests for the in-server run orchestration (routes/runs.ts) after
// the orphaned-spawn rewire: PID-dead → settle → finishAndRecord evidence
// inference, and the spawn-failure early-finalize on a still-queued row.
// The pure decision table is pinned in finalize.test.ts; these pin the new
// call site's INPUT wiring — what evidence finishAndRecord actually feeds
// inferTerminalState/artifactFresh, and what lands in finishRun.
//
// runs.ts pulls node:sqlite through runs-db.mjs (vitest's resolver cannot
// load it), so every impure module boundary is mocked; runs-finalize.mjs
// keeps its real inferTerminalState (wrapped in a spy) so the asserted
// outcomes go through the production decision table.

import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A PID no live process can own (well above darwin/linux defaults) —
// process.kill(pid, 0) throws ESRCH, so the follower sees it dead at once.
const DEAD_PID = 2 ** 30;

const TMP_BASE = join(tmpdir(), 'runs-wiring-test');

const mocks = vi.hoisted(() => ({
  appendChunk: vi.fn(),
  artifactFresh: vi.fn(() => false),
  createRun: vi.fn(),
  finishRun: vi.fn(),
  inferTerminalState: vi.fn(),
  markRunning: vi.fn(),
  recordEvent: vi.fn(),
  setHooksFired: vi.fn(),
  spawnClaudeOrphaned: vi.fn(),
}));

vi.mock('../../../scripts/dispatch-claude.mjs', () => ({
  resolveWallTimeCapMs: vi.fn(async () => 25 * 60_000),
  spawnClaudeOrphaned: mocks.spawnClaudeOrphaned,
}));

vi.mock('../../../scripts/events-db.mjs', () => ({
  recordEvent: mocks.recordEvent,
}));

vi.mock('../../../scripts/extract-event-attribution.mjs', () => ({
  extractFromPrompt: vi.fn(() => ({
    change_id: null,
    project: null,
    domain: null,
    report_id: null,
  })),
  extractSkill: vi.fn(() => null),
}));

vi.mock('../../../scripts/runs-db.mjs', () => ({
  RUNS_RETENTION_CAP: 500,
  appendChunk: mocks.appendChunk,
  countRuns: vi.fn(() => 0),
  createRun: mocks.createRun,
  evictBeyondCap: vi.fn(() => []),
  finishRun: mocks.finishRun,
  getActiveRunForChange: vi.fn(() => null),
  getRun: vi.fn(() => null),
  listRuns: vi.fn(() => []),
  listUnhookedTerminalRuns: vi.fn(() => []),
  markCancelRequested: vi.fn(),
  markRunning: mocks.markRunning,
  setHooksFired: mocks.setHooksFired,
  stderrPathFor: vi.fn((p: string) => `${p}.stderr`),
  unlinkOutput: vi.fn(),
}));

vi.mock('../../../scripts/runs-finalize.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  mocks.inferTerminalState.mockImplementation(
    actual.inferTerminalState as (...args: unknown[]) => unknown,
  );
  return {
    ...actual,
    artifactFresh: mocks.artifactFresh,
    inferTerminalState: mocks.inferTerminalState,
    recoverUsageFromJournal: vi.fn(() => null),
  };
});

vi.mock('../../../domains/meta/app/server/repo.js', async () => {
  const { join: j } = await import('node:path');
  const { tmpdir: t } = await import('node:os');
  return { safePath: (rel: string) => j(t(), 'runs-wiring-test', rel) };
});

vi.mock('../../../domains/meta/app/server/routes/automation.js', () => ({
  onAutomationStepComplete: vi.fn(async () => {}),
  onChangeAutomationStepComplete: vi.fn(async () => {}),
}));

import { startRun } from '../../../domains/meta/app/server/routes/runs.js';

function createdRow(): { id: string; output_path: string; started_at: string } {
  return mocks.createRun.mock.calls.at(-1)?.[0];
}

describe('runs.ts wiring — PID-dead settle + spawn-failure early-finalize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRun.mockImplementation((row: { id: string }) => ({ run_id: row.id }));
    mocks.artifactFresh.mockReturnValue(false);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(TMP_BASE, { recursive: true, force: true });
  });

  it('dead PID → settle → infers done from the journaled result frame', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });
    const res = await startRun({ prompt: 'wiring test' });
    expect(res.ok).toBe(true);
    const row = createdRow();
    expect(mocks.markRunning).toHaveBeenCalledWith(row.id, DEAD_PID);

    // The child's terminal stream-json result frame lands in the journal.
    writeFileSync(
      row.output_path,
      `${JSON.stringify({
        type: 'result',
        is_error: false,
        total_cost_usd: 0.42,
        duration_ms: 1234,
        usage: { input_tokens: 10, output_tokens: 20 },
        modelUsage: { 'claude-test': {} },
      })}\n`,
    );

    await vi.advanceTimersByTimeAsync(300); // follower tick: drain + first dead-PID observation
    expect(mocks.finishRun).not.toHaveBeenCalled(); // settle pending — not finalized yet
    await vi.advanceTimersByTimeAsync(150); // settle: drain once more, then finalize

    expect(mocks.inferTerminalState).toHaveBeenCalledWith({
      result: { isError: false },
      fresh: false,
      errorMarker: null,
    });
    // result present ⇒ artifact freshness is never consulted
    expect(mocks.artifactFresh).not.toHaveBeenCalled();
    expect(mocks.finishRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ state: 'done', exit_status: 0, cost_usd: 0.42 }),
    );
    expect(mocks.setHooksFired).toHaveBeenCalledWith(row.id);
  });

  it('dead PID with no result + fresh linked entity → died-after-writeback', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });
    mocks.artifactFresh.mockReturnValue(true);
    await startRun({ prompt: 'wiring test', tags: { change_id: 'some-change' } });
    const row = createdRow();

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(150);

    expect(mocks.artifactFresh).toHaveBeenCalledWith({
      change_id: 'some-change',
      project: null,
      started_at: row.started_at,
    });
    expect(mocks.inferTerminalState).toHaveBeenCalledWith({
      result: null,
      fresh: true,
      errorMarker: null,
    });
    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        state: 'died-after-writeback',
        exit_status: null,
        error: expect.stringContaining('work likely landed'),
      }),
    );
  });

  it('spawn failure → early-finalize failed on the still-queued row, never died-after-writeback', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: null, error: 'holder exploded' });
    // Adversarial setup: a fresh linked entity (the orchestrator wrote the
    // change entry around dispatch). Without the spawnFailed guard this
    // would classify died-after-writeback for a child that never existed.
    mocks.artifactFresh.mockReturnValue(true);

    const res = await startRun({ prompt: 'wiring test', tags: { change_id: 'some-change' } });
    expect(res.ok).toBe(true);
    const row = createdRow();

    // Row never transitions to running — early-finalize happens on queued.
    expect(mocks.markRunning).not.toHaveBeenCalled();
    // fresh is forced false at the source — artifactFresh is not even consulted.
    expect(mocks.artifactFresh).not.toHaveBeenCalled();
    expect(mocks.inferTerminalState).toHaveBeenCalledWith({
      result: null,
      fresh: false,
      errorMarker: null,
    });
    expect(mocks.finishRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        state: 'failed',
        error: expect.stringContaining('spawn error: holder exploded'),
      }),
    );
    expect(mocks.appendChunk).toHaveBeenCalledWith(
      row.id,
      'stderr',
      expect.stringContaining('spawn error: holder exploded'),
    );
  });
});
