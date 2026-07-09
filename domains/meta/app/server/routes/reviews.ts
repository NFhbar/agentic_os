// /api/reviews — list + detail of pr-review archetype entries.
//
// Reads vault/wiki/<domain>/pr-review/*.md, parses frontmatter (full YAML via
// js-yaml so the nested `config:` block survives) plus the Pass/Comments/Stats
// body sections, and translates the archetype shape into the ReviewRow /
// ReviewDetail shapes the frontend already renders against. Write path is
// /api/action (skill dispatch) — this module is read-only.

import type { Dirent } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type {
  LinkedChange,
  PassStats,
  RecentRun,
  ReviewComment,
  ReviewDetail,
  ReviewPass,
  ReviewRow,
  Severity,
} from './reviews.types.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./reviews.types.js per standard-shared-types.
export type {
  CommentState,
  LinkedChange,
  PassStats,
  PassStatus,
  RecentRun,
  ReviewComment,
  ReviewDetail,
  ReviewPass,
  ReviewRow,
  Severity,
} from './reviews.types.js';

// ---------------------------------------------------------------------------
// Filesystem walk + entry parsing
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

// ---------------------------------------------------------------------------
// Body parser — walks `## Pass N` sections and extracts Comments + Stats.
// Markdown shape is the contract from archetype-pr-review.md § Body sections.
// ---------------------------------------------------------------------------

interface RawComment {
  n: number;
  category: string;
  severity: string;
  file: string | null;
  // `line` is the anchor / range END; `startLine` is the range START (null for
  // single-line comments). A legacy `- line: N-M` header parses to
  // startLine=N, line=M. `side` / `startSide` carry the diff side when set.
  line: number | null;
  startLine: number | null;
  side: string | null;
  startSide: string | null;
  status: string;
  prior: string | null;
  body: string;
  // Phase 2 — optional rationales captured by the per-comment mutation
  // endpoint. Both null when the user hasn't actioned the comment.
  acceptNote: string | null;
  dismissReason: string | null;
  // Phase 4 — GitHub publish receipt (set by dev-pr-review-publish).
  githubCommentId: number | null;
  githubReviewId: number | null;
  // Phase 5 — set by dev-write-change after addressing the comment in code.
  actedOnAt: string | null;
  // Set by dev-pr-review continuation passes when a prior-pass comment is
  // confirmed resolved by the new commit. `resolvedInPass` is the pass
  // number that confirmed the resolution (typically priorPass + 1).
  resolvedAt: string | null;
  resolvedInPass: number | null;
}

interface RawPass {
  n: number;
  started: string;
  model: string | null;
  focusAreas: string;
  style: string | null;
  comments: RawComment[];
  stats: { files: number; additions: number; deletions: number; commits: number };
}

