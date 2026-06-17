// Pure decision table for the runs-origin audit (scripts/audit.mjs's
// checkRunsDb). Separated from the DB reads so the branch → severity contract
// is unit-testable: audit.mjs imports node:sqlite at module top, which
// vitest's resolver can't load, so the impure half can't be imported by a
// test. checkRunsDb does the PRAGMA + COUNT reads and feeds the facts in here;
// it maps each returned decision `kind` to a finding `id` (keeping the id
// literals in audit.mjs so the audit-check-id scanners still see them).
//
// Returned decisions carry `kind`, `severity`, `message`, `hint` — everything
// except the finding id. Order matches the legacy checkRunsDb emission order.

/**
 * @param {object} facts
 * @param {string[]} facts.columns         live `runs` table columns (PRAGMA table_info)
 * @param {string[]} facts.expectedColumns RUNS_EXPECTED_COLUMNS
 * @param {string[]} facts.validOrigins    RUN_ORIGINS
 * @param {number}   facts.legacyNullCount rows with origin IS NULL
 * @param {number}   facts.invalidCount    rows with a non-NULL out-of-vocabulary origin
 * @returns {Array<{kind: string, severity: string, message: string, hint: string}>}
 */
export function classifyRunsOrigin({
  columns,
  expectedColumns,
  validOrigins,
  legacyNullCount,
  invalidCount,
}) {
  const decisions = [];
  // No runs table yet (fresh clone that never dispatched) — nothing to check.
  if (columns.length === 0) return decisions;

  if (!columns.includes('origin')) {
    decisions.push({
      kind: 'origin-column-missing',
      severity: 'error',
      message: 'runs table is missing the `origin` column',
      hint: 'Re-open the dashboard (initRunsTable migrates in place) or run `node scripts/runs-db-init.mjs`.',
    });
    // Without the column the count queries below are meaningless — stop here.
    return decisions;
  }

  // Schema drift backstop — a distinct id from run-origin-missing so a generic
  // missing column (e.g. hooks_fired_at) doesn't masquerade as origin-specific.
  const missing = expectedColumns.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    decisions.push({
      kind: 'schema-drift',
      severity: 'warn',
      message: `runs table missing columns: ${missing.join(', ')}`,
      hint: 'Re-open the dashboard or run `node scripts/runs-db-init.mjs` (idempotent additive migrations).',
    });
  }

  if (legacyNullCount > 0) {
    decisions.push({
      kind: 'legacy-null',
      severity: 'info',
      message: `${legacyNullCount} runs row(s) have a NULL origin (legacy — read as human)`,
      hint: 'Expected for rows created before origin was stamped at dispatch. No action needed; they render as `human`.',
    });
  }

  if (invalidCount > 0) {
    decisions.push({
      kind: 'invalid-origin',
      severity: 'error',
      message: `${invalidCount} runs row(s) carry an origin outside the vocabulary (${validOrigins.join(' | ')})`,
      hint: 'A dispatch path stamped an unknown origin. Check the startRun callers; valid values live in RUN_ORIGINS (scripts/runs-db-init.mjs).',
    });
  }

  return decisions;
}
