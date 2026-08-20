// /api/ops — read-only surface over the ops domain's review protocols and the
// dated reports they produce.
//
// READ-ONLY BY CONTRACT. Every route here is a GET. The ops domain never
// mutates a monitored system, and this surface never mutates the vault either:
// running a review is a dispatch through the shared /api/runs API, which is
// where run concurrency, origin stamping, and supervision already live. There
// is deliberately no POST here to "just update last_reviewed" — the skill owns
// that stamp, so the report and the stamp can never disagree.
//
// Frontmatter is parsed with the shared parser (real YAML, CORE_SCHEMA), which
// accepts both the single-line JSON the archetype mandates and an equivalent
// block form. The archetype still pins single-line because line-oriented
// readers elsewhere drop block structures silently — this route being tolerant
// does not make the write-side contract optional, so a `kpi` that arrives as
// anything other than a usable object surfaces as `kpi: null` (a visibly
// missing contract) rather than as a half-populated one.

import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT, safePath } from '../repo.js';
import type {
  OpsKpi,
  OpsMonitor,
  OpsProtocolDetail,
  OpsProtocolSummary,
  OpsReportDetail,
  OpsReportSummary,
  OpsVerdict,
} from './ops.types.js';

const PROTOCOL_DIR = join(REPO_ROOT, 'vault', 'wiki', 'ops', 'review-protocol');
const DEFAULT_REPORTS_ROOT = 'vault/output/ops/health-reviews';

// Entry ids and report filenames both come off the URL. Constrain them before
// they reach the filesystem — no separators, no dots, no traversal.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPORT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

const VERDICTS = new Set<OpsVerdict>(['healthy', 'watch', 'action-needed']);

function asVerdict(v: unknown): OpsVerdict | null {
  return typeof v === 'string' && VERDICTS.has(v as OpsVerdict) ? (v as OpsVerdict) : null;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  // CORE_SCHEMA keeps timestamps as strings, but a hand-edited entry can still
  // land a Date via another writer — accept it rather than dropping the field.
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// A structured field may arrive as a parsed object (the normal case) or as a
// JSON string (when a writer quoted the whole value). Anything else — most
// importantly a block form that a line-oriented reader would have dropped —
// yields null so the gap is visible instead of half-rendered.
function asStructured(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function toKpi(raw: unknown): OpsKpi | null {
  const v = asStructured(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = asString(o.name);
  if (!name) return null;
  return {
    name,
    formula: asString(o.formula) ?? '',
    baseline: asNumber(o.baseline),
    target: asNumber(o.target),
    window_days: asNumber(o.window_days),
    guardrail: asNumber(o.guardrail),
  };
}

function toTickets(raw: unknown): string[] {
  const v = asStructured(raw);
  if (!Array.isArray(v)) return [];
  return v.map((t) => (typeof t === 'string' ? t : String(t))).filter((t) => t.length > 0);
}

// Monitors without a gate are dropped, not defaulted to an empty string. The
// gate is the whole point of the field — a gateless monitor rendering as
// "ready" would invert the safety property it exists to enforce.
function toMonitors(raw: unknown): OpsMonitor[] {
  const v = asStructured(raw);
  if (!Array.isArray(v)) return [];
  const out: OpsMonitor[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const o = m as Record<string, unknown>;
    const id = asString(o.id);
    const gate = asString(o.gate);
    if (!id || !gate) continue;
    out.push({ id, name: asString(o.name) ?? id, gate });
  }
  return out;
}

// Report filenames are date-led (`YYYY-MM-DD.md`, `YYYY-MM-DD-2.md` for the Nth
// same-day review) so ordering is derivable from the name alone — no need to
// read every file to sort the list.
function parseReportFilename(file: string): { date: string | null; seq: number } {
  const m = file.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/);
  if (!m) return { date: null, seq: 1 };
  return { date: m[1], seq: m[2] ? Number(m[2]) : 1 };
}

// Newest first. Date descending, then same-day sequence descending. Files that
// don't follow the convention sort last (by name descending) rather than
// silently interleaving at an arbitrary position.
function compareReportsNewestFirst(a: OpsReportSummary, b: OpsReportSummary): number {
  if (a.date && b.date) {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.seq - a.seq;
  }
  if (a.date) return -1;
  if (b.date) return 1;
  return b.file.localeCompare(a.file);
}

async function listMdFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A protocol whose reports_dir doesn't exist yet has simply never been
    // reviewed. Empty list, not an error.
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => e.name);
}

// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function toProtocolSummary(fm: any, filePath: string, reportsCount: number): OpsProtocolSummary {
  const id = asString(fm.id) ?? filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  return {
    id,
    path: relative(REPO_ROOT, filePath),
    title: asString(fm.title) ?? id,
    target: asString(fm.target),
    owner: asString(fm.owner),
    scan_minutes: asNumber(fm.scan_minutes),
    kpi: toKpi(fm.kpi),
    verify_tickets: toTickets(fm.verify_tickets),
    monitors: toMonitors(fm.monitors),
    reports_dir: asString(fm.reports_dir) ?? `${DEFAULT_REPORTS_ROOT}/${id}`,
    last_reviewed: asString(fm.last_reviewed),
    last_verdict: asVerdict(fm.last_verdict),
    created: asString(fm.created),
    updated: asString(fm.updated),
    reports_count: reportsCount,
  };
}

// Every graded value comes from frontmatter. Prose is never parsed for a
// verdict or a KPI — a number lifted out of a sentence is a number nobody can
// be held to, and it would silently disagree with the report it came from.
// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function toReportSummary(fm: any, file: string, absPath: string): OpsReportSummary {
  const { date, seq } = parseReportFilename(file);
  return {
    file,
    path: relative(REPO_ROOT, absPath),
    date,
    seq,
    reviewed_at: asString(fm.reviewed_at),
    verdict: asVerdict(fm.verdict),
    kpi_name: asString(fm.kpi_name),
    kpi_value: asNumber(fm.kpi_value),
    kpi_baseline: asNumber(fm.kpi_baseline),
    kpi_target: asNumber(fm.kpi_target),
    kpi_guardrail: asNumber(fm.kpi_guardrail),
    window_days: asNumber(fm.window_days),
    window_overridden: fm.window_overridden === true || fm.window_overridden === 'true',
    failures_total: asNumber(fm.failures_total),
    failures_unclassified: asNumber(fm.failures_unclassified),
    tickets_confirmed: asNumber(fm.tickets_confirmed),
    tickets_pending: asNumber(fm.tickets_pending),
    tickets_contradicted: asNumber(fm.tickets_contradicted),
    monitors_ready: asNumber(fm.monitors_ready),
    gaps: asNumber(fm.gaps),
    forecast_horizon_hours: asNumber(fm.forecast_horizon_hours),
  };
}

async function readProtocolFile(
  id: string,
): Promise<{ fm: Record<string, unknown>; body: string; path: string } | null> {
  if (!ID_RE.test(id)) return null;
  const abs = safePath(join('vault', 'wiki', 'ops', 'review-protocol', `${id}.md`));
  let content: string;
  try {
    content = await readFile(abs, 'utf8');
  } catch {
    return null;
  }
  const { fm, body, parseError } = parseFrontmatter(content);
  if (parseError) return null;
  if (fm.type !== 'review-protocol') return null;
  return { fm, body, path: abs };
}

async function readReports(reportsDir: string): Promise<OpsReportSummary[]> {
  let absDir: string;
  try {
    absDir = safePath(reportsDir);
  } catch {
    // A reports_dir pointing outside the repo is a broken entry, not a reason
    // to read outside the tree.
    return [];
  }
  const files = await listMdFiles(absDir);
  const out: OpsReportSummary[] = [];
  for (const file of files) {
    const abs = join(absDir, file);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const { fm, parseError } = parseFrontmatter(content);
    // A report whose frontmatter won't parse still belongs in the list — it
    // exists, it's dated, and hiding it would make a broken review look like a
    // week that was never reviewed. Its graded fields land null.
    out.push(toReportSummary(parseError ? {} : fm, file, abs));
  }
  out.sort(compareReportsNewestFirst);
  return out;
}

