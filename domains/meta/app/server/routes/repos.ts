// /api/repos — list of pr-review-repo-cache archetype entries.
//
// Backs the PR Review app's Repos tab. Reads
// vault/wiki/development/pr-review-repo-cache/*.md (and any other domain
// hosting cache entries), translates the archetype shape into the Repo[]
// shape the frontend already renders against, and joins in a `reviews`
// count by scanning pr-review entries for matching owner/repo. Read-only —
// mutations dispatch dev-cache-pr-review-repo via /api/action.

import type { Dirent } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type { KnowledgeSummary, Repo } from './repos.types.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./repos.types.js per standard-shared-types.
export type { KnowledgeSummary, ReposListResponse, Repo } from './repos.types.js';

const AUDIT_LOG = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');

// js-yaml parses bare ISO timestamps as JavaScript Date objects, not strings,
// so a naive `typeof v === 'string'` check on frontmatter timestamp fields
// would always fail and return null. Normalize both shapes to an ISO string.
function asISOString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

// ---------------------------------------------------------------------------
// Walk + lookups
// ---------------------------------------------------------------------------

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

// Count pr-review entries per <owner>/<repo> in one pass. Returns a map
// keyed by `${owner}/${repo}` (case-preserving). Reads frontmatter only —
// pr-review entries carry owner+repo only via pr_url, so we parse that.
async function buildReviewCounts(files: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { fm, parseError } = parseFrontmatter(content);
    if (parseError) continue;
    if (fm.type !== 'pr-review') continue;
    const url = typeof fm.pr_url === 'string' ? fm.pr_url : '';
    const m = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?\/pull\/\d+/i);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// Walk for repo-knowledge entries, keyed by `${owner}/${repo}`. One entry
// per repo (singleton-like); duplicates would be a data integrity issue —
// last-write wins here, audit flags it separately.
async function buildKnowledgeMap(files: string[]): Promise<Map<string, KnowledgeSummary>> {
  const out = new Map<string, KnowledgeSummary>();
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { fm, parseError } = parseFrontmatter(content);
    if (parseError) continue;
    if (fm.type !== 'repo-knowledge') continue;
    const key = `${fm.owner ?? ''}/${fm.repo ?? ''}`;
    const rawStatus = typeof fm.status === 'string' ? fm.status : '';
    const status: KnowledgeSummary['status'] =
      rawStatus === 'ready' || rawStatus === 'analyzing' || rawStatus === 'error'
        ? rawStatus
        : 'ready';
    out.set(key, {
      analyzedAt: asISOString(fm.analyzed_at),
      analyzerModel: typeof fm.analyzer_model === 'string' ? fm.analyzer_model : null,
      basedOnCommit: typeof fm.based_on_commit === 'string' ? fm.based_on_commit : null,
      status,
    });
  }
  return out;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function computeKnowledgeStale(
  knowledge: KnowledgeSummary | undefined,
  cacheHeadSha: string | null,
): boolean {
  if (!knowledge) return false;
  // Calendar drift — even an unchanged repo benefits from periodic re-analysis.
  if (knowledge.analyzedAt) {
    const age = Date.now() - Date.parse(knowledge.analyzedAt);
    if (!Number.isNaN(age) && age > THIRTY_DAYS_MS) return true;
  }
  // Structural drift — code has moved since the analysis ran.
  if (cacheHeadSha && knowledge.basedOnCommit && cacheHeadSha !== knowledge.basedOnCommit) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Translation — archetype shape → frontend Repo shape
// ---------------------------------------------------------------------------

function mapStatus(s: string | undefined): Repo['status'] {
  if (s === 'ready') return 'indexed';
  if (s === 'indexing') return 'indexing';
  if (s === 'error') return 'error';
  return 'stale'; // unknown / missing → stale
}

function humanSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const ms = Date.now() - t;
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function pickPrimaryLang(languages: unknown): string {
  // Phase 3.5 Stage 1 stores languages as YAML tuples [['ts', 1284], …].
  // js-yaml parses these as nested arrays. First tuple's first element wins.
  if (!Array.isArray(languages) || languages.length === 0) return 'unknown';
  const first = languages[0];
  if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  return 'unknown';
}

function normalizeLanguages(languages: unknown): Array<[string, number]> {
  // Stage 1 stores languages as YAML tuples of [extension, file_count].
  // The frontend's LangBar treats the second element as a PERCENTAGE (matching
  // the mock contract that the type was lifted from). Convert counts → percent
  // here so the bar fills 100% with proportional segments.
  if (!Array.isArray(languages)) return [];
  const counts: Array<[string, number]> = [];
  for (const item of languages) {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number') {
      counts.push([item[0], item[1]]);
    }
  }
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return [];

  // Convert with largest-remainder rounding so the percentages sum to exactly
  // 100. Floor everyone first, then distribute the leftover to the entries
  // with the largest fractional parts. Avoids the "row of bars adds up to 97%"
  // visual bug that naive Math.round produces.
  const floats = counts.map(([l, n]) => ({ lang: l, exact: (n / total) * 100 }));
  const floored = floats.map((f) => ({
    lang: f.lang,
    whole: Math.floor(f.exact),
    frac: f.exact - Math.floor(f.exact),
  }));
  let remainder = 100 - floored.reduce((s, f) => s + f.whole, 0);
  floored.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < floored.length && remainder > 0; i++) {
    floored[i].whole += 1;
    remainder--;
  }
  // Restore original order (by count descending — matches the input order).
  const langToWhole = new Map(floored.map((f) => [f.lang, f.whole]));
  return counts.map(([l]) => [l, langToWhole.get(l) ?? 0]);
}

