// /api/runs — first-class run records for skill dispatches.
//
// Replaces the modal-bound `/api/action` model: each POST to /api/runs creates
// a row in events.db's `runs` table, spawns `claude -p` as a subprocess, and
// streams output to `.claude/state/runs/<id>.jsonl`. Clients subscribe by id
// over SSE; many subscribers can attach to the same run.
//
// See vault/wiki/development/change/runs-as-process.md for the change context.

import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { resolveWallTimeCapMs, spawnClaude } from '../../../../../scripts/dispatch-claude.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { recordEvent } from '../../../../../scripts/events-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractFromPrompt } from '../../../../../scripts/extract-event-attribution.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractSkill } from '../../../../../scripts/extract-event-attribution.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { appendChunk } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { countRuns } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { createRun } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { RUNS_RETENTION_CAP, evictBeyondCap } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { finishRun } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { getActiveRunForChange } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { getRun } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { listRuns } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { listUnhookedTerminalRuns } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { markCancelRequested } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { markRunning } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { setHooksFired } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { stderrPathFor } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { unlinkOutput } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { artifactFresh } from '../../../../../scripts/runs-finalize.mjs';
import { parseStreamJsonLine } from '../lib/stream-json.js';
import { safePath } from '../repo.js';
import { onAutomationStepComplete, onChangeAutomationStepComplete } from './automation.js';
import type { RunRecord, RunTags } from './runs.types.js';

// Re-export wire-shape types for backward-compat. New consumers should
// import from ./runs.types.js per standard-shared-types.
export type { RunFilter, RunRecord, RunState, RunTags } from './runs.types.js';

// Local alias: existing server code uses `RunRow`. RunRow is byte-equivalent
// to RunRecord (wire shape); the rename to RunRecord matches the client's
// convention. Aliased here so call sites don't need to change.
type RunRow = RunRecord;

interface StartBody {
  prompt: string;
  title?: string;
  tags?: RunTags;
}

// In-memory per-run state. Lives only while the child is running.
interface RunSession {
  id: string;
  child: ChildProcess;
  subscribers: Set<FastifyReply>;
  cancelled: boolean;
  startedMs: number;
  ts: string;
  prompt: string;
  skill: string | null;
  change_id: string | null;
  project: string | null;
  domain: string | null;
  report_id: string | null;
  // Captured from the stream-json result event.
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  costUsd: number | null;
  claudeDurationMs: number | null;
  isError: boolean;
  combinedText: string;
  stderrAll: string;
  // Set by the wall-time-cap watchdog (sweepWallTimeCap below) when the
  // subprocess is killed for exceeding the cap. The close handler reads
  // this to write a distinguishable `error` field on the run row (vs.
  // orphan-sweep's "PID not alive" or natural-exit's stderr). Null when
  // the run terminates for any other reason.
  killedReason: string | null;
  // Watchdog bookkeeping — tracks when SIGTERM was sent so the next sweep
  // tick can escalate to SIGKILL if the process hasn't dropped. Independent
  // of `killedReason` (which is the user-facing message).
  killedAt: number | null;
  onFinished: ((summary: RunFinishedSummary) => void) | null;
  // Journal follower state. The child writes raw stream-json straight to
  // outputPath (and stderr to stderrPath); the server FOLLOWS the files
  // rather than holding pipes, so the child survives a server death.
  outputPath: string;
  stderrPath: string;
  rawOffset: number;
  errOffset: number;
  rawBuf: string;
  follower: NodeJS.Timeout | null;
  // Guards double-finalization (exit + error events, watchdog races).
  finished: boolean;
  // Per-skill wall-time cap (frontmatter > history-derived > 25m floor),
  // resolved once at spawn time. See dispatch-claude.mjs resolveWallTimeCapMs.
  wallCapMs: number;
}

const sessions = new Map<string, RunSession>();

