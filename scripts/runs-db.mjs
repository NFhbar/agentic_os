// Runs store helper — write/read API for the `runs` table in events.db plus
// the on-disk JSONL output files at .claude/state/runs/<id>.jsonl.
//
// Design mirrors events-db.mjs:
// - Lazy DB connection, kept alive for process lifetime
// - Best-effort writes (telemetry must not break the action)
// - One open WriteStream per active run, cached so we don't reopen per chunk
//
// Output JSONL format: one line per chunk, each line is
//   { ts, kind: 'stdout' | 'stderr' | 'meta' | 'done', data?, exit_status? }

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH, initDb } from './events-db-init.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNS_DIR = join(REPO_ROOT, '.claude', 'state', 'runs');

export const DEFAULT_RUNS_DIR = RUNS_DIR;

let _db = null;
function getDb() {
  if (_db) return _db;
  _db = initDb(DEFAULT_DB_PATH);
  return _db;
}

export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {}
    _db = null;
  }
}

// Cached WriteStreams keyed by run id. Closed in finishRun().
const _streams = new Map();
// Running byte tallies — equal to the size of the JSONL file. Lets the
// stream route snapshot a precise replay offset without an fs.stat() call.
const _bytesWritten = new Map();

function ensureRunsDir() {
  mkdirSync(RUNS_DIR, { recursive: true });
}

// Raw journal — the child's stdout (stream-json) is redirected straight to
// this file at spawn time, so it stays complete even if the server dies.
// Readers parse raw lines on read. Legacy runs used `<id>.jsonl` with
// pre-parsed {kind,...} frames; per-line format detection keeps them
// renderable.
export function outputPathFor(runId) {
  return join(RUNS_DIR, `${runId}.raw.jsonl`);
}

// The child's stderr, also file-redirected at spawn.
export function stderrPathFor(outputPath) {
  return outputPath.replace(/\.raw\.jsonl$|\.jsonl$/, '.stderr.log');
}

function getStream(runId, outputPath) {
  let s = _streams.get(runId);
  if (s) return s;
  ensureRunsDir();
  s = createWriteStream(outputPath, { flags: 'a' });
  _streams.set(runId, s);
  if (!_bytesWritten.has(runId)) {
    try {
      const sz = existsSync(outputPath) ? statSync(outputPath).size : 0;
      _bytesWritten.set(runId, sz);
    } catch {
      _bytesWritten.set(runId, 0);
    }
  }
  return s;
}

const INSERT_SQL = `
INSERT INTO runs (
  id, started_at, state, pid, skill, change_id, project, repo, domain,
  title, prompt, output_path, origin
) VALUES (
  @id, @started_at, @state, @pid, @skill, @change_id, @project, @repo, @domain,
  @title, @prompt, @output_path, @origin
)`;

let _insertStmt = null;
function getInsertStmt() {
  if (_insertStmt) return _insertStmt;
  _insertStmt = getDb().prepare(INSERT_SQL);
  return _insertStmt;
}

/**
 * Insert a row in state='queued'. Returns { run_id } on success, { error } on
 * failure (does not throw — telemetry must not break the action).
 */
export function createRun(payload) {
  try {
    const id = payload.id;
    if (!id) throw new Error('createRun: id is required');
    const row = {
      id,
      started_at: payload.started_at ?? new Date().toISOString(),
      state: payload.state ?? 'queued',
      pid: payload.pid ?? null,
      skill: payload.skill ?? null,
      change_id: payload.change_id ?? null,
      project: payload.project ?? null,
      repo: payload.repo ?? null,
      domain: payload.domain ?? null,
      title: payload.title ?? null,
      prompt: payload.prompt ?? '',
      output_path: payload.output_path ?? outputPathFor(id),
      // Default origin is resolved once by the caller (startRun); coerce a
      // missing value to NULL (legacy sentinel, read as `human`) rather than
      // defaulting a second time — single source of truth lives upstream.
      origin: payload.origin ?? null,
    };
    getInsertStmt().run(row);
    return { run_id: id };
  } catch (e) {
    try {
      process.stderr.write(`createRun error: ${e.message}\n`);
    } catch {}
    return { error: e.message };
  }
}

export function markRunning(id, pid) {
  try {
    getDb()
      .prepare(`UPDATE runs SET state='running', pid=@pid WHERE id=@id`)
      .run({ id, pid });
  } catch (e) {
    try {
      process.stderr.write(`markRunning error: ${e.message}\n`);
    } catch {}
  }
}

