// Helper: read a pr-review entry and count the curated-not-yet-acted-on
// comments on the latest pass. Used by both the changes route (drives the
// "N comments to address" UI signal) and the automation orchestrator (drives
// the no-op-loop guard in the state machine — see Task #427).
//
// Lives in its own file so the orchestrator doesn't have to import the
// changes route module (architectural keep-route-modules-independent rule).
// Both call sites do their own I/O around the pure work below.

import { existsSync, readFileSync } from 'node:fs';
import { safePath } from '../repo.js';

export interface ReviewLookup {
  // Count of comments on the latest pass with status in
  // {accepted, published, published-as-body} AND no `acted_on_at` field —
  // i.e. comments curated by the user that dev-write-change in
  // address-comments mode would actually re-implement.
  commentsToAddress: number;
  // True when the linked pr-review's frontmatter has `published: true`.
  reviewPublished: boolean;
  // Any GitHub review id captured on a comment header on the latest pass.
  // Used to build the deep link to the parent GitHub review.
  reviewGithubReviewId: number | null;
  // Highest `## Pass <N>` number in the entry (0 when no passes). Feeds the
  // automation orchestrator's artifact-verified advance: a pr-review step
  // only counts as done when this number incremented past the baseline.
  passCount: number;
  // Count of latest-pass comments still `status: new` — untriaged. Comment
  // disposition is a merge invariant (new → acted-on | dismissed); this count
  // gates the Mark-ready affordances.
  untriagedCount: number;
  // Count of latest-pass comments with severity blocker|bug whose status is
  // still standing (not resolved/dismissed/acted-on/wontfix). Mirrors
  // dev-pr-review's step-14 roll-up rule for `pr_review_status: approved`;
  // gates the orchestrator's pending → approved upgrade at completion so a
  // standing-bug `pending` is never relabeled as clean.
  standingBlockerCount: number;
}

// The "no review readable" shape. Exported so callers that need a fallback
// (e.g. changes.ts when pr_review_path is unset) don't hand-maintain a copy
// that drifts as the interface grows. Callers treat lookups as read-only.
export const EMPTY_REVIEW_LOOKUP: ReviewLookup = {
  commentsToAddress: 0,
  reviewPublished: false,
  reviewGithubReviewId: null,
  passCount: 0,
  untriagedCount: 0,
  standingBlockerCount: 0,
};

export function lookupLinkedReview(prReviewPath: string): ReviewLookup {
  const empty = EMPTY_REVIEW_LOOKUP;
  const abs = safePath(prReviewPath);
  if (!abs || !existsSync(abs)) return empty;
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return empty;
  }
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const reviewPublished = !!fmMatch?.[1]?.match(/^published:\s*true\s*$/m);
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  // Locate every `## Pass <N>` header — the latest-N section is the one we
  // care about (re-implementation always targets the most-recent pass).
  const passHeaderRe = /^## Pass (\d+)\b/gm;
  const headers: Array<{ n: number; start: number }> = [];
  let m: RegExpExecArray | null = passHeaderRe.exec(body);
  while (m !== null) {
    headers.push({ n: Number(m[1]), start: m.index });
    m = passHeaderRe.exec(body);
  }
  if (headers.length === 0) return { ...empty, reviewPublished };
  headers.sort((a, b) => a.n - b.n);
  const latest = headers[headers.length - 1];
  const passCount = latest.n;
  const latestIdx = headers.indexOf(latest);
  const sectionEnd = latestIdx + 1 < headers.length ? headers[latestIdx + 1].start : body.length;
  const section = body.slice(latest.start, sectionEnd);

  const commentRe = /^#### Comment \d+:/gm;
  const commentStarts: number[] = [];
  let cm: RegExpExecArray | null = commentRe.exec(section);
  while (cm !== null) {
    commentStarts.push(cm.index);
    cm = commentRe.exec(section);
  }
  let count = 0;
  let untriaged = 0;
  let standingBlockers = 0;
  let firstReviewId: number | null = null;
  for (let i = 0; i < commentStarts.length; i++) {
    const start = commentStarts[i];
    const end = i + 1 < commentStarts.length ? commentStarts[i + 1] : section.length;
    const block = section.slice(start, end);
    const blankIdx = block.search(/\n\s*\n/);
    const header = blankIdx >= 0 ? block.slice(0, blankIdx) : block;
    // Severity lives in the heading line: `#### Comment N: <category> · <severity>`.
    // Match the LAST ·-delimited token (greedy .*) — categories are free-form
    // and may contain spaces or even · themselves; failing to parse a severity
    // would fail-open on the standing-blocker gate.
    const severityM = header.match(/^#### Comment \d+:.*·\s*([\w-]+)\s*$/m);
    const severity = severityM ? severityM[1] : null;
    const statusM = header.match(/^- status:\s*([\w-]+)/m);
    const status = statusM ? statusM[1] : 'new';
    const actedOn = /^- acted_on_at:\s*\S/m.test(header);
    const ghReviewM = header.match(/^- github_review_id:\s*(\d+)/m);
    if (ghReviewM && firstReviewId == null) firstReviewId = Number(ghReviewM[1]);
    if (status === 'new') untriaged++;
    // wontfix is a user rejection — semantically equivalent to dismissed for
    // the standing test, else a wontfix'd bug pins the roll-up at pending.
    if (
      (severity === 'blocker' || severity === 'bug') &&
      status !== 'resolved' &&
      status !== 'dismissed' &&
      status !== 'acted-on' &&
      status !== 'wontfix'
    )
      standingBlockers++;
    if (
      !actedOn &&
      (status === 'accepted' || status === 'published' || status === 'published-as-body')
    )
      count++;
  }
  return {
    commentsToAddress: count,
    reviewPublished,
    reviewGithubReviewId: firstReviewId,
    passCount,
    untriagedCount: untriaged,
    standingBlockerCount: standingBlockers,
  };
}
