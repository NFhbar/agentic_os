// /api/audits — lifecycle-audit entries produced by meta-overseer-review.
//
// Three endpoints:
//   GET /api/audits                  — list summaries (newest first)
//   GET /api/audits/:id              — full detail (frontmatter + body)
//   GET /api/audits/aggregate        — verdict distribution + top tags +
//                                       top tuning suggestions, optionally
//                                       scoped to a project via ?project=
//
// Pattern mirrors reviews.ts: walk vault/wiki/meta/lifecycle-audit/, parse
// frontmatter, project to summary shape. The list endpoint is the fast path
// (one walk, no body reads); the detail endpoint reads one file; the
// aggregate endpoint walks once and synthesizes.

import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type {
  AuditAggregate,
  AuditDetail,
  AuditScores,
  AuditStatus,
  AuditSummary,
  FollowupSignal,
  HumanOverride,
  PerSkillFinding,
  TuningSuggestion,
  TuningSuggestionStatus,
  VerdictOverall,
} from './audits.types.js';

const AUDITS_DIR = join(REPO_ROOT, 'vault', 'wiki', 'meta', 'lifecycle-audit');
const DECISIONS_DIR = join(REPO_ROOT, 'vault', 'wiki', 'meta', 'decision');
const PROPOSALS_DIR = join(REPO_ROOT, 'vault', 'output', 'meta', 'tuning-proposals');
const DISMISSAL_PATH = join(REPO_ROOT, '.claude', 'state', 'dismissed-action-items.jsonl');

// Read dismissed-action-items.jsonl into a Map keyed by id.
// Cheap (single small JSONL file); recomputed per detail fetch — staleness
// would be limited to one extra-stale render after a dismiss action, which
// the UI also refreshes on its own after a successful POST.
// Exported so the /pending tuning-suggestions route can reuse it without
// duplicating the JSONL parsing.
export async function loadDismissals(): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!existsSync(DISMISSAL_PATH)) return out;
  try {
    const content = await readFile(DISMISSAL_PATH, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { id?: string; rationale?: string | null };
        if (typeof e.id === 'string') out.set(e.id, e.rationale ?? null);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* missing/unreadable → empty map */
  }
  return out;
}

// Walk vault/wiki/meta/decision/ and build an index keyed by
// `<audit_id>::<suggestion_index>` for fast lookup. Each value is the list
// of decision entries that cite that (audit, index) pair via
// `implements_tuning_suggestions`. Recomputed per detail fetch — typical
// vault has <50 decisions, so this is sub-millisecond.
// Exported alongside loadDismissals so the /pending route can reuse it.
export async function loadDecisionsByTuningRef(): Promise<
  Map<string, Array<{ id: string; path: string; status: string; title: string }>>
> {
  const out = new Map<string, Array<{ id: string; path: string; status: string; title: string }>>();
  if (!existsSync(DECISIONS_DIR)) return out;
  let entries: Dirent[];
  try {
    entries = await readdir(DECISIONS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const path = join(DECISIONS_DIR, e.name);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const { fm, parseError } = parseFrontmatter(content);
    if (parseError) continue;
    if (fm.type !== 'decision') continue;
    const refs = fm.implements_tuning_suggestions;
    if (!Array.isArray(refs)) continue;
    const decisionEntry = {
      id: String(fm.id ?? ''),
      path: relative(REPO_ROOT, path),
      status: typeof fm.status === 'string' ? fm.status : 'proposed',
      title: typeof fm.title === 'string' ? fm.title : '(untitled decision)',
    };
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue;
      const r = ref as { audit_id?: unknown; suggestion_index?: unknown };
      if (typeof r.audit_id !== 'string' || typeof r.suggestion_index !== 'number') continue;
      const key = `${r.audit_id}::${r.suggestion_index}`;
      const existing = out.get(key) ?? [];
      existing.push(decisionEntry);
      out.set(key, existing);
    }
  }
  return out;
}

