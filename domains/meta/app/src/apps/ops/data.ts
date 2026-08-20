// Type re-exports from the server's wire-shape definitions. Per
// standard-shared-types (sibling .types.ts pattern), the server route file's
// .types.ts is the single source of truth — this module re-exports them for
// the client and adds the UI-only presentation helpers.

export type {
  OpsKpi,
  OpsMonitor,
  OpsProtocolDetail,
  OpsProtocolSummary,
  OpsReportDetail,
  OpsReportSummary,
  OpsVerdict,
} from '../../../server/routes/ops.types';

import type { OpsKpi, OpsReportSummary, OpsVerdict } from '../../../server/routes/ops.types';

// Badge tone per verdict. `action-needed` is the only danger state; `watch`
// is warning; a protocol with no verdict yet is muted rather than green —
// "never reviewed" must never read as "healthy".
export function verdictBadgeClass(v: OpsVerdict | null): string {
  if (v === 'healthy') return 'badge success';
  if (v === 'watch') return 'badge warning';
  if (v === 'action-needed') return 'badge danger';
  return 'badge muted';
}

export function verdictLabel(v: OpsVerdict | null): string {
  return v ?? 'not reviewed';
}

// Formats a KPI value for a badge. Sub-1 values render as percentages because
// rates are the common case; everything else keeps up to three significant
// decimals. `null` renders as an explicit dash — never as 0.
export function formatKpiValue(value: number | null): string {
  if (value === null) return '—';
  if (Math.abs(value) < 1 && value !== 0) return `${(value * 100).toFixed(1)}%`;
  return String(Math.round(value * 1000) / 1000);
}

// One line describing the contract a value was graded against. An unset
// contract says so out loud — a blank would read as "nothing to report".
export function kpiContractLine(kpi: OpsKpi | null): string {
  if (!kpi) return 'no KPI contract on this protocol';
  const parts: string[] = [];
  parts.push(kpi.baseline === null ? 'baseline unset' : `baseline ${formatKpiValue(kpi.baseline)}`);
  parts.push(kpi.target === null ? 'target unset' : `target ${formatKpiValue(kpi.target)}`);
  parts.push(
    kpi.guardrail === null ? 'guardrail unset' : `guardrail ${formatKpiValue(kpi.guardrail)}`,
  );
  return parts.join(' · ');
}

// True when the protocol has no numbers to grade against yet — the honest-null
// state every protocol starts in. Surfaced as a "measure first" hint.
export function isContractUnset(kpi: OpsKpi | null): boolean {
  if (!kpi) return true;
  return kpi.baseline === null && kpi.target === null && kpi.guardrail === null;
}

// A report is degraded when it could not reach every source it needed. Shown
// next to the verdict so a confident-looking grade never hides a blind spot.
export function hasGaps(report: OpsReportSummary): boolean {
  return (report.gaps ?? 0) > 0;
}
