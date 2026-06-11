// /api/runs — first-class run records for skill dispatches.
//
// Replaces the modal-bound `/api/action` model: each POST to /api/runs creates
// a row in events.db's `runs` table, spawns `claude -p` as a subprocess, and
// streams output to `.claude/state/runs/<id>.jsonl`. Clients subscribe by id
// over SSE; many subscribers can attach to the same run.
//
// See vault/wiki/development/change/runs-as-process.md for the change context.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { recordEvent } from '../../../../../scripts/events-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractFromPrompt } from '../../../../../scripts/extract-event-attribution.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractSkill } from '../../../../../scripts/extract-event-attribution.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { appendChunk } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { bytesWritten } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { countRuns } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { createRun } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { evictBeyondCap } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { finishRun } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { getActiveRunForChange } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { getRun } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { listRuns } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { markRunning } from '../../../../../scripts/runs-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { unlinkOutput } from '../../../../../scripts/runs-db.mjs';
import { parseFrontmatter } from '../frontmatter.js';
import { parseStreamJsonLine } from '../lib/stream-json.js';
import { REPO_ROOT, safePath } from '../repo.js';
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
  state: 'done' | 'failed' | 'cancelled';
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

// Resolve the effort level to pass to `claude -p`. Precedence:
//   1. The skill's own `effort:` frontmatter field (per-skill opt-up/down)
//   2. .claude/settings.local.json `effortLevel` (per-install override)
//   3. .claude/settings.json `effortLevel` (team-tracked baseline)
//   4. null → omit `--effort` (let Claude Code use its model-specific default)
//
// CRITICAL: `claude -p` does NOT read effortLevel from settings files on its
// own — without an explicit `--effort` flag the subprocess falls back to
// Claude Code's built-in default, which silently ignores the dashboard's
// Settings → Effort dropdown. This function closes that gap so dispatched
// skill runs honor the same effort settings as interactive sessions.
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function readEffortFromJson(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    const v = parsed?.effortLevel;
    return typeof v === 'string' && VALID_EFFORTS.has(v) ? v : null;
  } catch {
    return null;
  }
}

