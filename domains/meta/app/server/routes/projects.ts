import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import { removeFrontmatterFields, rewriteFrontmatter } from '../frontmatter-rewrite.js';
import { parseFrontmatter } from '../frontmatter.js';
import { SKILL } from '../lib/skill-ids.js';
import { REPO_ROOT, safePath } from '../repo.js';
import { readAutomationConfig } from './automation.js';
import { type FileRef, loadFileRef } from './changes.js';
import type {
  BacklinkGroup,
  BacklinkRef,
  ChangeAggregate,
  Milestone,
  OwnedChangeRef,
  ProjectDetail,
  ProjectRollup,
  ProjectScheduleRef,
  ProjectSummary,
  Reporting,
  StatusReportRef,
} from './projects.types.js';
import {
  type ResearchReportSummary,
  findResearchReport,
  listResearchReportsForProject,
} from './research.js';
import { startRun } from './runs.js';
import { type RunEntry, nextRun, readRunLog } from './schedules.js';

// Re-export wire-shape types for any consumer that imports from this route
// module directly. New consumers should prefer `./projects.types.js`.
export type {
  BacklinkGroup,
  BacklinkRef,
  ChangeAggregate,
  Milestone,
  OwnedChangeRef,
  ProjectDetail,
  ProjectRollup,
  ProjectScheduleRef,
  ProjectSummary,
  Reporting,
  StatusReportRef,
} from './projects.types.js';

const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

function buildProjectRollup(projectId: string, ownedChangeIds: string[]): ProjectRollup {
  const empty: ProjectRollup = {
    cost_usd: 0,
    duration_ms: 0,
    skill_count: 0,
    by_skill: [],
    ai_prompt_runs: 0,
    failed_runs: 0,
  };
  if (!existsSync(EVENTS_DB_PATH)) return empty;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
    // SQLite binding doesn't expand arrays; generate (?, ?, …) inline for
    // the IN clause and bind owned-change-ids + projectId positionally.
    const changeClause = ownedChangeIds.length
      ? `OR change_id IN (${ownedChangeIds.map(() => '?').join(',')})`
      : '';
    interface Row {
      skill: string | null;
      n: number;
      cost: number | null;
      dur: number | null;
      failures: number;
    }
    const sql = `
      SELECT skill,
             COUNT(*) AS n,
             SUM(cost_usd) AS cost,
             SUM(duration_ms) AS dur,
             SUM(CASE WHEN exit_status != 0 THEN 1 ELSE 0 END) AS failures
        FROM events
       WHERE action = 'ai-prompt'
         AND (project = ? ${changeClause})
       GROUP BY skill`;
    const rows = db.prepare(sql).all(projectId, ...ownedChangeIds) as unknown as Row[];

    let cost = 0;
    let dur = 0;
    let runs = 0;
    let failed = 0;
    const bySkill: ProjectRollup['by_skill'] = [];
    for (const r of rows) {
      runs += r.n;
      cost += r.cost ?? 0;
      dur += r.dur ?? 0;
      failed += r.failures ?? 0;
      if (r.skill) {
        bySkill.push({
          skill: r.skill,
          count: r.n,
          cost_usd: Number((r.cost ?? 0).toFixed(4)),
          duration_ms: r.dur ?? 0,
        });
      }
    }
    bySkill.sort((a, b) => b.cost_usd - a.cost_usd);
    return {
      cost_usd: Number(cost.toFixed(4)),
      duration_ms: dur,
      skill_count: bySkill.length,
      by_skill: bySkill,
      ai_prompt_runs: runs,
      failed_runs: failed,
    };
  } catch {
    return empty;
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

// All wire-shape types moved to ./projects.types.ts (shared with client).
// Re-exported above for backward-compat; new consumers should import from
// ./projects.types.js directly.

// Locate a project entry by id. Walks the wiki tree (small enough to be
// cheap; cache later if the wiki ever grows). Returns the frontmatter +
// absolute path, or null when no entry with the given id and type=project
// exists. Used by every endpoint that takes `:id` so the typo path is
// caught BEFORE any side effect (no orphan dirs, no stray dispatches).
// biome-ignore lint/suspicious/noExplicitAny: frontmatter shape is arbitrary
async function findProjectFrontmatter(
  projectId: string,
  // biome-ignore lint/suspicious/noExplicitAny: yaml shape
): Promise<{ fm: any; path: string } | null> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type === 'project' && fm.id === projectId) {
        return { fm, path: file };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

// Whitelist filename for project-materials drops. Refuses anything outside
// `[A-Za-z0-9._-]`, leading dots, traversal sequences, or path separators.
// safePath() is a second line of defense in the call site.
function sanitizeMaterialFilename(name: string): string | null {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.includes('..')) return null;
  if (name.startsWith('.')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (name.length > 200) return null;
  return name;
}

// Slugify a URL into a filesystem-safe segment for the auto-generated
// `url-<n>-<slug>.md` material filename. Keeps the host + path informative
// without exotic chars.
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

// Fire-and-forget audit event. Uses spawnSync for the same reason the
// existing endpoints do — keeps the response latency stable and survives a
// missing record-dashboard-action.mjs by silently failing.
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

// Convert a raw frontmatter object into the ProjectSummary shape. Defensive:
// missing/malformed fields collapse to nulls/empties rather than throwing.
// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function toSummary(fm: any, filePath: string): ProjectSummary {
  const milestones: Milestone[] = [];
  if (Array.isArray(fm.milestones)) {
    for (const m of fm.milestones) {
      if (!m || typeof m !== 'object') continue;
      // Date handling: js-yaml parses bare ISO/date-only values (e.g. `2026-06-15`)
      // as Date objects, not strings. Quoted values (`"2026-06-15"`) stay strings.
      // Accept both — use asISOString-style normalization. Without this, milestones
      // authored without quotes show `date: null` in the API + status reports.
      let dateStr: string | null = null;
      if (typeof m.date === 'string') {
        dateStr = m.date;
      } else if (m.date instanceof Date && !Number.isNaN(m.date.getTime())) {
        // Render as YYYY-MM-DD only (the typical milestone form, not a timestamp).
        dateStr = m.date.toISOString().slice(0, 10);
      }
      milestones.push({
        date: dateStr,
        label: typeof m.label === 'string' ? m.label : '(no label)',
        status: typeof m.status === 'string' ? m.status : null,
      });
    }
  }
  let reporting: Reporting | null = null;
  if (fm.reporting && typeof fm.reporting === 'object') {
    reporting = {
      cadence: typeof fm.reporting.cadence === 'string' ? fm.reporting.cadence : null,
      target: typeof fm.reporting.target === 'string' ? fm.reporting.target : null,
      target_ref: typeof fm.reporting.target_ref === 'string' ? fm.reporting.target_ref : null,
      last_sent: typeof fm.reporting.last_sent === 'string' ? fm.reporting.last_sent : null,
      next_due: typeof fm.reporting.next_due === 'string' ? fm.reporting.next_due : null,
    };
  }
  // repos can be either an array (canonical) or a single string (legacy);
  // coerce to array of strings so the UI doesn't need both shapes.
  let repos: string[] = [];
  if (Array.isArray(fm.repos)) {
    repos = fm.repos.filter((x: unknown): x is string => typeof x === 'string');
  } else if (typeof fm.repo === 'string') {
    repos = [fm.repo];
  }
  return {
    id: typeof fm.id === 'string' ? fm.id : null,
    path: relative(REPO_ROOT, filePath),
    title: typeof fm.title === 'string' ? fm.title : (fm.id ?? '(untitled)'),
    domain: typeof fm.domain === 'string' ? fm.domain : null,
    status: typeof fm.status === 'string' ? fm.status : null,
    deadline: typeof fm.deadline === 'string' ? fm.deadline : null,
    stakeholders: Array.isArray(fm.stakeholders) ? fm.stakeholders : [],
    lifecycle_stage: typeof fm.lifecycle_stage === 'string' ? fm.lifecycle_stage : null,
    lifecycle_stage_derived: null, // computed once `changes` is attached
    repos,
    milestones,
    reporting,
    changes: null, // populated by the list endpoint after manifest read
    plan_path: typeof fm.plan_path === 'string' ? fm.plan_path : null,
    plan_status: typeof fm.plan_status === 'string' ? fm.plan_status : null,
    review_status: typeof fm.review_status === 'string' ? fm.review_status : null,
    // Derived trio computed in the detail endpoint after research + changes
    // are attached (see ../lib/lifecycle-state.ts).
    plan_status_derived: null,
    review_status_derived: null,
    plan_stage: null,
    plan_revision:
      typeof fm.plan_revision === 'number'
        ? fm.plan_revision
        : typeof fm.plan_revision === 'string' && /^\d+$/.test(fm.plan_revision)
          ? Number.parseInt(fm.plan_revision, 10)
          : null,
    review_path: typeof fm.review_path === 'string' ? fm.review_path : null,
    reviewed_at: asISOString(fm.reviewed_at),
    plan_revised_at: asISOString(fm.plan_revised_at),
    plan_revised_from_review:
      typeof fm.plan_revised_from_review === 'string' ? fm.plan_revised_from_review : null,
    plan_generated_at: asISOString(fm.plan_generated_at),
    research_paths: Array.isArray(fm.research_paths)
      ? fm.research_paths.filter((x: unknown): x is string => typeof x === 'string')
      : [],
    // Surface the automation block when present; null when the project has
    // never been configured for automation. Clients use null as the signal
    // to render the "off" state with no live status info.
    automation: fm.automation ? readAutomationConfig(fm as Record<string, unknown>) : null,
  };
}

