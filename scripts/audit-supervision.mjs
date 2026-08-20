// Pure decision table for the supervision-stale audit check (scripts/audit.mjs's
// checkSupervisionStale). Separated from the file + DB reads so the staleness
// contract is unit-testable: audit.mjs imports node:sqlite at module top, which
// vitest's resolver can't load, so the impure half can't be imported by a test.
// checkSupervisionStale reads .claude/state/supervision-heartbeat.json plus the
// live `running` run count and feeds the facts in here; it maps each returned
// decision onto the `supervision-stale` finding id (keeping the id literal in
// audit.mjs so the audit-check-id scanners still see it).
//
// Returned decisions carry `kind`, `source`, `severity`, `message`, `hint`.

// Per-source staleness windows. The scheduler tick fires every minute, so ten
// minutes is nine missed ticks; the server's orphan sweep runs every five, so
// fifteen is two missed sweeps plus slack for a slow boot.
export const SUPERVISION_WINDOWS_MS = {
  'scheduler-tick': 10 * 60 * 1000,
  'api-server': 15 * 60 * 1000,
};

const HINTS = {
  'scheduler-tick':
    'The per-minute LaunchAgent tick stopped supervising. Check `launchctl list | grep agentic-os` and re-run scripts/install-scheduler.sh if the agent is gone.',
  'api-server':
    "The dashboard server's dead-run sweep stopped stamping. Expected while the dashboard is deliberately down; otherwise restart it (`/os dashboard`) and check its logs.",
};

function minutes(ms) {
  return Math.floor(ms / 60000);
}

/**
 * @param {object} facts
 * @param {Record<string, string> | null} facts.heartbeat  parsed heartbeat file, or null when missing/corrupt
 * @param {number}  facts.nowMs
 * @param {number}  facts.runningRuns  rows currently in state `running`
 * @param {Record<string, number>} [facts.windows]  source → staleness window (ms)
 * @returns {Array<{kind: string, source: string|null, severity: string, message: string, hint: string}>}
 */
export function classifySupervisionStaleness({
  heartbeat,
  nowMs,
  runningRuns = 0,
  windows = SUPERVISION_WINDOWS_MS,
}) {
  const decisions = [];
  const inFlight = runningRuns > 0;

  // No heartbeat file at all. On a fresh clone this just means neither host
  // has ever supervised — silent. With runs in flight it means nobody is
  // watching work that is actually happening, which is the whole point of
  // the check.
  if (heartbeat === null || heartbeat === undefined) {
    if (!inFlight) return decisions;
    decisions.push({
      kind: 'absent',
      source: null,
      severity: 'warn',
      message: `No supervision heartbeat has ever been written, and ${runningRuns} run(s) are marked \`running\` — nothing is reaping dead children or enforcing the wall-time cap`,
      hint: 'Install the scheduler (scripts/install-scheduler.sh) or start the dashboard server; both stamp .claude/state/supervision-heartbeat.json after each supervision pass.',
    });
    return decisions;
  }

  for (const [source, windowMs] of Object.entries(windows)) {
    const stamp = heartbeat[source];
    // A source that has NEVER stamped is not drift — the LaunchAgent may not
    // be installed, or the dashboard may never have run on this clone. Only a
    // source that used to stamp and then went quiet is evidence of death.
    if (stamp === undefined || stamp === null) continue;
    const stampedMs = Date.parse(String(stamp));
    if (!Number.isFinite(stampedMs)) {
      decisions.push({
        kind: 'unparseable',
        source,
        severity: 'warn',
        message: `Supervision heartbeat for "${source}" is not a parseable ISO timestamp (${JSON.stringify(stamp)})`,
        hint: 'Delete .claude/state/supervision-heartbeat.json — the next supervision pass rebuilds it from scratch.',
      });
      continue;
    }
    const ageMs = nowMs - stampedMs;
    if (ageMs <= windowMs) continue; // fresh (a future stamp — clock skew — also reads fresh)
    decisions.push({
      kind: 'stale',
      source,
      // Escalated to warn only when work is actually in flight: a quiet host
      // with nothing to supervise is normal (dashboard closed, laptop asleep),
      // the same reasoning events-db-stale uses for its info severity.
      severity: inFlight ? 'warn' : 'info',
      message: inFlight
        ? `Supervision source "${source}" last stamped ${minutes(ageMs)}m ago (window ${minutes(windowMs)}m) while ${runningRuns} run(s) are marked \`running\` — those runs are unsupervised`
        : `Supervision source "${source}" last stamped ${minutes(ageMs)}m ago (window ${minutes(windowMs)}m)`,
      hint: HINTS[source] ?? 'Restart the supervision host so it resumes stamping after each pass.',
    });
  }

  return decisions;
}