// Stamp the dispatch-resolved model/effort onto the row right after spawn.
// Survives pre-init deaths (and even spawn failures) that never produce the
// stream-json result event the finish path reads from. `effort` has no other
// writer; `model` is later overwritten by the observed id when a result
// event lands (see FINISH_SQL's COALESCE note).
export function setDispatchConfig(id, { model = null, effort = null } = {}) {
  try {
    getDb()
      .prepare(`UPDATE runs SET model=@model, effort=@effort WHERE id=@id`)
      .run({ id, model, effort });
  } catch (e) {
    try {
      process.stderr.write(`setDispatchConfig error: ${e.message}\n`);
    } catch {}
  }
}

// Record a user cancel request on a still-running row. The finalizer maps
// a death whose error starts with 'cancelled' to state='cancelled' — needed
// for detached children cancelled after a server restart (no in-memory
// session flag to consult).
export function markCancelRequested(id) {
  try {
    getDb()
      .prepare(`UPDATE runs SET error='cancelled by user' WHERE id=@id AND state='running'`)
      .run({ id });
  } catch (e) {
    try {
      process.stderr.write(`markCancelRequested error: ${e.message}\n`);
    } catch {}
  }
}

// Persist an in-flight error annotation (e.g. the supervisor's wall-cap
// SIGTERM marker) without finalizing the row.
export function setRunError(id, error) {
  try {
    getDb().prepare(`UPDATE runs SET error=@error WHERE id=@id`).run({ id, error });
  } catch (e) {
    try {
      process.stderr.write(`setRunError error: ${e.message}\n`);
    } catch {}
  }
}

export function setHooksFired(id, ts = new Date().toISOString()) {
  try {
    getDb().prepare(`UPDATE runs SET hooks_fired_at=@ts WHERE id=@id`).run({ id, ts });
  } catch (e) {
    try {
      process.stderr.write(`setHooksFired error: ${e.message}\n`);
    } catch {}
  }
}

// Terminal rows whose post-terminal side-effects haven't fired yet — the
// server's idempotent hook poll consumes this (see routes/runs.ts
// processUnhookedRuns).
export function listUnhookedTerminalRuns(limit = 50) {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM runs
          WHERE state IN ('done','failed','cancelled','died-after-writeback')
            AND hooks_fired_at IS NULL
          ORDER BY started_at ASC
          LIMIT ?`,
      )
      .all(limit);
  } catch {
    return [];
  }
}

export function listActiveRuns() {
  try {
    return getDb()
      .prepare(`SELECT * FROM runs WHERE state IN ('queued','running')`)
      .all();
  } catch {
    return [];
  }
}

/**
 * Append one JSONL line for a chunk. Returns { offset, length } — `offset` is
 * the byte position at which the line started in the file (before write),
 * `length` is the byte length of the line. Callers can use offset+length for
 * late-joiner replay slicing.
 */
export function appendChunk(id, kind, data) {
  try {
    const outputPath = outputPathFor(id);
    const stream = getStream(id, outputPath);
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, data }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    const offset = _bytesWritten.get(id) ?? 0;
    stream.write(buf);
    _bytesWritten.set(id, offset + buf.byteLength);
    return { offset, length: buf.byteLength };
  } catch (e) {
    try {
      process.stderr.write(`appendChunk error: ${e.message}\n`);
    } catch {}
    return { error: e.message };
  }
}

/** Bytes written so far for a run (matches the JSONL file size). */
export function bytesWritten(id) {
  return _bytesWritten.get(id) ?? 0;
}

const FINISH_SQL = `
UPDATE runs
   SET state = @state,
       exit_status = @exit_status,
       ended_at = @ended_at,
       duration_ms = @duration_ms,
       error = @error,
       cost_usd = @cost_usd,
       tokens_in = @tokens_in,
       tokens_out = @tokens_out,
       tokens_cache_hit = @tokens_cache_hit,
       tokens_cache_write = @tokens_cache_write,
       model = COALESCE(@model, model),
       pid = NULL
 WHERE id = @id`;
// model COALESCE: the observed id from the result event wins (billing ground
// truth), but a run that dies pre-result must not have its dispatch-time
// stamp (setDispatchConfig) clobbered back to NULL — both the in-server
// close handler and the supervisor finalize through this statement. `effort`
// is deliberately absent: result events carry no effort field, so the
// dispatch stamp is the only writer and never needs protecting.

let _finishStmt = null;
function getFinishStmt() {
  if (_finishStmt) return _finishStmt;
  _finishStmt = getDb().prepare(FINISH_SQL);
  return _finishStmt;
}

export function finishRun(
  id,
  {
    state,
    exit_status = null,
    duration_ms = null,
    error = null,
    cost_usd = null,
    tokens_in = null,
    tokens_out = null,
    tokens_cache_hit = null,
    tokens_cache_write = null,
    model = null,
  },
) {
  try {
    // Append the terminal marker line so late joiners reading from disk see it.
    const outputPath = outputPathFor(id);
    const stream = getStream(id, outputPath);
    const line =
      JSON.stringify({ ts: new Date().toISOString(), kind: 'done', exit_status }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    const offset = _bytesWritten.get(id) ?? 0;
    stream.write(buf);
    _bytesWritten.set(id, offset + buf.byteLength);

    getFinishStmt().run({
      id,
      state,
      exit_status,
      ended_at: new Date().toISOString(),
      duration_ms,
      error,
      cost_usd,
      tokens_in,
      tokens_out,
      tokens_cache_hit,
      tokens_cache_write,
      model,
    });

    // Close the stream — no more writes expected.
    stream.end();
    _streams.delete(id);
  } catch (e) {
    try {
      process.stderr.write(`finishRun error: ${e.message}\n`);
    } catch {}
  }
}

export function getRun(id) {
  try {
    return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) ?? null;
  } catch (e) {
    try {
      process.stderr.write(`getRun error: ${e.message}\n`);
    } catch {}
    return null;
  }
}

const FILTER_KEYS = ['state', 'skill', 'change_id', 'project', 'repo', 'domain', 'origin'];

export function listRuns(filter = {}) {
  try {
    const where = [];
    const params = {};
    for (const key of FILTER_KEYS) {
      if (filter[key] != null) {
        where.push(`${key} = @${key}`);
        params[key] = filter[key];
      }
    }
    if (filter.since != null) {
      where.push('started_at >= @since');
      params.since = filter.since;
    }
    if (filter.until != null) {
      where.push('started_at <= @until');
      params.until = filter.until;
    }
    const limit = Math.min(Math.max(parseInt(filter.limit ?? 200, 10) || 200, 1), 5000);
    const sql = `
      SELECT * FROM runs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return getDb().prepare(sql).all(params);
  } catch (e) {
    try {
      process.stderr.write(`listRuns error: ${e.message}\n`);
    } catch {}
    return [];
  }
}

