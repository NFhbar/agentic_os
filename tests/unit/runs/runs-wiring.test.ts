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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  recoverUsageFromJournal: vi.fn((): Record<string, unknown> | null => null),
  // Hoisted so the override-seam tests can drive it per-case. Default null
  // keeps every pre-existing behavioral pin unchanged (the model_execute /
  // effort_execute override paths only activate on a non-null resolution).
  resolveModelExecuteForRun: vi.fn(async (): Promise<string | null> => null),
  resolveEffortExecuteForRun: vi.fn(async (): Promise<string | null> => null),
  setDispatchConfig: vi.fn(),
  setHooksFired: vi.fn(),
  spawnClaudeOrphaned: vi.fn(),
}));

vi.mock('../../../scripts/dispatch-claude.mjs', () => ({
  resolveModelExecuteForRun: mocks.resolveModelExecuteForRun,
  resolveEffortExecuteForRun: mocks.resolveEffortExecuteForRun,
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
  setDispatchConfig: mocks.setDispatchConfig,
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
    recoverUsageFromJournal: mocks.recoverUsageFromJournal,
  };
});

vi.mock('../../../domains/meta/app/server/repo.js', async () => {
  const { join: j } = await import('node:path');
  const { tmpdir: t } = await import('node:os');
  return {
    // REPO_ROOT is the tmp base. Most tests never write vault/wiki under it,
    // so readChangeReviewGate fail-opens to null and the model_execute path
    // stays inert; the override-seam tests below write a change fixture under
    // this root (writeChangeFixture) to actually drive the gate.
    REPO_ROOT: j(t(), 'runs-wiring-test'),
    safePath: (rel: string) => j(t(), 'runs-wiring-test', rel),
  };
});

vi.mock('../../../domains/meta/app/server/routes/automation.js', () => ({
  onAutomationStepComplete: vi.fn(async () => {}),
  onChangeAutomationStepComplete: vi.fn(async () => {}),
}));

import { startRun } from '../../../domains/meta/app/server/routes/runs.js';

function createdRow(): {
  id: string;
  output_path: string;
  started_at: string;
  origin?: string;
} {
  return mocks.createRun.mock.calls.at(-1)?.[0];
}

// Write a change entry under the mocked REPO_ROOT so readChangeReviewGate
// (real, unmocked in runs.ts) resolves its review gate. Lands at the change
// archetype's canonical path vault/wiki/<domain>/change/<id>.md; torn down by
// afterEach's rmSync(TMP_BASE).
function writeChangeFixture(
  id: string,
  fm: { review_status: string; plan_path?: string },
): void {
  const dir = join(TMP_BASE, 'vault', 'wiki', 'development', 'change');
  mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `id: ${id}`,
    'type: change',
    `review_status: ${fm.review_status}`,
    ...(fm.plan_path ? [`plan_path: ${fm.plan_path}`] : []),
    '---',
    '',
    `# ${id}`,
    '',
  ];
  writeFileSync(join(dir, `${id}.md`), lines.join('\n'));
}

