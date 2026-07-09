// GitHub MCP server — exposes a tight set of PR-focused tools to Claude Code.
//
// Boot: spawned via stdio by Claude Code (see .mcp.json after running
// scripts/sync-mcp-config.mjs). Reads mcps/github/.env for GITHUB_TOKEN,
// exits 1 with a helpful message if missing. Each tool dispatches via
// octokit; errors are returned as { isError: true, content: [...] } so
// the calling skill can surface the message verbatim.
//
// Auth: classic PAT with `repo` OR fine-grained PAT with
// (pull-requests: write, contents: read, checks: read). See .env.example.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Octokit } from '@octokit/rest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal dotenv — avoids pulling a dep. Reads mcps/github/.env and injects
// into process.env. Lines like `KEY=value`; ignores comments + blank lines.
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, '.env'), 'utf8');
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
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // No .env file — fall through; will fail on env validation below.
  }
}

loadEnv();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error(
    '[mcp/github] GITHUB_TOKEN not set. Copy mcps/github/.env.example to .env and add a token.',
  );
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const TOOLS = [
  {
    name: 'create_pull_request',
    description:
      'Open a new pull request on GitHub. Assumes the branch has already been pushed to origin. Returns { number, url, state, draft, user_login }.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (org or user).' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body (markdown).' },
        head: { type: 'string', description: 'Branch with your changes (e.g. feat/oidc).' },
        base: { type: 'string', description: 'Branch to merge into (default: main).' },
        draft: { type: 'boolean', description: 'Open as a draft PR. Default false.' },
      },
      required: ['owner', 'repo', 'title', 'head'],
    },
  },
  {
    name: 'get_pull_request',
    description:
      'Read pull request state by number. Returns key PR fields (number, state, merged, draft, title, body, user_login, html_url, head/base ref/sha, merged_at, closed_at, merge_commit_sha).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description:
      'List PRs filtered by head branch. Used by dev-open-pr to detect an existing PR for idempotent re-runs. Returns an array of { number, url, state, user_login }.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        head: {
          type: 'string',
          description: 'Branch name OR fully-qualified `owner:branch`. Filters to that head.',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'PR state to filter on. Default: open.',
        },
      },
      required: ['owner', 'repo', 'head'],
    },
  },
  {
    name: 'list_pull_request_checks',
    description:
      'Snapshot the PR\'s check runs + commit statuses for CI state reporting. Returns { total, by_state: { success, failure, in_progress, queued, neutral, other }, runs: [...] } where each run has { name, status, conclusion, url }. Single read, no polling.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_request_reviews',
    description:
      'List formal reviews submitted on a pull request — the top-level review events (one per submit). Each entry carries the review id, verdict (APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED), submitter, body, and submitted_at. Use this to surface external reviewers\' verdicts on an OS-authored PR. Pair with list_pull_request_review_comments to get the inline file-anchored comments those reviews carry.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_request_review_comments',
    description:
      'List inline file/line comments on a pull request — the actionable review feedback that should flow into the OS as a new pass on the linked pr-review entry. Returns { count, comments: [{ id, review_id, in_reply_to_id, path, line, side, body, author, created_at, html_url }] }. `in_reply_to_id` is set when the comment is a reply in a thread (vs. a fresh top-level comment).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        since: {
          type: 'string',
          description:
            'Optional ISO 8601 timestamp. When set, only return comments created at or after this time. Use to ingest only new comments since the last sync.',
        },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'create_pull_request_review',
    description:
      'Submit a pull request review with optional inline comments. Used by dev-pr-review-publish to ship the OS-side review back to GitHub as a single batched event. Maps the entry\'s `result` field to GitHub\'s review event (APPROVE / REQUEST_CHANGES / COMMENT). Returns { id, html_url, state, submitted_at, comments: [{ id, path, line, html_url }, ...] }.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        commit_id: {
          type: 'string',
          description:
            'SHA of the commit the review anchors to. Must be the PR\'s current head_sha (fetch via get_pull_request first); GitHub rejects stale anchors.',
        },
        event: {
          type: 'string',
          enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
          description:
            'Review verdict. APPROVE = LGTM; REQUEST_CHANGES = blocks merge; COMMENT = observations without judgment.',
        },
        body: {
          type: 'string',
          description: 'Top-level review body (markdown). Posted as the review summary.',
        },
        comments: {
          type: 'array',
          description:
            'Inline comments to attach to the review. Each must anchor to a file + line in the diff. Supply start_line (+ optional start_side) alongside line for a true multi-line range comment. Empty array = body-only review with no inline comments.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the repo root.' },
              line: {
                type: 'number',
                description:
                  'Line number to anchor the comment to (the LAST line of the range when start_line is set). For file-level / PR-level comments, omit (set subject_type instead).',
              },
              side: {
                type: 'string',
                enum: ['LEFT', 'RIGHT'],
                description:
                  'Which side of the diff to anchor to. RIGHT = the version after the PR\'s changes. Default RIGHT.',
              },
              start_line: {
                type: 'number',
                description:
                  'First line of a multi-line range comment (line is the last). Forwarded only when start_line < line; a malformed range silently degrades to the single-line form. Omit for single-line comments.',
              },
              start_side: {
                type: 'string',
                enum: ['LEFT', 'RIGHT'],
                description:
                  'Which side the range START anchors to. Defaults to `side`. Only meaningful with start_line.',
              },
              body: { type: 'string', description: 'Comment body (markdown).' },
            },
            required: ['path', 'body'],
          },
        },
      },
      required: ['owner', 'repo', 'pull_number', 'commit_id', 'event'],
    },
  },
];

