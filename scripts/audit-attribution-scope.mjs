// Pure scoping rules for the three telemetry-attribution audit checks
// (checkEventAttribution / checkProjectAttribution / checkReportAttribution in
// scripts/audit.mjs). Separated from the DB reads so the exemption contract is
// unit-testable: audit.mjs imports node:sqlite at module top, which vitest's
// resolver can't load, so the impure half can't be imported by a test.
//
// The checks ask: "this row's skill is change- / project- / report-scoped, so
// why is the corresponding id column NULL?" That question is only fair for
// rows a writer was supposed to tag. Two row classes carry no attribution by
// construction, and flagging them produces perpetual action items nobody can
// clear:
//
// 1. **Kinds / actions that predate attribution.** `dashboard.ai-prompt` rows
//    are raw dispatch envelopes — their `skill` is inferred from the prompt
//    body by extract-event-attribution.mjs, not stamped by a skill that also
//    knew the change/project/report id. `router.route` rows are the router's
//    own intent log, recorded BEFORE the entity exists (a `/os add-change`
//    route fires before the change entry is written). Both legitimately land
//    with a backfilled skill and a null id column.
// 2. **Args explicitly recorded as null.** `record-dashboard-action.mjs`
//    writes `args: null` into `raw` when the caller passed no `--args`; the
//    attribution helper lifts ids OUT of args, so there was nothing to lift.
//    Distinguished from an absent `$.args` path by SQLite's `json_type`,
//    which returns the string `'null'` only for an explicit JSON null.
//
// Everything else stays in scope — a `dashboard.<lifecycle-action>` row with a
// real args payload and a null id column is a genuine writer bug.

export const UNATTRIBUTED_EVENT_KINDS = new Set(['router']);
export const UNATTRIBUTED_EVENT_ACTIONS = new Set(['ai-prompt', 'route']);

// The projection each check SELECTs so the predicate below can see case 2.
// `json_valid` guards rows whose `raw` isn't JSON at all — without it one
// malformed row makes SQLite throw and silently kills the whole check.
export const ARGS_JSON_TYPE_SQL =
  "CASE WHEN json_valid(raw) THEN json_type(raw, '$.args') END AS args_json_type";

/**
 * @param {object} row
 * @param {string|null} [row.kind]           events.kind
 * @param {string|null} [row.action]         events.action
 * @param {string|null} [row.args_json_type] `json_type(raw, '$.args')` — `'null'` for an
 *                                           explicit JSON null, NULL/undefined when absent
 * @returns {boolean} true when the row legitimately carries no attribution
 */
export function isAttributionExempt({ kind, action, args_json_type } = {}) {
  if (kind && UNATTRIBUTED_EVENT_KINDS.has(kind)) return true;
  if (action && UNATTRIBUTED_EVENT_ACTIONS.has(action)) return true;
  return args_json_type === 'null';
}

/**
 * Drop the exempt rows, then group the remainder by skill — the shape the
 * attribution findings render (`skill=n, …`, biggest offender first; ties break
 * on skill name so the message is stable run to run).
 *
 * @param {Array<{skill: string|null, kind?: string|null, action?: string|null, args_json_type?: string|null}>} rows
 * @returns {Array<{skill: string, n: number}>}
 */
export function tallyUnattributed(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    if (!row?.skill) continue;
    if (isAttributionExempt(row)) continue;
    counts.set(row.skill, (counts.get(row.skill) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([skill, n]) => ({ skill, n }))
    .sort((a, b) => b.n - a.n || a.skill.localeCompare(b.skill));
}
