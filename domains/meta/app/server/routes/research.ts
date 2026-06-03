import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import { rewriteFrontmatter } from '../frontmatter-rewrite.js';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT, safePath } from '../repo.js';
import { type FileRef, loadFileRef } from './changes.js';
import { startRun } from './runs.js';

const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');
const RESEARCH_REPORT_DIR = join(REPO_ROOT, 'vault', 'wiki', 'research', 'research-report');
const DEFAULT_STALENESS_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Types — moved to ./research.types.ts (shared with client). Re-exported here
// so existing consumers (`import { ResearchReportSummary } from './research.js'`)
// keep working. New consumers should import from './research.types.js' directly.
// ---------------------------------------------------------------------------

import type {
  MaterialRef,
  NoteConsideredEntry,
  NoteRef,
  NoteSeverity,
  RecommendedChangeRef,
  ReplayTimelineEntry,
  ResearchReportDetail,
  ResearchReportSummary,
  UpdateTrigger,
} from './research.types.js';

export type {
  MaterialRef,
  NoteConsideredEntry,
  NoteRef,
  NoteSeverity,
  RecommendedChangeRef,
  ReplayTimelineEntry,
  ResearchReportDetail,
  ResearchReportSummary,
  UpdateTrigger,
  UpdateTriggerKind,
} from './research.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// js-yaml parses bare ISO timestamps into Date objects. Coerce both forms.
// biome-ignore lint/suspicious/noExplicitAny: yaml field, shape unknown
function asISOString(v: any): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: yaml field, shape unknown
function asStringArray(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// Direct lookup at the archetype-locked path. Returns `{ fm, path }` or null.
// Mirrors `findProjectFrontmatter` shape so callers feel identical.
export async function findResearchReport(
  reportId: string,
  // biome-ignore lint/suspicious/noExplicitAny: yaml shape
): Promise<{ fm: any; path: string } | null> {
  if (!reportId || typeof reportId !== 'string') return null;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(reportId)) return null;
  const path = join(RESEARCH_REPORT_DIR, `${reportId}.md`);
  if (!existsSync(path)) return null;
  try {
    const { fm, parseError } = parseFrontmatter(await readFile(path, 'utf8'));
    if (parseError) return null;
    if (fm.type !== 'research-report' || fm.id !== reportId) return null;
    return { fm, path };
  } catch {
    return null;
  }
}

// Whitelist filename for material drops (matches projects.ts sanitizer).
function sanitizeMaterialFilename(name: string): string | null {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.includes('..')) return null;
  if (name.startsWith('.')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.length > 200) return null;
  return name;
}

function urlSlug(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/[^a-z0-9]+/gi, '-');
    const pathSlug = u.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    const composed = pathSlug ? `${host}-${pathSlug}` : host;
    return composed.slice(0, 80).replace(/^-+|-+$/g, '') || 'url';
  } catch {
    return 'url';
  }
}

// Fire-and-forget audit event. Same shape as projects.ts.
function recordAudit(
  action: string,
  args: Record<string, unknown>,
  filesTouched: string[],
  exitStatus = 0,
): void {
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
        String(exitStatus),
      ],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
  } catch {
    /* best-effort */
  }
}

// Surgical frontmatter edit — preserves field ordering, comments, and
// inline-JSON form. Required for nested arrays (recommended_changes,
// dismissed_triggers) per archetype-research-report § Frontmatter caveats.
function replaceField(content: string, key: string, val: string): string {
  const re = new RegExp(`^${key}:[^\\n]*$`, 'm');
  if (re.test(content)) return content.replace(re, `${key}: ${val}`);
  return content.replace(/\n---\n/, `\n${key}: ${val}\n---\n`);
}

// biome-ignore lint/suspicious/noExplicitAny: yaml shape
function readRecommendedChanges(fm: any): Array<Record<string, unknown>> {
  if (!Array.isArray(fm.recommended_changes)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of fm.recommended_changes) {
    if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
  }
  return out;
}

const VALID_NOTE_SEVERITIES: readonly NoteSeverity[] = ['info', 'warn', 'blocker'];

