// Wire-shape types for the reviews route. Per standard-shared-types — the
// server (`reviews.ts`) and the client (the PR Review app under
// `src/apps/pr-review/`) consume the same shapes; this is the canonical
// definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `reviews.ts`.

// Severity bucket counts shown per review row.
export interface Severity {
  bug: number;
  nit: number;
  suggestion: number;
}

// Per-comment lifecycle status as it appears in the comment block's
// `passStatus` field. Drives the "resolved / unresolved / new" indicator in
// the timeline.
export type PassStatus = 'resolved' | 'unresolved' | 'new';

// Derived state for the per-comment action buttons. Terminal-published
// statuses (`published`, `published-as-body`, `acted-on`) collapse to
// 'accepted' here; the raw `status` field on ReviewComment retains the
// granular value for the UI to surface.
export type CommentState = 'open' | 'accepted' | 'dismissed';

// One row in GET /api/reviews.
export interface ReviewRow {
  id: string;
  pr: string;
  title: string;
  repo: string;
  branch: string;
  author: string;
  status: 'running' | 'completed' | 'failed';
  result: 'approve' | 'changes' | 'block' | null;
  severity: Severity;
  duration: string;
  started: string;
  files: number;
  additions: number;
  deletions: number;
  path: string;
  // Linked change's `status` field (planning / in-progress / in-review /
  // merged / abandoned), when the review's `change_id` resolves to a real
  // change entry. Drives the merged-badge on the Reviews list row. Null for
  // external PR reviews (no change_id) or stale change_id references.
  changeStatus: string | null;
  // Linked change's `pr_review_status` field (pending / needs-changes /
  // ready-for-human), when the change_id resolves. Surfaces the
  // "ready for human" signal on the Reviews list row so the user knows which
  // PRs are waiting on a human merge vs which still need address-comments.
  // Null for external PRs or stale references. Mirrors what the detail
  // endpoint already exposes as `prReviewStatus`.
  changePrReviewStatus: string | null;
  // The linked change id itself — used by the UI to click through to the
  // change in the Changes app.
  changeId: string | null;
  // Client-only field — used by the UI when a review is still in flight to
  // render a progress bar. Server never sets this; it's part of the
  // canonical type so the client can add it locally without widening.
  progress?: number;
  // Client-only field — surfaced when a review failed; the server stamps
  // failure info elsewhere and the UI synthesizes a short string for the
  // row badge.
  error?: string;
}

// One comment in a pass. The server emits all required fields verbatim from
// the parsed entry body. Optional client-only fields are documented above
// the interface.
export interface ReviewComment {
  id: string;
  priorId: string | null;
  passStatus: PassStatus;
  state: CommentState;
  // Raw status from the comment header — gives the UI access to terminal
  // states like 'published-as-body' that the derived `state` collapses.
  status: string;
  severity: 'bug' | 'nit' | 'suggestion';
  agent: 'logic' | 'security' | 'performance' | 'style' | 'tests' | 'docs';
  file: string;
  startLine: number;
  message: string;
  suggestion: string | null;
  lang: string;
  acceptNote: string | null;
  dismissReason: string | null;
  githubCommentId: number | null;
  githubReviewId: number | null;
  actedOnAt: string | null;
  resolvedAt: string | null;
  resolvedInPass: number | null;
}

// Stats summary for one pass.
export interface PassStats {
  bugs: number;
  nits: number;
  suggestions: number;
  resolved: number;
  stillOpen: number;
  fresh: number;
}

// One pass within a review.
export interface ReviewPass {
  id: string;
  n: number;
  label: string;
  commit: string;
  commitMsg: string;
  started: string;
  duration: string;
  status: 'running' | 'completed';
  result: 'approve' | 'changes' | 'block' | null;
  recommendation: 'approve' | 'changes' | 'block' | null;
  published: boolean;
  priorPass: string | null;
  summary: string;
  stats: PassStats;
  comments: ReviewComment[];
  // Client-only — rendered when status === 'running' to drive the in-flight
  // progress bar. Server never sets this.
  progress?: number;
}

// One row in ReviewDetail.recentRuns — recent skill dispatches relevant to
// the review, surfaced in the header.
export interface RecentRun {
  ts: string;
  // Either the action name from a skill-completion event (e.g.
  // "pr-review-publish") OR "ai-prompt:<skill-name>" for raw dispatches that
  // didn't reach a completion-event step.
  action: string;
  exitStatus: number | null;
  // Best-effort one-line summary derived from the event's args/prompt.
  summary: string;
  // True when an ai-prompt dispatch fired but no matching completion event
  // followed — meaning the skill ran but didn't reach its
  // record-dashboard-action step.
  silentCompletion: boolean;
}

// Snapshot of the linked change's OS-side workflow state, included on the
// ReviewDetail response so the review header can surface "ready-for-human"
// without an extra fetch. Null for external PRs (no change_id linkage).
export interface LinkedChange {
  id: string;
  prReviewStatus: string | null;
  prReadyAt: string | null;
}

// Frontmatter `config:` block as written by dev-pr-review at review-creation
// time. Snapshot of the policy values active when the FIRST pass ran — does
// not change across subsequent passes (passes use the body's "Pass config"
// subsection for their own per-pass record). Null when the entry predates
// the config-snapshot convention or the field is otherwise malformed.
export interface ReviewConfigSnapshot {
  primary_model: string;
  comment_style: 'terse' | 'concise' | 'detailed' | string;
  focus_areas: string[];
  context_strategy: string;
  // SHA256-of-first-12-hex of the custom_instructions text active at review
  // time. Null when instructions were empty. Useful for "did anyone change
  // the policy since this review ran?" — diff this against the current
  // /api/pr-review/config response's custom_instructions_hash.
  custom_instructions_hash: string | null;
}

// Full GET /api/reviews/:id response payload (under the `review` key).
export interface ReviewDetail {
  id: string;
  pr: string;
  title: string;
  repo: string;
  branch: string;
  base: string;
  author: string;
  url: string;
  files: number;
  additions: number;
  deletions: number;
  // From the pr-review entry's `result` frontmatter field. Drives the verdict
  // the Phase 4 publish flow submits to GitHub (approve / request-changes /
  // comment). Null when result is unset (status: running or no verdict yet).
  result: 'approved' | 'request-changes' | 'comment' | 'none' | null;
  // From entry frontmatter — true if any pass has been published to GitHub.
  published: boolean;
  passes: ReviewPass[];
  recentRuns: RecentRun[];
  linkedChange: LinkedChange | null;
  // Config snapshot — what review-policy values were active at the time the
  // review's first pass ran. Null when the entry doesn't carry a config: block
  // (older entries, or entries written outside dev-pr-review).
  config: ReviewConfigSnapshot | null;
}