// Compute the per-suggestion action status for one audit. Indexed in
// parallel with the audit's tuning_suggestions[] array.
async function computeTuningSuggestionStatus(
  auditId: string,
  suggestionCount: number,
  dismissals: Map<string, string | null>,
  decisionsByRef: Map<string, Array<{ id: string; path: string; status: string; title: string }>>,
): Promise<TuningSuggestionStatus[]> {
  const out: TuningSuggestionStatus[] = [];
  for (let i = 0; i < suggestionCount; i++) {
    const dismissId = `tuning-suggestion:${auditId}:${i}`;
    const dismissed = dismissals.has(dismissId);
    const diffPath = join(PROPOSALS_DIR, `${auditId}-${i}.diff`);
    const rationalePath = join(PROPOSALS_DIR, `${auditId}-${i}.rationale.md`);
    const diffExists = existsSync(diffPath);
    const rationaleExists = existsSync(rationalePath);
    // Derive proposal_state: 'diff' when a real unified diff was written
    // (skill target resolved cleanly), 'rationale-only' when propose ran
    // but couldn't synthesize a diff (non-skill target — only the rationale
    // exists), 'none' when no propose has been run for this suggestion.
    let proposalState: 'none' | 'diff' | 'rationale-only';
    if (diffExists) proposalState = 'diff';
    else if (rationaleExists) proposalState = 'rationale-only';
    else proposalState = 'none';
    const decisions = decisionsByRef.get(`${auditId}::${i}`) ?? [];
    out.push({
      dismissed,
      dismissal_rationale: dismissed ? (dismissals.get(dismissId) ?? null) : null,
      proposal_state: proposalState,
      proposal_diff_path: diffExists
        ? `vault/output/meta/tuning-proposals/${auditId}-${i}.diff`
        : null,
      proposal_rationale_path: rationaleExists
        ? `vault/output/meta/tuning-proposals/${auditId}-${i}.rationale.md`
        : null,
      decisions,
    });
  }
  return out;
}

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Dir missing → no audits yet. That's a valid empty state, not an error.
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

function asISOString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

// Normalize the audit_status field. Defaults to 'provisional' for entries
// that don't declare one — matches the archetype's default-state convention.
function asAuditStatus(v: unknown): AuditStatus {
  if (v === 'pending' || v === 'provisional' || v === 'final') return v;
  return 'provisional';
}

function asVerdict(v: unknown): VerdictOverall | null {
  if (v === 'good' || v === 'mixed' || v === 'poor') return v;
  return null;
}

// scores comes through the manifest as a parsed object (or null). Mirror what
// archetype-lifecycle-audit specifies — three numeric dimensions.
function asScores(v: unknown): AuditScores | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const c = Number(o.correctness);
  const cp = Number(o.completeness);
  const e = Number(o.efficiency);
  if (Number.isNaN(c) || Number.isNaN(cp) || Number.isNaN(e)) return null;
  return { correctness: c, completeness: cp, efficiency: e };
}