export function countRuns(filter = {}) {
  try {
    const where = [];
    const params = {};
    for (const key of FILTER_KEYS) {
      if (filter[key] != null) {
        where.push(`${key} = @${key}`);
        params[key] = filter[key];
      }
    }
    const sql = `SELECT count(*) AS n FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const row = getDb().prepare(sql).get(params);
    return row?.n ?? 0;
  } catch (e) {
    try {
      process.stderr.write(`countRuns error: ${e.message}\n`);
    } catch {}
    return 0;
  }
}

export function getActiveRunForChange(change_id) {
  try {
    return (
      getDb()
        .prepare(
          `SELECT id, skill FROM runs
            WHERE change_id = ? AND state IN ('queued','running')
            ORDER BY started_at DESC
            LIMIT 1`,
        )
        .get(change_id) ?? null
    );
  } catch {
    return null;
  }
}

export function countRunningRuns() {
  try {
    const row = getDb()
      .prepare(`SELECT count(*) AS n FROM runs WHERE state='running'`)
      .get();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// Retention: how many completed runs the table keeps (newest first). Evicted
// rows lose their JSONL journals too — raising this trades disk for history.
// The processes view pages past the 200-row poll window via load-more, so a
// cap above 200 is actually reachable in the UI.
export const RUNS_RETENTION_CAP = 500;

/**
 * Evict completed runs beyond the cap. Never evicts queued/running. Returns
 * the evicted ids (caller is responsible for unlinking their JSONL files).
 */
export function evictBeyondCap(cap = RUNS_RETENTION_CAP) {
  try {
    const db = getDb();
    const evict = db.prepare(`
      SELECT id, output_path FROM runs
       WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT @cap)
         AND state NOT IN ('queued','running')
    `);
    const rows = evict.all({ cap });
    if (rows.length === 0) return [];
    const stmt = db.prepare('DELETE FROM runs WHERE id = ?');
    for (const r of rows) stmt.run(r.id);
    return rows;
  } catch (e) {
    try {
      process.stderr.write(`evictBeyondCap error: ${e.message}\n`);
    } catch {}
    return [];
  }
}

/** Best-effort unlink for evicted journal files (raw + stderr sibling). */
export function unlinkOutput(outputPath) {
  try {
    unlinkSync(outputPath);
  } catch {
    /* ENOENT or permission issue — best-effort */
  }
  try {
    unlinkSync(stderrPathFor(outputPath));
  } catch {
    /* no stderr file — best-effort */
  }
}

// Dead-run sweeping moved to scripts/runs-supervisor.mjs (sweepDeadRuns),
// which finalizes via runs-finalize.mjs instead of blanket-failing: it
// extracts the result event from the raw journal when present, and
// distinguishes died-after-writeback from genuine failures via linked-entity
// artifact verification. Both the server (boot + periodic) and the
// scheduler tick call the same implementation.
