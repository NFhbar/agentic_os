// Does a session-transcript turn correspond to a run the OS already recorded?
//
// A dashboard-dispatched skill run is `claude -p` in a subprocess, and that
// subprocess writes a session transcript of its own into the same directory
// scripts/import-session-usage.mjs walks. The transcript is indistinguishable
// in SHAPE from an interactive turn: one user string message, then assistant
// work. So without this matcher every dispatched run lands in events.db twice
// — once as the dispatch row (cost from the CLI's own result event) and once
// as a `kind='session'` interactive turn (cost re-derived from token counts).
// The two figures differ materially, and any rollup that sums both kinds
// double-counts every dispatch.
//
// Two bases:
//   run-id     — the transcript text names a run row. Exact; used when present.
//   adjacency  — the turn's start AND duration both sit inside a small window
//                around a runs-table row's. Circumstantial, so it demands both
//                signals and refuses to guess when either side lacks one.
//
// The bias is deliberate and asymmetric. Skipping a genuine interactive turn
// deletes real cost data with nothing left to reconstruct it from; failing to
// skip a dispatch leaves a duplicate that is still visible and still fixable.
// Every uncertainty therefore resolves to "not a dispatch".
//
// DEPENDENCY-FREE BY CONTRACT. Its caller imports events-db.mjs (and node:sqlite
// behind it), which vitest's resolver cannot load — keeping the decision here
// is what makes it unit-testable. Same split as scripts/run-origins.mjs.

export const DISPATCH_DURATION_TOLERANCE_MS = 2000;
export const DISPATCH_START_TOLERANCE_MS = 5000;

// Run ids are `r_` + a uuid (or, on the no-crypto fallback path,
// `r_<ms>-<rand>`). A hit only counts when the id also exists in the dispatch
// index, so a loose match here costs nothing.
const RUN_ID_PATTERN = /\br_[0-9a-zA-Z][0-9a-zA-Z-]{7,}/;

export function extractRunId(text) {
  if (typeof text !== 'string') return null;
  const m = RUN_ID_PATTERN.exec(text);
  return m ? m[0] : null;
}

// `turn` is { runId, startMs, durationMs }; `dispatches` is a list of
// { id, started_ms, duration_ms } read from the runs table. Returns
// { run_id, basis } for a match, else null. Pure.
export function findDispatchMatch(turn, dispatches, opts = {}) {
  const {
    durationToleranceMs = DISPATCH_DURATION_TOLERANCE_MS,
    startToleranceMs = DISPATCH_START_TOLERANCE_MS,
  } = opts;
  if (!Array.isArray(dispatches) || dispatches.length === 0) return null;

  if (turn?.runId) {
    const byId = dispatches.find((d) => d.id === turn.runId);
    if (byId) return { run_id: byId.id, basis: 'run-id' };
  }

  // Adjacency needs both clocks on both sides. An unknown duration is not weak
  // evidence, it is no evidence — start time alone would sweep in every
  // interactive turn a user happened to type while a dispatch was launching.
  if (!Number.isFinite(turn?.startMs) || !Number.isFinite(turn?.durationMs)) return null;
  let best = null;
  for (const d of dispatches) {
    if (!Number.isFinite(d?.started_ms) || !Number.isFinite(d?.duration_ms)) continue;
    const startDelta = Math.abs(d.started_ms - turn.startMs);
    if (startDelta > startToleranceMs) continue;
    if (Math.abs(d.duration_ms - turn.durationMs) > durationToleranceMs) continue;
    // Ties broken by the closest start — two dispatches inside a 5s window is
    // possible, and the nearer one is the better claim.
    if (!best || startDelta < best.startDelta) best = { id: d.id, startDelta };
  }
  return best ? { run_id: best.id, basis: 'adjacency' } : null;
}