// Read the wiki manifest once and build a project-id → ChangeAggregate map.
// Cheap because the manifest now carries type / status / project / updated
// on every entry (see .claude/hooks/rebuild-vault-index.mjs).
async function buildChangeAggregates(): Promise<Map<string, ChangeAggregate>> {
  const path = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  const result = new Map<string, ChangeAggregate>();
  let manifest: {
    entries: Array<{
      type?: string;
      project?: string | null;
      status?: string | null;
      updated?: string | null;
    }>;
  };
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return result;
  }
  for (const e of manifest.entries ?? []) {
    if (e.type !== 'change' || !e.project) continue;
    let agg = result.get(e.project);
    if (!agg) {
      agg = {
        planning: 0,
        in_progress: 0,
        in_review: 0,
        merged: 0,
        abandoned: 0,
        total: 0,
        latest_change_updated: null,
      };
      result.set(e.project, agg);
    }
    agg.total += 1;
    switch (e.status) {
      case 'planning':
        agg.planning += 1;
        break;
      case 'in-progress':
        agg.in_progress += 1;
        break;
      case 'in-review':
        agg.in_review += 1;
        break;
      case 'merged':
        agg.merged += 1;
        break;
      case 'abandoned':
        agg.abandoned += 1;
        break;
    }
    if (e.updated && (!agg.latest_change_updated || e.updated > agg.latest_change_updated)) {
      agg.latest_change_updated = e.updated;
    }
  }
  return result;
}

// Discover entries connected to the given project, split into:
//   - owned:      entries whose frontmatter `project` field equals this id
//   - referenced: entries with [[<id>]] in body but NOT owned
// An entry that's both owned AND wikilinks the project shows up in owned only.
async function findRelatedEntries(
  projectId: string,
): Promise<{ owned: BacklinkRef[]; referenced: BacklinkRef[] }> {
  const path = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  const empty = { owned: [], referenced: [] };
  try {
    const content = await readFile(path, 'utf8');
    const manifest = JSON.parse(content) as {
      entries: Array<{
        id?: string;
        title?: string;
        type?: string;
        domain?: string;
        path?: string;
        updated?: string;
        project?: string | null;
        backlinks?: string[];
      }>;
    };
    const owned: BacklinkRef[] = [];
    const referenced: BacklinkRef[] = [];
    for (const e of manifest.entries ?? []) {
      if (!e.id || e.id === projectId) continue;
      const isOwned = e.project === projectId;
      const isReferenced = Array.isArray(e.backlinks) && e.backlinks.includes(projectId);
      if (!isOwned && !isReferenced) continue;
      const ref: BacklinkRef = {
        id: e.id,
        title: e.title ?? e.id,
        type: e.type ?? null,
        domain: e.domain ?? null,
        path: e.path ?? '',
        updated: e.updated ?? null,
      };
      if (isOwned) owned.push(ref);
      else referenced.push(ref);
    }
    return { owned, referenced };
  } catch {
    return empty;
  }
}

// Discover scheduled runbooks scoped to this project. Enriches each row
// with the next-fire timestamp (from the cron expr) and the most recent
// firing snapshot from `vault/raw/scheduled-runs.jsonl` so the project
// page can show "next: in 2h · last: skipped (precondition unmet)".
async function findProjectSchedules(projectId: string): Promise<ProjectScheduleRef[]> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  const refs: ProjectScheduleRef[] = [];
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError || fm.type !== 'runbook') continue;
      if (typeof fm.schedule !== 'string' || typeof fm.prompt !== 'string') continue;
      if (fm.project !== projectId) continue;
      const next = nextRun(fm.schedule);
      refs.push({
        id: typeof fm.id === 'string' ? fm.id : null,
        title: typeof fm.title === 'string' ? fm.title : (fm.id ?? '(untitled)'),
        schedule: fm.schedule,
        prompt: fm.prompt,
        path: relative(REPO_ROOT, file),
        next_run: next ? next.toISOString() : null,
        last_run: null, // attached below from the run log
      });
    } catch {
      /* skip unreadable */
    }
  }
  if (refs.length > 0) {
    // Single read of the run log; index by id, attach to the matching
    // refs. The log is reverse-chronological so the FIRST entry per id
    // is the most recent.
    const lastById = new Map<string, RunEntry>();
    try {
      const log = await readRunLog(200);
      for (const r of log) {
        if (!r.id) continue;
        if (!lastById.has(r.id)) lastById.set(r.id, r);
      }
    } catch {
      /* run log missing — leave last_run null */
    }
    for (const ref of refs) {
      if (!ref.id) continue;
      const r = lastById.get(ref.id);
      if (!r) continue;
      // The run log entries carry outcome/skip_reason via the scheduler
      // tick (see scripts/scheduler-tick.mjs). Older entries may lack
      // these fields — tolerate either shape.
      const outcome =
        typeof (r as unknown as { outcome?: string }).outcome === 'string'
          ? (r as unknown as { outcome: 'fired' | 'skipped' | 'spawn-error' }).outcome
          : null;
      const skipReason =
        typeof (r as unknown as { skip_reason?: string }).skip_reason === 'string'
          ? (r as unknown as { skip_reason: string }).skip_reason
          : null;
      ref.last_run = {
        ts: r.ts,
        outcome,
        exit: r.exit,
        skip_reason: skipReason,
      };
    }
  }
  return refs;
}

