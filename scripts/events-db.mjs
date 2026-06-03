// Event store helper — the canonical write/read API for .claude/state/events.db.
//
// All production write sites (scheduler, dashboard routes, future skills) should
// import recordEvent from here rather than instantiating DatabaseSync directly.
//
// Design:
// - Lazy connection: opened on first call, kept alive for process lifetime
// - Auto-init: missing DB triggers initDb() — first write recreates schema
// - Best-effort writes: failures log to stderr, do not throw (telemetry must
//   never break the action that generated it)
// - Truncates long fields (prompt/stdout_preview/stderr) at insert
// - Computes dedupe_key from (ts|kind|action|raw) so INSERT OR IGNORE handles
//   accidental double-writes and backfill re-runs

import { createHash } from 'node:crypto';
import { DEFAULT_DB_PATH, initDb } from './events-db-init.mjs';

const PROMPT_MAX = 4096;
const STDOUT_MAX = 4096;
const STDERR_MAX = 2048;

let _db = null;
function getDb() {
  if (_db) return _db;
  _db = initDb(DEFAULT_DB_PATH);
  return _db;
}

// Single setter, not an EventEmitter — only one consumer (dashboard's
// dispatcher) exists. Errors swallowed to honor recordEvent's
// telemetry-must-not-break contract (see module header lines 9-11).
let _afterInsertHook = null;
export function setAfterInsertHook(fn) {
  _afterInsertHook = fn ?? null;
}
export function getAfterInsertHook() {
  return _afterInsertHook;
}

// For tests / scripts that need a clean handle.
export function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch {}
    _db = null;
  }
}

function trunc(s, max) {
  if (s == null) return null;
  const str = typeof s === 'string' ? s : String(s);
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n…[truncated]';
}

function computeDedupeKey({ ts, kind, action, raw }) {
  return createHash('sha256')
    .update(`${ts}|${kind}|${action}|${raw ?? ''}`)
    .digest('hex');
}

const INSERT_SQL = `
INSERT OR IGNORE INTO events (
  ts, dedupe_key, kind, action, source,
  skill, project, change_id, report_id, domain,
  model, tokens_in, tokens_out, tokens_cache_hit, tokens_cache_write, cost_usd,
  duration_ms, exit_status, status, description,
  files_touched, prompt, stdout_preview, stderr,
  origin_log, raw
) VALUES (
  @ts, @dedupe_key, @kind, @action, @source,
  @skill, @project, @change_id, @report_id, @domain,
  @model, @tokens_in, @tokens_out, @tokens_cache_hit, @tokens_cache_write, @cost_usd,
  @duration_ms, @exit_status, @status, @description,
  @files_touched, @prompt, @stdout_preview, @stderr,
  @origin_log, @raw
)`;

let _insertStmt = null;
function getInsertStmt() {
  if (_insertStmt) return _insertStmt;
  _insertStmt = getDb().prepare(INSERT_SQL);
  return _insertStmt;
}

/**
 * Insert one event row. All fields except ts/kind/action are optional.
 * Returns { id, deduped } on success, { error } on failure (does not throw).
 */
