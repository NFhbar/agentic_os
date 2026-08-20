// Shared GitHub-PR building blocks: token/client caching, PR-url parsing,
// surgical frontmatter writeback, and the PR-state refresh TTL.
//
// These started life inside the changes route (its per-change `pr` / `pr/sync`
// endpoints). The reviews route needs the same primitives to batch-refresh
// merged/closed state across every open PR, and the keep-route-modules-
// independent rule says a route must never import another route. So they live
// here and both routes consume them — one token read, one Octokit instance,
// one URL grammar, one writeback semantic.
//
// Everything below is I/O-light: the only side effects are reading the PAT
// file once and constructing the client. The TTL helpers are pure so they can
// be unit-tested without a network or a clock.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import { REPO_ROOT } from '../repo.js';

// ---------------------------------------------------------------------------
// Token + client
// ---------------------------------------------------------------------------

// Lazy-load + cache the GitHub PAT from mcps/github/.env. Read at first
// request, cached for the dashboard process lifetime. Rotate by editing the
// file + restarting the dashboard (matches the MCP server's contract).
let _githubToken: string | null | undefined;
export function getGithubToken(): string | null {
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
export function getOctokit(): Octokit | null {
  if (_octokit) return _octokit;
  const token = getGithubToken();
  if (!token) return null;
  _octokit = new Octokit({ auth: token });
  return _octokit;
}

// ---------------------------------------------------------------------------
// PR url grammar
// ---------------------------------------------------------------------------

// Parse `owner/repo` and `pull_number` from a PR URL. Returns null when
// the URL doesn't match the canonical github.com/<owner>/<repo>/pull/<n> shape.
export function parsePrUrl(
  prUrl: string,
): { owner: string; repo: string; pull_number: number } | null {
  const m = prUrl.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], pull_number: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// Frontmatter writeback
// ---------------------------------------------------------------------------

// Surgical frontmatter field update — preserves comments, ordering, and the
// rest of the .md body. For each key in `updates`, replaces the value if the
// field already exists in the frontmatter, or appends to the end of the
// frontmatter block if it's new.
export function updateFrontmatterFields(content: string, updates: Record<string, string>): string {
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

// ---------------------------------------------------------------------------
// PR-state refresh TTL — pure decision core
// ---------------------------------------------------------------------------

// How long a recorded PR state stays authoritative before a batch refresh
// will re-check it against GitHub. A merge is not time-critical (the row it
// affects is a triage list, not a gate), and every re-check costs an API call
// per PR, so the window is generous.
export const PR_STATE_TTL_MS = 30 * 60 * 1000;

// One review's PR-state bookkeeping, as read off the entry's frontmatter.
export interface PrStateRecord {
  // Canonical PR url. Null/absent means there is nothing to check.
  prUrl: string | null;
  // Last recorded live state. `merged` and `closed` are terminal — a PR never
  // leaves them, so once recorded there is no reason to spend another call.
  prState: string | null;
  // ISO timestamp of the last successful GitHub check, or null if never.
  checkedAt: string | null;
  // Linked change's lifecycle status when the review has one, else null. A
  // change that already reached a terminal status carries the same "nothing
  // left to learn" signal as a terminal `prState`.
  changeStatus: string | null;
}

export type PrRefreshSkipReason = 'no-pr-url' | 'unparseable-pr-url' | 'already-terminal' | 'fresh';

export type PrRefreshDecision = { check: true } | { check: false; reason: PrRefreshSkipReason };

// Decide whether one review's PR is worth a GitHub round-trip right now.
// Pure: `nowMs` and `force` are inputs, never read from the ambient clock or
// request, so the whole rule set is unit-testable.
//
// Order matters — the cheapest, most permanent disqualifiers come first so a
// long-merged PR is never reported as merely "fresh".
export function decidePrRefresh(
  record: PrStateRecord,
  nowMs: number,
  force = false,
  ttlMs: number = PR_STATE_TTL_MS,
): PrRefreshDecision {
  if (!record.prUrl) return { check: false, reason: 'no-pr-url' };
  if (!parsePrUrl(record.prUrl)) return { check: false, reason: 'unparseable-pr-url' };
  if (record.prState === 'merged' || record.prState === 'closed') {
    return { check: false, reason: 'already-terminal' };
  }
  if (record.changeStatus === 'merged' || record.changeStatus === 'abandoned') {
    return { check: false, reason: 'already-terminal' };
  }
  if (force) return { check: true };
  if (isPrStateFresh(record.checkedAt, nowMs, ttlMs)) {
    return { check: false, reason: 'fresh' };
  }
  return { check: true };
}

// True when a recorded check is recent enough to trust. An absent or
// unparseable stamp is never fresh (fail open — re-check rather than skip
// forever on a corrupt timestamp). A stamp in the future is treated as fresh:
// clock skew should not cause a refresh storm.
export function isPrStateFresh(
  checkedAt: string | null | undefined,
  nowMs: number,
  ttlMs: number = PR_STATE_TTL_MS,
): boolean {
  if (!checkedAt) return false;
  const t = Date.parse(checkedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t < ttlMs;
}

// Collapse GitHub's two-field truth (`state` + `merged`) into the single
// value recorded on the entry. `merged` wins: a merged PR is `state: closed`
// on GitHub, and "closed" would read as "abandoned" to anyone scanning rows.
export function derivePrState(pr: { state?: string | null; merged?: boolean | null }): string {
  if (pr.merged === true) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return 'open';
}