// Find changes owned by this project (type=change + project: <id> frontmatter).
// Sorted by status priority (in-flight first) then by recency.
// js-yaml parses bare ISO timestamps into Date objects. Coerce both forms to
// a canonical string so the API never returns the structured Date or a stale
// null for a present field.
// biome-ignore lint/suspicious/noExplicitAny: yaml field, shape unknown
function asISOString(v: any): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

// Derive a richer lifecycle_stage from the project's own owned-change
// counts, mirroring how the change lifecycle stepper derives its current
// stage. The frontmatter field (set once at scaffolding) is mostly stale
// since users rarely hand-edit it; this gives the project view a live
// signal that tracks real work.
//
// Rule precedence:
//   - explicit `archived` from frontmatter wins (manual closure via
//     POST /:id/complete) — never override that
//   - 0 owned changes              → keep the frontmatter value (defaults to
//                                    "planning" at scaffolding time)
//   - any in-progress              → "active"
//   - any in-review (none earlier) → "review"
//   - all changes terminal merged  → "shipped"
//   - mixed terminal (some merged + some abandoned, no in-flight) → "shipped"
//   - all changes abandoned         → "abandoned"
function deriveLifecycleStage(
  frontmatterStage: string | null,
  changes: ChangeAggregate | null,
): string | null {
  if (frontmatterStage === 'archived') return 'archived';
  if (!changes || changes.total === 0) return frontmatterStage;
  if (changes.in_progress > 0) return 'active';
  if (changes.in_review > 0) return 'review';
  if (changes.merged > 0 && changes.in_progress === 0 && changes.in_review === 0) return 'shipped';
  if (changes.abandoned === changes.total) return 'abandoned';
  return frontmatterStage;
}

// Derive the project's plan state (plan_status × review_status pair) from
// the research-driven flow when the frontmatter pair is unset. The two
// flows are parallel: the meta-scaffold flow writes frontmatter directly;
// research-write → review → approve → scaffold-recommendations updates the
// research-report's status and the per-recommendation status, but does NOT
// touch project frontmatter. This derivation bridges the gap so the Plan
// lifecycle stepper reflects research-driven progress too.
//
// Mapping (pair form — see ../lib/lifecycle-state.ts for the full table):
//   no research-reports       → { null, null } (frontmatter pair takes over)
//   draft                     → { in-research, pending }
//   reviewed + pending review → { drafted, pending }
//   reviewed + request-changes→ { drafted, request-changes }
//   approved, no scaffolded   → { drafted, approved }
//   approved, scaffolded recs → { scaffolded|active, approved }
// Pure derivers live in ../lib/lifecycle-state.ts — the single lifecycle
// derivation module (project / change / report) — so unit tests can exercise
// the transitions without the I/O-heavy projects.ts transitive graph.
import type { DerivedPlanState } from '../lib/lifecycle-state.js';
import {
  derivePostApprovalStage,
  deriveProjectPlanState,
  planStageId,
} from '../lib/lifecycle-state.js';

// Lift of readChangeAutomation from changes.ts — kept local to avoid a
// circular import. Same semantics: null when the `automation:` block is
// absent; defaults filled when present; unknown phase falls back to idle.
// Keep the two in sync; if the shape drifts, lift to a shared helper.
function parseChangeAutomationFromFm(
  fm: Record<string, unknown>,
): import('./changes.types.js').ChangeAutomation | null {
  const raw = fm.automation;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stateRaw = (r.state && typeof r.state === 'object' ? r.state : {}) as Record<
    string,
    unknown
  >;
  const phase =
    stateRaw.phase === 'running' || stateRaw.phase === 'paused' || stateRaw.phase === 'complete'
      ? (stateRaw.phase as 'running' | 'paused' | 'complete')
      : ('idle' as const);
  return {
    enabled: r.enabled === true,
    iteration_cap:
      typeof r.iteration_cap === 'number' && r.iteration_cap > 0 ? Math.floor(r.iteration_cap) : 4,
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

async function findOwnedChanges(projectId: string): Promise<OwnedChangeRef[]> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  const out: OwnedChangeRef[] = [];
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'change') continue;
      if (fm.project !== projectId) continue;
      out.push({
        id: typeof fm.id === 'string' ? fm.id : '(no-id)',
        title: typeof fm.title === 'string' ? fm.title : (fm.id ?? '(untitled)'),
        status: typeof fm.status === 'string' ? fm.status : null,
        repo: typeof fm.repo === 'string' ? fm.repo : null,
        branch: typeof fm.branch === 'string' ? fm.branch : null,
        pr_url: typeof fm.pr_url === 'string' ? fm.pr_url : null,
        path: relative(REPO_ROOT, file),
        // js-yaml parses ISO timestamps as Date objects; a naive typeof
        // check returns null for every such field. Same bug fixed earlier
        // in changes.ts — coerce both string and Date forms.
        updated: asISOString(fm.updated),
        derived_from_report:
          typeof fm.derived_from_report === 'string' ? fm.derived_from_report : null,
        recommendation_index:
          typeof fm.recommendation_index === 'number'
            ? fm.recommendation_index
            : typeof fm.recommendation_index === 'string' && /^\d+$/.test(fm.recommendation_index)
              ? Number.parseInt(fm.recommendation_index, 10)
              : null,
        recommendations_total: null, // populated below
        review_status: typeof fm.review_status === 'string' ? fm.review_status : null,
        pr_review_status: typeof fm.pr_review_status === 'string' ? fm.pr_review_status : null,
        // Phase 4 — re-use the change route's parser via a local lift. The
        // shape is small enough that inlining is cheaper than importing
        // (avoids circular concerns with changes.ts).
        automation: parseChangeAutomationFromFm(fm as Record<string, unknown>),
      });
    } catch {
      /* skip */
    }
  }
  // Status ordering: in-flight states first, terminal states last.
  const order: Record<string, number> = {
    'in-review': 0,
    'in-progress': 1,
    planning: 2,
    merged: 3,
    abandoned: 4,
  };
  out.sort((a, b) => {
    const ai = a.status && a.status in order ? order[a.status] : 99;
    const bi = b.status && b.status in order ? order[b.status] : 99;
    if (ai !== bi) return ai - bi;
    // Within the same status group: if both are derived from the same
    // research-report, sort by recommendation_index so the [N/M] indicators
    // appear in numerical order (3/8, 4/8, 5/8, …) instead of being jumbled
    // by updated-time. Hand-scaffolded siblings fall back to updated DESC.
    if (
      a.derived_from_report &&
      a.derived_from_report === b.derived_from_report &&
      a.recommendation_index != null &&
      b.recommendation_index != null
    ) {
      return a.recommendation_index - b.recommendation_index;
    }
    return (b.updated ?? '').localeCompare(a.updated ?? '');
  });
  // Populate recommendations_total for each derived change. Counts are
  // cached per report id since multiple changes share a source report.
  const reportCounts = new Map<string, number>();
  for (const ch of out) {
    if (!ch.derived_from_report) continue;
    if (!reportCounts.has(ch.derived_from_report)) {
      const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            entries?: Array<{ type?: string | null; derived_from_report?: string | null }>;
          };
          let n = 0;
          for (const e of manifest.entries ?? []) {
            if (e.type === 'change' && e.derived_from_report === ch.derived_from_report) n++;
          }
          reportCounts.set(ch.derived_from_report, n);
        } catch {
          reportCounts.set(ch.derived_from_report, 0);
        }
      } else {
        reportCounts.set(ch.derived_from_report, 0);
      }
    }
    ch.recommendations_total = reportCounts.get(ch.derived_from_report) ?? null;
  }
  return out;
}