async function readEffortFromSkill(skillName: string): Promise<string | null> {
  try {
    const text = await readFile(
      join(REPO_ROOT, '.claude', 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    const { fm } = parseFrontmatter(text);
    const v = fm.effort;
    return typeof v === 'string' && VALID_EFFORTS.has(v) ? v : null;
  } catch {
    return null;
  }
}

export async function resolveEffortForRun(skillName: string | null): Promise<string | null> {
  if (skillName) {
    const fromSkill = await readEffortFromSkill(skillName);
    if (fromSkill) return fromSkill;
  }
  const fromLocal = await readEffortFromJson(join(REPO_ROOT, '.claude', 'settings.local.json'));
  if (fromLocal) return fromLocal;
  return await readEffortFromJson(join(REPO_ROOT, '.claude', 'settings.json'));
}

// Model resolution mirrors effort exactly. Precedence:
//   1. Skill's own `model:` frontmatter field (per-skill explicit choice)
//   2. .claude/settings.local.json `model` (per-install override)
//   3. .claude/settings.json `model` (team-tracked baseline)
//   4. null → omit `--model` (let `claude -p` use the user-global default
//      from ~/.claude/settings.json, set via Claude Code's /model command)
//
// Same architectural rationale as resolveEffortForRun: `claude -p` reads
// settings from disk, not from any parent context. The OS layers above the
// user-global default let teams + installs + per-skill overrides take
// precedence without modifying the user's personal Claude Code settings.
async function readModelFromJson(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    const v = parsed?.model;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function readModelFromSkill(skillName: string): Promise<string | null> {
  try {
    const text = await readFile(
      join(REPO_ROOT, '.claude', 'skills', skillName, 'SKILL.md'),
      'utf8',
    );
    const { fm } = parseFrontmatter(text);
    const v = fm.model;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function resolveModelForRun(skillName: string | null): Promise<string | null> {
  if (skillName) {
    const fromSkill = await readModelFromSkill(skillName);
    if (fromSkill) return fromSkill;
  }
  const fromLocal = await readModelFromJson(join(REPO_ROOT, '.claude', 'settings.local.json'));
  if (fromLocal) return fromLocal;
  return await readModelFromJson(join(REPO_ROOT, '.claude', 'settings.json'));
}

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
  const rel = `.claude/state/runs/${id}.jsonl`;
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

  const evicted = evictBeyondCap(200) as Array<{ id: string; output_path: string }>;
  for (const ev of evicted) unlinkOutput(ev.output_path);

  const [effort, model] = await Promise.all([
    resolveEffortForRun(skill),
    resolveModelForRun(skill),
  ]);
  const args = [
    '-p',
    prompt,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (effort) args.push('--effort', effort);
  if (model) args.push('--model', model);
  if (effort || model) {
    console.log(
      `runs: spawning ${skill ?? '(unknown skill)'}${effort ? ` --effort ${effort}` : ''}${model ? ` --model ${model}` : ''}`,
    );
  }

  const child = spawn('claude', args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
  };
  sessions.set(id, session);
  spawnRun(session);

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

function spawnRun(session: RunSession) {
  const { child, id } = session;
  let stdoutBuf = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let nl = stdoutBuf.indexOf('\n');
    while (nl >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      nl = stdoutBuf.indexOf('\n');
      if (!line) continue;
      const parsed = parseStreamJsonLine(line);
      for (const p of parsed) {
        if (p.kind === 'assistant-text') {
          session.combinedText += p.text;
          appendChunk(id, 'stdout', p.text);
          broadcast(session, { chunk: p.text });
        } else if (p.kind === 'raw') {
          session.combinedText += p.text;
          appendChunk(id, 'stdout', p.text);
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
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    session.stderrAll += s;
    appendChunk(id, 'stderr', s);
    broadcast(session, { stderr: s });
  });

  child.on('close', (code) => {
    const durationMs = Date.now() - session.startedMs;
    const exit = typeof code === 'number' ? code : null;
    const state: RunRow['state'] = session.cancelled
      ? 'cancelled'
      : exit === 0 && !session.isError
        ? 'done'
        : 'failed';
    finishRun(id, {
      state,
      exit_status: exit,
      duration_ms: session.claudeDurationMs ?? durationMs,
      // Watchdog-kill reason wins over stderr capture — gives operators a
      // distinguishable error string ("killed: wall-time cap exceeded") so
      // they can tell wall-time kills from natural failures or orphan-sweep
      // detections. See sweepWallTimeCap below + Task #398 / #418.
      error: state === 'failed' ? (session.killedReason ?? (session.stderrAll || null)) : null,
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
      status: exit === 0 && !session.isError ? 'success' : 'error',
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

    // Phase 1.5: if this run was dispatched by an active project automation,
    // tick the state machine forward (advance or pause per the gate rules).
    // Fire-and-forget — auto-tick is best-effort and must not block the
    // close handler's cleanup. Internal failures log to console only.
    void onAutomationStepComplete(session.project, session.change_id, session.skill, exit);
    // Phase 2: per-change automation hook. Runs alongside the project hook
    // above — they read from different frontmatter (project vs change), so
    // there's no conflict. The change hook only acts when the change's
    // automation.enabled is true AND last_run_id matches, so unrelated runs
    // are silent no-ops.
    void onChangeAutomationStepComplete(session.change_id, session.skill, exit, session.id);
  });

  child.on('error', (err) => {
    appendChunk(id, 'stderr', `spawn error: ${err.message}\n`);
    broadcast(session, { stderr: `spawn error: ${err.message}\n` });
    // Let close handler do the final state transition.
  });
}

async function replayFromDisk(reply: FastifyReply, outputPath: string, endOffset: number) {
  if (endOffset <= 0 || !existsSync(outputPath)) return;
  const stream = createReadStream(outputPath, { end: endOffset - 1, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const rawLine of rl) {
    if (!rawLine) continue;
    let parsed: JsonlLine | null = null;
    try {
      parsed = JSON.parse(rawLine) as JsonlLine;
    } catch {
      continue;
    }
    const frame = toActionChunk(parsed);
    if (frame) sseSend(reply, frame);
  }
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
// Cap default chosen empirically: 25 min covers the longest legitimate
// run we've seen (~15 min address-comments on a complex change) plus
// generous headroom. Per-skill override via SKILL.md frontmatter is
// deferred — a uniform default is enough to bound the worst case.

const DEFAULT_WALL_TIME_CAP_MS = 25 * 60 * 1000; // 25 minutes
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
    if (ageMs <= DEFAULT_WALL_TIME_CAP_MS) continue;
    // Cap exceeded — terminate.
    const minutes = Math.floor(DEFAULT_WALL_TIME_CAP_MS / 60000);
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
    return { n };
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
        try {
          ring.push(JSON.parse(raw) as JsonlLine);
          if (ring.length > 50) ring.shift();
        } catch {
          /* skip */
        }
      }
      recent_chunks.push(...ring);
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

    // Snapshot the replay endpoint BEFORE attaching to the live bus. Writes
    // are append-only, so any chunk fanned out after this snapshot has an
    // offset >= attachOffset — no duplicates.
    const attachOffset = session
      ? bytesWritten(id)
      : existsSync(outputPath)
        ? Number.MAX_SAFE_INTEGER
        : 0;

    if (session) {
      // Live path: replay the prefix, then subscribe to live fan-out.
      await replayFromDisk(reply, outputPath, attachOffset);
      session.subscribers.add(reply);
      req.raw.on('close', () => {
        session.subscribers.delete(reply);
      });
      return reply;
    }

    // Terminal path: file is the source of truth. Replay everything, emit
    // done, close.
    await replayFromDisk(reply, outputPath, attachOffset);
    sseSend(reply, { done: true, exit: row.exit_status ?? null });
    reply.raw.end();
    return reply;
  });

  // -------- POST /api/runs/:id/cancel --------
  fastify.post<{ Params: { id: string } }>('/:id/cancel', async (req, reply) => {
    const id = req.params.id;
    const session = sessions.get(id);
    if (!session) {
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
