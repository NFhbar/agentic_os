// Ops → one protocol: the contract on the left of the reader's attention, the
// report history below it.
//
// The contract is rendered because a verdict is only interpretable against it.
// Showing the reports without the thresholds they were graded by is how a
// "healthy" ends up meaning whatever the reader assumes it means.

import { Empty, Icons, MarkdownBlock } from '../../../shared';
import type { OpsProtocolDetail } from '../data';
import { formatKpiValue, hasGaps, isContractUnset, verdictBadgeClass, verdictLabel } from '../data';

export interface ProtocolPageProps {
  detail: OpsProtocolDetail;
  dispatching: boolean;
  onBack: () => void;
  onRunReview: () => void;
  onOpenReport: (file: string) => void;
}

export function ProtocolPage({
  detail,
  dispatching,
  onBack,
  onRunReview,
  onOpenReport,
}: ProtocolPageProps) {
  const kpi = detail.kpi;
  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← Ops
        </button>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 className="h1" style={{ margin: 0 }}>
            {detail.title}
          </h1>
          <div className="tiny subtle" style={{ marginTop: 2 }}>
            <span className="mono">{detail.id}</span>
            {detail.target ? ` · target ${detail.target}` : ''}
            {detail.owner ? ` · owner ${detail.owner}` : ''}
            {detail.scan_minutes ? ` · ${detail.scan_minutes} min budget` : ''}
          </div>
        </div>
        <span className={verdictBadgeClass(detail.last_verdict)}>
          <span className="badge-dot" />
          {verdictLabel(detail.last_verdict)}
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={dispatching}
          onClick={onRunReview}
          title={
            dispatching
              ? 'An ops run is already in flight'
              : 'Dispatch a health review against this protocol (read-only)'
          }
        >
          <Icons.Play size={14} /> Run review
        </button>
      </header>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-header">
          <span className="card-title">KPI contract</span>
        </div>
        <div className="card-body">
          {!kpi && (
            <p className="subtle" style={{ margin: 0 }}>
              This protocol declares no KPI. A review can still classify failures and verify fixes,
              but it has no number to grade — every verdict will be <code>watch</code>.
            </p>
          )}
          {kpi && (
            <>
              <p style={{ marginTop: 0 }}>
                <strong>{kpi.name}</strong>
                {kpi.window_days ? (
                  <span className="tiny subtle"> · {kpi.window_days}d window</span>
                ) : null}
              </p>
              {kpi.formula && (
                <p className="tiny" style={{ marginTop: 0 }}>
                  <code>{kpi.formula}</code>
                </p>
              )}
              <div className="hstack" style={{ gap: 18, flexWrap: 'wrap' }}>
                <ContractValue label="baseline" value={kpi.baseline} />
                <ContractValue label="target" value={kpi.target} />
                <ContractValue label="guardrail" value={kpi.guardrail} />
              </div>
              {isContractUnset(kpi) && (
                <p className="tiny subtle" style={{ marginBottom: 0, marginTop: 10 }}>
                  Nothing is set yet — that is the honest starting state. Run two or three reviews,
                  then set the numbers by hand from what they measured and record the reasoning in a
                  decision entry. Reviews against an unset contract report the value and return{' '}
                  <code>watch</code>.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {detail.monitors.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header">
            <span className="card-title">Monitor candidates</span>
          </div>
          <div className="card-body">
            <p className="tiny subtle" style={{ marginTop: 0 }}>
              Reviews evaluate each gate and recommend. Publishing is a human act — nothing in this
              domain creates, enables, silences, or edits a monitor.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {detail.monitors.map((m) => (
                <li key={m.id} style={{ marginBottom: 6 }}>
                  <span className="mono">{m.id}</span> — {m.name}
                  <div className="tiny subtle">gate: {m.gate}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {detail.verify_tickets.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header">
            <span className="card-title">Fixes under verification</span>
          </div>
          <div className="card-body">
            <div className="hstack" style={{ gap: 6, flexWrap: 'wrap' }}>
              {detail.verify_tickets.map((t) => (
                <span key={t} className="badge muted">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <h2 className="h2">Reports</h2>
      {detail.reports.length === 0 && (
        <Empty
          title="No reviews yet"
          hint="The first run establishes the measurement — its verdict will be `watch` because there is nothing to compare against."
          icon={<Icons.Flag size={24} />}
        />
      )}
      {detail.reports.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Verdict</th>
              <th>KPI</th>
              <th>Failures</th>
              <th>Gaps</th>
            </tr>
          </thead>
          <tbody>
            {detail.reports.map((r) => (
              <tr key={r.file} className="clickable" onClick={() => onOpenReport(r.file)}>
                <td>
                  <span className="mono">{r.date ?? r.file}</span>
                  {r.seq > 1 && <span className="tiny subtle"> · #{r.seq}</span>}
                </td>
                <td>
                  <span className={verdictBadgeClass(r.verdict)}>
                    <span className="badge-dot" />
                    {verdictLabel(r.verdict)}
                  </span>
                </td>
                <td className="mono">{formatKpiValue(r.kpi_value)}</td>
                <td className="tiny">
                  {r.failures_total ?? '—'}
                  {(r.failures_unclassified ?? 0) > 0 && (
                    <span className="subtle"> ({r.failures_unclassified} unclassified)</span>
                  )}
                </td>
                <td className="tiny">{hasGaps(r) ? r.gaps : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="h2" style={{ marginTop: 24 }}>
        Protocol
      </h2>
      <MarkdownBlock text={detail.body} />
    </div>
  );
}

function ContractValue({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="tiny subtle">{label}</div>
      <div className="mono">{value === null ? 'unset' : formatKpiValue(value)}</div>
    </div>
  );
}