// Module-scoped run launcher. Extracted from the POST /api/runs handler so
// other route modules (e.g. routes/projects.ts) can dispatch skills through
// the exact same path — the dashboard's Processes tab + cost rollups treat
// every run identically because they all flow through this function.
//
// Tags precedence matches the legacy handler exactly: explicit `tags` win
// over prompt-extracted attribution (see runs.ts pre-extraction). The
// concurrency gate is only applied when scoped to a change.
// StartRunInput + StartRunResult moved to ./runs.types.ts (shared with
// client). Re-exported above for backward-compat.
export type { StartRunInput, StartRunResult } from './runs.types.js';
import type { StartRunInput, StartRunResult } from './runs.types.js';

// Terminal summary handed to StartRunOptions.onFinished. Server-internal —
// not part of the HTTP wire shape (callbacks don't serialize), which is why
// these live here and not in runs.types.ts.
export interface RunFinishedSummary {
  state: 'done' | 'failed' | 'cancelled' | 'died-after-writeback';
  exit_status: number | null;
  duration_ms: number;
  cost_usd: number | null;
  model: string | null;
  stdout_preview: string;
  stderr: string | null;
}

// In-process callers (e.g. routes/schedules.ts run-now) may attach a
// completion callback. HTTP callers can't — req.body is JSON.
export interface StartRunOptions extends StartRunInput {
  onFinished?: (summary: RunFinishedSummary) => void;
}

// Effort/model resolution + arg assembly moved to scripts/dispatch-claude.mjs
// — the single source for `claude` subprocess invocations (audit check:
// dispatch-spawn-outside-helper). Same precedence chain as before: per-skill
// SKILL.md frontmatter > settings.local.json > settings.json > CLI default.

