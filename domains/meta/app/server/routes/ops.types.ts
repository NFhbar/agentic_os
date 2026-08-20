// Ops wire shapes — shared between server and client per standard-shared-types
// (the route file's sibling .types.ts is the single source of truth; the app's
// data.ts re-exports from here rather than redeclaring).
//
// The archetype contract these mirror is documented in
// vault/wiki/_seed/meta/reference/archetype-review-protocol.md.

export type OpsVerdict = 'healthy' | 'watch' | 'action-needed';

// The health contract carried on a protocol's `kpi` frontmatter field.
// baseline / target / guardrail are null until measured — an unset contract is
// a legitimate state, not a parse failure, and the UI renders it as "unset".
export interface OpsKpi {
  name: string;
  formula: string;
  baseline: number | null;
  target: number | null;
  window_days: number | null;
  guardrail: number | null;
}

// One monitor candidate. `gate` states what must be true before a human is
// asked to publish it; reviews evaluate gates and recommend, never publish.
export interface OpsMonitor {
  id: string;
  name: string;
  gate: string;
}

export interface OpsProtocolSummary {
  id: string;
  path: string; // repo-relative path to the protocol entry
  title: string;
  target: string | null;
  owner: string | null;
  scan_minutes: number | null;
  // null when the field is absent OR was reformatted into a multi-line block —
  // the silent-drop case the single-line-JSON contract exists to prevent. The
  // UI shows it as a missing contract rather than pretending a KPI exists.
  kpi: OpsKpi | null;
  verify_tickets: string[];
  monitors: OpsMonitor[];
  reports_dir: string; // repo-relative; defaulted when the entry omits it
  last_reviewed: string | null;
  last_verdict: OpsVerdict | null;
  created: string | null;
  updated: string | null;
  reports_count: number;
}

// One dated report under a protocol's reports_dir. Every graded field is read
// from the report's FRONTMATTER — never scraped from prose.
export interface OpsReportSummary {
  file: string; // e.g. '2026-08-27.md'
  path: string; // repo-relative
  date: string | null; // 'YYYY-MM-DD' parsed from the filename
  seq: number; // 1, or N for the Nth same-day review ('…-2.md' → 2)
  reviewed_at: string | null;
  verdict: OpsVerdict | null;
  kpi_name: string | null;
  kpi_value: number | null;
  kpi_baseline: number | null;
  kpi_target: number | null;
  kpi_guardrail: number | null;
  window_days: number | null;
  window_overridden: boolean;
  failures_total: number | null;
  failures_unclassified: number | null;
  tickets_confirmed: number | null;
  tickets_pending: number | null;
  tickets_contradicted: number | null;
  monitors_ready: number | null;
  gaps: number | null;
  forecast_horizon_hours: number | null;
}

export interface OpsProtocolDetail extends OpsProtocolSummary {
  body: string;
  reports: OpsReportSummary[];
}

export interface OpsReportDetail extends OpsReportSummary {
  protocol: string;
  content: string; // full file text, frontmatter included
  body: string; // content after the frontmatter fence
}
