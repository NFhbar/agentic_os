// Notification routes — desktop SSE stream + CRUD over notification-config
// entries + test-send. The dispatcher's afterInsert hook lives elsewhere
// (events-db.mjs → notifications/dispatcher.ts); this surface is for the
// Settings UI.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import { rewriteFrontmatter, serializeYamlValue } from '../frontmatter-rewrite.js';
import { parseFrontmatter } from '../frontmatter.js';
import { subscribeDesktopClient } from '../notifications/adapters/desktop.js';
import { detectSlackMode } from '../notifications/adapters/slack.js';
import { dispatchForTest } from '../notifications/dispatcher.js';
import { EVENT_TYPE_RE } from '../notifications/rules.js';
import type { Rule } from '../notifications/rules.js';
import { REPO_ROOT } from '../repo.js';
import type {
  ChannelId,
  EventCatalogEntry,
  RuleDelivery,
  RuleFilter,
  RuleListItem,
  RuleRateLimit,
} from './notifications.types.js';
import { VALID_CHANNELS, VALID_SEVERITIES, VALID_URGENCIES } from './notifications.types.js';

// Re-export wire-shape types for any consumer that imports from this route
// module directly. New consumers should prefer `./notifications.types.js`
// per standard-shared-types.
export type {
  ChannelId,
  EventCatalogEntry,
  NotificationEvent,
  RenderedNotification,
  RuleDelivery,
  RuleFilter,
  RuleListItem,
  RuleRateLimit,
  SlackMode,
  TestSendResult,
  ValidationError,
} from './notifications.types.js';

const SKIP_DOMAINS = new Set(['_seed', '_templates']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^rule-[a-z0-9][a-z0-9-]*$/;
const ID_MAX_LEN = 80;
const TITLE_MAX_LEN = 200;
const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

const EVENT_CATALOG_PATHS = [
  join(REPO_ROOT, 'vault', 'wiki', 'meta', 'reference', 'event-catalog.md'),
  join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'reference', 'event-catalog.md'),
];

async function loadEventCatalog(): Promise<EventCatalogEntry[]> {
  for (const path of EVENT_CATALOG_PATHS) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const rows: EventCatalogEntry[] = [];
    for (const line of raw.split('\n')) {
      // Markdown table rows start with `|` and split into 6-8 cells (leading
      // and trailing empties around 5 content cells; `lifecycle_step` is the
      // 5th content cell, optional). Skip header + separator rows by
      // validating the event_type cell matches the kind.action shape.
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 6) continue;
      const event_type = cells[1];
      if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(event_type)) continue;
      const description = cells[2];
      const entity = cells[3] || 'none';
      const fieldRaw = cells[4];
      const entity_filter_field = !fieldRaw || fieldRaw === '(none)' ? null : fieldRaw;
      // lifecycle_step is the 5th content cell. Empty / `—` / missing → [].
      // Comma-separated values split + trimmed; each entry shaped `<ctx>:<id>`.
      const stepsRaw = cells[5] ?? '';
      const lifecycle_steps =
        !stepsRaw || stepsRaw === '—' || stepsRaw === '-' || stepsRaw === '(none)'
          ? []
          : stepsRaw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0 && s.includes(':'));
      rows.push({ event_type, description, entity, entity_filter_field, lifecycle_steps });
    }
    return rows;
  }
  return [];
}

interface ValidationError {
  ok: false;
  error: string;
  field: string;
}