export async function startRun(input: StartRunOptions): Promise<StartRunResult> {
  const { prompt } = input;
  const promptAttribution = extractFromPrompt(prompt) as {
    change_id: string | null;
    project: string | null;
    domain: string | null;
    report_id: string | null;
  };
  const skillFromPrompt = extractSkill(prompt) as string | null;
  const tags: RunTags = input.tags ?? {};
  const skill = tags.skill ?? skillFromPrompt ?? null;
  const change_id = tags.change_id ?? promptAttribution.change_id ?? null;
  const project = tags.project ?? promptAttribution.project ?? null;
  const repo = tags.repo ?? null;
  const domain = tags.domain ?? promptAttribution.domain ?? null;
  // report_id rides only on the session + event row; the runs table doesn't
  // carry it. Research-domain skills declare report_id as their canonical
  // arg key (per their input schemas) so the events.db row is queryable
  // by report. Without this, the report-scoped attribution audit warns.
  const report_id = promptAttribution.report_id ?? null;

  if (change_id) {
    const blocking = getActiveRunForChange(change_id) as {
      id: string;
      skill: string | null;
    } | null;
    if (blocking) {
      return {
        ok: false,
        error: 'blocked',
        blocking: { run_id: blocking.id, skill: blocking.skill },
      };
    }
  }

  const id =
    'r_' +
    (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // Raw journal — the child's stdout is redirected here at spawn time (see
  // below); readers parse stream-json on read. Stays complete even if this
  // server process dies mid-run.
  const rel = `.claude/state/runs/${id}.raw.jsonl`;
  const output_path = safePath(rel);
  const ts = new Date().toISOString();
  const startedMs = Date.now();

  const created = createRun({
    id,
    started_at: ts,
    state: 'queued',
    skill,
    change_id,
    project,
    repo,
    domain,
    title: input.title ?? null,
    prompt,
    output_path,
  }) as { run_id?: string; error?: string };

  if (created.error) {
    return { ok: false, error: created.error };
  }

  const evicted = evictBeyondCap() as Array<{ id: string; output_path: string }>;
  for (const ev of evicted) unlinkOutput(ev.output_path);

  // Detached + file-redirected stdio: the child is its own process-group
  // leader writing straight to disk, so a dashboard restart no longer kills
  // it (pipes would EPIPE the child when the parent dies). Supervision of
  // children we can no longer see lives in scripts/runs-supervisor.mjs.
  const errPath = stderrPathFor(output_path) as string;
  const wallCapMs = (await resolveWallTimeCapMs(skill)) as number;
  mkdirSync(dirname(output_path), { recursive: true });
  const outFd = openSync(output_path, 'a');
  const errFd = openSync(errPath, 'a');
  let child: ChildProcess;
  try {
    ({ child } = (await spawnClaude(prompt, skill, {
      logPrefix: 'runs',
      stdio: ['ignore', outFd, errFd],
      detached: true,
    })) as { child: ChildProcess });
  } finally {
    // Parent's fd copies — the child holds its own descriptors.
    closeSync(outFd);
    closeSync(errFd);
  }
  child.unref();

  markRunning(id, child.pid ?? null);

  const session: RunSession = {
    id,
    child,
    subscribers: new Set(),
    cancelled: false,
    startedMs,
    ts,
    prompt,
    skill,
    change_id,
    project,
    domain,
    report_id,
    model: null,
    tokensIn: null,
    tokensOut: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costUsd: null,
    claudeDurationMs: null,
    isError: false,
    combinedText: '',
    stderrAll: '',
    killedReason: null,
    killedAt: null,
    onFinished: input.onFinished ?? null,
    outputPath: output_path,
    stderrPath: errPath,
    rawOffset: 0,
    errOffset: 0,
    rawBuf: '',
    follower: null,
    finished: false,
    wallCapMs,
  };
  sessions.set(id, session);
  superviseSession(session);

  return { ok: true, run_id: id };
}

function ssePrelude(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function sseSend(reply: FastifyReply, frame: Record<string, unknown>) {
  try {
    reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch {
    /* socket may be closed — best-effort */
  }
}

interface JsonlLine {
  ts?: string;
  kind?: string;
  data?: string;
  exit_status?: number | null;
}

// JSONL → wire frame translation, used identically in live-fanout and replay.
function toActionChunk(line: JsonlLine): Record<string, unknown> | null {
  if (line.kind === 'stdout') return { chunk: line.data ?? '' };
  if (line.kind === 'stderr') return { stderr: line.data ?? '' };
  if (line.kind === 'done') return { done: true, exit: line.exit_status ?? null };
  // 'meta' and anything else is server-side telemetry — dropped.
  return null;
}

// One journal line → zero or more legacy JsonlLine frames. Handles both
// eras: new runs hold raw stream-json straight from the child; legacy runs
// (pre durable-runs) hold pre-parsed {kind,...} frames. The done marker
// finishRun appends, the cancel note, and spawn-error notes are legacy
// frames in both eras.
function lineToJsonlFrames(rawLine: string): JsonlLine[] {
  let obj: unknown;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return [{ kind: 'stdout', data: `${rawLine}\n` }];
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.kind === 'string') return [rec as JsonlLine];
  const frames: JsonlLine[] = [];
  for (const p of parseStreamJsonLine(rawLine)) {
    if (p.kind === 'assistant-text' || p.kind === 'raw') {
      frames.push({ kind: 'stdout', data: p.text });
    }
  }
  return frames;
}

function broadcast(session: RunSession, frame: Record<string, unknown>) {
  for (const sub of session.subscribers) sseSend(sub, frame);
}

function closeSubscribers(session: RunSession, lastFrame?: Record<string, unknown>) {
  for (const sub of session.subscribers) {
    if (lastFrame) sseSend(sub, lastFrame);
    try {
      sub.raw.end();
    } catch {
      /* already closed */
    }
  }
  session.subscribers.clear();
}

// ---------------------------------------------------------------------------
// Journal following — the live half of the durable-runs design.
//
// The child writes raw stream-json to session.outputPath and stderr to
// session.stderrPath; while this server is alive we FOLLOW the files to
// drive SSE fan-out + capture the result event. If the server dies, the
// files keep growing and scripts/runs-supervisor.mjs finalizes the row from
// them — nothing is lost with the process.
// ---------------------------------------------------------------------------

const FOLLOW_INTERVAL_MS = 300;

function readNewText(path: string, offset: number): { text: string; nextOffset: number } {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { text: '', nextOffset: offset };
  }
  if (size <= offset) return { text: '', nextOffset: offset };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.toString('utf8'), nextOffset: size };
  } finally {
    closeSync(fd);
  }
}

