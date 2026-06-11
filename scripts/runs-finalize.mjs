// Finalize a dead run from its on-disk evidence.
//
// Detached children write raw stream-json straight to the run's journal
// (`<id>.raw.jsonl`), so the journal is complete even when nobody observed
// the death — server restart, silent OS kill, wall-cap SIGTERM from the
// supervisor. This module turns that evidence into a terminal row:
//
//   result event present, !is_error  → done   (cost/tokens/model recovered)
//   result event present, is_error   → failed
//   no result event, linked entity's `updated` >= run start
//                                     → died-after-writeback  (work landed)
//   no result event, no fresh artifact → failed
//   row.error starts with 'cancelled' → cancelled  (user cancel after the
//                                       server lost the in-memory session)
//
// `died-after-writeback` is the state the Fable review asked for: the
// CHANGELOG's old guidance was "verify the linked entity, don't trust the
// 'failed' badge alone" — this encodes that verification instead of asking
// a human to do it. The orchestrator treats it as success-with-warning.
//
// Pure node built-ins; used by scripts/runs-supervisor.mjs (scheduler tick,
// launchd context) and importable by the server.

// NOTE: no top-level runs-db import — runs-db pulls node:sqlite, which
// vitest's resolver cannot load, and the pure parts of this module
// (inferTerminalState et al.) are unit-tested. finishRun is dynamically
// imported inside finalizeDeadRun, the only impure entry point.
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Read at most the last `cap` bytes of a file (the result event is the final
// line; journals can be megabytes).
function readTail(path, cap = 512 * 1024) {
  const size = statSync(path).size;
  const start = Math.max(0, size - cap);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// Scan the journal tail (newest line first) for the stream-json result event.
// Returns null when the child died before emitting one.
export function extractResultEvent(rawPath) {
  if (!rawPath || !existsSync(rawPath)) return null;
  let text;
  try {
    text = readTail(rawPath);
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.type !== 'result') continue;
    const usage = evt.usage ?? {};
    let model = null;
    if (evt.modelUsage && typeof evt.modelUsage === 'object') {
      const keys = Object.keys(evt.modelUsage);
      if (keys.length > 0) model = keys[0];
    }
    return {
      isError: Boolean(evt.is_error),
      costUsd: evt.total_cost_usd ?? null,
      durationMs: evt.duration_ms ?? null,
      tokensIn: usage.input_tokens ?? null,
      tokensOut: usage.output_tokens ?? null,
      tokensCacheRead: usage.cache_read_input_tokens ?? null,
      tokensCacheWrite: usage.cache_creation_input_tokens ?? null,
      model,
    };
  }
  return null;
}

// Minimal scalar frontmatter read — only needs `updated:`. Consolidation of
// the repo's parsers is the one-shared-frontmatter-parser change.
function updatedOf(entryPath) {
  try {
    const text = readFileSync(entryPath, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const m = fm[1].match(/^updated:\s*['"]?([^'"\n]+)['"]?\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Was the run's linked entity (change > project) written to after the run
// started? Resolves the entity's path via the vault manifest. Any failure
// → false (we never upgrade to died-after-writeback without evidence).
export function artifactFresh(row, repoRoot = REPO_ROOT) {
  const entityId = row.change_id ?? row.project ?? null;
  if (!entityId || !row.started_at) return false;
  try {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'vault', '.index', 'manifest.json'), 'utf8'),
    );
    const entry = (manifest.entries ?? []).find((e) => e.id === entityId);
    if (!entry?.path) return false;
    const updated = updatedOf(join(repoRoot, entry.path));
    if (!updated) return false;
    const updatedMs = Date.parse(updated);
    const startedMs = Date.parse(row.started_at);
    if (!Number.isFinite(updatedMs) || !Number.isFinite(startedMs)) return false;
    return updatedMs >= startedMs;
  } catch {
    return false;
  }
}

// Pure terminal-state inference — unit-tested in tests/unit/runs/finalize.test.ts.
export function inferTerminalState({ result, fresh, errorMarker }) {
  if (errorMarker && errorMarker.startsWith('cancelled')) {
    return { state: 'cancelled', exit_status: null };
  }
  if (result) {
    return result.isError
      ? { state: 'failed', exit_status: 1 }
      : { state: 'done', exit_status: 0 };
  }
  if (fresh) return { state: 'died-after-writeback', exit_status: null };
  return { state: 'failed', exit_status: null };
}

// Finalize one dead run row. Returns the terminal state written.
export async function finalizeDeadRun(row, { reason = 'PID not alive' } = {}, repoRoot = REPO_ROOT) {
  const { finishRun } = await import('./runs-db.mjs');
  const result = extractResultEvent(row.output_path);
  const fresh = result ? false : artifactFresh(row, repoRoot);
  const { state, exit_status } = inferTerminalState({
    result,
    fresh,
    errorMarker: row.error ?? null,
  });

  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  const wallMs = Number.isFinite(startedMs) ? Date.now() - startedMs : null;

  let error = null;
  if (state === 'failed') {
    // Preserve a supervisor kill marker (wall-cap) over the generic reason.
    error = row.error?.startsWith('killed:') ? row.error : reason;
  } else if (state === 'died-after-writeback') {
    error = `${reason} — no result event, but the linked entity was updated after start; work likely landed (verify it)`;
  } else if (state === 'cancelled') {
    error = row.error;
  }

  finishRun(row.id, {
    state,
    exit_status,
    duration_ms: result?.durationMs ?? wallMs,
    error,
    cost_usd: result?.costUsd ?? null,
    tokens_in: result?.tokensIn ?? null,
    tokens_out: result?.tokensOut ?? null,
    tokens_cache_hit: result?.tokensCacheRead ?? null,
    tokens_cache_write: result?.tokensCacheWrite ?? null,
    model: result?.model ?? null,
  });
  return state;
}