export const opsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/ops — every review protocol, with its report count. Sorted by
  // attention: action-needed first, then watch, then healthy, then never
  // reviewed; within a verdict, least-recently-reviewed first (the one most
  // overdue for a look sits at the top of its band).
  fastify.get('/', async () => {
    let entries: Dirent[];
    try {
      entries = await readdir(PROTOCOL_DIR, { withFileTypes: true });
    } catch {
      return { protocols: [] as OpsProtocolSummary[] };
    }
    const out: OpsProtocolSummary[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
      const abs = join(PROTOCOL_DIR, e.name);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'review-protocol') continue;
      const summary = toProtocolSummary(fm, abs, 0);
      summary.reports_count = (await readReports(summary.reports_dir)).length;
      out.push(summary);
    }
    const verdictPriority = (v: OpsVerdict | null): number => {
      if (v === 'action-needed') return 0;
      if (v === 'watch') return 1;
      if (v === 'healthy') return 2;
      return 3; // never reviewed
    };
    out.sort((a, b) => {
      const pa = verdictPriority(a.last_verdict);
      const pb = verdictPriority(b.last_verdict);
      if (pa !== pb) return pa - pb;
      const at = a.last_reviewed ?? '';
      const bt = b.last_reviewed ?? '';
      if (at !== bt) return at.localeCompare(bt); // oldest review first
      return a.id.localeCompare(b.id);
    });
    return { protocols: out };
  });

  // GET /api/ops/:id — one protocol with its body and its reports (newest
  // first). The body is the operative contract a review executes; the UI
  // renders it so a reader can see what the verdict was graded against.
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const found = await readProtocolFile(req.params.id);
    if (!found) {
      return reply.code(404).send({ error: 'protocol not found' });
    }
    const summary = toProtocolSummary(found.fm, found.path, 0);
    const reports = await readReports(summary.reports_dir);
    summary.reports_count = reports.length;
    const detail: OpsProtocolDetail = { ...summary, body: found.body, reports };
    return detail;
  });

  // GET /api/ops/:id/reports — the protocol's reports, newest first.
  fastify.get<{ Params: { id: string } }>('/:id/reports', async (req, reply) => {
    const found = await readProtocolFile(req.params.id);
    if (!found) {
      return reply.code(404).send({ error: 'protocol not found' });
    }
    const summary = toProtocolSummary(found.fm, found.path, 0);
    return { reports: await readReports(summary.reports_dir) };
  });

  // GET /api/ops/:id/reports/:file — one report's full content. Resolved
  // through the OWNING protocol's reports_dir, so a report can only be fetched
  // via the protocol that claims it.
  fastify.get<{ Params: { id: string; file: string } }>(
    '/:id/reports/:file',
    async (req, reply) => {
      const { id, file } = req.params;
      const found = await readProtocolFile(id);
      if (!found) {
        return reply.code(404).send({ error: 'protocol not found' });
      }
      if (!REPORT_FILE_RE.test(file) || file.includes('..')) {
        return reply.code(400).send({ error: 'invalid report filename' });
      }
      const summary = toProtocolSummary(found.fm, found.path, 0);
      let abs: string;
      try {
        abs = safePath(join(summary.reports_dir, file));
      } catch {
        return reply.code(400).send({ error: 'reports_dir escapes the repo root' });
      }
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        return reply.code(404).send({ error: 'report not found' });
      }
      const { fm, body, parseError } = parseFrontmatter(content);
      const detail: OpsReportDetail = {
        ...toReportSummary(parseError ? {} : fm, file, abs),
        protocol: summary.id,
        content,
        body,
      };
      return detail;
    },
  );
};