function consumeJournalLine(session: RunSession, line: string) {
  for (const p of parseStreamJsonLine(line)) {
    if (p.kind === 'assistant-text' || p.kind === 'raw') {
      session.combinedText += p.text;
      broadcast(session, { chunk: p.text });
    } else if (p.kind === 'result') {
      session.model = p.model;
      session.tokensIn = p.tokensIn;
      session.tokensOut = p.tokensOut;
      session.tokensCacheRead = p.tokensCacheRead;
      session.tokensCacheWrite = p.tokensCacheWrite;
      session.costUsd = p.costUsd;
      session.claudeDurationMs = p.claudeDurationMs;
      session.isError = p.isError;
    }
  }
}

function followTick(session: RunSession) {
  const out = readNewText(session.outputPath, session.rawOffset);
  if (out.text) {
    session.rawOffset = out.nextOffset;
    session.rawBuf += out.text;
    let nl = session.rawBuf.indexOf('\n');
    while (nl >= 0) {
      const line = session.rawBuf.slice(0, nl);
      session.rawBuf = session.rawBuf.slice(nl + 1);
      nl = session.rawBuf.indexOf('\n');
      if (line) consumeJournalLine(session, line);
    }
  }
  const err = readNewText(session.stderrPath, session.errOffset);
  if (err.text) {
    session.errOffset = err.nextOffset;
    session.stderrAll += err.text;
    broadcast(session, { stderr: err.text });
  }
}

function finishAndRecord(session: RunSession, code: number | null) {
  if (session.finished) return;
  session.finished = true;
  if (session.follower) {
    clearInterval(session.follower);
    session.follower = null;
  }
  const { id } = session;
  const durationMs = Date.now() - session.startedMs;
  const exit = typeof code === 'number' ? code : null;
  let state: RunRow['state'] = session.cancelled
    ? 'cancelled'
    : exit === 0 && !session.isError
      ? 'done'
      : 'failed';
  // Watchdog-kill reason wins over stderr capture — gives operators a
  // distinguishable error string ("killed: wall-time cap exceeded") so
  // they can tell wall-time kills from natural failures or orphan-sweep
  // detections. See sweepWallTimeCap below + Task #398 / #418.
  let error: string | null =
    state === 'failed' ? (session.killedReason ?? (session.stderrAll || null)) : null;
  // Artifact verification before failing a cap-kill: a SIGTERM'd child that
  // already wrote its linked entity is died-after-writeback, not failed —
  // the same rule the finalizer applies to runs that die while the server
  // is down (runs-finalize.mjs).
  if (state === 'failed' && session.killedReason?.startsWith('killed:')) {
    const fresh = artifactFresh({
      change_id: session.change_id,
      project: session.project,
      started_at: session.ts,
    }) as boolean;
    if (fresh) {
      state = 'died-after-writeback';
      error = `${session.killedReason} — linked entity updated after start; work likely landed (verify it)`;
    }
  }
  const ok = state === 'done' || state === 'died-after-writeback';
  finishRun(id, {
    state,
    exit_status: exit,
    duration_ms: session.claudeDurationMs ?? durationMs,
    error,
    cost_usd: session.costUsd,
    tokens_in: session.tokensIn,
    tokens_out: session.tokensOut,
    tokens_cache_hit: session.tokensCacheRead,
    tokens_cache_write: session.tokensCacheWrite,
    model: session.model,
  });

  closeSubscribers(session, { done: true, exit });
  sessions.delete(id);

  // Preserve the Insights view's existing observability surface — same
  // event shape as /api/action wrote.
  recordEvent({
    ts: session.ts,
    kind: 'dashboard',
    action: 'ai-prompt',
    source: 'dashboard',
    skill: session.skill,
    change_id: session.change_id,
    project: session.project,
    report_id: session.report_id,
    domain: session.domain,
    model: session.model,
    tokens_in: session.tokensIn,
    tokens_out: session.tokensOut,
    tokens_cache_hit: session.tokensCacheRead,
    tokens_cache_write: session.tokensCacheWrite,
    cost_usd: session.costUsd,
    duration_ms: session.claudeDurationMs ?? durationMs,
    exit_status: exit,
    status: ok ? 'success' : 'error',
    prompt: session.prompt,
    stdout_preview: session.combinedText,
    stderr: session.stderrAll || null,
  });

  if (session.onFinished) {
    try {
      session.onFinished({
        state,
        exit_status: exit,
        duration_ms: session.claudeDurationMs ?? durationMs,
        cost_usd: session.costUsd,
        model: session.model,
        stdout_preview: session.combinedText,
        stderr: session.stderrAll || null,
      });
    } catch (e) {
      console.error('runs: onFinished callback failed', e);
    }
  }

  // died-after-writeback advances automation as a success (the linked
  // entity was verifiably updated); the warning lives on the run row.
  const effectiveExit = ok ? 0 : exit;
  // Phase 1.5: if this run was dispatched by an active project automation,
  // tick the state machine forward (advance or pause per the gate rules).
  // Fire-and-forget — auto-tick is best-effort and must not block the
  // close handler's cleanup. Internal failures log to console only.
  void onAutomationStepComplete(session.project, session.change_id, session.skill, effectiveExit);
  // Phase 2: per-change automation hook. Runs alongside the project hook
  // above — they read from different frontmatter (project vs change), so
  // there's no conflict. The change hook only acts when the change's
  // automation.enabled is true AND last_run_id matches, so unrelated runs
  // are silent no-ops.
  void onChangeAutomationStepComplete(session.change_id, session.skill, effectiveExit, session.id);

  // Hooks fired in-process — the unhooked-runs poll (processUnhookedRuns)
  // skips this row. Supervisor-finalized rows take the poll path instead.
  setHooksFired(id);
}