export function recordEvent(payload = {}) {
  try {
    const ts = payload.ts ?? new Date().toISOString();
    const kind = payload.kind;
    const action = payload.action;
    if (!kind || !action) {
      // Strict at the API boundary; this is a programmer error worth logging.
      throw new Error('recordEvent: kind and action are required');
    }
    const rawJson =
      payload.raw == null
        ? JSON.stringify({ ...payload, ts, kind, action })
        : typeof payload.raw === 'string'
          ? payload.raw
          : JSON.stringify(payload.raw);

    const filesTouched =
      payload.files_touched == null
        ? null
        : Array.isArray(payload.files_touched)
          ? JSON.stringify(payload.files_touched)
          : String(payload.files_touched);

    const row = {
      ts,
      dedupe_key: computeDedupeKey({ ts, kind, action, raw: rawJson }),
      kind,
      action,
      source: payload.source ?? null,
      skill: payload.skill ?? null,
      project: payload.project ?? null,
      change_id: payload.change_id ?? null,
      report_id: payload.report_id ?? null,
      domain: payload.domain ?? null,
      model: payload.model ?? null,
      tokens_in: payload.tokens_in ?? null,
      tokens_out: payload.tokens_out ?? null,
      tokens_cache_hit: payload.tokens_cache_hit ?? null,
      tokens_cache_write: payload.tokens_cache_write ?? null,
      cost_usd: payload.cost_usd ?? null,
      duration_ms: payload.duration_ms ?? null,
      exit_status: payload.exit_status ?? null,
      status: payload.status ?? null,
      description: payload.description ?? null,
      files_touched: filesTouched,
      prompt: trunc(payload.prompt, PROMPT_MAX),
      stdout_preview: trunc(payload.stdout_preview, STDOUT_MAX),
      stderr: trunc(payload.stderr, STDERR_MAX),
      origin_log: payload.origin_log ?? null,
      raw: rawJson,
    };

    const result = getInsertStmt().run(row);
    if (result.changes === 1 && _afterInsertHook) {
      const hookRow = { id: result.lastInsertRowid, ...row };
      setImmediate(() => {
        try {
          _afterInsertHook(hookRow);
        } catch (e) {
          try {
            process.stderr.write(
              `notifications/events-db: afterInsert hook threw: ${e?.stack ?? e}\n`,
            );
          } catch {}
        }
      });
    }
    return { id: result.lastInsertRowid, deduped: result.changes === 0 };
  } catch (e) {
    // Telemetry MUST NOT break the action. Log and continue.
    try {
      process.stderr.write(`recordEvent error: ${e.message}\n`);
    } catch {}
    return { error: e.message };
  }
}

/**
 * Filtered query. Returns rows ordered by ts DESC.
 *   filter: { kind, skill, project, change_id, review_id, model, domain, since, until, limit }
 *
 * `review_id` matches against `json_extract(raw, '$.args.review')` — used to
 * pull the activity timeline for a pr-review entry whose events don't carry
 * `change_id` (e.g. external PR reviews, or comment-mutate/publish events that
 * record the review id in args rather than in a dedicated column).
 */
export function queryEvents(filter = {}) {
  const where = [];
  const params = {};
  for (const key of ['kind', 'skill', 'project', 'change_id', 'report_id', 'model', 'domain']) {
    if (filter[key] != null) {
      where.push(`${key} = @${key}`);
      params[key] = filter[key];
    }
  }
  if (filter.review_id != null) {
    where.push("json_extract(raw, '$.args.review') = @review_id");
    params.review_id = filter.review_id;
  }
  if (filter.since != null) {
    where.push('ts >= @since');
    params.since = filter.since;
  }
  if (filter.until != null) {
    where.push('ts <= @until');
    params.until = filter.until;
  }
  const limit = Math.min(Math.max(parseInt(filter.limit ?? 200, 10) || 200, 1), 5000);
  const sql = `
    SELECT * FROM events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts DESC
    LIMIT ${limit}
  `;
  return getDb().prepare(sql).all(params);
}

/**
 * Count rows matching equality filters on (kind, action, source) with an
 * optional `since` lower-bound on ts. Used by the dispatcher's rate-limit
 * gate; the composite index `events_rate_limit(kind, action, ts, source)`
 * covers both the global query (no source) and the per-rule query.
 *
 *   filter: { kind, action, source?, since? } — all optional, but at least one
 *   should be set in practice.
 *
 * Returns a JS Number (not BigInt) so callers can do plain `>= cap` compares
 * — node:sqlite can return BigInt for INTEGER columns.
 */
export function countEvents(filter = {}) {
  const where = [];
  const params = {};
  for (const key of ['kind', 'action', 'source']) {
    if (filter[key] != null) {
      where.push(`${key} = @${key}`);
      params[key] = filter[key];
    }
  }
  if (filter.since != null) {
    where.push('ts >= @since');
    params.since = filter.since;
  }
  const sql = `
    SELECT count(*) AS n FROM events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  `;
  const row = getDb().prepare(sql).get(params);
  return Number(row?.n ?? 0);
}