// Project an audit entry's frontmatter to the summary shape. The body isn't
// read for summaries — list-many path stays fast even with hundreds of audits.
// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function toSummary(fm: any, filePath: string): AuditSummary {
  // `audit_tags` is the categorical pattern vocabulary (well-scoped,
  // missed-issue, etc.) — distinct from the wiki-standard `tags` field
  // ([audit, overseer]) that classifies entries for vault search. They live
  // under different frontmatter keys to avoid the YAML duplicate-key trap.
  const tags = Array.isArray(fm.audit_tags)
    ? fm.audit_tags.filter((t: unknown) => typeof t === 'string')
    : [];
  const tuningSuggestions = Array.isArray(fm.tuning_suggestions) ? fm.tuning_suggestions : [];
  const followupSignals = Array.isArray(fm.followup_signals) ? fm.followup_signals : [];
  const humanOverride = fm.human_override && typeof fm.human_override === 'object';
  return {
    id: String(fm.id ?? ''),
    path: relative(REPO_ROOT, filePath),
    title: String(fm.title ?? '(untitled audit)'),
    audited_change_id: String(fm.audited_change_id ?? ''),
    audited_change_path: String(fm.audited_change_path ?? ''),
    project: String(fm.project ?? ''),
    audit_status: asAuditStatus(fm.audit_status),
    verdict_overall: asVerdict(fm.verdict_overall),
    scores: asScores(fm.scores),
    overseer_model: typeof fm.overseer_model === 'string' ? fm.overseer_model : null,
    overseer_dispatched_at: asISOString(fm.overseer_dispatched_at),
    overseer_completed_at: asISOString(fm.overseer_completed_at),
    rubric_version: String(fm.rubric_version ?? 'v1.0'),
    audit_cost_usd: typeof fm.audit_cost_usd === 'number' ? fm.audit_cost_usd : null,
    audit_duration_ms: typeof fm.audit_duration_ms === 'number' ? fm.audit_duration_ms : null,
    tag_count: tags.length,
    tuning_suggestions_count: tuningSuggestions.length,
    has_human_override: humanOverride,
    has_followups: followupSignals.length > 0,
    created: asISOString(fm.created),
    updated: asISOString(fm.updated),
  };
}

// Build the detail shape from a fully-parsed frontmatter + body. Nested arrays
// that the manifest parser can't represent flat (per_skill_findings, etc.)
// come through here intact when js-yaml parses the entry directly.
// Phase 4: takes a precomputed tuning_suggestion_status (parallel to the
// suggestions array) — passed in by the caller so the dismissal + decisions
// indexes only get read once per request, not once per suggestion.
// biome-ignore lint/suspicious/noExplicitAny: same — frontmatter is YAML
function toDetail(
  fm: any,
  filePath: string,
  body: string,
  tuningSuggestionStatus: TuningSuggestionStatus[],
): AuditDetail {
  const summary = toSummary(fm, filePath);
  return {
    ...summary,
    per_skill_findings: Array.isArray(fm.per_skill_findings)
      ? (fm.per_skill_findings as PerSkillFinding[])
      : [],
    tags: Array.isArray(fm.audit_tags)
      ? fm.audit_tags.filter((t: unknown) => typeof t === 'string')
      : [],
    tuning_suggestions: Array.isArray(fm.tuning_suggestions)
      ? (fm.tuning_suggestions as TuningSuggestion[])
      : [],
    tuning_suggestion_status: tuningSuggestionStatus,
    red_flags: Array.isArray(fm.red_flags)
      ? fm.red_flags.filter((t: unknown) => typeof t === 'string')
      : [],
    files_touched: Array.isArray(fm.files_touched)
      ? fm.files_touched.filter((t: unknown) => typeof t === 'string')
      : [],
    followup_signals: Array.isArray(fm.followup_signals)
      ? (fm.followup_signals as FollowupSignal[])
      : [],
    human_override:
      fm.human_override && typeof fm.human_override === 'object'
        ? (fm.human_override as HumanOverride)
        : null,
    body,
  };
}