function superviseSession(session: RunSession) {
  const { child } = session;
  session.follower = setInterval(() => followTick(session), FOLLOW_INTERVAL_MS);
  session.follower.unref?.();

  child.on('exit', (code) => {
    // Drain twice: once immediately (bytes written before exit are visible),
    // and once shortly after to be safe about flush ordering.
    followTick(session);
    setTimeout(() => {
      followTick(session);
      finishAndRecord(session, code);
    }, 150);
  });

  child.on('error', (err) => {
    // Spawn-level failure (ENOENT etc.) — 'exit' may never fire.
    appendChunk(session.id, 'stderr', `spawn error: ${err.message}\n`);
    broadcast(session, { stderr: `spawn error: ${err.message}\n` });
    setTimeout(() => finishAndRecord(session, null), 50);
  });
}

async function replayFromDisk(reply: FastifyReply, outputPath: string, endOffset: number) {
  if (endOffset <= 0 || !existsSync(outputPath)) return;
  const stream = createReadStream(outputPath, { end: endOffset - 1, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const rawLine of rl) {
    if (!rawLine) continue;
    for (const parsed of lineToJsonlFrames(rawLine)) {
      const frame = toActionChunk(parsed);
      if (frame) sseSend(reply, frame);
    }
  }
}

// Replay the stderr sidecar (separate file since durable-runs) as one frame.
function replayStderr(reply: FastifyReply, outputPath: string, endOffset?: number) {
  try {
    let text = readFileSync(stderrPathFor(outputPath) as string, 'utf8');
    if (endOffset != null) text = text.slice(0, endOffset);
    if (text) sseSend(reply, { stderr: text });
  } catch {
    /* no sidecar — legacy run; its stderr frames live in the journal */
  }
}

// ---------------------------------------------------------------------------
// Post-terminal hooks for runs finalized OUTSIDE this process.
//
// Row finalization and hook firing are split (hooks_fired_at column): the
// supervisor (scheduler tick) finalizes dead runs even while the server is
// down, but events.db recording + automation advancement need the server's
// modules. This poll fires them idempotently for any terminal row that
// hasn't had hooks fired — without it, a run that died during a server
// outage would leave its change automation parked forever.
// ---------------------------------------------------------------------------

async function deriveOutputsFromFiles(
  outputPath: string,
): Promise<{ combined: string; stderrText: string }> {
  let combined = '';
  if (existsSync(outputPath)) {
    const rl = createInterface({
      input: createReadStream(outputPath, { encoding: 'utf8' }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      if (!line) continue;
      for (const f of lineToJsonlFrames(line)) {
        if (f.kind === 'stdout') combined += f.data ?? '';
      }
    }
  }
  let stderrText = '';
  try {
    stderrText = readFileSync(stderrPathFor(outputPath) as string, 'utf8');
  } catch {
    /* no sidecar */
  }
  return { combined, stderrText };
}

export async function processUnhookedRuns(): Promise<number> {
  const rows = listUnhookedTerminalRuns(50) as RunRow[];
  for (const row of rows) {
    try {
      const ok = row.state === 'done' || row.state === 'died-after-writeback';
      const { combined, stderrText } = await deriveOutputsFromFiles(row.output_path);
      recordEvent({
        ts: row.started_at,
        kind: 'dashboard',
        action: 'ai-prompt',
        source: 'dashboard',
        skill: row.skill,
        change_id: row.change_id,
        project: row.project,
        domain: row.domain,
        model: row.model,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        tokens_cache_hit: row.tokens_cache_hit,
        tokens_cache_write: row.tokens_cache_write,
        cost_usd: row.cost_usd,
        duration_ms: row.duration_ms,
        exit_status: row.exit_status,
        status: ok ? 'success' : 'error',
        prompt: row.prompt,
        stdout_preview: combined.slice(0, 16384),
        stderr: stderrText ? stderrText.slice(0, 8192) : null,
      });
      // died-after-writeback advances automation as a success (the linked
      // entity was verifiably updated) — the warning lives on the run row.
      const effectiveExit = ok ? (row.exit_status ?? 0) : (row.exit_status ?? 1);
      void onAutomationStepComplete(row.project, row.change_id, row.skill, effectiveExit);
      void onChangeAutomationStepComplete(row.change_id, row.skill, effectiveExit, row.id);
    } catch (e) {
      console.error(`runs: unhooked-run processing failed for ${row.id}`, e);
    } finally {
      // Mark even on partial failure — re-firing recordEvent/automation on
      // every poll forever is worse than one lost event.
      setHooksFired(row.id);
    }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Wall-time cap watchdog — Task #418 mitigation
//
// Long-running `claude -p` subprocesses sometimes die silently (OS-level
// kill, OOM pressure, App Nap). Observed three times in one session this
// week — see [[note-mull-version-2-dogfooding-findings]] and the finding
// description.
//
// This watchdog turns the silent-OS-kill failure mode into a visible,
// time-bounded, structured failure: any subprocess that runs longer than
// the configured cap gets SIGTERM'd (escalating to SIGKILL after 30s if
// still alive). The close handler sees `session.killedReason` and writes
// it as the run's `error` field, distinct from orphan-sweep's "PID not
// alive" message.
//
// Caps are per-skill since the Fable review: the old uniform 25-minute cap
// sat below meta-curate's measured 41-minute average — migrating long
// skills onto this watchdog would have killed every healthy run. Each
// session resolves its cap at spawn time (SKILL.md `wall_time_cap_minutes:`
// > 2×p95 of the skill's successful duration history > 25m floor — see
// dispatch-claude.mjs resolveWallTimeCapMs) and cap-kills are artifact-
// verified in finishAndRecord before being marked failed.

const WALL_TIME_SWEEP_INTERVAL_MS = 30 * 1000; // tick every 30s
const SIGKILL_ESCALATION_MS = 30 * 1000; // wait this long after SIGTERM

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sweepWallTimeCap(): void {
  const now = Date.now();
  for (const session of sessions.values()) {
    // Already killed this round — escalate to SIGKILL if the process
    // hasn't dropped after the escalation window. process.kill(pid, 0)
    // probes liveness without sending a real signal.
    if (session.killedReason && session.killedAt !== null) {
      if (now - session.killedAt > SIGKILL_ESCALATION_MS) {
        const pid = session.child.pid;
        if (pid && isPidAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
            console.warn(
              `runs: escalated SIGKILL on run ${session.id} (PID ${pid}) — wall-time cap escalation`,
            );
          } catch {
            /* process already gone */
          }
        }
      }
      continue;
    }
    const ageMs = now - session.startedMs;
    if (ageMs <= session.wallCapMs) continue;
    // Cap exceeded — terminate.
    const minutes = Math.floor(session.wallCapMs / 60000);
    session.killedReason = `killed: wall-time cap exceeded (${minutes}m)`;
    session.killedAt = now;
    try {
      session.child.kill('SIGTERM');
      console.warn(
        `runs: SIGTERM run ${session.id} (skill=${session.skill}, age=${Math.floor(ageMs / 1000)}s) — wall-time cap exceeded`,
      );
    } catch {
      /* child may have died between our check and the kill — orphan-sweep
         will pick up the row */
    }
  }
}

const wallTimeCapTimer = setInterval(sweepWallTimeCap, WALL_TIME_SWEEP_INTERVAL_MS);
// Don't keep the process alive on shutdown.
wallTimeCapTimer.unref();

export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  // -------- POST /api/runs --------
  // Thin wrapper over startRun(). HTTP-shape only — prompt validation + 409
  // translation for the concurrency gate. The actual launch logic lives in
  // startRun so other route modules can share it.
  fastify.post<{ Body: StartBody }>('/', async (req, reply) => {
    const body = req.body ?? ({} as StartBody);
    if (!body.prompt || typeof body.prompt !== 'string') {
      reply.code(400);
      return { error: 'prompt is required' };
    }
    const result = await startRun({ prompt: body.prompt, title: body.title, tags: body.tags });
    if (result.ok) return { run_id: result.run_id };
    if ('blocking' in result) {
      reply.code(409);
      return { error: 'blocked', blocking: result.blocking };
    }
    reply.code(500);
    return { error: result.error };
  });

  // -------- GET /api/runs --------
  fastify.get<{
    Querystring: {
      state?: string;
      skill?: string;
      change_id?: string;
      project?: string;
      repo?: string;
      domain?: string;
      since?: string;
      until?: string;
      limit?: string;
    };
  }>('/', async (req) => {
    const q = req.query ?? {};
    const rows = listRuns({
      state: q.state || undefined,
      skill: q.skill || undefined,
      change_id: q.change_id || undefined,
      project: q.project || undefined,
      repo: q.repo || undefined,
      domain: q.domain || undefined,
      since: q.since || undefined,
      until: q.until || undefined,
      limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
    }) as RunRow[];
    return { runs: rows };
  });

  // -------- GET /api/runs/count --------
  fastify.get<{
    Querystring: {
      state?: string;
      skill?: string;
      change_id?: string;
      project?: string;
      repo?: string;
      domain?: string;
    };
  }>('/count', async (req) => {
    const q = req.query ?? {};
    const n = countRuns({
      state: q.state || undefined,
      skill: q.skill || undefined,
      change_id: q.change_id || undefined,
      project: q.project || undefined,
      repo: q.repo || undefined,
      domain: q.domain || undefined,
    }) as number;
    return { n, cap: RUNS_RETENTION_CAP as number };
  });

  // -------- GET /api/runs/:id --------
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = getRun(req.params.id) as RunRow | null;
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }
    // Tail the last 50 lines from the JSONL file as `recent_chunks` so clients
    // that opened with stale state have something to render immediately.
    const recent_chunks: JsonlLine[] = [];
    if (existsSync(row.output_path)) {
      const stream = createReadStream(row.output_path, { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
      const ring: JsonlLine[] = [];
      for await (const raw of rl) {
        if (!raw) continue;
        for (const frame of lineToJsonlFrames(raw)) {
          ring.push(frame);
          if (ring.length > 50) ring.shift();
        }
      }
      recent_chunks.push(...ring);
      // stderr sidecar tail (separate file since durable-runs)
      try {
        const errText = readFileSync(stderrPathFor(row.output_path) as string, 'utf8');
        if (errText) recent_chunks.push({ kind: 'stderr', data: errText.slice(-4096) });
      } catch {
        /* no sidecar — legacy run */
      }
    }
    return { run: row, recent_chunks };
  });

  // -------- POST /api/runs/:id/stream --------
  // SSE over POST so the existing runStream() helper on the client can reuse
  // unchanged (matches the /api/action precedent).
  fastify.post<{ Params: { id: string } }>('/:id/stream', async (req, reply) => {
    const id = req.params.id;
    const row = getRun(id) as RunRow | null;
    if (!row) {
      reply.code(404);
      return { error: 'not found' };
    }

    ssePrelude(reply);

    const session = sessions.get(id);
    const outputPath = row.output_path;

    if (session) {
      // Live path: replay the journal prefix this server has already
      // consumed (append-only ⇒ no duplicates with the live fan-out), then
      // subscribe.
      const attachOffset = session.rawOffset;
      const errAttach = session.errOffset;
      await replayFromDisk(reply, outputPath, attachOffset);
      replayStderr(reply, outputPath, errAttach);
      session.subscribers.add(reply);
      req.raw.on('close', () => {
        session.subscribers.delete(reply);
      });
      return reply;
    }

    if (row.state === 'running' || row.state === 'queued') {
      // Adopted live path — this server restarted while the detached child
      // kept running. No in-memory session exists; follow the journal files
      // directly until the row goes terminal (the supervisor or this
      // server's dead-run sweep finalizes it).
      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      let offset = 0;
      let errOffset = 0;
      let buf = '';
      const errPath = stderrPathFor(outputPath) as string;
      const pump = () => {
        const out = readNewText(outputPath, offset);
        if (out.text) {
          offset = out.nextOffset;
          buf += out.text;
          let nl = buf.indexOf('\n');
          while (nl >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
            if (!line) continue;
            for (const parsed of lineToJsonlFrames(line)) {
              const frame = toActionChunk(parsed);
              if (frame) sseSend(reply, frame);
            }
          }
        }
        const err = readNewText(errPath, errOffset);
        if (err.text) {
          errOffset = err.nextOffset;
          sseSend(reply, { stderr: err.text });
        }
      };
      while (!closed) {
        pump();
        const fresh = getRun(id) as RunRow | null;
        if (!fresh || (fresh.state !== 'running' && fresh.state !== 'queued')) {
          pump();
          sseSend(reply, { done: true, exit: fresh?.exit_status ?? null });
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      reply.raw.end();
      return reply;
    }

    // Terminal path: files are the source of truth. Replay everything, emit
    // done, close.
    await replayFromDisk(reply, outputPath, Number.MAX_SAFE_INTEGER);
    replayStderr(reply, outputPath);
    sseSend(reply, { done: true, exit: row.exit_status ?? null });
    reply.raw.end();
    return reply;
  });

  // -------- POST /api/runs/:id/cancel --------
  fastify.post<{ Params: { id: string } }>('/:id/cancel', async (req, reply) => {
    const id = req.params.id;
    const session = sessions.get(id);
    if (!session) {
      // Detached child from a previous server process — no in-memory
      // session, but the row + PID survive. Mark the cancel so the
      // finalizer maps the death to state='cancelled', then signal.
      const row = getRun(id) as RunRow | null;
      if (row && row.state === 'running' && row.pid) {
        markCancelRequested(id);
        appendChunk(id, 'stderr', '\n✗ Cancelled by user\n');
        try {
          process.kill(row.pid, 'SIGTERM');
        } catch {
          /* already dead — the supervisor finalizes */
        }
        return { ok: true };
      }
      reply.code(409);
      return { ok: false, error: 'not running' };
    }
    session.cancelled = true;
    appendChunk(id, 'stderr', '\n✗ Cancelled by user\n');
    broadcast(session, { stderr: '\n✗ Cancelled by user\n' });
    try {
      session.child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    return { ok: true };
  });
};