// biome-ignore lint/suspicious/noExplicitAny: yaml shape
function readNotesLog(fm: any): NoteRef[] {
  if (!Array.isArray(fm.notes_log)) return [];
  const out: NoteRef[] = [];
  fm.notes_log.forEach((item: unknown, index: number) => {
    if (!item || typeof item !== 'object') return;
    const row = item as Record<string, unknown>;
    const ts = typeof row.ts === 'string' ? row.ts : asISOString(row.ts);
    const severity = VALID_NOTE_SEVERITIES.includes(row.severity as NoteSeverity)
      ? (row.severity as NoteSeverity)
      : 'info';
    const body = typeof row.body === 'string' ? row.body : '';
    if (!ts || body.length === 0) return;
    const considered_by: NoteConsideredEntry[] = Array.isArray(row.considered_by)
      ? row.considered_by
          .filter((c) => c && typeof c === 'object')
          .map((c) => {
            const rec = c as Record<string, unknown>;
            return {
              skill: typeof rec.skill === 'string' ? rec.skill : 'unknown',
              ts: typeof rec.ts === 'string' ? rec.ts : '',
              run_id: typeof rec.run_id === 'string' ? rec.run_id : null,
            };
          })
      : [];
    out.push({ index, ts, severity, body, considered_by });
  });
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: yaml shape
function toSummary(fm: any, filePath: string): ResearchReportSummary {
  const recs = readRecommendedChanges(fm);
  let proposed = 0;
  let scaffolded = 0;
  let merged = 0;
  let abandoned = 0;
  for (const r of recs) {
    if (r.status === 'proposed') proposed += 1;
    else if (r.status === 'scaffolded') scaffolded += 1;
    else if (r.status === 'merged') merged += 1;
    else if (r.status === 'abandoned') abandoned += 1;
  }
  return {
    id: typeof fm.id === 'string' ? fm.id : '(no-id)',
    path: relative(REPO_ROOT, filePath),
    title: typeof fm.title === 'string' ? fm.title : (fm.id ?? '(untitled)'),
    project: typeof fm.project === 'string' ? fm.project : null,
    status: typeof fm.status === 'string' ? fm.status : null,
    review_status: typeof fm.review_status === 'string' ? fm.review_status : null,
    review_required: fm.review_required !== false,
    review_path: typeof fm.review_path === 'string' ? fm.review_path : null,
    reviewed_at: asISOString(fm.reviewed_at),
    report_generated_at: asISOString(fm.report_generated_at),
    report_revision:
      typeof fm.report_revision === 'number'
        ? fm.report_revision
        : typeof fm.report_revision === 'string' && /^\d+$/.test(fm.report_revision)
          ? Number.parseInt(fm.report_revision, 10)
          : null,
    report_revised_at: asISOString(fm.report_revised_at),
    report_revised_from_review:
      typeof fm.report_revised_from_review === 'string' ? fm.report_revised_from_review : null,
    materials_path: typeof fm.materials_path === 'string' ? fm.materials_path : null,
    last_data_ingest: asISOString(fm.last_data_ingest),
    update_count: typeof fm.update_count === 'number' ? fm.update_count : 0,
    recommended_changes_count: recs.length,
    recommended_changes_proposed: proposed,
    recommended_changes_scaffolded: scaffolded,
    recommended_changes_merged: merged,
    recommended_changes_abandoned: abandoned,
    dismissed_triggers: asStringArray(fm.dismissed_triggers),
    has_updates_pending: false, // populated by caller via detectUpdateTriggers
    created: asISOString(fm.created),
    updated: asISOString(fm.updated),
  };
}

// Materials drop path for a report. Honors `materials_path` override when set,
// falls back to the convention `vault/raw/project-research/<project>/<report>/`.
function materialsDirFor(summary: ResearchReportSummary): string | null {
  if (summary.materials_path) {
    try {
      return safePath(summary.materials_path);
    } catch {
      return null;
    }
  }
  if (!summary.project) return null;
  try {
    return safePath(join('vault', 'raw', 'project-research', summary.project, summary.id));
  } catch {
    return null;
  }
}

async function listMaterialsAt(
  dirAbs: string | null,
  lastDataIngest: string | null,
): Promise<MaterialRef[]> {
  if (!dirAbs || !existsSync(dirAbs)) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const ingestThresholdMs =
    lastDataIngest && !Number.isNaN(Date.parse(lastDataIngest)) ? Date.parse(lastDataIngest) : null;
  const out: MaterialRef[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = join(dirAbs, e.name);
    try {
      const s = await stat(abs);
      const mtimeIso = new Date(s.mtimeMs).toISOString();
      out.push({
        name: e.name,
        path: relative(REPO_ROOT, abs),
        size: s.size,
        mtime: mtimeIso,
        ingested: ingestThresholdMs !== null && s.mtimeMs <= ingestThresholdMs,
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

// Manifest-backed lookup for `recommended-change-merged` trigger detection.
interface ChangeRef {
  id: string;
  title: string;
  status: string | null;
  pr_url: string | null;
  path: string;
}

async function loadChangeRefsFromManifest(): Promise<Map<string, ChangeRef>> {
  const path = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  const out = new Map<string, ChangeRef>();
  try {
    const raw = await readFile(path, 'utf8');
    const manifest = JSON.parse(raw) as {
      entries: Array<{
        id?: string;
        title?: string;
        type?: string;
        status?: string | null;
        pr_url?: string | null;
        path?: string;
      }>;
    };
    for (const e of manifest.entries ?? []) {
      if (e.type !== 'change' || !e.id) continue;
      out.set(e.id, {
        id: e.id,
        title: e.title ?? e.id,
        status: typeof e.status === 'string' ? e.status : null,
        pr_url: typeof e.pr_url === 'string' ? e.pr_url : null,
        path: e.path ?? '',
      });
    }
  } catch {
    /* manifest missing */
  }
  return out;
}

// Compute the list of currently-fired update triggers for a report. Filters
// out ids in `report.dismissed_triggers`. Driven by the archetype's canonical
// trigger vocabulary (archetype-research-report § Update triggers).
export async function detectUpdateTriggers(
  summary: ResearchReportSummary,
  // biome-ignore lint/suspicious/noExplicitAny: yaml shape
  fm: any,
  stalenessWindowDays: number = DEFAULT_STALENESS_WINDOW_DAYS,
): Promise<UpdateTrigger[]> {
  const dismissed = new Set(summary.dismissed_triggers);
  const out: UpdateTrigger[] = [];
  const generatedAt = summary.report_generated_at;
  const generatedMs =
    generatedAt && !Number.isNaN(Date.parse(generatedAt)) ? Date.parse(generatedAt) : null;

  // new-materials-ingested
  const lastIngestMs =
    summary.last_data_ingest && !Number.isNaN(Date.parse(summary.last_data_ingest))
      ? Date.parse(summary.last_data_ingest)
      : null;
  if (lastIngestMs !== null && generatedMs !== null && lastIngestMs > generatedMs) {
    const id = 'new-materials-ingested';
    if (!dismissed.has(id)) {
      out.push({
        id,
        kind: 'new-materials-ingested',
        fired_at: summary.last_data_ingest as string,
        reason: `materials updated ${summary.last_data_ingest} after report write ${generatedAt}`,
      });
    }
  }

  // staleness-threshold-passed
  if (generatedMs !== null) {
    const ageMs = Date.now() - generatedMs;
    const thresholdMs = stalenessWindowDays * 86400_000;
    if (ageMs > thresholdMs) {
      const id = 'staleness-threshold-passed';
      if (!dismissed.has(id)) {
        const days = Math.floor(ageMs / 86400_000);
        out.push({
          id,
          kind: 'staleness-threshold-passed',
          fired_at: new Date().toISOString(),
          reason: `report is ${days}d old (threshold ${stalenessWindowDays}d)`,
        });
      }
    }
  }

  // recommended-change-merged — per-recommendation id per the plan; emit one
  // trigger per merged recommendation whose `id` is set and whose status in
  // the recommended_changes array is not already `merged` or `abandoned`.
  const recs = readRecommendedChanges(fm);
  if (recs.length > 0) {
    const changes = await loadChangeRefsFromManifest();
    for (let i = 0; i < recs.length; i += 1) {
      const r = recs[i];
      const linkedId = typeof r.id === 'string' ? r.id : null;
      if (!linkedId) continue;
      if (r.status === 'merged' || r.status === 'abandoned') continue;
      const change = changes.get(linkedId);
      if (!change || change.status !== 'merged') continue;
      const id = `recommended-change-merged:${linkedId}`;
      if (dismissed.has(id)) continue;
      out.push({
        id,
        kind: 'recommended-change-merged',
        fired_at: new Date().toISOString(),
        reason: `recommendation ${i} (${linkedId}) reached status: merged`,
      });
    }
  }

  return out;
}

// Read the owning project's staleness override when set, else default.
async function resolveStalenessWindowDays(projectId: string | null): Promise<number> {
  if (!projectId) return DEFAULT_STALENESS_WINDOW_DAYS;
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type === 'project' && fm.id === projectId) {
        const v = fm.staleness_window_days;
        if (typeof v === 'number' && v > 0) return v;
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
        return DEFAULT_STALENESS_WINDOW_DAYS;
      }
    } catch {
      /* skip */
    }
  }
  return DEFAULT_STALENESS_WINDOW_DAYS;
}

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Exported variant for cross-route callers (projects.ts uses this to surface
// research-reports under a project without duplicating the directory walk).
export async function listResearchReportsForProject(
  projectId: string,
): Promise<ResearchReportSummary[]> {
  return listResearchReports({ project: projectId });
}

// Walk research-report/ and apply filters.
async function listResearchReports(filters: {
  project?: string;
  status?: string;
  review_status?: string;
  has_updates_pending?: string;
}): Promise<ResearchReportSummary[]> {
  if (!existsSync(RESEARCH_REPORT_DIR)) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(RESEARCH_REPORT_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ResearchReportSummary[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const abs = join(RESEARCH_REPORT_DIR, e.name);
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(abs, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'research-report') continue;
      if (filters.project && fm.project !== filters.project) continue;
      if (filters.status && fm.status !== filters.status) continue;
      if (filters.review_status && fm.review_status !== filters.review_status) continue;
      const summary = toSummary(fm, abs);
      if (filters.has_updates_pending === 'true') {
        const stalenessDays = await resolveStalenessWindowDays(summary.project);
        const triggers = await detectUpdateTriggers(summary, fm, stalenessDays);
        if (triggers.length === 0) continue;
        summary.has_updates_pending = true;
      }
      out.push(summary);
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  return out;
}

// Replay timeline — events tagged with skill in the research-* family for
// this report id. The events DB doesn't carry a `research_report` column,
// so we filter by skill family + args JSON match.
function buildReplayTimeline(reportId: string): ReplayTimelineEntry[] {
  if (!existsSync(EVENTS_DB_PATH)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
    interface Row {
      id: number;
      ts: string;
      action: string | null;
      skill: string | null;
      duration_ms: number | null;
      exit_status: number | null;
      cost_usd: number | null;
    }
    // Filter on the canonical `report_id` column (added in research-domain
    // phase E). The prior implementation substring-matched a non-existent
    // `args_json` column, so it always returned zero events even when the
    // attribution was correct.
    const sql = `
      SELECT id, ts, action, skill, duration_ms, exit_status, cost_usd
        FROM events
       WHERE report_id = ?
       ORDER BY ts ASC
       LIMIT 500`;
    const rows = db.prepare(sql).all(reportId) as unknown as Row[];
    const out: ReplayTimelineEntry[] = [];
    for (const r of rows) {
      out.push({
        ts: r.ts,
        kind: 'event',
        event: {
          id: r.id,
          action: r.action,
          skill: r.skill,
          duration_ms: r.duration_ms,
          exit_status: r.exit_status == null ? null : String(r.exit_status),
          cost_usd: r.cost_usd,
        },
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const researchRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/research?project=&status=&review_status=&has_updates_pending=true
  fastify.get<{
    Querystring: {
      project?: string;
      status?: string;
      review_status?: string;
      has_updates_pending?: string;
    };
  }>('/', async (req) => {
    const reports = await listResearchReports(req.query ?? {});
    return { reports };
  });

  // GET /api/research/:id — full detail.
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    const stalenessDays = await resolveStalenessWindowDays(summary.project);
    const [triggers, materials, review, changes] = await Promise.all([
      detectUpdateTriggers(summary, found.fm, stalenessDays),
      listMaterialsAt(materialsDirFor(summary), summary.last_data_ingest),
      loadFileRef(summary.review_path),
      loadChangeRefsFromManifest(),
    ]);
    summary.has_updates_pending = triggers.length > 0;

    const recs = readRecommendedChanges(found.fm);
    const recommended_changes: RecommendedChangeRef[] = recs.map((r, index) => {
      const linkedId = typeof r.id === 'string' ? r.id : null;
      const linked_change = linkedId ? (changes.get(linkedId) ?? null) : null;
      return {
        index,
        id: linkedId,
        summary: typeof r.summary === 'string' ? r.summary : '(no summary)',
        domain: typeof r.domain === 'string' ? r.domain : null,
        size: typeof r.size === 'string' ? r.size : null,
        status: typeof r.status === 'string' ? r.status : 'proposed',
        linked_change,
      };
    });

    // Body — strip frontmatter + the always-present H1 title.
    let body: string | null = null;
    try {
      const raw = await readFile(found.path, 'utf8');
      const parsed = parseFrontmatter(raw);
      const stripped = parsed.body.replace(/^#\s+[^\n]*\n+/, '').trim();
      body = stripped.length > 0 ? stripped : null;
    } catch {
      /* body stays null */
    }

    const timeline = buildReplayTimeline(reportId);
    const notes = readNotesLog(found.fm);

    return {
      report: summary,
      body,
      recommended_changes,
      materials,
      review,
      triggers,
      timeline,
      notes,
    } satisfies ResearchReportDetail;
  });

  // POST /api/research/:id/notes — append a note to notes_log.
  // Hybrid persistence model: notes are append-only audit trail; each note
  // carries a `considered_by` list that downstream skills (research-review /
  // -revise / -update) append to as they fold the note into their work.
  // UI surfaces "unconsidered" notes (empty considered_by) so the user knows
  // which guidance is still pending action by some skill run.
  fastify.post<{
    Params: { id: string };
    Body: { severity?: string; body?: string };
  }>('/:id/notes', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const severity = req.body?.severity;
    const body = (req.body?.body ?? '').trim();
    if (!VALID_NOTE_SEVERITIES.includes(severity as NoteSeverity)) {
      reply.code(400);
      return {
        ok: false,
        error: `severity must be one of: ${VALID_NOTE_SEVERITIES.join(', ')}`,
        field: 'severity',
      };
    }
    if (body.length === 0) {
      reply.code(400);
      return { ok: false, error: 'body is required and must be non-empty', field: 'body' };
    }
    let content: string;
    try {
      content = await readFile(found.path, 'utf8');
    } catch {
      reply.code(500);
      return { ok: false, error: 'failed to read research-report entry' };
    }
    const existing = readNotesLog(found.fm).map(({ index: _, ...rest }) => rest);
    const nowIso = new Date().toISOString();
    existing.push({ ts: nowIso, severity: severity as NoteSeverity, body, considered_by: [] });
    const serialized = `notes_log: ${JSON.stringify(existing)}`;
    let updated: string;
    if (/^notes_log:[^\n]*$/m.test(content)) {
      updated = content.replace(/^notes_log:[^\n]*$/m, serialized);
    } else {
      // Insert before closing --- if the field doesn't exist yet.
      updated = content.replace(/\n---\n/, `\n${serialized}\n---\n`);
    }
    // Also bump `updated:` so the UI's "last touched" stamps refresh.
    updated = updated.replace(/^updated:[^\n]*$/m, `updated: ${nowIso}`);
    try {
      await writeFile(found.path, updated, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }
    recordAudit(
      'research-note-added',
      { report: reportId, severity, note_index: existing.length - 1 },
      [relative(REPO_ROOT, found.path)],
    );
    return { ok: true, note_index: existing.length - 1, ts: nowIso };
  });

  // POST /api/research/:id/write — dispatch research-write. Body shape mirrors
  // the skill's inputs; `:id` is validated against `<project>-<report_topic>`.
  fastify.post<{
    Params: { id: string };
    Body: {
      project?: string;
      report_topic?: string;
      notes?: string;
      materials?: { wikilinks?: string[]; urls?: string[] };
      material_limit?: number;
    };
  }>('/:id/write', async (req, reply) => {
    const reportId = req.params.id;
    const body = req.body ?? {};
    const project = typeof body.project === 'string' ? body.project.trim() : '';
    const reportTopic = typeof body.report_topic === 'string' ? body.report_topic.trim() : '';
    if (!project || !reportTopic) {
      reply.code(400);
      return {
        ok: false,
        error: 'request body must include project and report_topic strings',
      };
    }
    const expectedId = `${project}-${reportTopic}`;
    if (expectedId !== reportId) {
      reply.code(400);
      return {
        ok: false,
        error: `id mismatch: expected '${expectedId}', got '${reportId}'`,
      };
    }
    const targetPath = join(RESEARCH_REPORT_DIR, `${reportId}.md`);
    if (existsSync(targetPath)) {
      reply.code(409);
      return {
        ok: false,
        error: `report exists at ${relative(REPO_ROOT, targetPath)}`,
      };
    }

    const materialsBlock = JSON.stringify(body.materials ?? {});
    const materialLimit = typeof body.material_limit === 'number' ? body.material_limit : null;
    const notes = typeof body.notes === 'string' ? body.notes : '';
    const dispatcherPrompt = `Run the research-write skill for project "${project}" with report_topic "${reportTopic}".

Inputs:
- project: ${project}
- report_topic: ${reportTopic}
- materials: ${materialsBlock}
${materialLimit !== null ? `- material_limit: ${materialLimit}` : ''}
${notes ? `- notes: ${notes}` : ''}

Read .claude/skills/research-write/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os research-write ${reportId}`,
      tags: {
        project,
        domain: 'research',
        skill: 'research-write',
      },
    });
    if (!result.ok) {
      if ('blocking' in result) {
        reply.code(409);
        return { ok: false, error: 'blocked', blocking: result.blocking };
      }
      reply.code(500);
      return { ok: false, error: result.error };
    }
    recordAudit(
      'research-write-dispatch',
      { report_id: reportId, project, run_id: result.run_id },
      [],
    );
    return { ok: true, run_id: result.run_id };
  });

  // POST /api/research/:id/review — dispatch research-review.
  fastify.post<{ Params: { id: string } }>('/:id/review', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    const dispatcherPrompt = `Run the research-review skill for report "${reportId}".

Inputs:
- report_id: ${reportId}

Read .claude/skills/research-review/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary of the verdict when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os research-review ${reportId}`,
      tags: {
        project: summary.project ?? undefined,
        domain: 'research',
        skill: 'research-review',
      },
    });
    if (!result.ok) {
      if ('blocking' in result) {
        reply.code(409);
        return { ok: false, error: 'blocked', blocking: result.blocking };
      }
      reply.code(500);
      return { ok: false, error: result.error };
    }
    recordAudit('research-review-dispatch', { report_id: reportId, run_id: result.run_id }, []);
    return { ok: true, run_id: result.run_id };
  });

  // POST /api/research/:id/revise — dispatch research-revise.
  fastify.post<{ Params: { id: string } }>('/:id/revise', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    if (!summary.review_path) {
      reply.code(409);
      return {
        ok: false,
        error: 'no review_path set — run research-review first',
      };
    }
    const dispatcherPrompt = `Run the research-revise skill for report "${reportId}".

Inputs:
- report_id: ${reportId}

Read .claude/skills/research-revise/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary of what was changed when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os research-revise ${reportId}`,
      tags: {
        project: summary.project ?? undefined,
        domain: 'research',
        skill: 'research-revise',
      },
    });
    if (!result.ok) {
      if ('blocking' in result) {
        reply.code(409);
        return { ok: false, error: 'blocked', blocking: result.blocking };
      }
      reply.code(500);
      return { ok: false, error: result.error };
    }
    recordAudit('research-revise-dispatch', { report_id: reportId, run_id: result.run_id }, []);
    return { ok: true, run_id: result.run_id };
  });

  // POST /api/research/:id/approve — vault-only flip of review_status from
  // 'request-changes' to 'approved'. Gated on review_status === 'request-changes'
  // (the override case where the user disagrees with the reviewer's verdict) —
  // not callable from 'pending' (forces reviewer-first path on fresh reports)
  // or 'approved' (no-op; 409 to make repeat-clicks obvious).
  fastify.post<{ Params: { id: string } }>('/:id/approve', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const current = typeof found.fm.review_status === 'string' ? found.fm.review_status : null;
    if (current !== 'request-changes') {
      reply.code(409);
      return {
        ok: false,
        error: `research-report "${reportId}" has review_status: ${current ?? 'null'} — Mark approved is only available when review_status is 'request-changes' (override the reviewer's verdict). Run /review first on a fresh report.`,
      };
    }
    let content: string;
    try {
      content = await readFile(found.path, 'utf8');
    } catch {
      reply.code(500);
      return { ok: false, error: 'failed to read research-report entry' };
    }
    const nowIso = new Date().toISOString();
    const updated = rewriteFrontmatter(content, {
      review_status: 'approved',
      updated: nowIso,
    });
    try {
      await writeFile(found.path, updated, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }
    recordAudit('research-mark-approved', { report: reportId, prior_review_status: current }, [
      relative(REPO_ROOT, found.path),
    ]);
    return { ok: true, approved_at: nowIso };
  });

  // POST /api/research/:id/update — dispatch research-update. Body translates
  // archetype-aligned trigger ids to the skill's enum at the dispatch boundary.
  fastify.post<{
    Params: { id: string };
    Body: {
      trigger_source?: 'materials' | 'milestone' | 'change-merged' | 'manual';
      notes?: string;
    };
  }>('/:id/update', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    const body = req.body ?? {};
    const triggerSource = typeof body.trigger_source === 'string' ? body.trigger_source : 'manual';
    if (!['materials', 'milestone', 'change-merged', 'manual'].includes(triggerSource)) {
      reply.code(400);
      return {
        ok: false,
        error: `invalid trigger_source '${triggerSource}' — expected one of: materials, milestone, change-merged, manual`,
      };
    }
    const notes = typeof body.notes === 'string' ? body.notes : '';

    // Auto-dismiss currently-fired triggers — running research-update IS the
    // user's "incorporate" action, so any open trigger should clear. Without
    // this, the new-materials-ingested trigger persists indefinitely because
    // the skill bumps `last_data_ingest` (advancing the mtime baseline) but
    // preserves `report_generated_at` (so `lastIngestMs > generatedMs` stays
    // true after every update — banner never clears). See archetype-research-
    // report § dismissed_triggers + decision-remove-dispatch-cost-cap sibling
    // pattern (UI controls must match underlying state semantics).
    try {
      const stalenessDays = await resolveStalenessWindowDays(summary.project);
      const firedTriggers = await detectUpdateTriggers(summary, found.fm, stalenessDays);
      const newIds = firedTriggers
        .map((t) => t.id)
        .filter((id) => !summary.dismissed_triggers.includes(id));
      if (newIds.length > 0) {
        const next = [...summary.dismissed_triggers, ...newIds];
        let raw = await readFile(found.path, 'utf8');
        raw = replaceField(raw, 'dismissed_triggers', JSON.stringify(next));
        raw = replaceField(raw, 'updated', new Date().toISOString());
        await writeFile(found.path, raw, 'utf8');
      }
    } catch {
      // Non-fatal — proceed with dispatch even if frontmatter write failed.
      // The skill will run; banner just won't clear until next manual dismiss.
    }

    const dispatcherPrompt = `Run the research-update skill for report "${reportId}".

Inputs:
- report_id: ${reportId}
- trigger_source: ${triggerSource}
${notes ? `- notes: ${notes}` : ''}

Read .claude/skills/research-update/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os research-update ${reportId}`,
      tags: {
        project: summary.project ?? undefined,
        domain: 'research',
        skill: 'research-update',
      },
    });
    if (!result.ok) {
      if ('blocking' in result) {
        reply.code(409);
        return { ok: false, error: 'blocked', blocking: result.blocking };
      }
      reply.code(500);
      return { ok: false, error: result.error };
    }
    recordAudit(
      'research-update-dispatch',
      { report_id: reportId, trigger_source: triggerSource, run_id: result.run_id },
      [],
    );
    return { ok: true, run_id: result.run_id };
  });

  // POST /api/research/:id/scaffold-recommendations — thin dispatcher of the
  // research-scaffold-recommendations orchestrator skill. The skill owns the
  // per-item dev-add-change loop + report-frontmatter writeback.
  fastify.post<{
    Params: { id: string };
    Body: { subset?: number[] };
  }>('/:id/scaffold-recommendations', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    const recs = readRecommendedChanges(found.fm);

    const rawSubset = req.body?.subset;
    let resolvedSubset: number[];
    if (rawSubset === undefined) {
      resolvedSubset = [];
      for (let i = 0; i < recs.length; i += 1) {
        if (recs[i].status === 'proposed') resolvedSubset.push(i);
      }
    } else {
      if (
        !Array.isArray(rawSubset) ||
        rawSubset.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 0)
      ) {
        reply.code(400);
        return {
          ok: false,
          error: 'subset must be an array of non-negative integer indices',
        };
      }
      const bad = rawSubset.filter((i) => i >= recs.length);
      if (bad.length > 0) {
        reply.code(400);
        return {
          ok: false,
          error: `subset indices out of range (recommended_changes.length=${recs.length}): ${bad.join(', ')}`,
        };
      }
      resolvedSubset = [...new Set(rawSubset)].sort((a, b) => a - b);
    }

    if (resolvedSubset.length === 0) {
      reply.code(409);
      return { ok: false, error: 'no proposed recommendations to scaffold' };
    }

    const subsetJson = JSON.stringify(resolvedSubset);
    const dispatcherPrompt = `Run the research-scaffold-recommendations skill for report "${reportId}".

Inputs:
- report: ${reportId}
- indices: ${subsetJson}

Read .claude/skills/research-scaffold-recommendations/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight per-item summary when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os scaffold-research-recommendations ${reportId}`,
      tags: {
        project: summary.project ?? undefined,
        domain: 'research',
        skill: 'research-scaffold-recommendations',
      },
    });
    if (!result.ok) {
      if ('blocking' in result) {
        reply.code(409);
        return { ok: false, error: 'blocked', blocking: result.blocking };
      }
      reply.code(500);
      return { ok: false, error: result.error };
    }
    recordAudit(
      'research-scaffold-recommendations-dispatch',
      { report_id: reportId, subset: resolvedSubset, run_id: result.run_id },
      [],
    );
    return { ok: true, run_id: result.run_id };
  });

  // POST /api/research/seed-materials — pre-create the materials directory and
  // drop files into it BEFORE the research-report exists. Used by the
  // AddResearchReportModal so the user can stage files (drag-drop / picker)
  // alongside URLs/wikilinks; research-write picks them up on the first run.
  //
  // Preserves the "report must exist" invariant on POST /:id/materials by
  // living as a sibling endpoint with explicit (project, report_topic) inputs.
  // If the user cancels the modal after seeding, files remain on disk — they
  // are inert materials and the next attempt with the same topic can either
  // reuse or overwrite them.
  fastify.post<{
    Body: {
      project?: string;
      report_topic?: string;
      files?: Array<{ filename?: string; content_base64?: string }>;
    };
  }>('/seed-materials', async (req, reply) => {
    const project = typeof req.body?.project === 'string' ? req.body.project : '';
    const reportTopic = typeof req.body?.report_topic === 'string' ? req.body.report_topic : '';
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!project) {
      reply.code(400);
      return { ok: false, error: 'project is required', field: 'project' };
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(reportTopic)) {
      reply.code(400);
      return {
        ok: false,
        error: 'report_topic must be slug-shaped (lowercase, alphanumeric, hyphens)',
        field: 'report_topic',
      };
    }
    // Validate project exists by walking the wiki for a matching project entry.
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    let projectFound = false;
    for (const file of await walkMd(wikiDir)) {
      try {
        const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
        if (parseError) continue;
        if (fm.type === 'project' && fm.id === project) {
          projectFound = true;
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (!projectFound) {
      reply.code(404);
      return { ok: false, error: `project "${project}" not found`, field: 'project' };
    }
    if (files.length === 0) {
      // No files — no-op success. Caller may have nothing to seed.
      return { ok: true, materials: [] as Array<{ ok: boolean; path?: string; error?: string }> };
    }
    let dropDir: string;
    try {
      dropDir = safePath(join('vault', 'raw', 'project-research', project, reportTopic));
    } catch {
      reply.code(400);
      return { ok: false, error: 'safePath rejected target directory' };
    }
    await mkdir(dropDir, { recursive: true });
    const results: Array<{ ok: boolean; path?: string; error?: string }> = [];
    for (const f of files) {
      const filename = sanitizeMaterialFilename(f.filename ?? '');
      if (!filename) {
        results.push({
          ok: false,
          error: `filename rejected: ${String(f.filename ?? '<unset>')}`,
        });
        continue;
      }
      let target: string;
      try {
        target = safePath(join(relative(REPO_ROOT, dropDir), filename));
      } catch {
        results.push({ ok: false, error: 'safePath rejected target' });
        continue;
      }
      let content: Buffer;
      try {
        content = Buffer.from(f.content_base64 ?? '', 'base64');
      } catch {
        results.push({ ok: false, error: 'invalid base64 content' });
        continue;
      }
      if (content.byteLength > 5 * 1024 * 1024) {
        results.push({ ok: false, error: 'file exceeds 5 MB cap' });
        continue;
      }
      try {
        await writeFile(target, content);
        results.push({ ok: true, path: relative(REPO_ROOT, target) });
      } catch (e) {
        results.push({ ok: false, error: `write failed: ${(e as Error).message}` });
      }
    }
    recordAudit(
      'research-seed-materials',
      {
        project,
        report_topic: reportTopic,
        count_ok: results.filter((r) => r.ok).length,
        count_failed: results.filter((r) => !r.ok).length,
      },
      results.filter((r) => r.ok).map((r) => r.path) as string[],
    );
    return { ok: true, materials: results };
  });

  // GET /api/research/:id/materials — list files in the report's materials dir.
  fastify.get<{ Params: { id: string } }>('/:id/materials', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    const dirAbs = materialsDirFor(summary);
    const materials = await listMaterialsAt(dirAbs, summary.last_data_ingest);
    return { ok: true, materials };
  });

  // POST /api/research/:id/materials — upload a material. Same JSON shape as
  // POST /api/projects/:id/materials (kind: 'url' | 'file').
  fastify.post<{
    Params: { id: string };
    Body:
      | { kind: 'url'; urls: string[] }
      | { kind: 'file'; filename: string; content: string; content_encoding?: 'base64' };
  }>('/:id/materials', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const summary = toSummary(found.fm, found.path);
    if (!summary.project) {
      reply.code(409);
      return { ok: false, error: 'report has no project — cannot resolve materials drop dir' };
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { ok: false, error: 'request body required' };
    }

    const dropDir = materialsDirFor(summary);
    if (!dropDir) {
      reply.code(400);
      return { ok: false, error: 'invalid report materials directory' };
    }
    await mkdir(dropDir, { recursive: true });

    const materials: Array<{ ok: boolean; path?: string; error?: string }> = [];

    if (body.kind === 'url') {
      const urls = Array.isArray(body.urls) ? body.urls : [];
      let existing: string[] = [];
      try {
        existing = (await readdir(dropDir)).filter((n) => n.startsWith('url-'));
      } catch {
        existing = [];
      }
      let n = existing.length;
      for (const rawUrl of urls) {
        if (typeof rawUrl !== 'string') {
          materials.push({ ok: false, error: 'url must be a string' });
          continue;
        }
        let u: URL;
        try {
          u = new URL(rawUrl);
        } catch {
          materials.push({ ok: false, error: `invalid url: ${rawUrl}` });
          continue;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          materials.push({ ok: false, error: `unsupported protocol: ${u.protocol}` });
          continue;
        }
        n += 1;
        const slug = urlSlug(rawUrl);
        const filename = `url-${n}-${slug}.md`;
        let target: string;
        try {
          target = safePath(join(relative(REPO_ROOT, dropDir), filename));
        } catch {
          materials.push({ ok: false, error: 'safePath rejected target' });
          continue;
        }
        try {
          const response = await fetch(rawUrl);
          if (!response.ok) {
            materials.push({ ok: false, error: `fetch failed: HTTP ${response.status}` });
            continue;
          }
          const buf = await response.arrayBuffer();
          if (buf.byteLength > 5 * 1024 * 1024) {
            materials.push({ ok: false, error: 'response exceeds 5 MB cap' });
            continue;
          }
          const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
          const fetchedAt = new Date().toISOString();
          const header = [
            '---',
            `source: ${rawUrl}`,
            `fetched_at: ${fetchedAt}`,
            '---',
            '',
            '',
          ].join('\n');
          await writeFile(target, header + text, 'utf8');
          materials.push({ ok: true, path: relative(REPO_ROOT, target) });
        } catch (e) {
          materials.push({ ok: false, error: `fetch error: ${(e as Error).message}` });
        }
      }
      recordAudit(
        'research-materials-add',
        {
          report_id: reportId,
          kind: 'url',
          count: materials.filter((m) => m.ok).length,
          paths: materials.filter((m) => m.ok).map((m) => m.path),
        },
        materials.filter((m) => m.ok).map((m) => m.path) as string[],
      );
      return { ok: true, materials };
    }

    if (body.kind === 'file') {
      const filename = sanitizeMaterialFilename(body.filename);
      if (!filename) {
        reply.code(400);
        return {
          ok: false,
          error: 'filename rejected — must match [A-Za-z0-9._-]+ with no leading dot or traversal',
        };
      }
      let target: string;
      try {
        target = safePath(join(relative(REPO_ROOT, dropDir), filename));
      } catch {
        reply.code(400);
        return { ok: false, error: 'safePath rejected target' };
      }
      let content: Buffer | string;
      if (body.content_encoding === 'base64') {
        try {
          content = Buffer.from(body.content, 'base64');
        } catch {
          reply.code(400);
          return { ok: false, error: 'invalid base64 content' };
        }
      } else {
        content = body.content;
      }
      await writeFile(target, content);
      materials.push({ ok: true, path: relative(REPO_ROOT, target) });
      recordAudit(
        'research-materials-add',
        {
          report_id: reportId,
          kind: 'file',
          count: 1,
          paths: [relative(REPO_ROOT, target)],
        },
        [relative(REPO_ROOT, target)],
      );
      return { ok: true, materials };
    }

    reply.code(400);
    return { ok: false, error: "body.kind must be 'url' or 'file'" };
  });

  // DELETE /api/research/:id/materials/:filename — remove a single material.
  fastify.delete<{ Params: { id: string; filename: string } }>(
    '/:id/materials/:filename',
    async (req, reply) => {
      const reportId = req.params.id;
      const filename = sanitizeMaterialFilename(req.params.filename);
      if (!filename) {
        reply.code(400);
        return { ok: false, error: 'filename rejected — invalid characters' };
      }
      const found = await findResearchReport(reportId);
      if (!found) {
        reply.code(404);
        return { ok: false, error: `research-report "${reportId}" not found` };
      }
      const summary = toSummary(found.fm, found.path);
      const dropDir = materialsDirFor(summary);
      if (!dropDir) {
        reply.code(400);
        return { ok: false, error: 'invalid report materials directory' };
      }
      let target: string;
      try {
        target = safePath(join(relative(REPO_ROOT, dropDir), filename));
      } catch {
        reply.code(400);
        return { ok: false, error: 'safePath rejected target' };
      }
      if (!existsSync(target)) {
        reply.code(404);
        return { ok: false, error: `material not found: ${filename}` };
      }
      try {
        await unlink(target);
      } catch (e) {
        reply.code(500);
        return { ok: false, error: `delete failed: ${(e as Error).message}` };
      }
      recordAudit('research-materials-delete', { report_id: reportId, filename }, [
        relative(REPO_ROOT, target),
      ]);
      return { ok: true };
    },
  );

  // POST /api/research/:id/triggers/dismiss — adds the trigger id to
  // dismissed_triggers[]. Single-line JSON re-emission per archetype caveat.
  fastify.post<{
    Params: { id: string };
    Body: { trigger_id?: string };
  }>('/:id/triggers/dismiss', async (req, reply) => {
    const reportId = req.params.id;
    const found = await findResearchReport(reportId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `research-report "${reportId}" not found` };
    }
    const triggerId = req.body?.trigger_id;
    if (typeof triggerId !== 'string' || triggerId.length === 0) {
      reply.code(400);
      return { ok: false, error: 'trigger_id required (non-empty string)' };
    }
    const summary = toSummary(found.fm, found.path);
    if (summary.dismissed_triggers.includes(triggerId)) {
      return { ok: true, already_dismissed: true };
    }
    const next = [...summary.dismissed_triggers, triggerId];
    let raw: string;
    try {
      raw = await readFile(found.path, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `read failed: ${(e as Error).message}` };
    }
    const nowIso = new Date().toISOString();
    let updated = replaceField(raw, 'dismissed_triggers', JSON.stringify(next));
    updated = replaceField(updated, 'updated', nowIso);
    try {
      await writeFile(found.path, updated, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }
    recordAudit('research-trigger-dismiss', { report_id: reportId, trigger_id: triggerId }, [
      relative(REPO_ROOT, found.path),
    ]);
    return { ok: true, dismissed_triggers: next };
  });
};
