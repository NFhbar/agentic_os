import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Octokit } from '@octokit/rest';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { type EventRow, computeLifecycle } from '../lib/lifecycle-state.js';
import { REPO_ROOT, safePath } from '../repo.js';
import type {
  ChangeAutomation,
  ChangeAutomationPhase,
  ChangeRollup,
  ChangeSummary,
  FileRef,
  LifecycleStage,
  RelatedEntities,
  StageStatus,
} from './changes.types.js';
import { lookupLinkedReview } from './pr-review-lookup.js';

// Re-export so existing consumers that import { ChangeSummary, ... } from
// './changes.js' keep working without changes. New consumers should import
// from './changes.types.js' directly.
export type {
  ChangeAutomation,
  ChangeAutomationPhase,
  ChangeAutomationState,
  ChangeRollup,
  ChangeSummary,
  FileRef,
  LifecycleStage,
  RelatedEntities,
  StageStatus,
} from './changes.types.js';

const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

// ---------------------------------------------------------------------------
// PR endpoint helpers — live PR + CI fetch via octokit
// ---------------------------------------------------------------------------

// Lazy-load + cache the GitHub PAT from mcps/github/.env. Read at first
// request, cached for the dashboard process lifetime. Rotate by editing the
// file + restarting the dashboard (matches the MCP server's contract).
let _githubToken: string | null | undefined;
function getGithubToken(): string | null {
  if (_githubToken !== undefined) return _githubToken;
  const envPath = join(REPO_ROOT, 'mcps', 'github', '.env');
  if (!existsSync(envPath)) {
    _githubToken = null;
    return null;
  }
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (key === 'GITHUB_TOKEN' && val.length > 0) {
        _githubToken = val;
        return _githubToken;
      }
    }
  } catch {
    /* fall through */
  }
  _githubToken = null;
  return null;
}

// Lazy-construct an Octokit instance, reusing the token cache.
let _octokit: Octokit | null = null;
function getOctokit(): Octokit | null {
  if (_octokit) return _octokit;
  const token = getGithubToken();
  if (!token) return null;
  _octokit = new Octokit({ auth: token });
  return _octokit;
}

// Parse `owner/repo` and `pull_number` from a PR URL. Returns null when
// the URL doesn't match the canonical github.com/<owner>/<repo>/pull/<n> shape.
function parsePrUrl(prUrl: string): { owner: string; repo: string; pull_number: number } | null {
  const m = prUrl.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pull_number: Number(m[3]) };
}

interface PrCheckRun {
  name: string;
  status: string | null; // queued | in_progress | completed
  conclusion: string | null;
  url: string | null;
  source: 'check_run' | 'commit_status';
}

interface PrDetailResponse {
  ok: true;
  pr: {
    number: number;
    url: string;
    state: string;
    merged: boolean;
    draft: boolean;
    mergeable: boolean | null;
    title: string;
    body: string | null;
    user_login: string | null;
    head_ref: string | null;
    head_sha: string | null;
    base_ref: string | null;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
  };
  ci: {
    state: 'pass' | 'fail' | 'running' | 'none';
    total: number;
    by_state: {
      success: number;
      failure: number;
      in_progress: number;
      queued: number;
      neutral: number;
      other: number;
    };
    runs: PrCheckRun[];
  };
  fetched_at: string;
}

interface PrErrorResponse {
  ok: false;
  error: string;
  reason: 'no-pr-url' | 'no-token' | 'parse-failed' | 'github-error' | 'not-found';
  hint?: string;
}

// Surgical frontmatter field update — preserves comments, ordering, and the
// rest of the .md body. For each key in `updates`, replaces the value if the
// field already exists in the frontmatter, or appends to the end of the
// frontmatter block if it's new. Used by the PR-sync endpoint to write back
// ci_state / ci_completed_at / merged_at / status / updated when GitHub
// state diverges from the change entry.
function updateFrontmatterFields(content: string, updates: Record<string, string>): string {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return content;
  const fmText = m[1];
  const restStart = m[0].length;
  const body = content.slice(restStart);
  const lines = fmText.split('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const km = line.match(/^([a-z_][a-z0-9_]*):/i);
    if (km && updates[km[1]] !== undefined && !seen.has(km[1])) {
      out.push(`${km[1]}: ${updates[km[1]]}`);
      seen.add(km[1]);
    } else {
      out.push(line);
    }
  }
  for (const key of Object.keys(updates)) {
    if (!seen.has(key)) {
      out.push(`${key}: ${updates[key]}`);
    }
  }
  return `---\n${out.join('\n')}\n---\n${body}`;
}

// ChangeSummary, FileRef — moved to ./changes.types.ts (shared with client).

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

// js-yaml parses bare ISO timestamps as Date objects, not strings — a naive
// typeof check returns null for every timestamp field. Normalize both forms.
function asISOString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