/**
 * Aggregate stats over a time window. `window` is a number of days (default 30).
 * Returns counts by kind/skill/model + total cost + slowest 5 + most-invoked 5.
 */
export function statsEvents(windowDays = 30) {
  const sinceMs = Date.now() - windowDays * 86400 * 1000;
  const since = new Date(sinceMs).toISOString();
  const db = getDb();

  const total = db.prepare('SELECT count(*) AS n FROM events WHERE ts >= ?').get(since);

  const byKind = db
    .prepare(
      `SELECT kind, count(*) AS n FROM events
       WHERE ts >= ? GROUP BY kind ORDER BY n DESC`,
    )
    .all(since);

  const bySkill = db
    .prepare(
      `SELECT skill, count(*) AS n FROM events
       WHERE ts >= ? AND skill IS NOT NULL
       GROUP BY skill ORDER BY n DESC LIMIT 10`,
    )
    .all(since);

  const byModel = db
    .prepare(
      `SELECT model, count(*) AS n FROM events
       WHERE ts >= ? AND model IS NOT NULL
       GROUP BY model ORDER BY n DESC`,
    )
    .all(since);

  const costRow = db
    .prepare(
      `SELECT
         coalesce(sum(cost_usd), 0) AS total,
         coalesce(sum(tokens_in), 0) AS tokens_in,
         coalesce(sum(tokens_out), 0) AS tokens_out
       FROM events WHERE ts >= ?`,
    )
    .get(since);

  const slowest = db
    .prepare(
      `SELECT id, ts, kind, action, skill, duration_ms FROM events
       WHERE ts >= ? AND duration_ms IS NOT NULL
       ORDER BY duration_ms DESC LIMIT 5`,
    )
    .all(since);

  const errors = db
    .prepare(
      `SELECT count(*) AS n FROM events
       WHERE ts >= ?
         AND (exit_status IS NOT NULL AND exit_status <> 0
              OR status = 'error')`,
    )
    .get(since);

  return {
    window_days: windowDays,
    since,
    total: total.n,
    errors: errors.n,
    cost_usd: costRow.total,
    tokens_in: costRow.tokens_in,
    tokens_out: costRow.tokens_out,
    by_kind: byKind,
    top_skills: bySkill,
    by_model: byModel,
    slowest,
  };
}

// Fetch events with `id > afterId`, ordered ascending by id. Used by the
// dashboard server's notification dispatcher poller — the in-process
// setAfterInsertHook only fires for events inserted in THIS process, but
// skills + scripts insert via record-dashboard-action.mjs (a separate
// Node process). Polling closes the cross-process gap.
//
// Returns rows in the same shape as queryEvents, plus the `id` column so the
// poller can advance its high-water mark.
export function getEventsAfterId(afterId = 0, limit = 200) {
  const db = getDb();
  const stmt = db.prepare(
    `SELECT id, ts, dedupe_key, kind, action, source, skill, project, change_id, domain,
            model, tokens_in, tokens_out, tokens_cache_hit, tokens_cache_write, cost_usd,
            duration_ms, exit_status, status, description, files_touched, prompt,
            stdout_preview, stderr, origin_log, raw, report_id
       FROM events
      WHERE id > @afterId
      ORDER BY id ASC
      LIMIT @limit`,
  );
  return stmt.all({ afterId, limit }).map((r) => ({
    ...r,
    files_touched: r.files_touched ? JSON.parse(r.files_touched) : null,
    raw: r.raw ? JSON.parse(r.raw) : null,
  }));
}

// Return the current maximum event id. Used by the poller at startup to set
// its high-water mark — events recorded BEFORE the server started don't get
// dispatched (they already had their chance via the original insertion path).
export function getMaxEventId() {
  const db = getDb();
  const row = db.prepare('SELECT MAX(id) as max_id FROM events').get();
  return row?.max_id ?? 0;
}

export { DEFAULT_DB_PATH };