function toRepo(
  fm: Record<string, unknown>,
  reviewCount: number,
  knowledge: KnowledgeSummary | undefined,
): Repo {
  const owner = String(fm.owner ?? '');
  const repo = String(fm.repo ?? '');
  const cacheHeadSha = typeof fm.head_sha === 'string' ? fm.head_sha : null;
  return {
    id: String(fm.id ?? ''),
    name: repo,
    org: owner,
    branch: String(fm.default_branch ?? '—'),
    lang: pickPrimaryLang(fm.languages),
    files: Number(fm.files_count ?? 0),
    size: humanSize(typeof fm.size_bytes === 'number' ? fm.size_bytes : undefined),
    indexed: relativeTime(asISOString(fm.last_pulled) ?? undefined),
    status: mapStatus(fm.status as string | undefined),
    reviews: reviewCount,
    error: typeof fm.last_error === 'string' ? fm.last_error : undefined,
    languages: normalizeLanguages(fm.languages),
    analyzedAt: knowledge?.analyzedAt ?? null,
    analyzerModel: knowledge?.analyzerModel ?? null,
    knowledgeStatus: knowledge?.status ?? 'missing',
    knowledgeStale: computeKnowledgeStale(knowledge, cacheHeadSha),
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const reposRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/repos — list all cache entries with per-repo review counts.
  fastify.get('/', async () => {
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);

    // Single walk; three joins built from one file-content read pass each.
    const [reviewCounts, knowledgeMap] = await Promise.all([
      buildReviewCounts(files),
      buildKnowledgeMap(files),
    ]);

    // Pair each Repo with the raw last_pulled timestamp so we can sort
    // newest-first by the source-of-truth value (the formatted `indexed`
    // string is lossy — "5h ago" and "1d ago" don't compare lexically).
    const paired: Array<{ row: Repo; pulledAt: number }> = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'pr-review-repo-cache') continue;
      const key = `${fm.owner ?? ''}/${fm.repo ?? ''}`;
      const lastPulledIso = asISOString(fm.last_pulled);
      const pulled = lastPulledIso ? Date.parse(lastPulledIso) : 0;
      paired.push({
        row: toRepo(fm, reviewCounts.get(key) ?? 0, knowledgeMap.get(key)),
        pulledAt: Number.isNaN(pulled) ? 0 : pulled,
      });
    }
    paired.sort((a, b) => b.pulledAt - a.pulledAt);
    return { repos: paired.map((p) => p.row) };
  });

  // DELETE /api/repos/:id — evict one cache cleanly. Removes:
  //   1. the cache dir at .claude/state/pr-review-cache/<owner>/<repo>/
  //   2. the empty <owner>/ parent dir (if no other repos share it)
  //   3. the cache archetype entry (vault)
  //   4. the companion repo-knowledge entry (vault) — matched by owner+repo
  // Then records a single 'remove-repo-cache' event for traceability.
  //
  // The cache_path comes from the entry's frontmatter so the API can never
  // delete something the user didn't intend — we validate the resolved path
  // stays inside the cache root before any rm().
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    const cacheRoot = resolve(REPO_ROOT, '.claude', 'state', 'pr-review-cache');

    // First pass: find the target cache entry by id.
    let targetFile: string | null = null;
    let targetFm: Record<string, unknown> | null = null;
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'pr-review-repo-cache' || fm.id !== id) continue;
      targetFile = file;
      targetFm = fm;
      break;
    }

    if (!targetFile || !targetFm) {
      reply.code(404);
      return { ok: false, error: `repo cache "${id}" not found` };
    }

    const owner = String(targetFm.owner ?? '');
    const repo = String(targetFm.repo ?? '');
    const removed: string[] = [];

    // Step 1: remove cache dir (validated to be inside cache root).
    const localRaw = typeof targetFm.local_path === 'string' ? targetFm.local_path : '';
    if (localRaw) {
      const absCache = isAbsolute(localRaw) ? resolve(localRaw) : resolve(REPO_ROOT, localRaw);
      const rel = relative(cacheRoot, absCache);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        try {
          await rm(absCache, { recursive: true, force: true });
          removed.push(relative(REPO_ROOT, absCache));
        } catch {
          /* tolerate — vault entry delete below is still useful */
        }

        // Step 2: prune the empty <owner>/ parent shell if nothing else uses it.
        // rmdir fails (non-empty) when other repos under the same owner are
        // cached — that's correct behavior, leave it alone in that case.
        const ownerDir = dirname(absCache);
        if (ownerDir !== cacheRoot) {
          try {
            await rmdir(ownerDir);
          } catch {
            /* parent has other entries OR already gone — both fine */
          }
        }
      }
    }

    // Step 3: remove the cache archetype entry.
    try {
      await unlink(targetFile);
      removed.push(relative(REPO_ROOT, targetFile));
    } catch {
      reply.code(500);
      return { ok: false, error: 'failed to remove cache entry file' };
    }

    // Step 4: remove the companion repo-knowledge entry, if present. Match by
    // type + owner + repo (deterministic — slug is owner_lower + repo_lower
    // but matching by frontmatter is more defensive against slug-format drift).
    for (const file of files) {
      if (file === targetFile) continue;
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'repo-knowledge') continue;
      if (fm.owner !== owner || fm.repo !== repo) continue;
      try {
        await unlink(file);
        removed.push(relative(REPO_ROOT, file));
      } catch {
        /* tolerate — main cache eviction already succeeded */
      }
      break;
    }

    // Step 5: dual-write the event — JSONL audit trail + events.db row.
    // Both writes are best-effort; the eviction itself has already succeeded.
    const ts = new Date().toISOString();
    const eventDescription = `Removed cache for ${owner}/${repo} (${removed.length} artifacts)`;

    try {
      await mkdir(dirname(AUDIT_LOG), { recursive: true });
      await appendFile(
        AUDIT_LOG,
        `${JSON.stringify({
          ts,
          action: 'remove-repo-cache',
          args: { owner, repo },
          files_touched: removed,
          exit_status: 0,
        })}\n`,
      );
    } catch {
      /* JSONL write is best-effort */
    }

    try {
      // @ts-expect-error — pure-ESM .mjs helper with no .d.ts
      const { recordEvent } = await import('../../../../../scripts/events-db.mjs');
      recordEvent({
        ts,
        kind: 'dashboard',
        action: 'remove-repo-cache',
        source: 'dashboard',
        skill: null,
        status: 'success',
        description: eventDescription,
        files_touched: removed,
      });
    } catch {
      /* events.db write is best-effort */
    }

    return { ok: true, id, removed };
  });
};
