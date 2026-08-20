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
  // Hoisted so the fallback-hook tests can hand finishAndRecord a finalized
  // row. Default null = "row not found" ⇒ the hook is a no-op, which keeps
  // every pre-existing pin unchanged.
  getRun: vi.fn((): Record<string, unknown> | null => null),
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
  getRun: mocks.getRun,
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
    mocks.getRun.mockReturnValue(null);
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

  // -------------------------------------------------------------------------
  // Model-availability wiring (§3.2)
  //
  // Failure injection at the close handler: a child that dies because it
  // cannot reach its model must say so on the row instead of landing as a
  // bare "failed" with an empty error. Everything here lives in the failure
  // arm — the last test in this block is the §8.3 pin that proves it.
  // -------------------------------------------------------------------------

  // A child's terminal stream-json result frame.
  function resultFrame(isError: boolean, text: string): string {
    return `${JSON.stringify({
      type: 'result',
      is_error: isError,
      total_cost_usd: 0.01,
      duration_ms: 900,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { 'claude-fable-5': {} },
      result: text,
    })}\n`;
  }

  // Echo the resolved model/effort back the way the real helper does, so the
  // dispatch-time stamp (and session.dispatchModel) carries a real value.
  function spawnEchoingResolution() {
    mocks.spawnClaudeOrphaned.mockImplementation(
      async (_prompt: string, _skill: string | null, opts: { model?: string; effort?: string }) => ({
        pid: DEAD_PID,
        model: opts.model ?? 'claude-fable-5',
        effort: opts.effort ?? 'max',
      }),
    );
  }

  it('model_override / effort_override beat the phase-aware execute defaults', async () => {
    // The sanctioned human escape hatch: even a dispatch the gate classifies
    // EXECUTE-bound (which would otherwise force model_execute/effort_execute)
    // yields to an explicit override — and the override is what gets recorded.
    mocks.resolveModelExecuteForRun.mockResolvedValue('claude-opus-4-8');
    mocks.resolveEffortExecuteForRun.mockResolvedValue('xhigh');
    writeChangeFixture('override-change', { review_status: 'approved' });
    spawnEchoingResolution();

    await startRun({
      prompt: 'Run dev-write-change for change "override-change".',
      tags: { skill: 'dev-write-change', change_id: 'override-change' },
      model_override: 'claude-sonnet-4-5',
      effort_override: 'medium',
    });

    expect(mocks.spawnClaudeOrphaned).toHaveBeenCalledWith(
      expect.any(String),
      'dev-write-change',
      expect.objectContaining({ model: 'claude-sonnet-4-5', effort: 'medium' }),
    );
    expect(mocks.setDispatchConfig).toHaveBeenCalledWith(createdRow().id, {
      model: 'claude-sonnet-4-5',
      effort: 'medium',
    });
  });

  it('failed run: prepends the structured availability line to the row error', async () => {
    spawnEchoingResolution();
    await startRun({ prompt: 'Run dev-pr-review.', tags: { skill: 'dev-pr-review' } });
    const row = createdRow();
    writeFileSync(row.output_path, resultFrame(true, 'API Error: Credit balance is too low'));

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(150);

    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        state: 'failed',
        error:
          'model-unavailable(credits): claude-fable-5 — policy: required; parked, no side effects; restore credits and re-dispatch',
      }),
    );
  });

  it('instant death: classifies with no result event and no captured stderr', async () => {
    // The credit shape — exit 1 in ~1 s. No result frame, and the stderr the
    // follower captured is empty, so before this wiring the row landed with a
    // null error. The evidence is the stderr SIDECAR next to the journal, and
    // the model named is the dispatch-time one (nothing was ever observed).
    spawnEchoingResolution();
    await startRun({ prompt: 'Run meta-curate.', tags: { skill: 'meta-curate' } });
    const row = createdRow();
    writeFileSync(row.output_path, '');
    writeFileSync(row.output_path.replace(/\.raw\.jsonl$/, '.stderr.log'), 'Please run /login\n');

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(150);

    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        state: 'failed',
        // meta-curate declares no policy → the bare line.
        error: 'model-unavailable(auth): claude-fable-5',
      }),
    );
  });

  it('failed fallback-allowed run: re-dispatches once on the declared fallback', async () => {
    spawnEchoingResolution();
    await startRun({ prompt: 'Run research-write.', tags: { skill: 'research-write' } });
    const row = createdRow();
    writeFileSync(row.output_path, resultFrame(true, 'Credit balance is too low'));
    // The hook reads the freshly-finalized row back. `Once` so the second
    // leg's own finalization finds nothing and can never spawn a third.
    mocks.getRun.mockReturnValueOnce({
      ...row,
      state: 'failed',
      skill: 'research-write',
      model: 'claude-fable-5',
      title: null,
      prompt: 'Run research-write.',
      change_id: null,
      project: null,
      repo: null,
      domain: 'research',
    });

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(50); // flush the fire-and-forget hook

    const second = mocks.createRun.mock.calls.at(-1)?.[0];
    expect(mocks.createRun).toHaveBeenCalledTimes(2);
    expect(second.title).toBe('fallback(claude-opus-4-8): research-write');
    expect(second.origin).toBe('automation');
    expect(second.prompt).toBe('Run research-write.');
    expect(mocks.spawnClaudeOrphaned).toHaveBeenLastCalledWith(
      'Run research-write.',
      'research-write',
      expect.objectContaining({ model: 'claude-opus-4-8', effort: 'high' }),
    );
  });

  it('happy path stays byte-identical — no classification, no second leg', async () => {
    // The journal text would classify as rate-limit if anything looked at it;
    // a successful run means nothing does (§8.3).
    spawnEchoingResolution();
    await startRun({ prompt: 'Run research-write.', tags: { skill: 'research-write' } });
    const row = createdRow();
    writeFileSync(row.output_path, resultFrame(false, 'hit a rate limit early on, then recovered'));

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.finishRun).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ state: 'done', error: null }),
    );
    // The fallback hook never even reads the row back on a successful run.
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.createRun).toHaveBeenCalledTimes(1);
  });
});