describe('runs.ts wiring — PID-dead settle + spawn-failure early-finalize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRun.mockImplementation((row: { id: string }) => ({ run_id: row.id }));
    mocks.artifactFresh.mockReturnValue(false);
    mocks.recoverUsageFromJournal.mockReturnValue(null);
    // clearAllMocks wipes call history but NOT mockResolvedValue impls — reset
    // the override resolvers so a per-test value can't bleed into the next test.
    mocks.resolveModelExecuteForRun.mockResolvedValue(null);
    mocks.resolveEffortExecuteForRun.mockResolvedValue(null);
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

  it('recycled PID: result journaled + stream quiet → follower finalizes despite a live PID probe', async () => {
    // process.pid is guaranteed alive — stands in for a recycled PID that
    // keeps isPidAlive() true after the real child is long gone. Without
    // the !mayStillSignal dead-equivalence in the follower, this session
    // never finalizes: the wall-cap sweep skips it (recycled-PID guard) and
    // the dead-PID path never fires, wedging the row in `running` and
    // 409-blocking new dispatches for the change until a server restart.
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: process.pid });
    const res = await startRun({ prompt: 'wiring test' });
    expect(res.ok).toBe(true);
    const row = createdRow();

    writeFileSync(
      row.output_path,
      `${JSON.stringify({
        type: 'result',
        is_error: false,
        total_cost_usd: 0.11,
        duration_ms: 999,
        usage: { input_tokens: 1, output_tokens: 2 },
        modelUsage: { 'claude-test': {} },
      })}\n`,
    );

    // First tick drains the result frame; the PID probe reads alive and the
    // stream is not yet quiet, so the session stays open.
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.finishRun).not.toHaveBeenCalled();

    // Past the 2 s quiet window the follower treats the session as dead:
    // settle is scheduled on the next tick and finalization lands.
    await vi.advanceTimersByTimeAsync(2_400);
    expect(mocks.finishRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ state: 'done', exit_status: 0, cost_usd: 0.11 }),
    );
    expect(mocks.setHooksFired).toHaveBeenCalledWith(row.id);
  });

  it('dead PID with no result + fresh linked entity → died-after-writeback', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });
    mocks.artifactFresh.mockReturnValue(true);
    // Killed-run usage recovery: no result frame and no cost on the session,
    // so the journal-tail lower bound must land on the row + insights event.
    const recovered = {
      costUsd: 0.07,
      tokensIn: 11,
      tokensOut: 22,
      tokensCacheRead: 3,
      tokensCacheWrite: 4,
      model: 'claude-recovered',
    };
    mocks.recoverUsageFromJournal.mockReturnValue(recovered);
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
    expect(mocks.recoverUsageFromJournal).toHaveBeenCalledWith(row.output_path);
    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        cost_usd: 0.07,
        tokens_in: 11,
        tokens_out: 22,
        tokens_cache_hit: 3,
        tokens_cache_write: 4,
        model: 'claude-recovered',
      }),
    );
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ cost_usd: 0.07, model: 'claude-recovered' }),
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

  it('stamps origin=human into the created row by default', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });
    await startRun({ prompt: 'wiring test' });
    expect(createdRow().origin).toBe('human');
  });

  it('honors an explicit origin on the start input', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });
    await startRun({ prompt: 'wiring test', origin: 'automation' });
    expect(createdRow().origin).toBe('automation');
    await startRun({ prompt: 'wiring test', origin: 'scheduler' });
    expect(createdRow().origin).toBe('scheduler');
  });

  it('stamps dispatch-resolved model/effort on the row right after spawn', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({
      pid: DEAD_PID,
      effort: 'max',
      model: 'claude-opus-4-8',
    });
    await startRun({ prompt: 'wiring test' });
    const row = createdRow();
    expect(mocks.setDispatchConfig).toHaveBeenCalledWith(row.id, {
      model: 'claude-opus-4-8',
      effort: 'max',
    });
  });

  it('spawn failure still stamps dispatch config, before the early finalize', async () => {
    mocks.spawnClaudeOrphaned.mockResolvedValue({
      pid: null,
      error: 'holder exploded',
      effort: 'max',
      model: 'claude-opus-4-8',
    });
    const res = await startRun({ prompt: 'wiring test' });
    expect(res.ok).toBe(true);
    const row = createdRow();
    expect(mocks.setDispatchConfig).toHaveBeenCalledWith(row.id, {
      model: 'claude-opus-4-8',
      effort: 'max',
    });
    // The stamp must land before finishRun finalizes the failed row —
    // that ordering is what makes spawn-level failures recorded at all.
    expect(mocks.setDispatchConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finishRun.mock.invocationCallOrder[0],
    );
  });

  it('execute-bound gate → threads model_execute AND effort_execute as spawn overrides', async () => {
    // Skill declares model_execute + effort_execute AND the change's review
    // gate is approved, so classifyChangeDispatchPhase (real, via
    // readChangeDispatchGate reading the fixture) returns execute-bound → both
    // overrides reach the spawn options.
    mocks.resolveModelExecuteForRun.mockResolvedValue('claude-opus-4-8');
    mocks.resolveEffortExecuteForRun.mockResolvedValue('xhigh');
    writeChangeFixture('exec-change', { review_status: 'approved' });
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });

    await startRun({
      prompt: 'Run dev-write-change for change "exec-change".',
      tags: { skill: 'dev-write-change', change_id: 'exec-change' },
    });

    expect(mocks.spawnClaudeOrphaned).toHaveBeenCalledWith(
      expect.any(String),
      'dev-write-change',
      expect.objectContaining({ model: 'claude-opus-4-8', effort: 'xhigh' }),
    );
  });

  it('plan-bound gate → no model/effort override even when both are declared', async () => {
    // Same declared model_execute + effort_execute, but review_status: pending
    // classifies plan-bound, so both overrides stay null and the skill's
    // model:/effort: chains apply — the gate, not just the frontmatter, decides.
    mocks.resolveModelExecuteForRun.mockResolvedValue('claude-opus-4-8');
    mocks.resolveEffortExecuteForRun.mockResolvedValue('xhigh');
    writeChangeFixture('plan-change', { review_status: 'pending' });
    mocks.spawnClaudeOrphaned.mockResolvedValue({ pid: DEAD_PID });

    await startRun({
      prompt: 'Run dev-write-change for change "plan-change".',
      tags: { skill: 'dev-write-change', change_id: 'plan-change' },
    });

    expect(mocks.spawnClaudeOrphaned).toHaveBeenCalledWith(
      expect.any(String),
      'dev-write-change',
      expect.objectContaining({ model: null, effort: null }),
    );
  });
});