// Parse the per-change `automation:` block from frontmatter. Returns null
// when the block is absent — the canonical signal that automation has never
// been touched for this change. Returns a populated ChangeAutomation when
// present, filling in safe defaults for any missing sub-fields so callers
// can read state.* without null-guarding every sub-key.
//
// Extensibility: `current_step` and `paused_reason` are read as free-form
// strings — new step kinds + pause reasons land without data migration. Only
// `phase` enforces a closed enum; unknown values fall back to 'idle' (safe
// default that prevents accidental loops).
//
// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function readChangeAutomation(fm: any): ChangeAutomation | null {
  const raw = fm?.automation;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stateRaw = (r.state && typeof r.state === 'object' ? r.state : {}) as Record<
    string,
    unknown
  >;
  const phase: ChangeAutomationPhase =
    stateRaw.phase === 'running' || stateRaw.phase === 'paused' || stateRaw.phase === 'complete'
      ? stateRaw.phase
      : 'idle';
  return {
    enabled: r.enabled === true,
    iteration_cap:
      typeof r.iteration_cap === 'number' && r.iteration_cap > 0 ? Math.floor(r.iteration_cap) : 4, // default 4 — see decision in standard-automation-loop.md
    state: {
      phase,
      current_step: typeof stateRaw.current_step === 'string' ? stateRaw.current_step : null,
      iteration_count:
        typeof stateRaw.iteration_count === 'number' && stateRaw.iteration_count >= 0
          ? Math.floor(stateRaw.iteration_count)
          : 0,
      paused_reason: typeof stateRaw.paused_reason === 'string' ? stateRaw.paused_reason : null,
      paused_at: asISOString(stateRaw.paused_at),
      last_transition: asISOString(stateRaw.last_transition),
      last_run_id: typeof stateRaw.last_run_id === 'string' ? stateRaw.last_run_id : null,
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function toSummary(fm: any, filePath: string): ChangeSummary {
  return {
    id: typeof fm.id === 'string' ? fm.id : null,
    path: relative(REPO_ROOT, filePath),
    title: typeof fm.title === 'string' ? fm.title : (fm.id ?? '(untitled)'),
    domain: typeof fm.domain === 'string' ? fm.domain : null,
    status: typeof fm.status === 'string' ? fm.status : null,
    repo: typeof fm.repo === 'string' ? fm.repo : null,
    branch: typeof fm.branch === 'string' ? fm.branch : null,
    scope: typeof fm.scope === 'string' ? fm.scope : null,
    pr_url: typeof fm.pr_url === 'string' ? fm.pr_url : null,
    size: typeof fm.size === 'string' ? fm.size : null,
    project: typeof fm.project === 'string' ? fm.project : null,
    parent_change: typeof fm.parent_change === 'string' ? fm.parent_change : null,
    // ISO-string fields go through asISOString — js-yaml parses bare ISO
    // timestamps as Date objects, and a typeof === 'string' check would
    // reject them. asISOString accepts both shapes.
    updated: asISOString(fm.updated),
    review_required: typeof fm.review_required === 'boolean' ? fm.review_required : null,
    review_status: typeof fm.review_status === 'string' ? fm.review_status : null,
    plan_path: typeof fm.plan_path === 'string' ? fm.plan_path : null,
    review_path: typeof fm.review_path === 'string' ? fm.review_path : null,
    plan_generated_at: asISOString(fm.plan_generated_at),
    reviewed_at: asISOString(fm.reviewed_at),
    plan_revision:
      typeof fm.plan_revision === 'number'
        ? fm.plan_revision
        : typeof fm.plan_revision === 'string' && /^\d+$/.test(fm.plan_revision)
          ? Number.parseInt(fm.plan_revision, 10)
          : null,
    plan_revised_at: asISOString(fm.plan_revised_at),
    plan_revised_from_review:
      typeof fm.plan_revised_from_review === 'string' ? fm.plan_revised_from_review : null,
    pr_review_status: typeof fm.pr_review_status === 'string' ? fm.pr_review_status : null,
    pr_review_path: typeof fm.pr_review_path === 'string' ? fm.pr_review_path : null,
    pr_review_passes: typeof fm.pr_review_passes === 'number' ? fm.pr_review_passes : null,
    pr_reviewed_at: asISOString(fm.pr_reviewed_at),
    pr_ready_at: asISOString(fm.pr_ready_at),
    merged_at: asISOString(fm.merged_at),
    abandoned_at: asISOString(fm.abandoned_at),
    abandoned_reason: typeof fm.abandoned_reason === 'string' ? fm.abandoned_reason : null,
    ci_state: typeof fm.ci_state === 'string' ? fm.ci_state : null,
    ci_completed_at: asISOString(fm.ci_completed_at),
    derived_from_report: typeof fm.derived_from_report === 'string' ? fm.derived_from_report : null,
    recommendation_index:
      typeof fm.recommendation_index === 'number'
        ? fm.recommendation_index
        : typeof fm.recommendation_index === 'string' && /^\d+$/.test(fm.recommendation_index)
          ? Number.parseInt(fm.recommendation_index, 10)
          : null,
    // Populated by the list + single endpoints after summary build — see
    // populateRecommendationsTotal below.
    recommendations_total: null,
    automation: readChangeAutomation(fm),
  };
}

// Count sibling changes scaffolded from the same research-report. Reads the
// manifest (cheap — already kept warm by the rebuild-vault-index hook). Used
// to surface `[N+1/M]` step indicators on derived change titles.
function countSiblingRecommendations(reportId: string): number {
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return 0;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      entries?: Array<{ type?: string | null; derived_from_report?: string | null }>;
    };
    let count = 0;
    for (const e of manifest.entries ?? []) {
      if (e.type === 'change' && e.derived_from_report === reportId) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// Patch recommendations_total on summaries that have derived_from_report set.
// Called once per endpoint with all summaries in hand — cheaper than calling
// countSiblingRecommendations N times when most summaries share reports.
function populateRecommendationsTotal(summaries: ChangeSummary[]): void {
  const counts = new Map<string, number>();
  for (const s of summaries) {
    if (s.derived_from_report) {
      if (!counts.has(s.derived_from_report)) {
        counts.set(s.derived_from_report, countSiblingRecommendations(s.derived_from_report));
      }
      s.recommendations_total = counts.get(s.derived_from_report) ?? null;
    }
  }
}

// Load a referenced output file (plan or review) — returns null when missing.
// Truncates preview to ~600 chars so the dashboard doesn't pay for a full
// markdown payload until the user clicks through.
export async function loadFileRef(relPath: string | null | undefined): Promise<FileRef | null> {
  if (!relPath) return null;
  let abs: string;
  try {
    abs = safePath(relPath);
  } catch {
    return null;
  }
  try {
    const [content, s] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
    const preview = content.length > 600 ? `${content.slice(0, 600)}…` : content;
    return {
      path: relPath,
      mtime: new Date(s.mtimeMs).toISOString(),
      preview,
    };
  } catch {
    return null;
  }
}

// Canonical artifact path fallback. Some skills write their output file but
// fail to update the change entry's `plan_path` / `review_path` frontmatter
// fields (e.g. when a sub-step errors after the file lands). The dashboard
// would then show "no plan yet" even though the file exists on disk. This
// helper tries the canonical convention `vault/output/<domain>/changes/<id>-<kind>.md`
// and returns a FileRef if it exists.
//
// Kind is `plan` or `review` per the dev-write-change / dev-review-change
// canonical paths declared in their SKILL.md outputs sections.
async function loadFileRefByConvention(
  domain: string | null,
  changeId: string | null,
  kind: 'plan' | 'review',
): Promise<FileRef | null> {
  if (!domain || !changeId) return null;
  const convPath = `vault/output/${domain}/changes/${changeId}-${kind}.md`;
  return loadFileRef(convPath);
}

// ---------------------------------------------------------------------------
// Lifecycle + activity timeline (per-change visualization)
// ---------------------------------------------------------------------------

// StageStatus, LifecycleStage, RelatedEntities — moved to ./changes.types.ts.
// EventRow, STAGE_DEFS, computeLifecycle — moved to ../lib/lifecycle-state.ts
// (the single lifecycle-derivation module; Finding 4.3).

// lookupLinkedReview + ReviewLookup are extracted to pr-review-lookup.ts so
// the change-automation orchestrator (automation.ts) can reuse them without
// importing this route module — see Task #427's no-op-loop guard.

// Find the most recent `pr-review-publish` event for a given pr-review entry
// id. The event is stored with `change_id: null` (the publish skill doesn't
// take the owning change as input — it goes by review id), so we have to
// match against `json_extract(raw, '$.args.review')` instead of a normal
// indexed column.
function queryLastPublishTs(reviewId: string): string | null {
  if (!existsSync(EVENTS_DB_PATH)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
    const row = db
      .prepare(`
        SELECT ts FROM events
        WHERE action = 'pr-review-publish'
          AND json_extract(raw, '$.args.review') = ?
        ORDER BY ts DESC
        LIMIT 1
      `)
      .get(reviewId) as { ts: string } | undefined;
    return row?.ts ?? null;
  } catch {
    return null;
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

function queryEventsForChange(changeId: string): EventRow[] {
  if (!existsSync(EVENTS_DB_PATH)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
    const rows = db
      .prepare(`
        SELECT id, ts, kind, action, skill, duration_ms, exit_status, cost_usd
        FROM events
        WHERE change_id = ?
        ORDER BY ts ASC
        LIMIT 500
      `)
      .all(changeId) as Array<{
      id: number;
      ts: string;
      kind: string;
      action: string | null;
      skill: string | null;
      duration_ms: number | null;
      exit_status: string | null;
      cost_usd: number | null;
    }>;
    return rows;
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

// ChangeRollup — moved to ./changes.types.ts.

function buildChangeRollup(events: EventRow[]): ChangeRollup {
  let cost = 0;
  let dur = 0;
  let aiPromptRuns = 0;
  const skillMap = new Map<string, { count: number; cost: number; duration: number }>();
  for (const ev of events) {
    // Only ai-prompt events have billable cost; everything else is audit/sync
    // and contributes zero. Keep the rollup honest.
    if (ev.action === 'ai-prompt') {
      aiPromptRuns += 1;
      if (typeof ev.cost_usd === 'number') cost += ev.cost_usd;
      if (typeof ev.duration_ms === 'number') dur += ev.duration_ms;
      if (ev.skill) {
        const cur = skillMap.get(ev.skill) ?? { count: 0, cost: 0, duration: 0 };
        cur.count += 1;
        cur.cost += ev.cost_usd ?? 0;
        cur.duration += ev.duration_ms ?? 0;
        skillMap.set(ev.skill, cur);
      }
    }
  }
  const bySkill = [...skillMap.entries()]
    .map(([skill, v]) => ({
      skill,
      count: v.count,
      cost_usd: Number(v.cost.toFixed(4)),
      duration_ms: v.duration,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  return {
    cost_usd: Number(cost.toFixed(4)),
    duration_ms: dur,
    skill_count: skillMap.size,
    by_skill: bySkill,
    ai_prompt_runs: aiPromptRuns,
  };
}

// Skills that imply an MCP call. Used to derive `mcps_used` from event history
// since events.db doesn't currently log MCP invocations directly.
const SKILL_TO_MCPS: Record<string, string[]> = {
  'dev-open-pr': ['github'],
  'dev-pr-review': ['github'],
};

function computeRelated(summary: ChangeSummary, events: EventRow[]): RelatedEntities {
  const skillsSet = new Set<string>();
  for (const ev of events) {
    if (ev.skill) skillsSet.add(ev.skill);
  }
  const mcpsSet = new Set<string>();
  for (const skill of skillsSet) {
    for (const mcp of SKILL_TO_MCPS[skill] ?? []) mcpsSet.add(mcp);
  }
  const artifacts: Array<{ kind: string; path: string }> = [];
  if (summary.plan_path) artifacts.push({ kind: 'plan', path: summary.plan_path });
  if (summary.review_path) artifacts.push({ kind: 'review', path: summary.review_path });
  if (summary.pr_url) artifacts.push({ kind: 'pr', path: summary.pr_url });
  return {
    project: summary.project,
    repo: summary.repo,
    parent_change: summary.parent_change,
    skills_used: [...skillsSet].sort(),
    mcps_used: [...mcpsSet].sort(),
    artifacts,
  };
}

// Status ordering for the list view — in-flight states first, terminal last.
// Within each group, more-recent updates sort earlier.
const STATUS_ORDER: Record<string, number> = {
  'in-review': 0,
  'in-progress': 1,
  planning: 2,
  merged: 3,
  abandoned: 4,
};

function compareStatus(a: string | null, b: string | null): number {
  const ai = a && a in STATUS_ORDER ? STATUS_ORDER[a] : 99;
  const bi = b && b in STATUS_ORDER ? STATUS_ORDER[b] : 99;
  return ai - bi;
}

export const changesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/changes?status=in-progress&project=<id> — list changes.
  fastify.get<{ Querystring: { status?: string; project?: string; repo?: string } }>(
    '/',
    async (req) => {
      const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
      const files = await walkMd(wikiDir);
      const statusFilter = req.query.status;
      const projectFilter = req.query.project;
      const repoFilter = req.query.repo;
      const out: ChangeSummary[] = [];

      for (const file of files) {
        let content: string;
        try {
          content = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const { fm, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type !== 'change') continue;
        if (statusFilter && fm.status !== statusFilter) continue;
        if (projectFilter && fm.project !== projectFilter) continue;
        if (repoFilter && fm.repo !== repoFilter) continue;

        out.push(toSummary(fm, file));
      }

      populateRecommendationsTotal(out);

      // In-flight statuses get the rec-index sort within a research report
      // (so the user sees step 1/8, 2/8 … in order). Terminal statuses get
      // pure newest-first by `updated` — recency matters more than the
      // original plan order once work is done.
      const IN_FLIGHT_STATUSES = new Set(['planning', 'in-progress', 'in-review']);
      out.sort((a, b) => {
        const s = compareStatus(a.status, b.status);
        if (s !== 0) return s;
        const bothInFlight =
          a.status &&
          b.status &&
          IN_FLIGHT_STATUSES.has(a.status) &&
          IN_FLIGHT_STATUSES.has(b.status);
        if (
          bothInFlight &&
          a.derived_from_report &&
          a.derived_from_report === b.derived_from_report &&
          a.recommendation_index != null &&
          b.recommendation_index != null
        ) {
          return a.recommendation_index - b.recommendation_index;
        }
        return (b.updated ?? '').localeCompare(a.updated ?? '');
      });

      return { changes: out };
    },
  );

  // GET /api/changes/:id — single change detail (frontmatter summary + body + full content for EditableMarkdown).
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const changeId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const { fm, body, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type === 'change' && fm.id === changeId) {
          const summary = toSummary(fm, file);
          populateRecommendationsTotal([summary]);
          // Load plan + review file refs in parallel. Two-stage lookup per
          // artifact: prefer the explicit frontmatter path, then fall back
          // to the canonical convention path. This rescues the case where
          // a skill wrote the file but failed to stamp plan_path/review_path
          // back into frontmatter (e.g. errored mid-procedure after the
          // file landed). Without the fallback, the Plan/Review tabs would
          // show empty even though the file exists on disk.
          const [plan, review] = await Promise.all([
            (async () =>
              (await loadFileRef(summary.plan_path)) ||
              (await loadFileRefByConvention(summary.domain, summary.id, 'plan')))(),
            (async () =>
              (await loadFileRef(summary.review_path)) ||
              (await loadFileRefByConvention(summary.domain, summary.id, 'review')))(),
          ]);
          // Detect template placeholder text — same check the audit + the
          // dev-write-change PLAN phase gate use. When true, the dashboard
          // shows a yellow warning prompting the user to fill in the body.
          //
          // Two distinct unreviewed-content modes (both block dev-write-change):
          //   - placeholders: template stubs that the user has to actively
          //     replace with real content. No one-click fix.
          //   - DRAFT markers: `> **DRAFT** — review and refine...` blockquotes
          //     inserted by dev-add-change's auto-draft step. The content
          //     under them IS the proposed draft; accepting just means
          //     stripping the marker blockquotes. One-click via the new
          //     POST /:id/accept-drafts endpoint.
          const lowerBody = body.toLowerCase();
          const bodyHasPlaceholders =
            lowerBody.includes("what's broken / what's missing / what we're improving") ||
            lowerBody.includes(
              'how you plan to do it. touched files, key functions, test strategy',
            );
          const draftMarkerCount = (body.match(/\*\*DRAFT\*\*/g) || []).length;
          // Events.db rows tagged with this change_id. Powers the activity
          // timeline + lets the lifecycle stepper backfill stage timestamps
          // when frontmatter doesn't carry them (e.g. EXECUTE phase).
          const events = changeId ? queryEventsForChange(changeId) : [];
          const lifecycle = computeLifecycle(summary, plan, review, events);
          const related = computeRelated(summary, events);
          // Phase 5 — count comments on the latest pass of the linked
          // pr-review that dev-write-change would address on a re-run.
          // Also surface publish state (frontmatter `published: true`) +
          // any github_review_id captured on a comment header so the
          // PrReviewSummaryCard can render a "Published to GitHub" deep link.
          const reviewLookup = summary.pr_review_path
            ? lookupLinkedReview(summary.pr_review_path)
            : {
                commentsToAddress: 0,
                reviewPublished: false,
                reviewGithubReviewId: null,
                untriagedCount: 0,
              };
          // Extract the review id from the path and look up the most recent
          // publish event's timestamp. The change frontmatter already carries
          // pr_review_path (e.g. vault/wiki/development/pr-review/<id>.md);
          // strip the dir + .md to get the id.
          const reviewId = summary.pr_review_path
            ?.replace(/^vault\/wiki\/development\/pr-review\//, '')
            .replace(/\.md$/, '');
          const reviewPublishedAt =
            reviewLookup.reviewPublished && reviewId ? queryLastPublishTs(reviewId) : null;
          return {
            change: summary,
            body,
            // Full file content (frontmatter + body) so the frontend can hand
            // it to EditableMarkdown directly for in-place editing.
            content,
            // Plan and review artifacts — null when the corresponding file
            // doesn't exist yet (still in PLAN-pending or REVIEW-pending state).
            plan,
            review,
            body_has_placeholders: bodyHasPlaceholders,
            body_draft_marker_count: draftMarkerCount,
            lifecycle,
            events,
            related,
            rollup: buildChangeRollup(events),
            comments_to_address: reviewLookup.commentsToAddress,
            untriaged_comments: reviewLookup.untriagedCount,
            pr_review_published: reviewLookup.reviewPublished,
            pr_review_github_review_id: reviewLookup.reviewGithubReviewId,
            pr_review_published_at: reviewPublishedAt,
          };
        }
      } catch {
        /* skip */
      }
    }
    reply.code(404);
    return { ok: false, error: `change "${changeId}" not found` };
  });

  // GET /api/changes/:id/replay — chronological "autobiography" of a change.
  // Merges events (events.db), runs (runs table), git commits (from the
  // change's branch in the linked repo's local_path), and lifecycle stage
  // entries into one sorted timeline. Powers the Replay tab so every kind
  // of audit trail is reachable from one surface.
  fastify.get<{ Params: { id: string } }>('/:id/replay', async (req, reply) => {
    const changeId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    // biome-ignore lint/suspicious/noExplicitAny: frontmatter shape
    let changeFm: any = null;
    for (const file of files) {
      try {
        const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
        if (parseError) continue;
        if (fm.type === 'change' && fm.id === changeId) {
          changeFm = fm;
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (!changeFm) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const repoId = typeof changeFm.repo === 'string' ? changeFm.repo : null;
    const branch = typeof changeFm.branch === 'string' ? changeFm.branch : null;

    // Resolve repo entity for local_path/default_branch (so we can git-log).
    let localPath: string | null = null;
    let defaultBranch: string | null = null;
    if (repoId) {
      for (const file of files) {
        try {
          const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
          if (parseError) continue;
          if (fm.type !== 'entity' || fm.kind !== 'repo' || fm.id !== repoId) continue;
          if (typeof fm.local_path === 'string') localPath = fm.local_path;
          if (typeof fm.default_branch === 'string') defaultBranch = fm.default_branch;
          break;
        } catch {
          /* skip */
        }
      }
    }

    const events = queryEventsForChange(changeId);
    const rollup = buildChangeRollup(events);

    // Pull runs for this change. Read-only query into events.db's `runs`.
    interface ReplayRunRef {
      id: string;
      started_at: string;
      ended_at: string | null;
      state: string;
      exit_status: number | null;
      duration_ms: number | null;
      skill: string | null;
      title: string | null;
      cost_usd: number | null;
      tokens_in: number | null;
      tokens_out: number | null;
      model: string | null;
      output_path: string | null;
    }
    let runs: ReplayRunRef[] = [];
    if (existsSync(EVENTS_DB_PATH)) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
        runs = db
          .prepare(`
            SELECT id, started_at, ended_at, state, exit_status, duration_ms,
                   skill, title, cost_usd, tokens_in, tokens_out, model, output_path
              FROM runs
             WHERE change_id = ?
             ORDER BY started_at ASC
          `)
          .all(changeId) as unknown as ReplayRunRef[];
      } catch {
        runs = [];
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

    // Git commits on the change's branch (the commits that are on
    // `<branch>` but not on `default_branch`). Best-effort — silently
    // returns empty if the repo isn't a git repo or the branch is gone.
    interface ReplayCommit {
      sha: string;
      short_sha: string;
      subject: string;
      author: string;
      ts: string;
      body: string;
    }
    const commits: ReplayCommit[] = [];
    if (localPath && branch && defaultBranch) {
      try {
        const { spawnSync } = await import('node:child_process');
        // Use a unit separator the parser splits on. body comes last
        // because it can contain newlines.
        const SEP = '\x1f';
        const REC = '\x1e';
        const fmt = ['%H', '%h', '%s', '%an', '%aI', '%b'].join(SEP);
        // Once a feature branch is merged into default_branch, the range
        // `default..branch` becomes empty (commits are now on default too).
        // For merged changes, fall back to a bounded log of the branch
        // itself — still shows the commits the change produced.
        // Once a feature branch is merged into default_branch, the range
        // `default..branch` becomes empty. For merged changes we fall
        // back to `<branch> --since <change.created>` — keeps the output
        // bounded to the change's lifetime rather than dumping unrelated
        // repo history.
        const isMerged = changeFm.status === 'merged';
        // js-yaml turns bare ISO timestamps into Date objects, so a naive
        // typeof check returns null. asISOString coerces both forms.
        const created = asISOString(changeFm.created);
        const range = isMerged
          ? [branch, '-n', '20', ...(created ? ['--since', created] : [])]
          : [`${defaultBranch}..${branch}`];
        const r = spawnSync('git', ['-C', localPath, 'log', `--format=${fmt}${REC}`, ...range], {
          encoding: 'utf8',
        });
        if (r.status === 0) {
          for (const raw of r.stdout.split(REC)) {
            const line = raw.replace(/^\n+/, '').trim();
            if (!line) continue;
            const parts = line.split(SEP);
            if (parts.length < 5) continue;
            commits.push({
              sha: parts[0],
              short_sha: parts[1],
              subject: parts[2],
              author: parts[3],
              ts: parts[4],
              body: (parts[5] ?? '').trim(),
            });
          }
        }
      } catch {
        /* best-effort — leave empty */
      }
    }

    // Stage transitions — derived from the lifecycle stepper's `at`
    // timestamps. Re-uses computeLifecycle for one source of truth.
    const summary = toSummary(changeFm, '');
    const plan = await loadFileRef(changeFm.plan_path ?? null);
    const review = await loadFileRef(changeFm.review_path ?? null);
    const lifecycle = computeLifecycle(summary, plan, review, events);
    const stageTransitions = lifecycle
      .filter((s) => s.status === 'done' && s.at)
      .map((s) => ({ stage: s.id, label: s.label, at: s.at, via: s.via }));

    // Unified timeline. Each entry has a `ts` (string ISO), a `kind`, and
    // payload-specific fields. Sorted ascending. Lifecycle entries get a
    // special kind so the UI can render section dividers.
    interface TimelineEntry {
      ts: string;
      kind: 'stage' | 'event' | 'commit';
      // Pull-through payloads — typed loosely; the client narrows on kind.
      stage?: { id: string; label: string; via: string | null };
      event?: {
        id: number;
        action: string | null;
        skill: string | null;
        duration_ms: number | null;
        exit_status: string | null;
        cost_usd: number | null;
        // When the event has a matching run (action='ai-prompt' with
        // matching ts), attach the run id so the client can jump to
        // /processes#<run-id>.
        run_id: string | null;
      };
      commit?: ReplayCommit;
    }
    const timeline: TimelineEntry[] = [];
    for (const s of stageTransitions) {
      if (!s.at) continue;
      timeline.push({
        ts: s.at,
        kind: 'stage',
        stage: { id: s.stage, label: s.label, via: s.via },
      });
    }
    // Build a ts → run_id lookup so events get linked to their run.
    const runByTs = new Map<string, string>();
    for (const r of runs) runByTs.set(r.started_at, r.id);
    for (const ev of events) {
      timeline.push({
        ts: ev.ts,
        kind: 'event',
        event: {
          id: ev.id,
          action: ev.action,
          skill: ev.skill,
          duration_ms: ev.duration_ms,
          exit_status: ev.exit_status,
          cost_usd: ev.cost_usd,
          run_id: runByTs.get(ev.ts) ?? null,
        },
      });
    }
    for (const c of commits) {
      timeline.push({ ts: c.ts, kind: 'commit', commit: c });
    }
    timeline.sort((a, b) => a.ts.localeCompare(b.ts));

    return {
      ok: true,
      change_id: changeId,
      rollup,
      stage_transitions: stageTransitions,
      runs,
      commits,
      timeline,
    };
  });

  // ─── Live PR + CI fetch ──────────────────────────────────────────────────
  // GET /api/changes/:id/pr — fetches the PR + check runs + commit statuses
  // for the change's pr_url. Always fresh; no cache. Used by the dashboard's
  // "Pull request" tab (manual refresh) and as a smoke test for the auth path.
  // The runbook-pr-ci-monitor uses a different code path (LLM + the github
  // MCP) but consumes the same GitHub data; they're complementary.
  fastify.get<{ Params: { id: string } }>('/:id/pr', async (req, reply) => {
    const changeId = req.params.id;
    // Find the change entry by id (same walk as /:id; small enough to repeat).
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    let foundFm: { [k: string]: unknown } | null = null;
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const { fm, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type === 'change' && fm.id === changeId) {
          foundFm = fm as { [k: string]: unknown };
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (!foundFm) {
      reply.code(404);
      const err: PrErrorResponse = {
        ok: false,
        reason: 'not-found',
        error: `change "${changeId}" not found`,
      };
      return err;
    }
    const prUrl = typeof foundFm.pr_url === 'string' ? foundFm.pr_url : null;
    if (!prUrl) {
      const err: PrErrorResponse = {
        ok: false,
        reason: 'no-pr-url',
        error: 'change has no pr_url set',
        hint: 'Run /os open-pr to create the PR first.',
      };
      return err;
    }
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      const err: PrErrorResponse = {
        ok: false,
        reason: 'parse-failed',
        error: `Could not parse owner/repo/number from pr_url: ${prUrl}`,
      };
      return err;
    }
    const octokit = getOctokit();
    if (!octokit) {
      const err: PrErrorResponse = {
        ok: false,
        reason: 'no-token',
        error: 'GitHub PAT not configured',
        hint: 'Copy mcps/github/.env.example to mcps/github/.env, paste a PAT, then restart the dashboard.',
      };
      reply.code(503);
      return err;
    }
    const { owner, repo, pull_number } = parsed;
    let pr: Awaited<ReturnType<typeof octokit.pulls.get>>['data'];
    try {
      ({ data: pr } = await octokit.pulls.get({ owner, repo, pull_number }));
    } catch (e) {
      const err: PrErrorResponse = {
        ok: false,
        reason: 'github-error',
        error: `GitHub PR fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        hint: 'Verify the PAT has access to this repo + the PR exists.',
      };
      reply.code(502);
      return err;
    }
    // Fetch check runs + commit statuses for the head SHA in parallel.
    const ref = pr.head?.sha ?? '';
    let checks: { check_runs?: Array<Record<string, unknown>> } = { check_runs: [] };
    let statuses: Array<Record<string, unknown>> = [];
    if (ref) {
      try {
        const [c, s] = await Promise.all([
          octokit.checks.listForRef({ owner, repo, ref }),
          octokit.repos.listCommitStatusesForRef({ owner, repo, ref }),
        ]);
        checks = c.data;
        statuses = s.data;
      } catch {
        // Don't fail the whole response — return PR data without checks.
      }
    }
    const runs: PrCheckRun[] = [];
    for (const c of checks.check_runs ?? []) {
      runs.push({
        name: String(c.name ?? ''),
        status: c.status as string | null,
        conclusion: c.conclusion as string | null,
        url: (c.html_url as string | null) ?? null,
        source: 'check_run',
      });
    }
    for (const s of statuses) {
      const state = s.state as string;
      runs.push({
        name: String(s.context ?? ''),
        status: state === 'pending' ? 'in_progress' : 'completed',
        conclusion: state === 'success' ? 'success' : state === 'failure' ? 'failure' : state,
        url: (s.target_url as string | null) ?? null,
        source: 'commit_status',
      });
    }
    const by_state = {
      success: 0,
      failure: 0,
      in_progress: 0,
      queued: 0,
      neutral: 0,
      other: 0,
    };
    for (const r of runs) {
      if (r.status === 'in_progress') by_state.in_progress += 1;
      else if (r.status === 'queued') by_state.queued += 1;
      else if (r.conclusion === 'success') by_state.success += 1;
      else if (
        r.conclusion === 'failure' ||
        r.conclusion === 'cancelled' ||
        r.conclusion === 'timed_out'
      )
        by_state.failure += 1;
      else if (r.conclusion === 'neutral' || r.conclusion === 'skipped') by_state.neutral += 1;
      else by_state.other += 1;
    }
    // Aggregate state: in_progress|queued > 0 → running; failure > 0 → fail;
    // total === 0 → none; else → pass. Mirrors the skill's logic so
    // dashboard + runbook + skill all use the same buckets.
    let ciState: 'pass' | 'fail' | 'running' | 'none' = 'none';
    if (runs.length === 0) ciState = 'none';
    else if (by_state.in_progress > 0 || by_state.queued > 0) ciState = 'running';
    else if (by_state.failure > 0) ciState = 'fail';
    else ciState = 'pass';

    const ok: PrDetailResponse = {
      ok: true,
      pr: {
        number: pr.number,
        url: pr.html_url,
        state: pr.state,
        merged: pr.merged ?? false,
        draft: pr.draft ?? false,
        mergeable: pr.mergeable ?? null,
        title: pr.title,
        body: pr.body ?? null,
        user_login: pr.user?.login ?? null,
        head_ref: pr.head?.ref ?? null,
        head_sha: pr.head?.sha ?? null,
        base_ref: pr.base?.ref ?? null,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: pr.merged_at ?? null,
      },
      ci: { state: ciState, total: runs.length, by_state, runs },
      fetched_at: new Date().toISOString(),
    };
    return ok;
  });

  // ─── Manual PR sync — fetches GitHub state AND writes back to frontmatter ──
  // POST /api/changes/:id/pr/sync — used by the dashboard's Refresh button
  // when the user wants to push fresh GitHub state into the wiki manifest
  // (e.g. after CI was re-triggered by a force-push). The scheduler-driven
  // runbook-pr-ci-monitor has a STRICT filter (only polls non-conclusive CI)
  // to keep cost bounded; this endpoint is the human-initiated bypass.
  //
  // Same fetch logic as GET /:id/pr, plus: compare with current frontmatter,
  // write back when state diverges, log via events.db with source=dashboard-sync.
  // POST /api/changes/:id/accept-drafts — one-click resolution for the
  // dev-add-change auto-draft pattern. Strips every `> **DRAFT** — ...`
  // blockquote line (and a single trailing blank line) from the body,
  // leaving the actual draft content intact. dev-write-change's PLAN-phase
  // gate then proceeds normally on the accepted content.
  //
  // Idempotent: calling on a change with no DRAFT markers returns ok with
  // `removed: 0` and doesn't touch the file.
  fastify.post<{ Params: { id: string } }>('/:id/accept-drafts', async (req, reply) => {
    const changeId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const { fm, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type !== 'change' || fm.id !== changeId) continue;
        // Strip `> **DRAFT** — ...` lines (with optional trailing blank line).
        // The regex is anchored to line start (multiline flag) so we never
        // accidentally clip mid-line content. We also drop ONE blank line
        // after each marker so the output doesn't accumulate orphan blanks.
        const draftLineRe = /^> \*\*DRAFT\*\* — [^\n]*\n(?:\n)?/gm;
        const newContent = content.replace(draftLineRe, '');
        const removed = (content.match(draftLineRe) || []).length;
        if (removed === 0) {
          return { ok: true, removed: 0, message: 'no DRAFT markers found' };
        }
        await writeFile(file, newContent);
        return {
          ok: true,
          removed,
          message: `Stripped ${removed} DRAFT marker(s). The auto-drafted content is now accepted; run /os write-change to plan.`,
        };
      } catch {
        /* skip and continue searching */
      }
    }
    reply.code(404);
    return { ok: false, error: `change "${changeId}" not found` };
  });

  // POST /api/changes/:id/close-local — vault-only change closure for work
  // done inline without a PR (typically OS-internal changes against the
  // agentic-os repo, which has no remote). Flips status → merged, stamps
  // merged_at + updated, records an audit event. Refuses when pr_url is set
  // (use dev-close-change in that case so GitHub state stays consistent) and
  // when status is already 'merged' / 'abandoned' (returns ok with
  // already_closed:true).
  fastify.post<{ Params: { id: string } }>('/:id/close-local', async (req, reply) => {
    const changeId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    let foundFile: string | null = null;
    let foundContent: string | null = null;
    let foundFm: Record<string, unknown> | null = null;
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const { fm, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type === 'change' && fm.id === changeId) {
          foundFile = file;
          foundContent = content;
          foundFm = fm as Record<string, unknown>;
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (!foundFile || !foundContent || !foundFm) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const currentStatus = typeof foundFm.status === 'string' ? foundFm.status : null;
    if (currentStatus === 'merged' || currentStatus === 'abandoned') {
      return { ok: true, already_closed: true, status: currentStatus };
    }
    const prUrl = typeof foundFm.pr_url === 'string' ? foundFm.pr_url : null;
    if (prUrl) {
      reply.code(409);
      return {
        ok: false,
        error:
          'This change has a pr_url — close it through dev-close-change so GitHub state stays consistent. close-local is only for inline work that never opened a PR.',
        pr_url: prUrl,
      };
    }
    const nowIso = new Date().toISOString();
    const updated = updateFrontmatterFields(foundContent, {
      status: 'merged',
      merged_at: nowIso,
      updated: nowIso,
    });
    try {
      await writeFile(foundFile, updated, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }

    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'change-close-local',
          '--args',
          JSON.stringify({
            change: changeId,
            prev_status: currentStatus,
            reason: 'inline-no-pr',
          }),
          '--files-touched',
          JSON.stringify([relative(REPO_ROOT, foundFile)]),
          '--exit-status',
          '0',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    } catch {
      /* best-effort */
    }

    return {
      ok: true,
      status: 'merged',
      merged_at: nowIso,
      prev_status: currentStatus,
    };
  });

  // POST /api/changes/:id/abandon — vault-only abandonment. Flips status →
  // abandoned, stamps abandoned_at + abandoned_reason, appends an `## Abandoned`
  // section to the body with the reason. When the change is research-derived
  // (derived_from_report set), also updates the source research-report's
  // recommended_changes[<index>].status: scaffolded → abandoned and stamps
  // recommended_changes[<index>].abandoned_reason so the audit drift-check
  // doesn't fire and the report's recommended-changes table reflects reality.
  // Refuses when status is already terminal (merged / abandoned).
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/abandon',
    async (req, reply) => {
      const changeId = req.params.id;
      const reason = (req.body?.reason ?? '').trim();
      if (!reason) {
        reply.code(400);
        return { ok: false, error: 'reason is required (non-empty string)' };
      }
      const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
      const files = await walkMd(wikiDir);

      // Find the change file.
      let changeFile: string | null = null;
      let changeContent: string | null = null;
      let changeFm: Record<string, unknown> | null = null;
      for (const file of files) {
        try {
          const content = await readFile(file, 'utf8');
          const { fm, parseError } = parseFrontmatter(content);
          if (parseError) continue;
          if (fm.type === 'change' && fm.id === changeId) {
            changeFile = file;
            changeContent = content;
            changeFm = fm as Record<string, unknown>;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (!changeFile || !changeContent || !changeFm) {
        reply.code(404);
        return { ok: false, error: `change "${changeId}" not found` };
      }
      const currentStatus = typeof changeFm.status === 'string' ? changeFm.status : null;
      if (currentStatus === 'merged' || currentStatus === 'abandoned') {
        return { ok: true, already_terminal: true, status: currentStatus };
      }
      const nowIso = new Date().toISOString();

      // 1. Update change frontmatter + append `## Abandoned` body section.
      let updated = updateFrontmatterFields(changeContent, {
        status: 'abandoned',
        abandoned_at: nowIso,
        // Quote the reason so YAML preserves it as a single string even if
        // the user writes prose with colons / quotes. Strip embedded
        // double-quotes to keep the YAML safe.
        abandoned_reason: `"${reason.replace(/"/g, "'")}"`,
        updated: nowIso,
      });
      // Append the prose section. Idempotent-ish: if the body already ends
      // with `## Abandoned`, leave a blank line separator before adding;
      // otherwise add fresh.
      const abandonSection = `\n## Abandoned\n\nMarked abandoned ${nowIso}.\n\n**Reason:** ${reason}\n`;
      updated = `${updated.replace(/\n*$/, '\n')}${abandonSection}`;
      try {
        await writeFile(changeFile, updated, 'utf8');
      } catch (e) {
        reply.code(500);
        return { ok: false, error: `write failed: ${(e as Error).message}` };
      }

      // 2. If research-derived, update the source report's
      // recommended_changes[index].status + .abandoned_reason.
      const reportId =
        typeof changeFm.derived_from_report === 'string' ? changeFm.derived_from_report : null;
      const recIndex =
        typeof changeFm.recommendation_index === 'number' ? changeFm.recommendation_index : null;
      let reportTouched = false;
      if (reportId && recIndex != null) {
        for (const file of files) {
          try {
            const content = await readFile(file, 'utf8');
            const { fm, parseError } = parseFrontmatter(content);
            if (parseError) continue;
            if (fm.type === 'research-report' && fm.id === reportId) {
              // Surgically patch the Nth recommended_changes entry's
              // `status:` line. The block looks like:
              //   recommended_changes:
              //     - id: ...
              //       summary: ...
              //       status: scaffolded   ← target the Nth occurrence
              // We find each item by counting `^  - ` lines under the
              // `recommended_changes:` key, find the Nth one, then update
              // its `status:` line and inject an `abandoned_reason:` line.
              const m = content.match(/(\nrecommended_changes:\n)([\s\S]*?)(\n(?:[a-z_]+:|---))/);
              if (m) {
                const block = m[2];
                // Split on top-level `  - ` (two-space indent + dash).
                const items = block.split(/(?=^ {2}- )/m);
                if (items.length > recIndex) {
                  let item = items[recIndex];
                  // Replace `status: <anything>` with `status: abandoned`.
                  item = item.replace(/(\n {4}status:\s*)\S+/, '$1abandoned');
                  // Add abandoned_reason if not already present.
                  if (!/\n {4}abandoned_reason:/.test(item)) {
                    // Insert before the next item boundary (the trailing
                    // newline of this item).
                    item = item.replace(
                      /(\n)$/,
                      `\n    abandoned_reason: "${reason.replace(/"/g, "'")}"$1`,
                    );
                  }
                  items[recIndex] = item;
                  const newBlock = items.join('');
                  const newContent = content.replace(
                    /(\nrecommended_changes:\n)[\s\S]*?(\n(?:[a-z_]+:|---))/,
                    `$1${newBlock}$2`,
                  );
                  // Bump report's `updated` timestamp too.
                  const bumped = newContent.replace(/^(updated:\s*)\S+/m, `$1${nowIso}`);
                  await writeFile(file, bumped, 'utf8');
                  reportTouched = true;
                }
              }
              break;
            }
          } catch {
            /* skip */
          }
        }
      }

      // 3. Best-effort audit event.
      try {
        const { spawnSync } = await import('node:child_process');
        spawnSync(
          'node',
          [
            join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
            '--action',
            'change-abandon',
            '--args',
            JSON.stringify({
              change: changeId,
              prev_status: currentStatus,
              reason,
              report_id: reportId,
              recommendation_index: recIndex,
              report_touched: reportTouched,
            }),
            '--files-touched',
            JSON.stringify([relative(REPO_ROOT, changeFile)]),
            '--exit-status',
            '0',
          ],
          { cwd: REPO_ROOT, stdio: 'ignore' },
        );
      } catch {
        /* best-effort */
      }

      return {
        ok: true,
        status: 'abandoned',
        abandoned_at: nowIso,
        prev_status: currentStatus,
        report_touched: reportTouched,
      };
    },
  );

  // POST /api/changes/:id/push — push the change's branch to origin. Manual
  // escape hatch for cases where dev-write-change's auto-push (in EXECUTE /
  // ADDRESS-COMMENTS phases) failed, or when the user made out-of-band
  // commits and wants them on GitHub. Refuses to push when pr_url is null —
  // the first push goes through dev-open-pr so the PR row is created server-
  // side; this endpoint is strictly for follow-up pushes.
  fastify.post<{ Params: { id: string } }>('/:id/push', async (req, reply) => {
    const changeId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);

    // Locate change + repo entity in a single walk.
    let changeFm: Record<string, unknown> | null = null;
    let changeFile: string | null = null;
    let repoEntityFm: Record<string, unknown> | null = null;
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type === 'change' && fm.id === changeId) {
        changeFm = fm as Record<string, unknown>;
        changeFile = file;
      } else if (fm.type === 'entity' && fm.kind === 'repo' && typeof fm.id === 'string') {
        // Keep all repo entities indexed by id — we resolve after we know the change's repo.
        // (Stored on a Map below to avoid quadratic walks.)
      }
    }
    if (!changeFm || !changeFile) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }

    const prUrl = typeof changeFm.pr_url === 'string' ? changeFm.pr_url : null;
    if (!prUrl) {
      reply.code(409);
      return {
        ok: false,
        error:
          'No PR exists for this change yet. The first push goes through /os open-pr, which creates the GitHub PR. This endpoint only handles follow-up pushes.',
      };
    }
    const repoId = typeof changeFm.repo === 'string' ? changeFm.repo : null;
    const branch = typeof changeFm.branch === 'string' ? changeFm.branch : null;
    if (!repoId || !branch) {
      reply.code(400);
      return {
        ok: false,
        error: `change "${changeId}" is missing repo or branch — frontmatter is malformed`,
      };
    }

    // Resolve repo entity → local_path.
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type === 'entity' && fm.kind === 'repo' && fm.id === repoId) {
        repoEntityFm = fm as Record<string, unknown>;
        break;
      }
    }
    if (!repoEntityFm) {
      reply.code(404);
      return { ok: false, error: `repo entity "${repoId}" not found` };
    }
    const localPath = typeof repoEntityFm.local_path === 'string' ? repoEntityFm.local_path : null;
    if (!localPath) {
      reply.code(400);
      return { ok: false, error: `repo "${repoId}" has no local_path` };
    }

    // Spawn git push. Don't shell-out via /bin/sh — pass args directly so
    // branch + path can't be interpreted as flags / metacharacters.
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn('git', ['-C', localPath, 'push', 'origin', branch]);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b: Buffer) => {
          stdout += b.toString('utf8');
        });
        child.stderr.on('data', (b: Buffer) => {
          stderr += b.toString('utf8');
        });
        child.on('close', (code) => {
          resolve({ code: code ?? -1, stdout, stderr });
        });
        child.on('error', (err) => {
          resolve({ code: -1, stdout: '', stderr: err.message });
        });
      },
    );

    // Audit event — best-effort.
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'change-push',
          '--args',
          JSON.stringify({ change: changeId, repo: repoId, branch, exit_code: result.code }),
          '--files-touched',
          JSON.stringify([relative(REPO_ROOT, changeFile)]),
          '--exit-status',
          String(result.code),
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    } catch {
      /* best-effort */
    }

    if (result.code !== 0) {
      reply.code(500);
      return {
        ok: false,
        error: `git push failed (exit ${result.code})`,
        stderr: result.stderr.trim(),
        stdout: result.stdout.trim(),
      };
    }
    // Bump change's `updated` timestamp so the UI sees the activity. Don't
    // touch status/branch/pr_url — those are still authoritative.
    try {
      const cur = await readFile(changeFile, 'utf8');
      const nowIso = new Date().toISOString();
      const bumped = cur.replace(/^(updated:\s*)\S+/m, `$1${nowIso}`);
      if (bumped !== cur) await writeFile(changeFile, bumped, 'utf8');
    } catch {
      /* best-effort */
    }
    return {
      ok: true,
      branch,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    };
  });

  fastify.post<{ Params: { id: string } }>('/:id/pr/sync', async (req, reply) => {
    const changeId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    let foundPath: string | null = null;
    let foundFm: { [k: string]: unknown } | null = null;
    let foundContent: string | null = null;
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const { fm, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type === 'change' && fm.id === changeId) {
          foundFm = fm as { [k: string]: unknown };
          foundPath = file;
          foundContent = content;
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (!foundFm || !foundPath || !foundContent) {
      reply.code(404);
      const err: PrErrorResponse = {
        ok: false,
        reason: 'not-found',
        error: `change "${changeId}" not found`,
      };
      return err;
    }
    const prUrl = typeof foundFm.pr_url === 'string' ? foundFm.pr_url : null;
    if (!prUrl) {
      const err: PrErrorResponse = {
        ok: false,
        reason: 'no-pr-url',
        error: 'change has no pr_url set',
        hint: 'Run /os open-pr to create the PR first.',
      };
      return err;
    }
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      const err: PrErrorResponse = {
        ok: false,
        reason: 'parse-failed',
        error: `Could not parse owner/repo/number from pr_url: ${prUrl}`,
      };
      return err;
    }
    const octokit = getOctokit();
    if (!octokit) {
      reply.code(503);
      const err: PrErrorResponse = {
        ok: false,
        reason: 'no-token',
        error: 'GitHub PAT not configured',
        hint: 'Copy mcps/github/.env.example to mcps/github/.env, paste a PAT, then restart the dashboard.',
      };
      return err;
    }
    const { owner, repo, pull_number } = parsed;
    let pr: Awaited<ReturnType<typeof octokit.pulls.get>>['data'];
    try {
      ({ data: pr } = await octokit.pulls.get({ owner, repo, pull_number }));
    } catch (e) {
      reply.code(502);
      const err: PrErrorResponse = {
        ok: false,
        reason: 'github-error',
        error: `GitHub PR fetch failed: ${e instanceof Error ? e.message : String(e)}`,
        hint: 'Verify the PAT has access to this repo + the PR exists.',
      };
      return err;
    }
    const ref = pr.head?.sha ?? '';
    let checks: { check_runs?: Array<Record<string, unknown>> } = { check_runs: [] };
    let statuses: Array<Record<string, unknown>> = [];
    if (ref) {
      try {
        const [c, s] = await Promise.all([
          octokit.checks.listForRef({ owner, repo, ref }),
          octokit.repos.listCommitStatusesForRef({ owner, repo, ref }),
        ]);
        checks = c.data;
        statuses = s.data;
      } catch {
        /* leave checks empty */
      }
    }
    const runs: PrCheckRun[] = [];
    for (const c of checks.check_runs ?? []) {
      runs.push({
        name: String(c.name ?? ''),
        status: c.status as string | null,
        conclusion: c.conclusion as string | null,
        url: (c.html_url as string | null) ?? null,
        source: 'check_run',
      });
    }
    for (const s of statuses) {
      const state = s.state as string;
      runs.push({
        name: String(s.context ?? ''),
        status: state === 'pending' ? 'in_progress' : 'completed',
        conclusion: state === 'success' ? 'success' : state === 'failure' ? 'failure' : state,
        url: (s.target_url as string | null) ?? null,
        source: 'commit_status',
      });
    }
    const by_state = {
      success: 0,
      failure: 0,
      in_progress: 0,
      queued: 0,
      neutral: 0,
      other: 0,
    };
    for (const r of runs) {
      if (r.status === 'in_progress') by_state.in_progress += 1;
      else if (r.status === 'queued') by_state.queued += 1;
      else if (r.conclusion === 'success') by_state.success += 1;
      else if (
        r.conclusion === 'failure' ||
        r.conclusion === 'cancelled' ||
        r.conclusion === 'timed_out'
      )
        by_state.failure += 1;
      else if (r.conclusion === 'neutral' || r.conclusion === 'skipped') by_state.neutral += 1;
      else by_state.other += 1;
    }
    let ciState: 'pass' | 'fail' | 'running' | 'none' = 'none';
    if (runs.length === 0) ciState = 'none';
    else if (by_state.in_progress > 0 || by_state.queued > 0) ciState = 'running';
    else if (by_state.failure > 0) ciState = 'fail';
    else ciState = 'pass';

    // ─── Writeback diff ───────────────────────────────────────────────────
    const currentCi = typeof foundFm.ci_state === 'string' ? foundFm.ci_state : null;
    const currentStatus = typeof foundFm.status === 'string' ? foundFm.status : null;
    const currentMergedAt = typeof foundFm.merged_at === 'string' ? foundFm.merged_at : null;
    const nowIso = new Date().toISOString();

    const updates: Record<string, string> = {};
    const transitions: string[] = [];

    if (ciState !== currentCi) {
      updates.ci_state = ciState;
      transitions.push(`ci_state: ${currentCi ?? 'null'} → ${ciState}`);
      // ci_completed_at gets set when transitioning AWAY from running into a
      // conclusive state. Don't set when going back to running (CI re-triggered)
      // or when staying at the same conclusive state.
      const conclusive = ciState === 'pass' || ciState === 'fail' || ciState === 'none';
      const wasInflight = currentCi === null || currentCi === 'running';
      if (conclusive && wasInflight) {
        updates.ci_completed_at = nowIso;
      }
    }
    if (pr.merged === true && currentStatus === 'in-review') {
      updates.status = 'merged';
      updates.merged_at = pr.merged_at ?? nowIso;
      transitions.push(`status: in-review → merged via PR #${pr.number}`);
    } else if (pr.merged === true && !currentMergedAt && pr.merged_at) {
      // status already merged but merged_at missing (manual transition) — fill it
      updates.merged_at = pr.merged_at;
      transitions.push('merged_at backfilled');
    }
    if (Object.keys(updates).length > 0) {
      updates.updated = nowIso;
      const newContent = updateFrontmatterFields(foundContent, updates);
      await writeFile(foundPath, newContent, 'utf8');
    }

    // Log via the canonical recordEvent path. source=dashboard-sync
    // distinguishes this from the runbook-driven path (source=cli/skill).
    try {
      // @ts-expect-error — pure-ESM .mjs helper with no .d.ts
      const { recordEvent } = await import('../../../../../scripts/events-db.mjs');
      recordEvent({
        ts: nowIso,
        kind: 'dashboard',
        action: 'pr-ci-poll',
        source: 'dashboard-sync',
        skill: null,
        change_id: changeId,
        status: 'success',
        description:
          transitions.length > 0
            ? transitions.join(', ')
            : 'no changes (frontmatter already current)',
        files_touched: Object.keys(updates).length > 0 ? [relative(REPO_ROOT, foundPath)] : null,
      });
    } catch {
      // Logging is best-effort; the sync itself succeeded.
    }

    const ok: PrDetailResponse & {
      synced: { transitions: string[]; updates_applied: number };
    } = {
      ok: true,
      pr: {
        number: pr.number,
        url: pr.html_url,
        state: pr.state,
        merged: pr.merged ?? false,
        draft: pr.draft ?? false,
        mergeable: pr.mergeable ?? null,
        title: pr.title,
        body: pr.body ?? null,
        user_login: pr.user?.login ?? null,
        head_ref: pr.head?.ref ?? null,
        head_sha: pr.head?.sha ?? null,
        base_ref: pr.base?.ref ?? null,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: pr.merged_at ?? null,
      },
      ci: { state: ciState, total: runs.length, by_state, runs },
      fetched_at: nowIso,
      synced: {
        transitions,
        updates_applied: Object.keys(updates).length,
      },
    };
    return ok;
  });
};