// Group similar tuning_suggestions into rolled-up patterns. The Overseer
// produces per-instance suggestions; aggregate surfaces want patterns ("this
// skill keeps getting suggested for the same thing"). For v1, group simply
// by skill + first 60 chars of suggestion — cheap, surfaces obvious recurrences
// without over-engineering similarity matching. v2+ could use embeddings.
function aggregateTuningSuggestions(
  details: Array<{ id: string; suggestions: TuningSuggestion[] }>,
): AuditAggregate['top_tuning_suggestions'] {
  const groups = new Map<
    string,
    { skill: string; sample: string; count: number; auditIds: string[] }
  >();
  for (const { id, suggestions } of details) {
    for (const s of suggestions) {
      const key = `${s.skill}::${s.suggestion.slice(0, 60).trim().toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        if (existing.auditIds.length < 3) existing.auditIds.push(id);
      } else {
        groups.set(key, {
          skill: s.skill,
          sample: s.suggestion,
          count: 1,
          auditIds: [id],
        });
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((g) => ({
      skill: g.skill,
      suggestion_summary: g.sample.length > 200 ? `${g.sample.slice(0, 200)}…` : g.sample,
      count: g.count,
      sample_audit_ids: g.auditIds,
    }));
}

export const auditsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/audits[?project=<id>] — list summaries (newest first).
  // Optional ?project= filter scopes to one project's audits.
  fastify.get<{ Querystring: { project?: string } }>('/', async (req) => {
    const projectFilter = req.query.project;
    const files = await walkMd(AUDITS_DIR);
    const audits: AuditSummary[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'lifecycle-audit') continue;
      if (projectFilter && fm.project !== projectFilter) continue;
      audits.push(toSummary(fm, file));
    }
    // Newest first by overseer_completed_at, falling back to updated, then created.
    audits.sort((a, b) => {
      const at = a.overseer_completed_at ?? a.updated ?? a.created ?? '';
      const bt = b.overseer_completed_at ?? b.updated ?? b.created ?? '';
      return bt.localeCompare(at);
    });
    return { audits };
  });

  // GET /api/audits/:id — full detail by audit id. Also enriches each
  // tuning suggestion with action status (dismissed / proposed / promoted)
  // so the UI can show what's already been done with each suggestion.
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const auditId = req.params.id;
    const files = await walkMd(AUDITS_DIR);
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, body, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'lifecycle-audit') continue;
      if (String(fm.id) !== auditId) continue;

      // Compute per-suggestion status. Two index reads (dismissals + decisions
      // walk) happen once per detail request, then status is computed for
      // each suggestion in O(N) array indexing.
      const suggestions = Array.isArray(fm.tuning_suggestions) ? fm.tuning_suggestions : [];
      const [dismissals, decisionsByRef] = await Promise.all([
        loadDismissals(),
        loadDecisionsByTuningRef(),
      ]);
      const tuningSuggestionStatus = await computeTuningSuggestionStatus(
        auditId,
        suggestions.length,
        dismissals,
        decisionsByRef,
      );
      return toDetail(fm, file, body, tuningSuggestionStatus);
    }
    reply.code(404);
    return { error: `audit "${auditId}" not found` };
  });

  // GET /api/audits/aggregate[?project=<id>] — verdict distribution +
  // top tags + top tuning suggestions across the scoped audits.
  // GET /api/audits/candidates — terminal changes from audit-enabled
  // projects with no lifecycle-audit yet. Powers the Overview tab's
  // "Un-audited lifecycles" card (the audit-dispatch affordance used to live
  // ONLY on the change detail page — a discoverability gap; the Overseer app
  // is where operators go looking for it). Newest activity first.
  fastify.get('/candidates', async () => {
    let entries: Array<Record<string, unknown>> = [];
    try {
      const manifest = JSON.parse(
        await readFile(join(REPO_ROOT, 'vault', '.index', 'manifest.json'), 'utf8'),
      );
      entries = manifest.entries ?? [];
    } catch {
      return { candidates: [] };
    }
    // Audited change ids — audit files are named audit-<change-id>.md.
    const audited = new Set<string>();
    try {
      for (const f of await readdir(AUDITS_DIR)) {
        if (f.startsWith('audit-') && f.endsWith('.md')) {
          audited.add(f.slice('audit-'.length, -'.md'.length));
        }
      }
    } catch {
      /* no audits dir yet */
    }
    // Projects that opted in (audit.enabled is not lifted to the manifest —
    // read each project entry's frontmatter; projects are few).
    const auditEnabled = new Set<string>();
    for (const e of entries) {
      if (e.type !== 'project' || typeof e.path !== 'string' || typeof e.id !== 'string') continue;
      try {
        const { fm } = parseFrontmatter(await readFile(join(REPO_ROOT, e.path), 'utf8'));
        const audit = (fm as Record<string, unknown>).audit as { enabled?: boolean } | undefined;
        if (audit?.enabled === true) auditEnabled.add(e.id);
      } catch {
        /* unreadable project — skip */
      }
    }
    const candidates = entries
      .filter(
        (e) =>
          e.type === 'change' &&
          typeof e.id === 'string' &&
          (e.status === 'merged' || e.status === 'abandoned') &&
          typeof e.project === 'string' &&
          auditEnabled.has(e.project) &&
          !audited.has(e.id),
      )
      .map((e) => ({
        change_id: e.id as string,
        title: (e.title as string) ?? (e.id as string),
        project: e.project as string,
        status: e.status as string,
        merged_at: (e.merged_at as string) ?? null,
        updated: (e.updated as string) ?? null,
      }))
      .sort((a, b) =>
        ((b.merged_at ?? b.updated ?? '') as string).localeCompare(
          (a.merged_at ?? a.updated ?? '') as string,
        ),
      );
    return { candidates };
  });

  fastify.get<{ Querystring: { project?: string } }>('/aggregate', async (req) => {
    const projectFilter = req.query.project ?? null;
    const files = await walkMd(AUDITS_DIR);
    const verdictCounts = { good: 0, mixed: 0, poor: 0, unknown: 0 };
    const tagCounts = new Map<string, number>();
    const detailsForSuggestionRollup: Array<{ id: string; suggestions: TuningSuggestion[] }> = [];
    const totalScores = { correctness: 0, completeness: 0, efficiency: 0 };
    let scoredCount = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    let total = 0;

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'lifecycle-audit') continue;
      if (projectFilter && fm.project !== projectFilter) continue;
      total++;

      const verdict = asVerdict(fm.verdict_overall);
      if (verdict === 'good') verdictCounts.good++;
      else if (verdict === 'mixed') verdictCounts.mixed++;
      else if (verdict === 'poor') verdictCounts.poor++;
      else verdictCounts.unknown++;

      const tags = Array.isArray(fm.audit_tags) ? fm.audit_tags : [];
      for (const t of tags) {
        if (typeof t !== 'string') continue;
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }

      const scores = asScores(fm.scores);
      if (scores) {
        totalScores.correctness += scores.correctness;
        totalScores.completeness += scores.completeness;
        totalScores.efficiency += scores.efficiency;
        scoredCount++;
      }

      const completedAt = asISOString(fm.overseer_completed_at) ?? asISOString(fm.updated);
      if (completedAt) {
        if (!oldest || completedAt < oldest) oldest = completedAt;
        if (!newest || completedAt > newest) newest = completedAt;
      }

      const suggestions = Array.isArray(fm.tuning_suggestions)
        ? (fm.tuning_suggestions as TuningSuggestion[])
        : [];
      if (suggestions.length > 0) {
        detailsForSuggestionRollup.push({ id: String(fm.id ?? ''), suggestions });
      }
    }

    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    const meanScores: AuditScores | null =
      scoredCount > 0
        ? {
            correctness: Number((totalScores.correctness / scoredCount).toFixed(2)),
            completeness: Number((totalScores.completeness / scoredCount).toFixed(2)),
            efficiency: Number((totalScores.efficiency / scoredCount).toFixed(2)),
          }
        : null;

    const out: AuditAggregate = {
      scope: { project: projectFilter },
      total_audits: total,
      verdict_distribution: verdictCounts,
      top_tags: topTags,
      top_tuning_suggestions: aggregateTuningSuggestions(detailsForSuggestionRollup),
      mean_scores: meanScores,
      time_range: { oldest, newest },
    };
    return out;
  });
};