async function handleCreatePullRequest(args) {
  const { owner, repo, title, body = '', head, base = 'main', draft = false } = args;
  const { data } = await octokit.pulls.create({ owner, repo, title, body, head, base, draft });
  return {
    number: data.number,
    url: data.html_url,
    state: data.state,
    draft: data.draft,
    user_login: data.user?.login ?? null,
  };
}

async function handleGetPullRequest(args) {
  const { owner, repo, pull_number } = args;
  const { data } = await octokit.pulls.get({ owner, repo, pull_number });
  return {
    number: data.number,
    state: data.state,
    merged: data.merged,
    draft: data.draft,
    title: data.title,
    body: data.body,
    user_login: data.user?.login ?? null,
    html_url: data.html_url,
    head_ref: data.head?.ref ?? null,
    base_ref: data.base?.ref ?? null,
    head_sha: data.head?.sha ?? null,
    // Merge lifecycle timestamps — used by dev-close-change to record the
    // canonical merged_at on the change entry instead of falling back to
    // now() (Task #432). closed_at is set whenever the PR is closed (merged
    // or abandoned); merged_at is set only when actually merged.
    merged_at: data.merged_at ?? null,
    closed_at: data.closed_at ?? null,
    merge_commit_sha: data.merge_commit_sha ?? null,
  };
}

async function handleListPullRequests(args) {
  const { owner, repo, head, state = 'open' } = args;
  // GitHub's PR list filters by head as `owner:branch`. If the caller passed
  // only the branch name, prepend the owner.
  const headFilter = head.includes(':') ? head : `${owner}:${head}`;
  const { data } = await octokit.pulls.list({ owner, repo, head: headFilter, state });
  return {
    count: data.length,
    pull_requests: data.map((pr) => ({
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
      draft: pr.draft,
      title: pr.title,
      user_login: pr.user?.login ?? null,
    })),
  };
}

async function handleListPullRequestChecks(args) {
  const { owner, repo, pull_number } = args;
  // Resolve the PR's head SHA, then fetch check runs + commit statuses for it.
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
  const ref = pr.head?.sha;
  if (!ref) {
    return {
      total: 0,
      by_state: { success: 0, failure: 0, in_progress: 0, queued: 0, neutral: 0, other: 0 },
      runs: [],
      note: 'No head SHA available for this PR.',
    };
  }
  const [{ data: checks }, { data: statuses }] = await Promise.all([
    octokit.checks.listForRef({ owner, repo, ref }),
    octokit.repos.listCommitStatusesForRef({ owner, repo, ref }),
  ]);
  const runs = [];
  for (const c of checks.check_runs ?? []) {
    runs.push({
      name: c.name,
      status: c.status, // queued | in_progress | completed
      conclusion: c.conclusion, // success | failure | neutral | cancelled | skipped | timed_out | action_required
      url: c.html_url,
      source: 'check_run',
    });
  }
  for (const s of statuses) {
    runs.push({
      name: s.context,
      status: s.state === 'pending' ? 'in_progress' : 'completed',
      conclusion:
        s.state === 'success' ? 'success' : s.state === 'failure' ? 'failure' : s.state,
      url: s.target_url,
      source: 'commit_status',
    });
  }
  const by_state = { success: 0, failure: 0, in_progress: 0, queued: 0, neutral: 0, other: 0 };
  for (const r of runs) {
    if (r.status === 'in_progress') by_state.in_progress += 1;
    else if (r.status === 'queued') by_state.queued += 1;
    else if (r.conclusion === 'success') by_state.success += 1;
    else if (r.conclusion === 'failure' || r.conclusion === 'cancelled' || r.conclusion === 'timed_out')
      by_state.failure += 1;
    else if (r.conclusion === 'neutral' || r.conclusion === 'skipped') by_state.neutral += 1;
    else by_state.other += 1;
  }
  return { total: runs.length, by_state, runs };
}

