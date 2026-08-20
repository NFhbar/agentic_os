// Ops → one dated report, deep-linkable at /ops/:id/reports/:file.
//
// The header renders the graded fields from the report's FRONTMATTER — never
// from its prose. A verdict scraped out of a sentence would be a number nobody
// could be held to, and it could silently disagree with the report below it.

import { Icons, MarkdownBlock } from '../../../shared';
import type { OpsReportDetail } from '../data';
import { formatKpiValue, hasGaps, verdictBadgeClass, verdictLabel } from '../data';

export interface ReportPageProps {
  report: OpsReportDetail;
  protocolTitle: string;
  onBack: () => void;
}

export function ReportPage({ report, protocolTitle, onBack }: ReportPageProps) {
  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← {protocolTitle}
        </button>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 className="h1" style={{ margin: 0 }}>
            {report.date ?? report.file}
            {report.seq > 1 ? ` · review #${report.seq}` : ''}
          </h1>
          <div className="tiny subtle" style={{ marginTop: 2 }}>
            <span className="mono">{report.path}</span>
          </div>
        </div>
        <span className={verdictBadgeClass(report.verdict)}>
          <span className="badge-dot" />
          {verdictLabel(report.verdict)}
        </span>
      </header>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-body">
          <div className="hstack" style={{ gap: 22, flexWrap: 'wrap' }}>
            <Fact label={report.kpi_name ?? 'KPI'} value={formatKpiValue(report.kpi_value)} />
            <Fact label="target" value={formatKpiValue(report.kpi_target)} />
            <Fact label="guardrail" value={formatKpiValue(report.kpi_guardrail)} />
            <Fact
              label="window"
              value={
                report.window_days === null
                  ? '—'
                  : `${report.window_days}d${report.window_overridden ? ' (overridden)' : ''}`
              }
            />
            <Fact
              label="failures"
              value={
                report.failures_total === null
                  ? '—'
                  : `${report.failures_total}${
                      (report.failures_unclassified ?? 0) > 0
                        ? ` · ${report.failures_unclassified} unclassified`
                        : ''
                    }`
              }
            />
            <Fact
              label="tickets"
              value={`${report.tickets_confirmed ?? 0} confirmed · ${
                report.tickets_pending ?? 0
              } pending${
                (report.tickets_contradicted ?? 0) > 0
                  ? ` · ${report.tickets_contradicted} contradicted`
                  : ''
              }`}
            />
            <Fact
              label="monitors ready"
              value={
                (report.monitors_ready ?? 0) > 0
                  ? `${report.monitors_ready} (recommendation only)`
                  : '0'
              }
            />
            <Fact
              label="forecast"
              value={
                report.forecast_horizon_hours ? `${report.forecast_horizon_hours}h` : 'withheld'
              }
            />
          </div>
          {hasGaps(report) && (
            <p className="tiny" style={{ marginBottom: 0, marginTop: 12 }}>
              <Icons.AlertTriangle size={13} />{' '}
              <strong>
                {report.gaps} source{report.gaps === 1 ? '' : 's'} could not be reached
              </strong>{' '}
              — findings below that depended on {report.gaps === 1 ? 'it' : 'them'} are degraded.
              See the report's Gaps section.
            </p>
          )}
        </div>
      </div>

      <MarkdownBlock text={report.body} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tiny subtle">{label}</div>
      <div className="mono">{value}</div>
    </div>
  );
}