// List owning-domain directories under vault/wiki (top-level only, filtered).
function listOwningDomains(): string[] {
  const wiki = join(REPO_ROOT, 'vault', 'wiki');
  try {
    return readdirSync(wiki, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DOMAINS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Fresh read of ALL notification-config rules (enabled + disabled). Does NOT
// use the dispatcher's TTL cache — the Settings UI needs to see every rule.
async function listAllRules(): Promise<RuleListItem[]> {
  const out: RuleListItem[] = [];
  const wiki = join(REPO_ROOT, 'vault', 'wiki');
  const domains = listOwningDomains();
  for (const domain of domains) {
    const ruleDir = join(wiki, domain, 'notification-config');
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      entries = await readdir(ruleDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue;
      const filePath = join(ruleDir, e.name);
      try {
        const content = await readFile(filePath, 'utf8');
        const { fm, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        const id = typeof fm.id === 'string' ? fm.id : null;
        const event_type = typeof fm.event_type === 'string' ? fm.event_type : null;
        const channel = typeof fm.channel === 'string' ? fm.channel : null;
        if (!id || !event_type || !channel) continue;
        // YAML frontmatter is unknown-shaped at parse time; validateBody
        // gates writes so what's on disk SHOULD match RuleFilter/Delivery/
        // RateLimit. Cast at the response boundary; downstream consumers
        // (UI form rendering, matcher) assume the strict shape.
        out.push({
          id,
          domain,
          title: typeof fm.title === 'string' ? fm.title : id,
          event_type,
          channel: channel as ChannelId,
          enabled: fm.enabled !== false,
          filter: ((fm.filter as RuleFilter | undefined) ?? {}) as RuleFilter,
          delivery: ((fm.delivery as RuleDelivery | undefined) ?? {}) as RuleDelivery,
          rate_limit: (fm.rate_limit as RuleRateLimit | undefined) ?? null,
          source_path: relative(REPO_ROOT, filePath),
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

async function findRuleById(id: string): Promise<RuleListItem | null> {
  const all = await listAllRules();
  return all.find((r) => r.id === id) ?? null;
}

interface ValidationContext {
  isUpdate: boolean;
  knownDomains: string[];
  takenIds: Set<string>;
}

// biome-ignore lint/suspicious/noExplicitAny: input is unvalidated JSON
function validateBody(body: any, ctx: ValidationContext): ValidationError | null {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be an object', field: '_root' };
  }
  if (ctx.isUpdate) {
    for (const forbidden of ['id', 'created', 'domain']) {
      if (forbidden in body) {
        return {
          ok: false,
          error: `${forbidden} is read-only after create`,
          field: forbidden,
        };
      }
    }
  } else {
    if (typeof body.id === 'string') {
      if (!ID_RE.test(body.id) || body.id.length > ID_MAX_LEN) {
        return {
          ok: false,
          error: `id must match /^rule-[a-z0-9][a-z0-9-]*$/ and be ≤ ${ID_MAX_LEN} chars`,
          field: 'id',
        };
      }
      if (ctx.takenIds.has(body.id)) {
        return { ok: false, error: `id "${body.id}" already in use`, field: 'id' };
      }
    }
    if (typeof body.domain !== 'string' || !ctx.knownDomains.includes(body.domain)) {
      return {
        ok: false,
        error: `domain must be one of: ${ctx.knownDomains.join(', ')}`,
        field: 'domain',
      };
    }
  }
  // title
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return { ok: false, error: 'title must be a non-empty string', field: 'title' };
    }
    if (body.title.length > TITLE_MAX_LEN) {
      return {
        ok: false,
        error: `title must be ≤ ${TITLE_MAX_LEN} chars`,
        field: 'title',
      };
    }
  } else if (!ctx.isUpdate) {
    return { ok: false, error: 'title is required', field: 'title' };
  }
  // event_type
  if (body.event_type !== undefined) {
    if (typeof body.event_type !== 'string' || !EVENT_TYPE_RE.test(body.event_type)) {
      return {
        ok: false,
        error: `event_type must match {kind}.{action} with [a-z0-9_-] (got "${body.event_type}")`,
        field: 'event_type',
      };
    }
  } else if (!ctx.isUpdate) {
    return { ok: false, error: 'event_type is required', field: 'event_type' };
  }
  // channel
  if (body.channel !== undefined) {
    if (!VALID_CHANNELS.includes(body.channel)) {
      return {
        ok: false,
        error: `channel must be one of: ${VALID_CHANNELS.join(', ')}`,
        field: 'channel',
      };
    }
  } else if (!ctx.isUpdate) {
    return { ok: false, error: 'channel is required', field: 'channel' };
  }
  // delivery — gated by channel
  if (body.delivery !== undefined) {
    if (typeof body.delivery !== 'object' || body.delivery === null) {
      return { ok: false, error: 'delivery must be an object', field: 'delivery' };
    }
    const ch = body.channel;
    if (ch === 'slack') {
      if (
        typeof body.delivery.slack_channel !== 'string' ||
        body.delivery.slack_channel.trim() === ''
      ) {
        return {
          ok: false,
          error: 'slack delivery requires non-empty slack_channel',
          field: 'delivery',
        };
      }
      if (body.delivery.tags !== undefined && !Array.isArray(body.delivery.tags)) {
        return { ok: false, error: 'slack delivery.tags must be an array', field: 'delivery' };
      }
    } else if (ch === 'email') {
      if (!Array.isArray(body.delivery.to) || body.delivery.to.length === 0) {
        return {
          ok: false,
          error: 'email delivery requires non-empty `to` array',
          field: 'delivery',
        };
      }
      for (const addr of body.delivery.to) {
        if (typeof addr !== 'string' || !EMAIL_RE.test(addr)) {
          return {
            ok: false,
            error: `email delivery.to contains invalid address "${addr}"`,
            field: 'delivery',
          };
        }
      }
    } else if (ch === 'desktop') {
      if (body.delivery.urgency !== undefined && !VALID_URGENCIES.includes(body.delivery.urgency)) {
        return {
          ok: false,
          error: `desktop delivery.urgency must be one of: ${VALID_URGENCIES.join(', ')}`,
          field: 'delivery',
        };
      }
    }
  }
  // filter
  if (body.filter !== undefined) {
    if (typeof body.filter !== 'object' || body.filter === null) {
      return { ok: false, error: 'filter must be an object', field: 'filter' };
    }
    if (body.filter.severity !== undefined && !VALID_SEVERITIES.includes(body.filter.severity)) {
      return {
        ok: false,
        error: `filter.severity must be one of: ${VALID_SEVERITIES.join(', ')}`,
        field: 'filter',
      };
    }
  }
  // rate_limit
  if (body.rate_limit !== undefined && body.rate_limit !== null) {
    if (typeof body.rate_limit !== 'object') {
      return { ok: false, error: 'rate_limit must be an object or null', field: 'rate_limit' };
    }
    const cap = (body.rate_limit as Record<string, unknown>).cap_per_day;
    if (cap !== undefined && cap !== null) {
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
        return {
          ok: false,
          error: 'rate_limit.cap_per_day must be a positive integer or null',
          field: 'rate_limit',
        };
      }
    }
  }
  // enabled
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean', field: 'enabled' };
  }
  return null;
}

// Record an audit event for a mutating notification-rule action.
function recordAudit(action: string, args: Record<string, unknown>, filesTouched: string[]): void {
  try {
    spawnSync(
      'node',
      [
        join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
        '--action',
        action,
        '--args',
        JSON.stringify(args),
        '--files-touched',
        JSON.stringify(filesTouched),
        '--exit-status',
        '0',
      ],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
  } catch {
    /* best-effort */
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// Generate a new rule id from event_type + channel + 6-char random suffix.
function generateRuleId(event_type: string, channel: string): string {
  const slug = event_type.replace(/\./g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `rule-${slug}-${channel}-${suffix}`;
}

export const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
  // SSE subscription for the desktop notification adapter.
  fastify.get('/desktop/stream', async (req, reply) => {
    const unsubscribe = subscribeDesktopClient(reply);
    req.raw.on('close', unsubscribe);
    return reply;
  });

  // GET /api/notifications/owning-domains — list domains the user can store
  // a rule under (top-level vault/wiki/<x>/ subdirs, filtered).
  fastify.get('/owning-domains', async () => {
    return { domains: listOwningDomains() };
  });

  // GET /api/notifications/slack-mode — which Slack transport is active.
  // The Rule Editor uses this to reflect honest UX on the slack_channel
  // field (editable in bot-token mode; disabled-with-hint in webhook mode;
  // disabled-with-hint in none mode).
  fastify.get('/slack-mode', async () => {
    return { mode: detectSlackMode() };
  });

  // GET /api/notifications/event-types — union of three sources:
  //   1. event-catalog.md (curated subscribable surface — every lifecycle event
  //      worth notifying on, even if it's never fired yet)
  //   2. historical events.db (kind, action) DISTINCT pairs
  //   3. event_types currently referenced by rules
  // The matrix renders this so users can wire up notifications for events
  // they haven't yet seen fire, AND so events that drift outside the catalog
  // still appear (don't silently hide rule misconfigurations).
  fastify.get('/event-types', async () => {
    const types = new Set<string>();
    const catalog = await loadEventCatalog();
    for (const c of catalog) types.add(c.event_type);
    if (existsSync(EVENTS_DB_PATH)) {
      try {
        const db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
        try {
          const rows = db
            .prepare(
              "SELECT DISTINCT kind, action FROM events WHERE kind != 'notification' ORDER BY ts DESC LIMIT 500",
            )
            .all() as Array<{ kind: string; action: string }>;
          for (const r of rows) {
            if (r.kind && r.action) types.add(`${r.kind}.${r.action}`);
          }
        } finally {
          db.close();
        }
      } catch {
        /* skip */
      }
    }
    const rules = await listAllRules();
    for (const r of rules) types.add(r.event_type);
    return { event_types: Array.from(types).sort() };
  });

  // GET /api/notifications/event-catalog — full curated event-catalog entries
  // with descriptions + entity attribution. Used by the Rule Editor's
  // event-type picker (richer than just the type string) and by the
  // per-lifecycle-step bell affordances on entity pages.
  fastify.get('/event-catalog', async () => {
    const entries = await loadEventCatalog();
    return { entries };
  });

  // GET /api/notifications/rules — list all rules across all domains.
  fastify.get('/rules', async () => {
    const rules = await listAllRules();
    return { rules };
  });

  // GET /api/notifications/rules/:id — single rule.
  fastify.get<{ Params: { id: string } }>('/rules/:id', async (req, reply) => {
    const rule = await findRuleById(req.params.id);
    if (!rule) {
      reply.code(404);
      return { ok: false, error: `rule "${req.params.id}" not found` };
    }
    return rule;
  });

  // POST /api/notifications/rules — create a new rule.
  // biome-ignore lint/suspicious/noExplicitAny: input JSON
  fastify.post<{ Body: any }>('/rules', async (req, reply) => {
    const knownDomains = listOwningDomains();
    const taken = new Set((await listAllRules()).map((r) => r.id));
    const err = validateBody(req.body, { isUpdate: false, knownDomains, takenIds: taken });
    if (err) {
      reply.code(400);
      return err;
    }
    // biome-ignore lint/suspicious/noExplicitAny: validated above
    const body = req.body as any;
    const id: string = body.id ?? generateRuleId(body.event_type, body.channel);
    if (!ID_RE.test(id) || taken.has(id)) {
      reply.code(409);
      return { ok: false, error: `id "${id}" invalid or in use`, field: 'id' };
    }
    const ts = nowIso();
    const frontmatter: Record<string, unknown> = {
      id,
      type: 'notification-config',
      domain: body.domain,
      created: ts,
      updated: ts,
      tags: [],
      source: 'manual',
      private: false,
      title: body.title,
      event_type: body.event_type,
      channel: body.channel,
      enabled: body.enabled ?? true,
    };
    if (body.filter && Object.keys(body.filter).length > 0) frontmatter.filter = body.filter;
    if (body.delivery && Object.keys(body.delivery).length > 0)
      frontmatter.delivery = body.delivery;
    if (body.rate_limit) frontmatter.rate_limit = body.rate_limit;

    const fmLines: string[] = [];
    for (const [k, v] of Object.entries(frontmatter)) {
      fmLines.push(`${k}: ${serializeYamlValue(v)}`);
    }
    const fileContent = `---\n${fmLines.join('\n')}\n---\n\n# ${body.title}\n\n## Purpose\n\nRoute ${body.event_type} events via ${body.channel}.\n\n## Notes\n\nAppend observations as the rule's behaviour evolves.\n`;

    const ruleDir = join(REPO_ROOT, 'vault', 'wiki', body.domain, 'notification-config');
    await mkdir(ruleDir, { recursive: true });
    const filePath = join(ruleDir, `${id}.md`);
    await writeFile(filePath, fileContent, 'utf8');

    recordAudit(
      'notification-rule-create',
      { id, domain: body.domain, event_type: body.event_type, channel: body.channel },
      [relative(REPO_ROOT, filePath)],
    );
    reply.code(201);
    return { ok: true, id, source_path: relative(REPO_ROOT, filePath) };
  });

  // PUT /api/notifications/rules/:id — partial update.
  // biome-ignore lint/suspicious/noExplicitAny: input JSON
  fastify.put<{ Params: { id: string }; Body: any }>('/rules/:id', async (req, reply) => {
    const existing = await findRuleById(req.params.id);
    if (!existing) {
      reply.code(404);
      return { ok: false, error: `rule "${req.params.id}" not found` };
    }
    const knownDomains = listOwningDomains();
    // biome-ignore lint/suspicious/noExplicitAny: input JSON
    const body = req.body as any;
    const err = validateBody(
      { ...(body ?? {}), channel: body?.channel ?? existing.channel },
      { isUpdate: true, knownDomains, takenIds: new Set() },
    );
    if (err) {
      reply.code(400);
      return err;
    }
    const filePath = join(REPO_ROOT, existing.source_path);
    const content = await readFile(filePath, 'utf8');
    const updates: Record<string, unknown> = { updated: nowIso() };
    for (const k of [
      'title',
      'event_type',
      'channel',
      'enabled',
      'filter',
      'delivery',
      'rate_limit',
    ]) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    const newContent = rewriteFrontmatter(content, updates);
    await writeFile(filePath, newContent, 'utf8');
    recordAudit('notification-rule-update', { id: existing.id, fields: Object.keys(updates) }, [
      existing.source_path,
    ]);
    return { ok: true, id: existing.id };
  });

  // DELETE /api/notifications/rules/:id — delete the rule file. The
  // archetype prefers disabling over deletion; the UI surfaces this as a
  // confirm warning.
  fastify.delete<{ Params: { id: string } }>('/rules/:id', async (req, reply) => {
    const existing = await findRuleById(req.params.id);
    if (!existing) {
      reply.code(404);
      return { ok: false, error: `rule "${req.params.id}" not found` };
    }
    const filePath = join(REPO_ROOT, existing.source_path);
    await unlink(filePath);
    recordAudit('notification-rule-delete', { id: existing.id }, [existing.source_path]);
    return {
      ok: true,
      id: existing.id,
      warning:
        'Historical `source=rule:<id>` events are now orphaned. Prefer `enabled: false` over deletion for audit-trail continuity.',
    };
  });

  // POST /api/notifications/rules/:id/test-send — dispatch a synthetic event
  // through the rule for end-to-end verification.
  fastify.post<{ Params: { id: string } }>('/rules/:id/test-send', async (req, reply) => {
    const existing = await findRuleById(req.params.id);
    if (!existing) {
      reply.code(404);
      return { ok: false, error: `rule "${req.params.id}" not found` };
    }
    const [kind, action] = existing.event_type.split('.');
    if (!kind || !action) {
      reply.code(500);
      return { ok: false, error: 'rule has malformed event_type' };
    }
    const synthEvent = {
      id: 0,
      ts: nowIso(),
      dedupe_key: `test:${existing.id}:${Date.now()}`,
      kind,
      action,
      source: null,
      skill: null,
      project: ((existing.filter as Record<string, unknown>).project as string | null) ?? null,
      change_id: null,
      domain: ((existing.filter as Record<string, unknown>).domain as string | null) ?? null,
      report_id: null,
      model: null,
      tokens_in: null,
      tokens_out: null,
      tokens_cache_hit: null,
      tokens_cache_write: null,
      cost_usd: null,
      duration_ms: null,
      exit_status: null,
      status: null,
      description: null,
      files_touched: null,
      prompt: null,
      stdout_preview: null,
      stderr: null,
      origin_log: null,
      raw: null,
    };
    // Cast wire-shape strict types back to the loose Record<string, unknown>
    // that the internal Rule + matcher use. Both shapes carry the same
    // runtime data; the difference is whether TS treats it as a typed object
    // or an unknown-indexable map. Matcher.ts uses key indexing → needs
    // loose.
    const rule: Rule = {
      id: existing.id,
      event_type: existing.event_type,
      channel: existing.channel as Rule['channel'],
      filter: existing.filter as unknown as Record<string, unknown>,
      delivery: existing.delivery as unknown as Record<string, unknown>,
      rate_limit: existing.rate_limit as unknown as Record<string, unknown> | null,
    };
    const result = await dispatchForTest(synthEvent, rule);
    recordAudit('notification-rule-test-send', { id: existing.id, channel: existing.channel }, [
      existing.source_path,
    ]);
    return {
      ok: true,
      rendered: result.rendered,
      channel: existing.channel,
      adapter_result: result.adapter_result,
    };
  });

  // GET /api/notifications/events — recent notification dispatch records,
  // joined with rule lookups for friendlier rendering. Default limit 200,
  // ordered ts DESC. Optional ?since=<iso> for cursor-style refresh polling.
  // Returns empty list when events.db is absent (fresh clone). Source values
  // shaped 'rule:<id>' or 'rule:<id>:test' — :test suffix preserved verbatim
  // so the Activity log can distinguish real dispatches from test-sends.
  fastify.get<{ Querystring: { limit?: string; since?: string } }>('/events', async (req) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit ?? '200', 10) || 200, 1), 1000);
    const since =
      typeof req.query.since === 'string' && req.query.since.length > 0 ? req.query.since : null;
    if (!existsSync(EVENTS_DB_PATH)) return { events: [], total: 0 };
    let rows: Array<{
      id: number;
      ts: string;
      source: string | null;
      action: string;
      status: string | null;
      description: string | null;
      project: string | null;
      change_id: string | null;
      skill: string | null;
    }> = [];
    let total = 0;
    try {
      const db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
      try {
        const query = since
          ? `SELECT id, ts, source, action, status, description, project, change_id, skill
               FROM events
               WHERE kind = 'notification' AND ts > ?
               ORDER BY ts DESC LIMIT ?`
          : `SELECT id, ts, source, action, status, description, project, change_id, skill
               FROM events
               WHERE kind = 'notification'
               ORDER BY ts DESC LIMIT ?`;
        const stmt = db.prepare(query);
        rows = since ? (stmt.all(since, limit) as typeof rows) : (stmt.all(limit) as typeof rows);
        const countQuery = since
          ? `SELECT COUNT(*) AS n FROM events WHERE kind = 'notification' AND ts > ?`
          : `SELECT COUNT(*) AS n FROM events WHERE kind = 'notification'`;
        const countRow = (
          since ? db.prepare(countQuery).get(since) : db.prepare(countQuery).get()
        ) as { n: number };
        total = countRow.n;
      } finally {
        db.close();
      }
    } catch {
      return { events: [], total: 0 };
    }
    // Cross-reference rule ids → channel so the UI doesn't have to fetch
    // every rule separately. Rule lookups are tens of entries — cheap.
    const rulesById = new Map((await listAllRules()).map((r) => [r.id, r]));
    const events = rows.map((r) => {
      let ruleId: string | null = null;
      let isTest = false;
      if (r.source?.startsWith('rule:')) {
        const rest = r.source.slice('rule:'.length);
        if (rest.endsWith(':test')) {
          ruleId = rest.slice(0, -':test'.length);
          isTest = true;
        } else {
          ruleId = rest;
        }
      }
      const rule = ruleId ? rulesById.get(ruleId) : undefined;
      return {
        id: r.id,
        ts: r.ts,
        rule_id: ruleId,
        rule_title: rule?.title ?? null,
        rule_exists: !!rule,
        channel: rule?.channel ?? null,
        event_type: rule?.event_type ?? null,
        action: r.action,
        status: r.status,
        description: r.description,
        project: r.project,
        change_id: r.change_id,
        skill: r.skill,
        is_test: isTest,
      };
    });
    return { events, total };
  });
};