// Find prior status reports in vault/output/<domain>/status-reports/ with
// filenames matching <project-id>-*.md.
async function findStatusReports(projectId: string, domain: string): Promise<StatusReportRef[]> {
  const dir = join(REPO_ROOT, 'vault', 'output', domain, 'status-reports');
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `${projectId}-`;
  const out: StatusReportRef[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    if (!e.name.startsWith(prefix)) continue;
    const p = join(dir, e.name);
    try {
      const s = await stat(p);
      // Best-effort preview: read body (skip frontmatter), strip the first
      // H1 (always the same title), take ~400 chars. Errors return null
      // preview — the row still renders, just without the excerpt.
      let preview: string | null = null;
      let kind: 'kickoff' | 'status' | 'wrap-up' | null = null;
      let timeframe_start: string | null = null;
      let timeframe_end: string | null = null;
      try {
        const raw = await readFile(p, 'utf8');
        const { fm, body } = parseFrontmatter(raw);
        // Kind precedence: frontmatter report_type → filename infix → null.
        const rtFm = typeof fm.report_type === 'string' ? fm.report_type : null;
        if (rtFm === 'kickoff' || rtFm === 'status' || rtFm === 'wrap-up') {
          kind = rtFm;
        } else if (e.name.includes('-wrap-up-')) kind = 'wrap-up';
        else if (e.name.includes('-kickoff-')) kind = 'kickoff';
        else if (e.name.includes('-status-')) kind = 'status';
        // Timeframe (best-effort; legacy reports lack the fields).
        timeframe_start = typeof fm.timeframe_start === 'string' ? fm.timeframe_start : null;
        timeframe_end = typeof fm.timeframe_end === 'string' ? fm.timeframe_end : null;
        // Strip leading H1 line + collapse whitespace + clip to 400.
        const cleaned = body
          .replace(/^#\s+[^\n]*\n+/, '')
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        preview = cleaned.slice(0, 400);
        if (preview.length === 0) preview = null;
      } catch {
        /* preview stays null */
      }
      out.push({
        path: relative(REPO_ROOT, p),
        name: e.name,
        mtime: new Date(s.mtimeMs).toISOString(),
        preview,
        kind,
        timeframe_start,
        timeframe_end,
      });
    } catch {
      /* skip */
    }
  }
  // Newest first
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

export const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects?status=active — list of project entries.
  fastify.get<{ Querystring: { status?: string } }>('/', async (req) => {
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    const statusFilter = req.query.status;
    const out: ProjectSummary[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'project') continue;
      if (statusFilter && fm.status !== statusFilter) continue;

      out.push(toSummary(fm, file));
    }

    // Attach change aggregates — one manifest read covers every project.
    const aggregates = await buildChangeAggregates();
    for (const p of out) {
      if (p.id) p.changes = aggregates.get(p.id) ?? null;
      p.lifecycle_stage_derived = deriveLifecycleStage(p.lifecycle_stage, p.changes);
    }

    out.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return a.title.localeCompare(b.title);
    });

    return { projects: out };
  });

  // GET /api/projects/ids — lightweight `{ ids, titles }` for dropdowns
  // (rule editor's per-project filter, scaffold pickers, etc). Walks the
  // wiki tree the same way as the list endpoint above but skips aggregate
  // computation, so it's cheap to call from form-rendering paths. Returns
  // ids sorted alphabetically; titles map keyed by id for human labels.
  fastify.get('/ids', async () => {
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    const ids: string[] = [];
    const titles: Record<string, string> = {};
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'project') continue;
      if (typeof fm.id !== 'string' || fm.id.length === 0) continue;
      ids.push(fm.id);
      if (typeof fm.title === 'string') titles[fm.id] = fm.title;
    }
    ids.sort();
    return { ids, titles };
  });

  // GET /api/projects/:id — project detail + backlinks + schedules + status reports.
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const { fm: foundFm, path: foundPath } = found;

    const project = toSummary(foundFm, foundPath);
    const [related, schedules, statusReports, ownedChanges, aggregates, researchReports] =
      await Promise.all([
        findRelatedEntries(projectId),
        findProjectSchedules(projectId),
        findStatusReports(projectId, project.domain ?? 'meta'),
        findOwnedChanges(projectId),
        buildChangeAggregates(),
        listResearchReportsForProject(projectId),
      ]);
    project.changes = aggregates.get(projectId) ?? null;
    project.lifecycle_stage_derived = deriveLifecycleStage(
      project.lifecycle_stage,
      project.changes,
    );
    const derivedPlan = deriveProjectPlanState(researchReports, ownedChanges);
    project.plan_status_derived = derivedPlan.plan_status;
    project.review_status_derived = derivedPlan.review_status;
    // Final linear stage: derived pair when the research flow is active,
    // else the frontmatter pair (legacy meta-scaffold flow).
    project.plan_stage = planStageId(
      derivedPlan.plan_status !== null
        ? derivedPlan
        : {
            plan_status: (project.plan_status as DerivedPlanState['plan_status']) ?? null,
            review_status: (project.review_status as DerivedPlanState['review_status']) ?? null,
          },
    );
    // Group each side by archetype for the UI.
    const groupByType = (refs: BacklinkRef[]): Record<string, BacklinkRef[]> => {
      const out: Record<string, BacklinkRef[]> = {};
      for (const r of refs) {
        const t = r.type ?? 'unknown';
        if (!out[t]) out[t] = [];
        out[t].push(r);
      }
      for (const k of Object.keys(out)) {
        out[k].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
      }
      return out;
    };

    const rollup = buildProjectRollup(
      projectId,
      ownedChanges.map((c) => c.id),
    );

    // Body content for the Overview tab — strip frontmatter + the always-
    // present H1 title (it's already shown in the page header). Null when
    // the entry has no prose past frontmatter.
    let body: string | null = null;
    try {
      const raw = await readFile(foundPath, 'utf8');
      const parsed = parseFrontmatter(raw);
      const stripped = parsed.body.replace(/^#\s+[^\n]*\n+/, '').trim();
      body = stripped.length > 0 ? stripped : null;
    } catch {
      /* body stays null */
    }

    return {
      project,
      body,
      backlinks: {
        owned: groupByType(related.owned),
        referenced: groupByType(related.referenced),
      },
      owned_changes: ownedChanges,
      schedules,
      status_reports: statusReports,
      research_reports: researchReports,
      rollup,
    } satisfies ProjectDetail;
  });

  // GET /api/projects/:id/research-reports — list research-reports owned by
  // this project. Same shape rendered standalone via /api/research?project=:id;
  // surfaced here for symmetry with the change-list endpoints.
  fastify.get<{ Params: { id: string } }>('/:id/research-reports', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const reports = await listResearchReportsForProject(projectId);
    return { ok: true, reports };
  });

  // POST /api/projects/:id/research — dual-mode endpoint.
  //
  // Body-shape discriminator (priority: `prompt` first):
  //   - `prompt` present → dispatcher mode: dispatch `research-write`
  //     through the runs system. Returns `{ ok, run_id, current_cost_usd }`.
  //     (Dispatched the deprecated meta-research-project alias until the
  //     alias was deleted — the slug-derivation duty the alias performed now
  //     lives in the dispatcher prompt below.)
  //     409 if `plan_status === 'in-research'` (one research per project).
  //   - `prompt` absent AND `title` present → legacy note-creation mode:
  //     scaffold a research note linked to the project. Returns
  //     `{ ok, id, path }`. Preserved verbatim so the existing "Add research
  //     note" form in View.tsx keeps working through the multi-change rollout.
  //   - neither present → 400.
  //
  // The project-existence precondition (`findProjectFrontmatter`) runs FIRST
  // so a typo'd id can't dispatch a stray run or write an orphan note.
  fastify.post<{
    Params: { id: string };
    Body: {
      prompt?: string;
      title?: string;
      body?: string;
      materials?: { wikilinks?: string[]; urls?: string[] };
      material_limit?: number;
    };
  }>('/:id/research', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const { fm: projectFm } = found;
    const project = toSummary(projectFm, found.path);
    const projectDomain = project.domain ?? 'meta';

    const rawPrompt = (req.body?.prompt ?? '').trim();
    const rawTitle = (req.body?.title ?? '').trim();
    const rawBody = (req.body?.body ?? '').trim();

    // ---- dispatcher mode ----
    if (rawPrompt) {
      if (projectFm.plan_status === 'in-research') {
        reply.code(409);
        return {
          ok: false,
          error: 'project is already in-research — wait for the running research to finish.',
        };
      }
      const materials = req.body?.materials ?? {};
      const materialsBlock = JSON.stringify(materials);
      const materialLimit =
        typeof req.body?.material_limit === 'number' ? req.body.material_limit : null;
      const dispatcherPrompt = `Run the research-write skill for project "${projectId}".

User intent:
${rawPrompt}

Inputs:
- project: ${projectId}
- report_topic: derive a kebab-case slug from the user intent above (lowercase [a-z0-9-], 3-60 chars, no leading/trailing hyphen) — it names the report entry
- prompt: the user intent above, verbatim
- materials: ${materialsBlock}
${materialLimit !== null ? `- material_limit: ${materialLimit}` : ''}

Read .claude/skills/research-write/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary of what was produced when done.`;
      const result = await startRun({
        prompt: dispatcherPrompt,
        title: `/os research write ${projectId}`,
        tags: {
          project: projectId,
          domain: projectDomain,
          skill: SKILL.RESEARCH_WRITE,
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
      const owned = await findOwnedChanges(projectId);
      const rollup = buildProjectRollup(
        projectId,
        owned.map((c) => c.id),
      );
      recordAudit('project-research-dispatch', { project: projectId, run_id: result.run_id }, []);
      return {
        ok: true,
        run_id: result.run_id,
        current_cost_usd: rollup.cost_usd,
      };
    }

    // ---- legacy note-creation mode ----
    if (!rawTitle) {
      reply.code(400);
      return {
        ok: false,
        error:
          'request body must include either prompt (dispatcher mode) or title (legacy note mode)',
      };
    }

    // Slug: kebab-case + suffix to avoid collisions. Title may have
    // arbitrary unicode; strip everything that isn't a-z 0-9 or hyphen.
    const baseSlug =
      rawTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'note';
    const dir = join(REPO_ROOT, 'vault', 'wiki', 'research', 'note');
    await mkdir(dir, { recursive: true });
    let slug = baseSlug;
    let attempt = 0;
    while (existsSync(join(dir, `${slug}.md`))) {
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
      if (attempt > 50) {
        reply.code(500);
        return { ok: false, error: 'failed to generate non-colliding slug' };
      }
    }
    const targetPath = join(dir, `${slug}.md`);
    const nowIso = new Date().toISOString();
    const yamlTitle =
      rawTitle.includes(':') || rawTitle.includes('"')
        ? `"${rawTitle.replace(/"/g, '\\"')}"`
        : rawTitle;
    const lines: string[] = [
      '---',
      `id: ${slug}`,
      'type: note',
      'domain: research',
      `created: ${nowIso}`,
      `updated: ${nowIso}`,
      'tags: []',
      'source: dashboard-research-form',
      'private: false',
      `title: ${yamlTitle}`,
      `project: ${projectId}`,
      '---',
      '',
      `# ${rawTitle}`,
      '',
      rawBody || '<!-- write your research note here. links to other entries via [[entry-id]]. -->',
      '',
    ];
    await writeFile(targetPath, lines.join('\n'), 'utf8');

    recordAudit('project-research-add', { project: projectId, note_id: slug }, [
      relative(REPO_ROOT, targetPath),
    ]);

    return { ok: true, id: slug, path: relative(REPO_ROOT, targetPath) };
  });

  // POST /api/projects/:id/plan/review — dispatch `meta-review-project-plan`.
  // Refuses 409 when no plan exists to review.
  fastify.post<{ Params: { id: string } }>('/:id/plan/review', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const project = toSummary(found.fm, found.path);
    if (!project.plan_path) {
      reply.code(409);
      return { ok: false, error: 'no plan to review — research the project first.' };
    }
    const dispatcherPrompt = `Run the meta-review-project-plan skill for project "${projectId}".

Inputs:
- project: ${projectId}

Read .claude/skills/meta-review-project-plan/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary of the verdict when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os review-project-plan ${projectId}`,
      tags: {
        project: projectId,
        domain: project.domain ?? 'meta',
        skill: 'meta-review-project-plan',
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
    const owned = await findOwnedChanges(projectId);
    const rollup = buildProjectRollup(
      projectId,
      owned.map((c) => c.id),
    );
    recordAudit('project-plan-review-dispatch', { project: projectId, run_id: result.run_id }, []);
    return { ok: true, run_id: result.run_id, current_cost_usd: rollup.cost_usd };
  });

  // POST /api/projects/:id/plan/revise — dispatch `meta-revise-project-plan`.
  // Refuses 409 when the plan's `review_status` is not `request-changes`
  // (shared review-state contract: the verdict lives in review_status,
  // plan_status is lifecycle-only).
  fastify.post<{ Params: { id: string } }>('/:id/plan/revise', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const project = toSummary(found.fm, found.path);
    if (project.review_status !== 'request-changes') {
      reply.code(409);
      return {
        ok: false,
        error: `nothing to revise from — plan_status is ${project.plan_status ?? 'null'}.`,
      };
    }
    const dispatcherPrompt = `Run the meta-revise-project-plan skill for project "${projectId}".

Inputs:
- project: ${projectId}

Read .claude/skills/meta-revise-project-plan/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary of what was changed when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os revise-project-plan ${projectId}`,
      tags: {
        project: projectId,
        domain: project.domain ?? 'meta',
        skill: 'meta-revise-project-plan',
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
    const owned = await findOwnedChanges(projectId);
    const rollup = buildProjectRollup(
      projectId,
      owned.map((c) => c.id),
    );
    recordAudit('project-plan-revise-dispatch', { project: projectId, run_id: result.run_id }, []);
    return { ok: true, run_id: result.run_id, current_cost_usd: rollup.cost_usd };
  });

  // POST /api/projects/:id/plan/scaffold — dispatch `meta-scaffold-project-plan`
  // with the curated items list. Refuses 409 when the plan's `review_status`
  // is not `approved` (shared review-state contract). Empty items array is
  // allowed — the skill itself handles the idempotent stop.
  fastify.post<{
    Params: { id: string };
    Body: { items?: string[] };
  }>('/:id/plan/scaffold', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const project = toSummary(found.fm, found.path);
    if (project.review_status !== 'approved' && project.review_status !== 'overridden') {
      reply.code(409);
      return {
        ok: false,
        error: `review_status must be 'approved' (or 'overridden') to scaffold — got '${project.review_status ?? 'null'}'.`,
      };
    }
    const rawItems = req.body?.items;
    if (!Array.isArray(rawItems) || rawItems.some((x) => typeof x !== 'string')) {
      reply.code(400);
      return { ok: false, error: 'items must be an array of strings (empty array allowed)' };
    }
    const itemsJson = JSON.stringify(rawItems);
    const dispatcherPrompt = `Run the meta-scaffold-project-plan skill for project "${projectId}".

Inputs:
- project: ${projectId}
- items: ${itemsJson}

Read .claude/skills/meta-scaffold-project-plan/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary of what was scaffolded when done.`;
    const result = await startRun({
      prompt: dispatcherPrompt,
      title: `/os scaffold-project-plan ${projectId}`,
      tags: {
        project: projectId,
        domain: project.domain ?? 'meta',
        skill: 'meta-scaffold-project-plan',
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
    const owned = await findOwnedChanges(projectId);
    const rollup = buildProjectRollup(
      projectId,
      owned.map((c) => c.id),
    );
    recordAudit(
      'project-plan-scaffold-dispatch',
      { project: projectId, items: rawItems, run_id: result.run_id },
      [],
    );
    return { ok: true, run_id: result.run_id, current_cost_usd: rollup.cost_usd };
  });

  // GET /api/projects/:id/plan — read-only. Returns the project's plan +
  // review file content (when present). Same `FileRef` shape as the change
  // detail endpoint so the Plan tab can render with the same component.
  fastify.get<{ Params: { id: string } }>('/:id/plan', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const project = toSummary(found.fm, found.path);
    const [plan, review] = await Promise.all([
      loadFileRef(project.plan_path),
      loadFileRef(project.review_path),
    ]);
    return { ok: true, plan, review } satisfies {
      ok: true;
      plan: FileRef | null;
      review: FileRef | null;
    };
  });

  // POST /api/projects/:id/materials — write to the drop zone at
  // `vault/raw/project-research/<id>/`. Two sub-modes via body shape:
  //   - `{ kind: 'url', urls: string[] }` — fetch each URL, write body
  //     to `url-<n>-<slug>.md` with a small frontmatter header.
  //   - `{ kind: 'file', filename, content, content_encoding? }` — write
  //     the (base64-decoded if encoded) content under `<filename>`.
  //     Filename is whitelisted; safePath() is a second guard.
  // Both modes return `{ ok, materials: [{ ok, path }, ...] }`.
  fastify.post<{
    Params: { id: string };
    Body:
      | { kind: 'url'; urls: string[]; report_id?: string }
      | {
          kind: 'file';
          filename: string;
          content: string;
          content_encoding?: 'base64';
          report_id?: string;
        };
  }>('/:id/materials', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }

    const body = req.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { ok: false, error: 'request body required' };
    }

    // Optional per-report routing. When set, validate the report exists AND
    // belongs to this project, then route writes under <project>/<report_id>/.
    // When unset, preserve existing behavior (writes to <project>/).
    const reportId = typeof body.report_id === 'string' ? body.report_id.trim() : '';
    let dropDirRel: string;
    if (reportId) {
      const report = await findResearchReport(reportId);
      if (!report) {
        reply.code(404);
        return { ok: false, error: `research-report "${reportId}" not found` };
      }
      if (report.fm.project !== projectId) {
        reply.code(400);
        return {
          ok: false,
          error: `report "${reportId}" belongs to project "${report.fm.project ?? '(null)'}", not "${projectId}"`,
        };
      }
      dropDirRel = join('vault', 'raw', 'project-research', projectId, reportId);
    } else {
      dropDirRel = join('vault', 'raw', 'project-research', projectId);
    }
    // Belt-and-brace via safePath() so a future loosened findProjectFrontmatter
    // or invalid report_id can't accidentally route writes outside the tree.
    let safeDropDir: string;
    try {
      safeDropDir = safePath(dropDirRel);
    } catch {
      reply.code(400);
      return { ok: false, error: 'invalid project drop directory' };
    }
    await mkdir(safeDropDir, { recursive: true });

    const materials: Array<{ ok: boolean; path?: string; error?: string }> = [];

    if (body.kind === 'url') {
      const urls = Array.isArray(body.urls) ? body.urls : [];
      // Index from the count of existing url-files so re-runs don't collide.
      let existing: string[] = [];
      try {
        existing = (await readdir(safeDropDir)).filter((n) => n.startsWith('url-'));
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
          target = safePath(join(dropDirRel, filename));
        } catch {
          materials.push({ ok: false, error: 'safePath rejected target' });
          continue;
        }
        try {
          // Cap body size at ~5 MB to prevent one weird URL from blowing storage.
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
        'project-materials-add',
        {
          project: projectId,
          report_id: reportId || null,
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
        target = safePath(join(dropDirRel, filename));
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
        'project-materials-add',
        {
          project: projectId,
          report_id: reportId || null,
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

  // GET /api/projects/:id/materials — list the drop-zone files for the
  // Plan tab's materials section. Returns an empty array when the drop dir
  // hasn't been created yet (lazy materialization). Optional ?report_id=<id>
  // routes the listing to the per-report subdirectory; when absent, lists
  // the project-level dir (back-compat with existing callers).
  fastify.get<{ Params: { id: string }; Querystring: { report_id?: string } }>(
    '/:id/materials',
    async (req, reply) => {
      const projectId = req.params.id;
      const found = await findProjectFrontmatter(projectId);
      if (!found) {
        reply.code(404);
        return { ok: false, error: `project "${projectId}" not found` };
      }
      const reportId = typeof req.query.report_id === 'string' ? req.query.report_id.trim() : '';
      let dropDir: string;
      if (reportId) {
        const report = await findResearchReport(reportId);
        if (!report) {
          reply.code(404);
          return { ok: false, error: `research-report "${reportId}" not found` };
        }
        if (report.fm.project !== projectId) {
          reply.code(400);
          return {
            ok: false,
            error: `report "${reportId}" belongs to project "${report.fm.project ?? '(null)'}", not "${projectId}"`,
          };
        }
        dropDir = join(REPO_ROOT, 'vault', 'raw', 'project-research', projectId, reportId);
      } else {
        dropDir = join(REPO_ROOT, 'vault', 'raw', 'project-research', projectId);
      }
      if (!existsSync(dropDir)) {
        return { ok: true, materials: [] };
      }
      const out: Array<{ name: string; path: string; size: number; mtime: string }> = [];
      let entries: Dirent[];
      try {
        entries = await readdir(dropDir, { withFileTypes: true });
      } catch {
        return { ok: true, materials: [] };
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        const abs = join(dropDir, e.name);
        try {
          const s = await stat(abs);
          out.push({
            name: e.name,
            path: relative(REPO_ROOT, abs),
            size: s.size,
            mtime: new Date(s.mtimeMs).toISOString(),
          });
        } catch {
          /* skip */
        }
      }
      out.sort((a, b) => b.mtime.localeCompare(a.mtime));
      return { ok: true, materials: out };
    },
  );

  // GET /api/projects/:id/replay — chronological autobiography of a
  // project. Unions every billable + audit event tagged to the project
  // OR any of its owned changes, plus commits from each owned-change's
  // branch, plus change-state-transition markers (change scaffolded /
  // merged / abandoned) so the cross-change story is visible inline.
  // Mirrors the change Replay shape so the same client components render.
  fastify.get<{ Params: { id: string } }>('/:id/replay', async (req, reply) => {
    const projectId = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);

    // Locate the project + its owned changes + repo entities in a single walk.
    // biome-ignore lint/suspicious/noExplicitAny: yaml shape
    let projectFm: any = null;
    interface OwnedChange {
      id: string;
      title: string;
      status: string | null;
      created: string | null;
      updated: string | null;
      merged_at: string | null;
      branch: string | null;
      repo: string | null;
    }
    const ownedChanges: OwnedChange[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: yaml shape
    const repoEntities = new Map<string, any>();
    for (const file of files) {
      try {
        const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
        if (parseError) continue;
        if (fm.type === 'project' && fm.id === projectId) {
          projectFm = fm;
        } else if (fm.type === 'change' && fm.project === projectId && typeof fm.id === 'string') {
          ownedChanges.push({
            id: fm.id,
            title: typeof fm.title === 'string' ? fm.title : fm.id,
            status: typeof fm.status === 'string' ? fm.status : null,
            created: asISOString(fm.created),
            updated: asISOString(fm.updated),
            merged_at: asISOString(fm.merged_at),
            branch: typeof fm.branch === 'string' ? fm.branch : null,
            repo: typeof fm.repo === 'string' ? fm.repo : null,
          });
        } else if (fm.type === 'entity' && fm.kind === 'repo' && typeof fm.id === 'string') {
          repoEntities.set(fm.id, fm);
        }
      } catch {
        /* skip */
      }
    }
    if (!projectFm) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const ownedIds = ownedChanges.map((c) => c.id);
    const rollup = buildProjectRollup(projectId, ownedIds);

    // Events query — project OR any owned change.
    interface ReplayEvent {
      id: number;
      ts: string;
      kind: string;
      action: string | null;
      skill: string | null;
      duration_ms: number | null;
      exit_status: string | null;
      cost_usd: number | null;
      change_id: string | null;
    }
    const events: ReplayEvent[] = [];
    if (existsSync(EVENTS_DB_PATH)) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
        const idPlaceholders = ownedIds.length
          ? `OR change_id IN (${ownedIds.map(() => '?').join(',')})`
          : '';
        const sql = `
          SELECT id, ts, kind, action, skill, duration_ms, exit_status, cost_usd, change_id
            FROM events
           WHERE project = ? ${idPlaceholders}
           ORDER BY ts ASC
           LIMIT 1000`;
        const rows = db.prepare(sql).all(projectId, ...ownedIds) as unknown as ReplayEvent[];
        events.push(...rows);
      } catch {
        /* ignore */
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

    // Runs join — same change_id-keyed lookup as the change Replay. Lets
    // each event row link to /processes#<run-id>.
    interface ReplayRunRef {
      id: string;
      started_at: string;
      skill: string | null;
      change_id: string | null;
    }
    const runs: ReplayRunRef[] = [];
    if (existsSync(EVENTS_DB_PATH) && (ownedIds.length || true)) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
        const idPlaceholders = ownedIds.length
          ? `OR change_id IN (${ownedIds.map(() => '?').join(',')})`
          : '';
        const sql = `
          SELECT id, started_at, skill, change_id
            FROM runs
           WHERE project = ? ${idPlaceholders}
           ORDER BY started_at ASC`;
        const rows = db.prepare(sql).all(projectId, ...ownedIds) as unknown as ReplayRunRef[];
        runs.push(...rows);
      } catch {
        /* ignore */
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

    // Commits — gather from every owned change's branch via git log.
    // Bounded by change.created (when present) so the output stays scoped.
    interface ReplayCommit {
      sha: string;
      short_sha: string;
      subject: string;
      author: string;
      ts: string;
      body: string;
      change_id: string;
      repo: string | null;
    }
    const commits: ReplayCommit[] = [];
    const { spawnSync } = await import('node:child_process');
    for (const ch of ownedChanges) {
      if (!ch.branch || !ch.repo) continue;
      const repoFm = repoEntities.get(ch.repo);
      if (!repoFm || typeof repoFm.local_path !== 'string') continue;
      const localPath = repoFm.local_path as string;
      const defaultBranch =
        typeof repoFm.default_branch === 'string' ? repoFm.default_branch : 'main';
      try {
        const SEP = '\x1f';
        const REC = '\x1e';
        const fmt = ['%H', '%h', '%s', '%an', '%aI', '%b'].join(SEP);
        const isMerged = ch.status === 'merged';
        const range = isMerged
          ? [ch.branch, '-n', '20', ...(ch.created ? ['--since', ch.created] : [])]
          : [`${defaultBranch}..${ch.branch}`];
        const r = spawnSync('git', ['-C', localPath, 'log', `--format=${fmt}${REC}`, ...range], {
          encoding: 'utf8',
        });
        if (r.status !== 0) continue;
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
            change_id: ch.id,
            repo: ch.repo,
          });
        }
      } catch {
        /* skip */
      }
    }

    // Change-state markers — one entry per change at its `created`,
    // `merged_at`, or status-transition timestamp. Surfaces "change X
    // scaffolded" / "change X merged" / "change X abandoned" alongside
    // the lower-grain event rows. Synthesized client-side from the
    // OwnedChange records below — we just include them in the response
    // so the client doesn't need to recompute.
    interface ChangeMarker {
      ts: string;
      change_id: string;
      change_title: string;
      kind: 'scaffolded' | 'merged' | 'abandoned';
    }
    const changeMarkers: ChangeMarker[] = [];
    for (const ch of ownedChanges) {
      if (ch.created) {
        changeMarkers.push({
          ts: ch.created,
          change_id: ch.id,
          change_title: ch.title,
          kind: 'scaffolded',
        });
      }
      if (ch.status === 'merged' && ch.merged_at) {
        changeMarkers.push({
          ts: ch.merged_at,
          change_id: ch.id,
          change_title: ch.title,
          kind: 'merged',
        });
      } else if (ch.status === 'abandoned' && ch.updated) {
        changeMarkers.push({
          ts: ch.updated,
          change_id: ch.id,
          change_title: ch.title,
          kind: 'abandoned',
        });
      }
    }

    // Build unified timeline. The discriminated-union shape matches the
    // change Replay so the client can reuse most rendering code.
    interface TimelineEntry {
      ts: string;
      kind: 'change-marker' | 'event' | 'commit';
      change_marker?: ChangeMarker;
      event?: {
        id: number;
        action: string | null;
        skill: string | null;
        duration_ms: number | null;
        exit_status: string | null;
        cost_usd: number | null;
        change_id: string | null;
        run_id: string | null;
      };
      commit?: ReplayCommit;
    }
    const timeline: TimelineEntry[] = [];
    for (const m of changeMarkers) {
      timeline.push({ ts: m.ts, kind: 'change-marker', change_marker: m });
    }
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
          change_id: ev.change_id,
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
      project_id: projectId,
      rollup,
      owned_change_count: ownedChanges.length,
      change_markers: changeMarkers,
      commits,
      timeline,
    };
  });

  // POST /api/projects/:id/complete — vault-only project closure. Flips
  // `status: completed`, `lifecycle_stage: archived`, and stamps a
  // `completed_at` field. Refuses when any owned change is still in-flight
  // (planning / in-progress / in-review) — the user must close those first
  // (or abandon them) so the audit trail stays honest. Idempotent: calling
  // on an already-completed project is a no-op with `already_completed: true`.
  fastify.post<{ Params: { id: string } }>('/:id/complete', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const foundFile = found.path;
    const foundFm = found.fm;
    let foundContent: string;
    try {
      foundContent = await readFile(foundFile, 'utf8');
    } catch {
      reply.code(500);
      return { ok: false, error: 'failed to read project entry' };
    }
    if (foundFm.status === 'completed') {
      return { ok: true, already_completed: true };
    }
    // Gate: refuse if any owned change isn't terminal. The user must close
    // (or abandon) every owned change first so the project closure can't
    // hide orphaned in-flight work.
    const aggregates = await buildChangeAggregates();
    const agg = aggregates.get(projectId);
    if (agg && (agg.planning > 0 || agg.in_progress > 0 || agg.in_review > 0)) {
      reply.code(409);
      return {
        ok: false,
        error: `project has ${agg.planning + agg.in_progress + agg.in_review} in-flight change(s) — close or abandon them before completing the project.`,
        in_flight: {
          planning: agg.planning,
          in_progress: agg.in_progress,
          in_review: agg.in_review,
        },
      };
    }

    const nowIso = new Date().toISOString();
    // Surgical frontmatter edit — preserve every other field and the body.
    // The status / lifecycle_stage replacements use anchored regex so we
    // only touch the canonical lines; the new `completed_at` is appended
    // immediately before the closing `---` to keep frontmatter compact.
    let updated = foundContent;
    const replaceField = (s: string, key: string, val: string): string => {
      const re = new RegExp(`^${key}:[^\\n]*$`, 'm');
      if (re.test(s)) return s.replace(re, `${key}: ${val}`);
      // Field missing — insert before frontmatter close.
      return s.replace(/\n---\n/, `\n${key}: ${val}\n---\n`);
    };
    updated = replaceField(updated, 'status', 'completed');
    updated = replaceField(updated, 'lifecycle_stage', 'archived');
    updated = replaceField(updated, 'completed_at', nowIso);
    updated = replaceField(updated, 'updated', nowIso);

    try {
      await writeFile(foundFile, updated, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }

    // Best-effort audit event.
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'project-complete',
          '--args',
          JSON.stringify({ project: projectId, owned_changes_total: agg?.total ?? 0 }),
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

    return { ok: true, completed_at: nowIso };
  });

  // POST /api/projects/:id/reopen — inverse of /complete. Flips
  // `status: completed` → `active`, `lifecycle_stage: archived` → `in-progress`,
  // drops `completed_at`, bumps `updated`. 409 if the project isn't currently
  // completed (nothing to reopen). Used when post-Complete gaps surface and
  // the project needs to absorb additional work before re-closing.
  fastify.post<{ Params: { id: string } }>('/:id/reopen', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProjectFrontmatter(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    if (found.fm.status !== 'completed') {
      reply.code(409);
      return {
        ok: false,
        error: `project "${projectId}" is not completed (status: ${String(found.fm.status ?? 'unset')}) — nothing to reopen`,
      };
    }
    let content: string;
    try {
      content = await readFile(found.path, 'utf8');
    } catch {
      reply.code(500);
      return { ok: false, error: 'failed to read project entry' };
    }
    const nowIso = new Date().toISOString();
    let updated = rewriteFrontmatter(content, {
      status: 'active',
      lifecycle_stage: 'in-progress',
      updated: nowIso,
    });
    updated = removeFrontmatterFields(updated, ['completed_at']);
    try {
      await writeFile(found.path, updated, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }
    try {
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'project-reopen',
          '--args',
          JSON.stringify({ project: projectId }),
          '--files-touched',
          JSON.stringify([relative(REPO_ROOT, found.path)]),
          '--exit-status',
          '0',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    } catch {
      /* best-effort */
    }
    return { ok: true, reopened_at: nowIso };
  });

  // POST /api/projects/:id/schedule-report?cadence=daily|weekly
  // Async-dispatches the canonical `meta-add-schedule` skill with inputs
  // pre-filled for the (project, cadence) combination. Single source of
  // truth for runbook scaffolding — when meta-add-schedule's frontmatter
  // shape evolves, this endpoint inherits the change for free.
  //
  // Idempotent pre-check: returns 409 sync (no LLM dispatch) if a runbook
  // for this (project, cadence) pair already exists, with a hint pointing
  // at the existing entry.
  //
  // On success returns { ok: true, run_id, runbook_id, runbook_path } —
  // the runbook file is created asynchronously by the dispatched skill run.
  // The UI polls (or refetches detail on terminal) to see the new entry.
  fastify.post<{ Params: { id: string }; Querystring: { cadence?: string } }>(
    '/:id/schedule-report',
    async (req, reply) => {
      const projectId = req.params.id;
      const cadence = req.query.cadence;
      if (cadence !== 'daily' && cadence !== 'weekly') {
        reply.code(400);
        return { ok: false, error: 'cadence must be "daily" or "weekly"', field: 'cadence' };
      }
      const found = await findProjectFrontmatter(projectId);
      if (!found) {
        reply.code(404);
        return { ok: false, error: `project "${projectId}" not found` };
      }
      const projectDomain = typeof found.fm.domain === 'string' ? found.fm.domain : 'meta';
      const runbookId = `runbook-status-report-${projectId}-${cadence}`;
      const runbookPath = safePath(
        join('vault', 'wiki', projectDomain, 'runbook', `${runbookId}.md`),
      );
      if (existsSync(runbookPath)) {
        reply.code(409);
        return {
          ok: false,
          error: `runbook "${runbookId}" already exists — see Schedules tab to edit or remove`,
          runbook_id: runbookId,
          runbook_path: relative(REPO_ROOT, runbookPath),
        };
      }
      const cron = cadence === 'daily' ? '0 9 * * *' : '0 9 * * 1';
      const triggerHuman =
        cadence === 'daily' ? 'Every day at 09:00 local time' : 'Every Monday at 09:00 local time';
      // The prompt the scheduler will fire — embedded in the runbook's
      // `prompt:` frontmatter. Composed here (not by the skill) so the
      // dispatch contract stays in one place.
      const firePrompt =
        `Run the meta-status-report skill for project "${projectId}" with report_type=status.\n\n` +
        `Headless dispatch: do NOT use AskUserQuestion or any interactive prompt. ` +
        `Compose the report per the "status" variant of the SKILL.md template. Write to the ` +
        `standard path and update the project entry's reporting fields per the Procedure.`;
      // Dispatch meta-add-schedule with the inputs it expects. Single
      // source of truth for runbook frontmatter shape — the skill walks
      // the standard template + writes the file. `project` is one of
      // meta-add-schedule's native inputs (Step 8 of its Procedure):
      // when set, the scheduler tick gates firing on project status.
      const dispatcherPrompt = [
        `Run the meta-add-schedule skill to scaffold a recurring status-report runbook.`,
        '',
        'Inputs:',
        `- name: ${runbookId}`,
        `- title: Status report — ${projectId} (${cadence})`,
        `- domain: ${projectDomain}`,
        `- schedule: ${cron}`,
        `- prompt: ${JSON.stringify(firePrompt)}`,
        `- trigger: ${triggerHuman}`,
        `- project: ${projectId}`,
        '',
        'Read .claude/skills/meta-add-schedule/SKILL.md and follow its Procedure exactly.',
        'Do NOT use AskUserQuestion or any interactive prompt. Report a tight summary when done.',
      ].join('\n');
      const result = await startRun({
        prompt: dispatcherPrompt,
        title: `/os schedule-report ${projectId} ${cadence}`,
        tags: {
          project: projectId,
          domain: projectDomain,
          skill: 'meta-add-schedule',
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
      // Audit the dispatch (the runbook file write itself audits separately
      // when meta-add-schedule's procedure runs).
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'schedule-report-dispatch',
          '--args',
          JSON.stringify({
            project: projectId,
            cadence,
            runbook_id: runbookId,
            run_id: result.run_id,
          }),
          '--files-touched',
          JSON.stringify([]),
          '--exit-status',
          '0',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
      return {
        ok: true,
        run_id: result.run_id,
        runbook_id: runbookId,
        runbook_path: relative(REPO_ROOT, runbookPath),
      };
    },
  );
};
