// Payload shaping for the github MCP's `create_pull_request_review` tool.
//
// Two anchor guards live here and they are complements, not alternatives:
//
//  1. Pre-flight normalization — a range whose start is not strictly before
//     its end can never be accepted, so it degrades to a single-line anchor
//     before the request is made. Cheap, local, always right.
//  2. Response-driven fallback — GitHub also rejects well-formed ranges for
//     reasons the caller cannot see from the diff alone (older diffs, some
//     API states). When a submission comes back 422 and the payload carried
//     ranges, the caller retries ONCE with every range stripped. A review
//     degrades to single-line anchors rather than failing outright.
//
// Kept in its own module — pure, no octokit, no env, no side effects — so the
// shaping rules are unit-testable without booting the server.

// Normalize caller-supplied comments to the shape the review API accepts.
// Comments missing a path or body are dropped (nothing to anchor or say);
// comments without a numeric `line` are passed through as file-level entries.
// `side` defaults to RIGHT (the post-change view reviewers expect).
export function normalizeReviewComments(comments = []) {
  return comments
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
          out.start_side =
            c.start_side === 'LEFT' ? 'LEFT' : c.start_side === 'RIGHT' ? 'RIGHT' : out.side;
        }
      }
      return out;
    });
}

// True when any comment in the payload anchors to a multi-line range. Gates
// the retry: a rejection on a payload with no ranges cannot be a range
// problem, so stripping nothing and re-submitting would only burn a call.
export function hasRangeAnchors(comments = []) {
  return comments.some((c) => c && (c.start_line !== undefined || c.start_side !== undefined));
}

// Drop every range field, collapsing each comment onto its end line. Returns
// the flattened payload plus how many comments lost a range, so the caller can
// report the degradation instead of silently changing what was published.
export function stripRangeAnchors(comments = []) {
  let stripped = 0;
  const flattened = comments.map((c) => {
    if (!c || (c.start_line === undefined && c.start_side === undefined)) return c;
    stripped += 1;
    const { start_line: _startLine, start_side: _startSide, ...rest } = c;
    return rest;
  });
  return { comments: flattened, stripped };
}

// Recognize GitHub's "unprocessable entity" rejection. Octokit surfaces the
// HTTP status on the error; when it doesn't (wrapped or re-thrown errors),
// fall back to the message text. An error carrying a different status is not
// a 422 no matter what its message says.
export function isUnprocessableEntity(err) {
  if (!err) return false;
  if (typeof err.status === 'number') return err.status === 422;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b422\b/.test(msg);
}