async function handleListPullRequestReviews(args) {
  const { owner, repo, pull_number } = args;
  const { data } = await octokit.pulls.listReviews({ owner, repo, pull_number });
  return {
    count: data.length,
    reviews: data.map((r) => ({
      id: r.id,
      // GitHub uses APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING.
      state: r.state,
      body: r.body ?? '',
      author: r.user?.login ?? null,
      submitted_at: r.submitted_at ?? null,
      commit_id: r.commit_id ?? null,
      html_url: r.html_url ?? null,
    })),
  };
}

async function handleListPullRequestReviewComments(args) {
  const { owner, repo, pull_number, since } = args;
  // Octokit accepts `since` as an ISO string and filters server-side. Omit
  // when not provided so the call returns all comments.
  const params = { owner, repo, pull_number, per_page: 100 };
  if (typeof since === 'string' && since) params.since = since;
  const { data } = await octokit.pulls.listReviewComments(params);
  return {
    count: data.length,
    comments: data.map((c) => ({
      id: c.id,
      review_id: c.pull_request_review_id ?? null,
      // Set when this comment is a reply to another comment (thread).
      // Top-level (file-anchor) comments leave this null.
      in_reply_to_id: c.in_reply_to_id ?? null,
      path: c.path,
      // GitHub's `line` is the canonical anchor on the new diff; `original_line`
      // is the anchor on the original commit. Prefer `line` since that's what
      // the OS-side schema expects.
      line: c.line ?? c.original_line ?? null,
      side: c.side ?? 'RIGHT',
      body: c.body ?? '',
      author: c.user?.login ?? null,
      created_at: c.created_at,
      html_url: c.html_url,
    })),
  };
}

async function handleCreatePullRequestReview(args) {
  const { owner, repo, pull_number, commit_id, event, body = '', comments = [] } = args;
  // Normalize each comment to GitHub's accepted shape. Default side=RIGHT
  // (post-change view) since that's what reviewers expect when anchoring to
  // the diff. Comments missing `line` are pushed body-only (PR-level).
  const normalized = comments
    .filter((c) => c && c.path && c.body)
    .map((c) => {
      const out = { path: c.path, body: c.body };
      if (typeof c.line === 'number') {
        out.line = c.line;
        out.side = c.side === 'LEFT' ? 'LEFT' : 'RIGHT';
        // Multi-line range: forward start_line/start_side only when the range
        // is well-formed (start strictly before end). A malformed range
        // degrades silently to the single-line form rather than 422-ing the
        // whole review — the caller's validator is the primary guard; this is
        // a last-resort safety net. start_side defaults to the resolved side.
        if (typeof c.start_line === 'number' && c.start_line < c.line) {
          out.start_line = c.start_line;
          out.start_side = c.start_side === 'LEFT' ? 'LEFT' : c.start_side === 'RIGHT' ? 'RIGHT' : out.side;
        }
      }
      return out;
    });
  const { data: review } = await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    commit_id,
    event,
    body,
    comments: normalized,
  });
  // After the review is submitted, fetch the resulting inline comments so the
  // caller can stamp `github_comment_id` per comment back onto the entry.
  // The list endpoint returns ALL comments on the PR; filter to this review
  // by pull_request_review_id.
  let postedComments = [];
  try {
    const { data: allComments } = await octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number,
    });
    postedComments = allComments
      .filter((c) => c.pull_request_review_id === review.id)
      .map((c) => ({
        id: c.id,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        body: c.body,
        html_url: c.html_url,
      }));
  } catch {
    // Non-fatal — the review was submitted; we just can't enumerate the
    // resulting comments. Caller can fall back to GitHub's own UI.
  }
  return {
    id: review.id,
    html_url: review.html_url,
    state: review.state, // APPROVED / CHANGES_REQUESTED / COMMENTED
    submitted_at: review.submitted_at,
    commit_id: review.commit_id,
    comments: postedComments,
  };
}

const HANDLERS = {
  create_pull_request: handleCreatePullRequest,
  get_pull_request: handleGetPullRequest,
  list_pull_requests: handleListPullRequests,
  list_pull_request_checks: handleListPullRequestChecks,
  list_pull_request_reviews: handleListPullRequestReviews,
  list_pull_request_review_comments: handleListPullRequestReviewComments,
  create_pull_request_review: handleCreatePullRequestReview,
};

const server = new Server(
  { name: 'agentic-os-github', version: '0.3.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = await handler(args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error in ${name}: ${msg}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