function extractSummary(body: string): string {
  const m = body.match(/^## Summary\n([\s\S]*?)(?=\n## |\n$|$)/m);
  return m ? m[1].trim() : '';
}

function extractPasses(body: string): RawPass[] {
  // Two-pass parser. JS regex has no `\Z` (end-of-string) anchor, and using
  // `$` with the `m` flag matches every line ending — both choices make a
  // single greedy regex unreliable here. So: first find every pass header's
  // position, then slice content between consecutive headers (or to end of
  // string for the last pass).
  const passes: RawPass[] = [];
  const headerRe = /^## Pass (\d+)\s*[—-]\s*([^\n]+)/gm;
  const headers: Array<{ pos: number; n: number; started: string; headerLen: number }> = [];
  for (const m of body.matchAll(headerRe)) {
    if (m.index === undefined) continue;
    headers.push({
      pos: m.index,
      n: Number(m[1]),
      started: m[2].trim(),
      headerLen: m[0].length,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].pos + headers[i].headerLen;
    const end = i + 1 < headers.length ? headers[i + 1].pos : body.length;
    const content = body.slice(start, end);
    passes.push({
      n: headers[i].n,
      started: headers[i].started,
      ...extractPassConfig(content),
      comments: extractComments(content),
      stats: extractStats(content),
    });
  }
  return passes;
}

function extractPassConfig(passContent: string): {
  model: string | null;
  focusAreas: string;
  style: string | null;
} {
  const cfg = passContent.match(/^### Pass config\n([\s\S]*?)(?=\n### |\n$|$)/m);
  if (!cfg) return { model: null, focusAreas: '', style: null };
  const lines = cfg[1].split('\n');
  let model: string | null = null;
  let focusAreas = '';
  let style: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('- model:')) model = t.slice(8).trim();
    else if (t.startsWith('- focus areas:')) focusAreas = t.slice(14).trim();
    else if (t.startsWith('- style:')) style = t.slice(8).trim();
  }
  return { model, focusAreas, style };
}

function extractStats(passContent: string): RawPass['stats'] {
  const block = passContent.match(/^### Stats\n([\s\S]*?)(?=\n## |\n### |\n$|$)/m);
  const stats = { files: 0, additions: 0, deletions: 0, commits: 0 };
  if (!block) return stats;
  for (const line of block[1].split('\n')) {
    const t = line.trim();
    const filesM = t.match(/^- files:\s*(\d+)/);
    if (filesM) stats.files = Number(filesM[1]);
    const plusMinus = t.match(/^- \+(\d+)\s*\/\s*-(\d+)/);
    if (plusMinus) {
      stats.additions = Number(plusMinus[1]);
      stats.deletions = Number(plusMinus[2]);
    }
    const cM = t.match(/^- commits:\s*(\d+)/);
    if (cM) stats.commits = Number(cM[1]);
  }
  return stats;
}

function extractComments(passContent: string): RawComment[] {
  // Comments live under "### Comments" and are split by "#### Comment <n>: …".
  // Use indexOf-based slicing instead of regex lookaheads — JS regex `$` with
  // the `m` flag matches end-of-LINE not end-of-string, so a blank line right
  // after "### Comments\n" was prematurely closing the section.
  const startIdx = passContent.indexOf('### Comments');
  if (startIdx < 0) return [];
  const afterHeader = passContent.slice(startIdx + '### Comments'.length);
  // Section ends at the next `### ` subheading (Stats / anything else) or at
  // the next `## ` major heading (next Pass). Match `\n### ` or `\n## `
  // (the trailing space disambiguates from `####` comment markers).
  const endMatch = afterHeader.search(/\n(?:### |## )/);
  const sec = endMatch >= 0 ? afterHeader.slice(0, endMatch) : afterHeader;
  const out: RawComment[] = [];
  // Same two-pass trick as extractPasses — JS regex has no end-of-string
  // anchor that works with `gm`, so collect header positions first then
  // slice content between them.
  const headerRe = /^#### Comment (\d+):\s*([^·\n]+?)\s*·\s*([^\n]+)/gm;
  const headers: Array<{
    pos: number;
    n: number;
    category: string;
    severity: string;
    headerLen: number;
  }> = [];
  for (const m of sec.matchAll(headerRe)) {
    if (m.index === undefined) continue;
    headers.push({
      pos: m.index,
      n: Number(m[1]),
      category: m[2].trim(),
      severity: m[3].trim(),
      headerLen: m[0].length,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const n = headers[i].n;
    const category = headers[i].category;
    const severity = headers[i].severity;
    const blockStart = headers[i].pos + headers[i].headerLen;
    const blockEnd = i + 1 < headers.length ? headers[i + 1].pos : sec.length;
    // Trim leading newlines — the block starts at the newline right after
    // the `#### Comment …` header, and we don't want the resulting empty
    // first line to trigger the "first blank line ends the header list"
    // rule below before any header lines have been seen.
    const block = sec.slice(blockStart, blockEnd).replace(/^\n+/, '');
    // Header list: - file:, - line:, - status:, - prior:, - accept_note:,
    // - dismiss_reason:, - github_comment_id:, - github_review_id:,
    // - acted_on_at:, - resolved_at:, - resolved_in_pass:
    let file: string | null = null;
    let line: number | null = null;
    let startLine: number | null = null;
    let side: string | null = null;
    let startSide: string | null = null;
    let status = 'new';
    let prior: string | null = null;
    let acceptNote: string | null = null;
    let dismissReason: string | null = null;
    let githubCommentId: number | null = null;
    let githubReviewId: number | null = null;
    let actedOnAt: string | null = null;
    let resolvedAt: string | null = null;
    let resolvedInPass: number | null = null;
    const bodyLines: string[] = [];
    let inHeader = true;
    for (const ln of block.split('\n')) {
      if (inHeader) {
        const fileM = ln.match(/^- file:\s*`?([^`\n]+?)`?$/);
        const lineM = ln.match(/^- line:\s*(\d+|null|[\d-]+)/);
        // Range start (multi-line comments) + explicit diff sides. Match on the
        // KEY (not just a well-formed value) so an unrecognized value can never
        // fall through and flip `inHeader` — that would strand `- status:` in
        // the body and resurrect a stale status on the next parse.
        const startLineM = ln.match(/^- start_line:\s*(.*?)\s*$/);
        const sideM = ln.match(/^- side:\s*(.*?)\s*$/);
        const startSideM = ln.match(/^- start_side:\s*(.*?)\s*$/);
        // Status can be hyphenated (e.g. `published-as-body`, `acted-on`,
        // `request-changes`), so allow letters + hyphens.
        const statusM = ln.match(/^- status:\s*([\w-]+)/);
        const priorM = ln.match(/^- prior:\s*(\S+)/);
        // Notes/reasons may be quoted ("..."), single-quoted ('...'), or bare.
        // Strip wrapping quotes if present so the surfaced string is clean.
        const acceptM = ln.match(/^- accept_note:\s*(.*?)\s*$/);
        const dismissM = ln.match(/^- dismiss_reason:\s*(.*?)\s*$/);
        const ghCommentM = ln.match(/^- github_comment_id:\s*(\d+)/);
        const ghReviewM = ln.match(/^- github_review_id:\s*(\d+)/);
        const actedOnM = ln.match(/^- acted_on_at:\s*(\S+)/);
        const resolvedAtM = ln.match(/^- resolved_at:\s*(\S+)/);
        const resolvedInPassM = ln.match(/^- resolved_in_pass:\s*(\d+)/);
        if (fileM) {
          file = fileM[1].trim() === 'null' ? null : fileM[1].trim();
          continue;
        }
        if (lineM) {
          const v = lineM[1];
          if (v === 'null') {
            line = null;
          } else if (v.includes('-')) {
            // Legacy range string `N-M`: preserve today's first-number-as-start
            // behavior and capture the end (M) as the anchor line.
            const parts = v.split('-');
            if (startLine == null) startLine = Number(parts[0]);
            line = Number(parts[parts.length - 1]);
          } else {
            line = Number(v);
          }
          continue;
        }
        if (startLineM) {
          const sv = startLineM[1].trim();
          const n = sv === '' || sv === 'null' ? Number.NaN : Number(sv);
          startLine = Number.isNaN(n) ? null : n;
          continue;
        }
        if (sideM) {
          side = sideM[1].trim() || null;
          continue;
        }
        if (startSideM) {
          startSide = startSideM[1].trim() || null;
          continue;
        }
        if (statusM) {
          status = statusM[1];
          continue;
        }
        if (priorM) {
          prior = priorM[1];
          continue;
        }
        if (acceptM) {
          acceptNote = stripQuotes(acceptM[1]);
          continue;
        }
        if (dismissM) {
          dismissReason = stripQuotes(dismissM[1]);
          continue;
        }
        if (ghCommentM) {
          githubCommentId = Number(ghCommentM[1]);
          continue;
        }
        if (ghReviewM) {
          githubReviewId = Number(ghReviewM[1]);
          continue;
        }
        if (actedOnM) {
          actedOnAt = stripQuotes(actedOnM[1]);
          continue;
        }
        if (resolvedAtM) {
          resolvedAt = stripQuotes(resolvedAtM[1]);
          continue;
        }
        if (resolvedInPassM) {
          resolvedInPass = Number(resolvedInPassM[1]);
          continue;
        }
        if (ln.trim() === '') {
          // First blank line ends the header list; body starts after it.
          inHeader = false;
          continue;
        }
        // Non-list, non-blank → no header for this comment; treat as body.
        inHeader = false;
        bodyLines.push(ln);
      } else {
        bodyLines.push(ln);
      }
    }
    out.push({
      n,
      category,
      severity,
      file,
      line,
      startLine,
      side,
      startSide,
      status,
      prior,
      body: bodyLines.join('\n').trim(),
      acceptNote,
      dismissReason,
      githubCommentId,
      githubReviewId,
      actedOnAt,
      resolvedAt,
      resolvedInPass,
    });
  }
  return out;
}

// Strip a single layer of wrapping single- or double-quotes if present.
// Used for accept_note / dismiss_reason whose values may have been quoted
// when written (necessary when they contain colons / leading whitespace).
function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    // Unescape `''` → `'` for single-quoted YAML form.
    return first === "'" ? s.slice(1, -1).replace(/''/g, "'") : s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Translation — archetype shape → frontend mock shape
// ---------------------------------------------------------------------------

const RESULT_MAP: Record<string, ReviewRow['result']> = {
  approved: 'approve',
  'request-changes': 'changes',
  comment: null,
  none: null,
};

const SEVERITY_MAP: Record<string, 'bug' | 'nit' | 'suggestion'> = {
  bug: 'bug',
  blocker: 'bug', // collapse blocker into bug — frontend's only 3-way bucket
  nit: 'nit',
  suggestion: 'suggestion',
};

const AGENT_KINDS = new Set(['logic', 'security', 'performance', 'style', 'tests', 'docs']);

function mapStatus(s: string | undefined): ReviewRow['status'] {
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  return 'running'; // pending + running both render as in-flight
}

function computeSeverityFromComments(comments: RawComment[]): Severity {
  const out: Severity = { bug: 0, nit: 0, suggestion: 0 };
  for (const c of comments) {
    const key = SEVERITY_MAP[c.severity];
    if (key) out[key]++;
  }
  return out;
}

function humanDuration(startISO: string | undefined, endISO: string | undefined): string {
  if (!startISO || !endISO) return '—';
  const ms = Date.parse(endISO) - Date.parse(startISO);
  if (Number.isNaN(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `0m ${String(s).padStart(2, '0')}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
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

function toReviewRow(
  fm: Record<string, unknown>,
  filePath: string,
  comments: RawComment[],
  changeMetaById: Map<string, { status: string; prReviewStatus: string | null }>,
): ReviewRow {
  const changeId = typeof fm.change_id === 'string' ? fm.change_id : null;
  const meta = changeId ? changeMetaById.get(changeId) : undefined;
  return {
    id: String(fm.id ?? ''),
    pr: typeof fm.pr_number === 'number' ? `#${fm.pr_number}` : '',
    title: String(fm.title ?? '(untitled)'),
    repo: String(fm.repo ?? ''),
    branch: String(fm.branch ?? ''),
    author: String(fm.pr_author ?? ''),
    status: mapStatus(fm.status as string | undefined),
    result: typeof fm.result === 'string' ? (RESULT_MAP[fm.result] ?? null) : null,
    severity: computeSeverityFromComments(comments),
    duration: humanDuration(fm.started as string, fm.completed as string),
    started: relativeTime(fm.started as string),
    files: Number(fm.files_changed ?? 0),
    additions: Number(fm.additions ?? 0),
    deletions: Number(fm.deletions ?? 0),
    path: relative(REPO_ROOT, filePath),
    changeStatus: meta?.status ?? null,
    changePrReviewStatus: meta?.prReviewStatus ?? null,
    changeId,
  };
}

function toReviewComment(raw: RawComment, passN: number): ReviewComment {
  const agent = AGENT_KINDS.has(raw.category) ? (raw.category as ReviewComment['agent']) : 'logic';
  const sev = SEVERITY_MAP[raw.severity] ?? 'suggestion';
  const passStatus = raw.status === 'resolved' ? 'resolved' : raw.prior ? 'unresolved' : 'new';
  // Anchor: for a single-line comment, startLine is the anchor and endLine is
  // null. For a range (explicit `- start_line:` or a legacy `- line: N-M`),
  // startLine is the range start and endLine the end. Guard endLine so a
  // degenerate start==end (or start>end) renders as a single line.
  const startLine = raw.startLine ?? raw.line ?? 0;
  const endLine =
    raw.startLine != null && raw.line != null && raw.line > raw.startLine ? raw.line : null;
  // Collapse terminal "yes, this was real" statuses into 'accepted' for the
  // action-button UI (the buttons disable on terminal states anyway — the
  // dedicated badges take over). Covers:
  //   - accepted: user clicked Accept
  //   - published: posted to GitHub as an inline comment
  //   - published-as-body: surfaced in the review body
  //   - acted-on: addressed in code via dev-write-change ADDRESS-COMMENTS
  const state =
    raw.status === 'accepted' ||
    raw.status === 'published' ||
    raw.status === 'published-as-body' ||
    raw.status === 'acted-on'
      ? 'accepted'
      : raw.status === 'dismissed'
        ? 'dismissed'
        : 'open';
  return {
    id: `pass-${passN}-comment-${raw.n}`,
    priorId: raw.prior,
    passStatus,
    state,
    status: raw.status,
    severity: sev,
    agent,
    file: raw.file ?? '',
    startLine,
    endLine,
    message: raw.body,
    suggestion: null,
    lang: guessLang(raw.file),
    acceptNote: raw.acceptNote,
    dismissReason: raw.dismissReason,
    githubCommentId: raw.githubCommentId,
    githubReviewId: raw.githubReviewId,
    actedOnAt: raw.actedOnAt,
    resolvedAt: raw.resolvedAt,
    resolvedInPass: raw.resolvedInPass,
  };
}

function guessLang(file: string | null): string {
  if (!file) return 'text';
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'ts',
    js: 'js',
    jsx: 'js',
    py: 'py',
    go: 'go',
    rs: 'rs',
    md: 'md',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'sh',
  };
  return map[ext] ?? ext ?? 'text';
}

function toReviewPass(raw: RawPass, summary: string): ReviewPass {
  const comments = raw.comments.map((c) => toReviewComment(c, raw.n));
  const stats: PassStats = {
    bugs: comments.filter((c) => c.severity === 'bug').length,
    nits: comments.filter((c) => c.severity === 'nit').length,
    suggestions: comments.filter((c) => c.severity === 'suggestion').length,
    resolved: comments.filter((c) => c.passStatus === 'resolved').length,
    stillOpen: comments.filter((c) => c.passStatus === 'unresolved').length,
    fresh: comments.filter((c) => c.passStatus === 'new').length,
  };
  // A pass is "published" the moment any of its comments has been posted to
  // GitHub. The skill stamps github_comment_id per comment on success;
  // partial-publish (e.g. accepted=3, only 2 succeeded) still counts as
  // published — the UI surfaces per-comment state for granular truth.
  // A pass is "published" once any of its comments has reached GitHub in any
  // form — either inline (`github_comment_id` set) or surfaced in the parent
  // review body (`status: published-as-body`). The pass timeline uses this
  // to render a "shipped to GitHub" indicator.
  const published = comments.some(
    (c) => c.githubCommentId != null || c.status === 'published-as-body',
  );
  return {
    id: `pass-${raw.n}`,
    n: raw.n,
    label: `Pass ${raw.n}`,
    commit: '',
    commitMsg: '',
    started: raw.started,
    duration: '—',
    status: 'completed',
    result: null,
    recommendation: null,
    published,
    priorPass: raw.n > 1 ? `pass-${raw.n - 1}` : null,
    summary,
    stats,
    comments,
  };
}

// Narrow the entry's frontmatter `result` field to the four documented values
// (archetype-pr-review § Optional frontmatter). Anything else becomes null —
// the UI treats null as "verdict unknown / publish flow disabled".
const VALID_RESULTS = new Set(['approved', 'request-changes', 'comment', 'none']);
function asResult(v: unknown): ReviewDetail['result'] {
  return typeof v === 'string' && VALID_RESULTS.has(v) ? (v as ReviewDetail['result']) : null;
}

// Project the frontmatter `config:` block into the wire-shape snapshot.
// Returns null when the block is missing OR malformed (any required field
// absent) — the UI surfaces that as a "no snapshot recorded" state rather
// than rendering partial fields that could mislead the reader.
function parseConfigSnapshot(fm: Record<string, unknown>): ReviewDetail['config'] {
  const raw = fm.config;
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const primary_model = typeof c.primary_model === 'string' ? c.primary_model : null;
  const comment_style = typeof c.comment_style === 'string' ? c.comment_style : null;
  const focus_areas = Array.isArray(c.focus_areas)
    ? (c.focus_areas as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;
  const context_strategy = typeof c.context_strategy === 'string' ? c.context_strategy : null;
  // custom_instructions_hash may be null intentionally (empty instructions);
  // null is a valid value, only undefined / wrong-type counts as missing.
  let custom_instructions_hash: string | null = null;
  if (c.custom_instructions_hash === null) {
    custom_instructions_hash = null;
  } else if (typeof c.custom_instructions_hash === 'string') {
    custom_instructions_hash = c.custom_instructions_hash;
  }
  if (!primary_model || !comment_style || !focus_areas || !context_strategy) return null;
  return {
    primary_model,
    comment_style,
    focus_areas,
    context_strategy,
    custom_instructions_hash,
  };
}

// Scan vault/raw/dashboard-actions.jsonl for events relevant to this review.
// Strategy: match the review id against the event's prompt (ai-prompt events)
// or args (skill-completion events). Returns the most recent ~5 dispatches
// newest first, annotated with `silentCompletion: true` when an ai-prompt
// fired but no matching completion event followed.
async function loadRecentRunsForReview(reviewId: string): Promise<RecentRun[]> {
  const path = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  type RawEvent = {
    ts?: string;
    action?: string;
    prompt?: string;
    args?: Record<string, unknown>;
    exit_status?: number | null;
    files_touched?: string[];
  };
  const matching: RawEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e: RawEvent = JSON.parse(line);
      if (!e.ts) continue;
      // Match by id substring in either the prompt body or the args. Both
      // routes are how the publish/review-publish/comment-mutate skills
      // identify their target review.
      const haystack = `${e.prompt ?? ''} ${JSON.stringify(e.args ?? {})}`;
      if (haystack.includes(reviewId)) matching.push(e);
    } catch {
      /* skip malformed line */
    }
  }
  // Newest first; cap at 5 to keep the header indicator compact.
  matching.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  const recent = matching.slice(0, 5);

  // Detect silent completion: an ai-prompt with no matching skill-completion
  // event within a small time window after it. The completion event would
  // share the same skill name (e.g. "pr-review-publish") and a later ts.
  const result: RecentRun[] = [];
  for (const e of recent) {
    const action = e.action ?? 'unknown';
    const exitStatus = e.exit_status ?? null;
    let summary = '';
    let silentCompletion = false;

    if (action === 'ai-prompt') {
      // Extract the skill name from the prompt body — first occurrence of
      // ".claude/skills/<name>/SKILL.md" is the dispatched skill.
      const skillMatch = (e.prompt ?? '').match(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/);
      const skillName = skillMatch ? skillMatch[1] : 'unknown';
      summary = `dispatched ${skillName}`;
      // Was there a matching completion event AFTER this ai-prompt?
      // Completion event's action would be the skill name minus the "dev-"
      // prefix (e.g. dev-pr-review-publish → pr-review-publish).
      const completionAction = skillName.replace(/^dev-/, '');
      const after = matching.filter(
        (m) => (m.ts ?? '') > (e.ts ?? '') && m.action === completionAction,
      );
      silentCompletion = after.length === 0;
    } else {
      // Completion event from a skill that ran record-dashboard-action.mjs.
      const fileCount = Array.isArray(e.files_touched) ? e.files_touched.length : 0;
      summary =
        fileCount > 0 ? `wrote ${fileCount} file${fileCount === 1 ? '' : 's'}` : 'completed';
    }
    result.push({
      ts: e.ts ?? '',
      action,
      exitStatus,
      summary,
      silentCompletion,
    });
  }
  return result;
}

// Look up the linked change's pr_review_* fields when the review's
// frontmatter carries `change_id`. Returns null for external PRs. We walk
// the wiki dir rather than using the manifest to keep this route's deps
// minimal — same pattern as the entry-walk in the GET handler.
async function loadLinkedChange(changeId: string | null): Promise<LinkedChange | null> {
  if (!changeId) return null;
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf8');
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'change' || fm.id !== changeId) continue;
      const prReadyAt = fm.pr_ready_at;
      return {
        id: changeId,
        prReviewStatus: typeof fm.pr_review_status === 'string' ? fm.pr_review_status : null,
        prReadyAt:
          typeof prReadyAt === 'string'
            ? prReadyAt
            : prReadyAt instanceof Date
              ? prReadyAt.toISOString()
              : null,
      };
    } catch {
      /* skip */
    }
  }
  return null;
}

async function toReviewDetailWithRuns(
  fm: Record<string, unknown>,
  body: string,
): Promise<ReviewDetail> {
  const summary = extractSummary(body);
  const rawPasses = extractPasses(body);
  const recentRuns = await loadRecentRunsForReview(String(fm.id ?? ''));
  const linkedChange = await loadLinkedChange(
    typeof fm.change_id === 'string' ? fm.change_id : null,
  );
  return {
    id: String(fm.id ?? ''),
    pr: typeof fm.pr_number === 'number' ? `#${fm.pr_number}` : '',
    title: String(fm.title ?? '(untitled)'),
    repo: String(fm.repo ?? ''),
    branch: String(fm.branch ?? ''),
    base: String(fm.base ?? ''),
    author: String(fm.pr_author ?? ''),
    url: String(fm.pr_url ?? ''),
    files: Number(fm.files_changed ?? 0),
    additions: Number(fm.additions ?? 0),
    deletions: Number(fm.deletions ?? 0),
    result: asResult(fm.result),
    published: fm.published === true,
    passes: rawPasses.map((p) => toReviewPass(p, summary)),
    recentRuns,
    linkedChange,
    config: parseConfigSnapshot(fm),
  };
}

function toReviewDetail(fm: Record<string, unknown>, body: string): ReviewDetail {
  // Sync overload — used by the PUT comment-mutate endpoint which doesn't
  // want to block on jsonl scan or linked-change file walk. Returns empty
  // recentRuns + null linkedChange; the next GET will repopulate.
  const summary = extractSummary(body);
  const rawPasses = extractPasses(body);
  return {
    id: String(fm.id ?? ''),
    pr: typeof fm.pr_number === 'number' ? `#${fm.pr_number}` : '',
    title: String(fm.title ?? '(untitled)'),
    repo: String(fm.repo ?? ''),
    branch: String(fm.branch ?? ''),
    base: String(fm.base ?? ''),
    author: String(fm.pr_author ?? ''),
    url: String(fm.pr_url ?? ''),
    files: Number(fm.files_changed ?? 0),
    additions: Number(fm.additions ?? 0),
    deletions: Number(fm.deletions ?? 0),
    result: asResult(fm.result),
    published: fm.published === true,
    passes: rawPasses.map((p) => toReviewPass(p, summary)),
    recentRuns: [],
    linkedChange: null,
    config: parseConfigSnapshot(fm),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Single-quote YAML escape for free-text fields. Wraps in `'…'` with `''`
// escaping for embedded apostrophes; collapses newlines to spaces because
// single-quoted YAML can't represent newlines (accept_note / dismiss_reason
// are intentionally short rationales — multi-line input is out of scope).
function yamlQuote(s: string): string {
  const flat = s.replace(/[\r\n]+/g, ' ').trim();
  return `'${flat.replace(/'/g, "''")}'`;
}

// Surgically rewrite ONE comment block within a pr-review entry's body.
// Returns { ok: true, newContent } on success, or { ok: false, error } when
// the target pass / comment isn't found. Updates the entry's frontmatter
// `updated` field too. Pure function — caller writes the result to disk.
// Exported for direct unit testing (the accept gesture that gates publish must
// not strand header fields; see tests/unit/reviews-comment-mutate.test.ts).
export function mutateCommentInContent(
  content: string,
  passN: number,
  commentN: number,
  action: 'accept' | 'dismiss',
  note: string | null,
): { ok: true; newContent: string } | { ok: false; error: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return { ok: false, error: 'entry has no frontmatter' };
  const body = content.slice(fmMatch[0].length);

  // Find the `## Pass <passN> — <ISO>` line.
  const passRe = new RegExp(`^## Pass ${passN}\\b[^\\n]*`, 'm');
  const passMatch = body.match(passRe);
  if (!passMatch || passMatch.index === undefined) {
    return { ok: false, error: `pass ${passN} not found in entry body` };
  }
  // Find the next `## Pass ` after this one (if any) — bounds the search.
  const passContentStart = passMatch.index + passMatch[0].length;
  const nextPassMatch = body.slice(passContentStart).match(/^## Pass \d/m);
  const passContentEnd =
    nextPassMatch && nextPassMatch.index !== undefined
      ? passContentStart + nextPassMatch.index
      : body.length;
  const passContent = body.slice(passContentStart, passContentEnd);

  // Find the `#### Comment <commentN>:` block within the pass.
  const commentRe = new RegExp(`^#### Comment ${commentN}\\b[^\\n]*`, 'm');
  const commentMatch = passContent.match(commentRe);
  if (!commentMatch || commentMatch.index === undefined) {
    return { ok: false, error: `comment ${commentN} not found in pass ${passN}` };
  }
  // Block content = from the header line to the next `#### Comment`, `### `, or `## `.
  const commentHeaderEnd = commentMatch.index + commentMatch[0].length;
  const restAfterHeader = passContent.slice(commentHeaderEnd);
  const endMatch = restAfterHeader.search(/\n(?:#### Comment |### |## )/);
  const blockBodyEnd = endMatch >= 0 ? endMatch : restAfterHeader.length;
  const blockBody = restAfterHeader.slice(0, blockBodyEnd);
  const blockBodyAbsStart = passContentStart + commentHeaderEnd;
  const blockBodyAbsEnd = blockBodyAbsStart + blockBodyEnd;

  // Within blockBody, separate the header-list lines (until first blank)
  // from the message body. Header lines are `- key: value` patterns.
  const blockLines = blockBody.replace(/^\n+/, '').split('\n');
  const headerLines: string[] = [];
  let i = 0;
  for (; i < blockLines.length; i++) {
    const ln = blockLines[i];
    // Preserve EVERY recognized header line on a mutate. The new range fields
    // (start_line/side/start_side) are emitted BEFORE `- status:`, so omitting
    // them here would strand `- status:` in the message zone and resurrect a
    // stale status on re-parse. The five publish/act-trail fields are folded in
    // for the same reason — they were parsed but never preserved, so a mutate
    // after publish/act destroyed exactly the ids the next step needs.
    if (
      /^- (file|line|start_line|side|start_side|status|prior|accept_note|dismiss_reason|github_comment_id|github_review_id|acted_on_at|resolved_at|resolved_in_pass):/.test(
        ln,
      )
    ) {
      headerLines.push(ln);
      continue;
    }
    if (ln.trim() === '' && headerLines.length > 0) break;
    break; // non-header line before any header — treat as body
  }
  const messageLines = blockLines.slice(i);

  // Apply mutations to header lines.
  const newStatus = action === 'accept' ? 'accepted' : 'dismissed';
  const keepStatusOnly = headerLines
    .filter((ln) => !/^- (status|accept_note|dismiss_reason):/.test(ln))
    .concat(`- status: ${newStatus}`);
  if (note?.trim()) {
    const noteKey = action === 'accept' ? 'accept_note' : 'dismiss_reason';
    keepStatusOnly.push(`- ${noteKey}: ${yamlQuote(note.trim())}`);
  }

  // Reassemble.
  const newBlockBody = `\n${keepStatusOnly.join('\n')}\n${messageLines.join('\n')}`;
  const newBody = body.slice(0, blockBodyAbsStart) + newBlockBody + body.slice(blockBodyAbsEnd);

  // Bump frontmatter `updated`.
  const nowIso = new Date().toISOString();
  const fmText = fmMatch[1];
  const fmLines = fmText.split('\n');
  let updatedSet = false;
  for (let j = 0; j < fmLines.length; j++) {
    if (/^updated:/i.test(fmLines[j])) {
      fmLines[j] = `updated: ${nowIso}`;
      updatedSet = true;
      break;
    }
  }
  if (!updatedSet) fmLines.push(`updated: ${nowIso}`);

  const newContent = `---\n${fmLines.join('\n')}\n---\n${newBody}`;
  return { ok: true, newContent };
}

export const reviewsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/reviews — list all pr-review entries (newest first).
  // Single walk of vault/wiki collects (a) every change's id→status map and
  // (b) every pr-review entry. The change map is then handed to toReviewRow
  // so each row carries the linked change's lifecycle status (drives the
  // "merged" badge on the row when the underlying PR has shipped).
  fastify.get('/', async () => {
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    const changeMetaById = new Map<string, { status: string; prReviewStatus: string | null }>();
    const reviewEntries: Array<{ file: string; fm: Record<string, unknown>; body: string }> = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, body, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type === 'change' && typeof fm.id === 'string' && typeof fm.status === 'string') {
        changeMetaById.set(fm.id, {
          status: fm.status,
          prReviewStatus: typeof fm.pr_review_status === 'string' ? fm.pr_review_status : null,
        });
        continue;
      }
      if (fm.type === 'pr-review') {
        reviewEntries.push({ file, fm: fm as Record<string, unknown>, body });
      }
    }
    // Sort reviewEntries BEFORE building rows. `ReviewRow.started` carries the
    // relative-time string ("5m ago", "2h ago", "1d ago") for display, which
    // doesn't string-sort chronologically. Use the raw ISO timestamp from
    // frontmatter (`completed` if present, else `started`) so newest lands
    // first. Newer entries → larger ISO string → reverse string order.
    //
    // js-yaml parses bare ISO timestamps to Date objects, so handle both
    // string and Date shapes — the same pattern used in `asISOString` helpers
    // elsewhere in this server tree.
    const toIso = (v: unknown): string => {
      if (typeof v === 'string') return v;
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
      return '';
    };
    reviewEntries.sort((a, b) => {
      const aTs = toIso(a.fm.completed) || toIso(a.fm.started);
      const bTs = toIso(b.fm.completed) || toIso(b.fm.started);
      return bTs.localeCompare(aTs);
    });
    const rows: ReviewRow[] = reviewEntries.map(({ file, fm, body }) => {
      const passes = extractPasses(body);
      const allComments = passes.flatMap((p) => p.comments);
      return toReviewRow(fm, file, allComments, changeMetaById);
    });
    return { reviews: rows };
  });

  // GET /api/reviews/:id — full detail with passes + comments.
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = req.params.id;
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf8');
        const { fm, body, parseError } = parseFrontmatter(content);
        if (parseError) continue;
        if (fm.type !== 'pr-review' || fm.id !== id) continue;
        return { review: await toReviewDetailWithRuns(fm, body) };
      } catch {
        /* skip */
      }
    }
    reply.code(404);
    return { ok: false, error: `review "${id}" not found` };
  });

  // PUT /api/reviews/:id/comments/:passN/:commentN — accept or dismiss one
  // comment with an optional rationale. Surgically rewrites just that
  // comment's header lines in the body; the rest of the entry is untouched.
  // Records a pr-comment-mutate event for the audit trail.
  fastify.put<{
    Params: { id: string; passN: string; commentN: string };
    Body: { action?: 'accept' | 'dismiss'; note?: string };
  }>('/:id/comments/:passN/:commentN', async (req, reply) => {
    const { id, passN: passNRaw, commentN: commentNRaw } = req.params;
    const passN = Number.parseInt(passNRaw, 10);
    const commentN = Number.parseInt(commentNRaw, 10);
    if (!Number.isInteger(passN) || passN < 1 || !Number.isInteger(commentN) || commentN < 1) {
      reply.code(400);
      return { ok: false, error: 'passN and commentN must be positive integers' };
    }
    const action = req.body?.action;
    if (action !== 'accept' && action !== 'dismiss') {
      reply.code(400);
      return { ok: false, error: 'action must be "accept" or "dismiss"' };
    }
    const note = typeof req.body?.note === 'string' ? req.body.note : null;

    // Locate the entry file by walking the wiki dir + filtering by id.
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    let targetFile: string | null = null;
    let targetContent: string | null = null;
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'pr-review' || fm.id !== id) continue;
      targetFile = file;
      targetContent = content;
      break;
    }
    if (!targetFile || !targetContent) {
      reply.code(404);
      return { ok: false, error: `review "${id}" not found` };
    }

    const result = mutateCommentInContent(targetContent, passN, commentN, action, note);
    if (!result.ok) {
      reply.code(404);
      return { ok: false, error: result.error };
    }

    try {
      await writeFile(targetFile, result.newContent, 'utf8');
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `failed to write entry: ${(e as Error).message}` };
    }

    // Record event (best-effort) — dual-write JSONL + events.db via the
    // wrapper script so the manifest rebuild auto-fires for the touched
    // file and Activity tab sees the mutation.
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'pr-comment-mutate',
          '--args',
          JSON.stringify({
            review: id,
            pass: passN,
            comment: commentN,
            action,
            has_note: Boolean(note?.trim()),
          }),
          '--files-touched',
          JSON.stringify([relative(REPO_ROOT, targetFile)]),
          '--exit-status',
          '0',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    } catch {
      /* event log is best-effort; the mutation already succeeded on disk */
    }

    // Return the updated review so the frontend doesn't need a follow-up GET.
    const reparsed = parseFrontmatter(result.newContent);
    return { ok: true, review: toReviewDetail(reparsed.fm, reparsed.body) };
  });

  // GET /api/reviews/:id/snippet?file=<rel>&line=<n>&context=<n>
  // Returns the source-code context around a line in a file, used by the
  // comment cards to render an inline snippet. Reads the file from the
  // linked repo entity's `local_path` (the user's writable clone) — this
  // shows whatever is currently checked out, which for an OS-authored PR
  // is typically the feature branch the change just wrote. The pr-review-
  // cache is on `default_branch` so it can't see new files yet; using
  // local_path covers the common case at the cost of going stale if the
  // user checks out something else.
  fastify.get<{
    Params: { id: string };
    Querystring: { file?: string; line?: string; context?: string };
  }>('/:id/snippet', async (req, reply) => {
    const id = req.params.id;
    const file = (req.query.file ?? '').trim();
    const line = Number(req.query.line);
    const context = Math.min(20, Math.max(0, Number(req.query.context ?? '5')));
    if (!file) {
      reply.code(400);
      return { ok: false, error: 'file is required' };
    }
    if (!Number.isInteger(line) || line < 1) {
      reply.code(400);
      return { ok: false, error: 'line must be a positive integer' };
    }
    // Reject paths with .. segments or absolute paths up front — defense in
    // depth against escape attempts. The eventual join() also normalizes,
    // but rejecting noisy input here gives clearer errors.
    if (file.includes('..') || file.startsWith('/')) {
      reply.code(400);
      return { ok: false, error: 'file path must be relative without ..' };
    }

    // Find the review entry → frontmatter.repo → entity entry → local_path.
    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    let reviewFm: Record<string, unknown> | null = null;
    let repoEntityFm: Record<string, unknown> | null = null;
    for (const f of files) {
      let content: string;
      try {
        content = await readFile(f, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type === 'pr-review' && fm.id === id) {
        reviewFm = fm as Record<string, unknown>;
      }
    }
    if (!reviewFm) {
      reply.code(404);
      return { ok: false, error: `review "${id}" not found` };
    }
    const repoId = typeof reviewFm.repo === 'string' ? reviewFm.repo : null;
    if (!repoId) {
      reply.code(404);
      return { ok: false, error: `review "${id}" has no linked repo entity` };
    }
    // Second walk only if needed — keeps the simple case fast.
    for (const f of files) {
      let content: string;
      try {
        content = await readFile(f, 'utf8');
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
      reply.code(404);
      return { ok: false, error: `repo "${repoId}" has no local_path set` };
    }

    const abs = join(localPath, file);
    let source: string;
    try {
      source = await readFile(abs, 'utf8');
    } catch {
      reply.code(404);
      return {
        ok: false,
        error: `file not found at local_path — the working tree may be on a branch that doesn't contain ${file}`,
      };
    }

    const allLines = source.split('\n');
    const startLine = Math.max(1, line - context);
    const endLine = Math.min(allLines.length, line + context);
    const out: Array<{ n: number; t: string; kind?: 'highlight' | 'context' }> = [];
    for (let n = startLine; n <= endLine; n++) {
      out.push({
        n,
        t: allLines[n - 1] ?? '',
        kind: n === line ? 'highlight' : 'context',
      });
    }
    return { ok: true, lines: out, focus: line, file, totalLines: allLines.length };
  });

  // POST /api/reviews/:id/comments/accept-all — bulk-accept every comment
  // whose status is `new` (untriaged) in the named pass. Idempotent: comments
  // already accepted/dismissed/published/acted-on are skipped. Records a
  // single audit event with the count instead of one per comment so the
  // events log stays readable.
  fastify.post<{
    Params: { id: string };
    Body: { passN?: number };
  }>('/:id/comments/accept-all', async (req, reply) => {
    const id = req.params.id;
    const passN = Number(req.body?.passN);
    if (!Number.isInteger(passN) || passN < 1) {
      reply.code(400);
      return { ok: false, error: 'passN must be a positive integer' };
    }

    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkMd(wikiDir);
    let targetFile: string | null = null;
    let targetContent: string | null = null;
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'pr-review' || fm.id !== id) continue;
      targetFile = file;
      targetContent = content;
      break;
    }
    if (!targetFile || !targetContent) {
      reply.code(404);
      return { ok: false, error: `review "${id}" not found` };
    }

    // Find the target pass + collect every comment whose status is `new`.
    const { body } = parseFrontmatter(targetContent);
    const passes = extractPasses(body);
    const pass = passes.find((p) => p.n === passN);
    if (!pass) {
      reply.code(404);
      return { ok: false, error: `pass ${passN} not found in review "${id}"` };
    }
    const targets = pass.comments.filter((c) => c.status === 'new').map((c) => c.n);

    // Apply one mutation per target — mutateCommentInContent rewrites the
    // entry each call, so loop with the running content.
    let working = targetContent;
    let acceptedCount = 0;
    for (const commentN of targets) {
      const r = mutateCommentInContent(working, passN, commentN, 'accept', null);
      if (!r.ok) continue;
      working = r.newContent;
      acceptedCount += 1;
    }

    if (acceptedCount > 0) {
      try {
        await writeFile(targetFile, working, 'utf8');
      } catch (e) {
        reply.code(500);
        return { ok: false, error: `failed to write entry: ${(e as Error).message}` };
      }
    }

    // Single audit event for the whole batch.
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'pr-comment-accept-all',
          '--args',
          JSON.stringify({ review: id, pass: passN, accepted: acceptedCount }),
          '--files-touched',
          JSON.stringify([relative(REPO_ROOT, targetFile)]),
          '--exit-status',
          '0',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    } catch {
      /* best-effort */
    }

    const reparsed = parseFrontmatter(working);
    return {
      ok: true,
      accepted: acceptedCount,
      review: toReviewDetail(reparsed.fm, reparsed.body),
    };
  });
};
