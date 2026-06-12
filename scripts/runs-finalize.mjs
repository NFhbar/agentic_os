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
// Pure JS, no node:sqlite — keeps this module vitest-loadable.
import { computeCost } from './models-registry.mjs';

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
      resultText: typeof evt.result === 'string' ? evt.result : null,
    };
  }
  return null;
}

// Killed-run usage recovery — runs that die without a result event (wall-cap
// SIGTERM, silent OS kill) otherwise carry no cost/token data at all. The
// per-message assistant events that DID land in the journal are evidence
// enough for a lower-bound recovery: each API call bills its full input
// (mostly cache reads), so summing per-unique-message usage approximates the
// billed total minus the final in-flight call.

// Read window for usage recovery. Journals can be megabytes and
// extractJournalUsage is also called synchronously from the server's
// finishAndRecord — the read cost must be bounded by design. Truncation only
// widens the lower-bound underestimate; the dominant cost sits in the later,
// larger API calls, which the tail keeps.
export const JOURNAL_USAGE_TAIL_BYTES = 4 * 1024 * 1024;

// Sum per-model token usage from the journal's assistant events, deduped by
// message.id (stream-json emits multiple assistant events per message —
// last write wins). Returns { perModel, model } (dominant model = highest
// summed output) or null when no usable assistant events exist.
export function extractJournalUsage(rawPath) {
  if (!rawPath || !existsSync(rawPath)) return null;
  let text;
  let truncated = false;
  try {
    truncated = statSync(rawPath).size > JOURNAL_USAGE_TAIL_BYTES;
    text = readTail(rawPath, JOURNAL_USAGE_TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const byMessageId = new Map();
  // When the window truncated the file, the first line is partial — drop it.
  for (let i = truncated ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.type !== 'assistant') continue;
    const msg = evt.message;
    if (!msg || typeof msg !== 'object') continue;
    const id = typeof msg.id === 'string' ? msg.id : null;
    const usage = msg.usage;
    if (!id || !usage || typeof usage !== 'object') continue;
    byMessageId.set(id, {
      model: typeof msg.model === 'string' ? msg.model : null,
      usage,
    });
  }
  if (byMessageId.size === 0) return null;
  const perModel = {};
  for (const { model, usage } of byMessageId.values()) {
    const key = model ?? 'unknown';
    const acc = perModel[key] ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    acc.input += usage.input_tokens ?? 0;
    acc.output += usage.output_tokens ?? 0;
    acc.cache_read += usage.cache_read_input_tokens ?? 0;
    acc.cache_write += usage.cache_creation_input_tokens ?? 0;
    perModel[key] = acc;
  }
  let model = null;
  let bestOutput = -1;
  for (const [m, acc] of Object.entries(perModel)) {
    if (acc.output > bestOutput) {
      bestOutput = acc.output;
      model = m;
    }
  }
  return { perModel, model };
}

// Compose extraction with the registry's cost math. Returns finishRun-shaped
// usage fields or null. Any model missing from the registry → tokens still
// recovered, costUsd null (the registry's "don't guess" rule).
export function recoverUsageFromJournal(rawPath) {
  const extracted = extractJournalUsage(rawPath);
  if (!extracted) return null;
  const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let costUsd = 0;
  let costKnown = true;
  for (const [model, t] of Object.entries(extracted.perModel)) {
    totals.input += t.input;
    totals.output += t.output;
    totals.cache_read += t.cache_read;
    totals.cache_write += t.cache_write;
    const c = computeCost(model, t);
    if (c == null) costKnown = false;
    else costUsd += c;
  }
  return {
    costUsd: costKnown ? Math.round(costUsd * 1_000_000) / 1_000_000 : null,
    tokensIn: totals.input,
    tokensOut: totals.output,
    tokensCacheRead: totals.cache_read,
    tokensCacheWrite: totals.cache_write,
    model: extracted.model,
  };
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
  // No result event (killed / limit-killed / silently dead) — recover what
  // the journaled assistant events prove was billed.
  const recovered = result ? null : recoverUsageFromJournal(row.output_path);
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
    cost_usd: result?.costUsd ?? recovered?.costUsd ?? null,
    tokens_in: result?.tokensIn ?? recovered?.tokensIn ?? null,
    tokens_out: result?.tokensOut ?? recovered?.tokensOut ?? null,
    tokens_cache_hit: result?.tokensCacheRead ?? recovered?.tokensCacheRead ?? null,
    tokens_cache_write: result?.tokensCacheWrite ?? recovered?.tokensCacheWrite ?? null,
    model: result?.model ?? recovered?.model ?? null,
  });
  return state;
}
