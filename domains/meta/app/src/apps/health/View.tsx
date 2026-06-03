// Health — OS audit findings drill-down. Migrated to apps/ + restyled with
// the prototype design system: .page wrapper, .card per severity group,
// <Metric> summary tiles, prototype .badge for severity counts, .mono for ids.

import { useCallback, useEffect, useState } from 'react';
import { LatestArtifactCard } from '../../components/LatestArtifactCard';
import { getJson } from '../../lib/api';
import { useNavigation } from '../../lib/navigation';
import { formatLocal, formatRelative } from '../../lib/time';
import { Icons, Metric } from '../../shared';
import '../../shared/styles.css';
import type { AuditFinding, AuditResponse } from '../../../server/routes/audit.types';

// Resolve the latest weekly health-check artifact path. The runbook writes
// `vault/output/meta/health-checks/<YYYY-MM-DD>.md` and does NOT mirror to
// latest.md, so we list the directory and pick the newest-dated file. Sort
// is alphanumeric — ISO date filenames sort identically to chronological.
interface OutputListResponse {
  files: string[];
}
async function findLatestHealthCheckPath(): Promise<string | null> {
  try {
    const r = await getJson<OutputListResponse>('/api/vault/output');
    const matches = r.files
      .filter((f) => /^vault\/output\/meta\/health-checks\/.+\.md$/.test(f))
      .sort();
    return matches.length > 0 ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

function navigatorFor(path: string, nav: ReturnType<typeof useNavigation>): (() => void) | null {
  const skillMatch = path.match(/^\.claude\/skills\/([^/]+)\/SKILL\.md$/);
  if (skillMatch) {
    return () => nav.navigateToSkill(skillMatch[1]);
  }
  const wikiMatch = path.match(/^vault\/wiki\/.+\/([^/]+)\.md$/);
  if (wikiMatch) {
    return () => nav.navigateToEntry(wikiMatch[1]);
  }
  if (path.match(/^domains\/.+\/playbook\.md$/)) {
    return () => nav.setView('domains');
  }
  return null;
}

function sevSymbol(s: AuditFinding['severity']): string {
  return s === 'error' ? '✗' : s === 'warn' ? '⚠' : 'ℹ';
}

function sevLabel(s: AuditFinding['severity']): string {
  return s === 'error' ? 'Errors' : s === 'warn' ? 'Warnings' : 'Info';
}

function sevBadgeClass(s: AuditFinding['severity']): string {
  return s === 'error' ? 'badge danger' : s === 'warn' ? 'badge warning' : 'badge accent';
}

function sevMetricSeverity(s: AuditFinding['severity']): 'ok' | 'warn' | 'err' {
  return s === 'error' ? 'err' : s === 'warn' ? 'warn' : 'ok';
}

export default function Health() {
  const nav = useNavigation();
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Default-hide findings the user has dismissed from the action-items panel.
  // The audit response stamps `dismissed: true` server-side by joining each
  // finding's composed id against the dismissal log.
  const [showDismissed, setShowDismissed] = useState<boolean>(false);

  const [healthCheckPath, setHealthCheckPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getJson<AuditResponse>('/api/audit');
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    findLatestHealthCheckPath().then(setHealthCheckPath);
  }, []);

  const groups: AuditFinding['severity'][] = ['error', 'warn', 'info'];

  // Findings the user actually wants to see right now. When showDismissed
  // is off, dismissed items are filtered out entirely; when on, they're
  // included with a muted treatment + "Dismissed" chip in the row.
  const visibleFindings = data
    ? showDismissed
      ? data.findings
      : data.findings.filter((f) => !f.dismissed)
    : [];

  // Summary counts mirror what the user sees in the list, NOT the raw
  // server totals — otherwise the metric tiles would say "1 warning" while
  // the list is empty (confusing). Recompute from visibleFindings.
  const visibleSummary = {
    error: visibleFindings.filter((f) => f.severity === 'error').length,
    warn: visibleFindings.filter((f) => f.severity === 'warn').length,
    info: visibleFindings.filter((f) => f.severity === 'info').length,
  };
  const dismissedCount = data ? data.findings.filter((f) => f.dismissed).length : 0;

  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">OS health</h1>
        <span className="spacer" />
        {dismissedCount > 0 && (
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            title="Findings you previously dismissed from the action items panel"
          >
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
            />
            <span className="tiny" style={{ color: 'var(--muted)' }}>
              Show {dismissedCount} dismissed
            </span>
          </label>
        )}
        <button type="button" className="btn btn-primary" onClick={refresh} disabled={loading}>
          {loading ? (
            <>
              <Icons.Sparkles size={13} /> Auditing…
            </>
          ) : (
            <>
              <Icons.Refresh size={13} /> Refresh
            </>
          )}
        </button>
      </header>

      <p className="subtle" style={{ marginBottom: 18 }}>
        Reads <span className="mono">scripts/audit.mjs</span>'s JSON output. Errors block (exit 1 on
        the CLI); warnings + info are advisory. Each finding's <span className="mono">id</span> maps
        to a check in{' '}
        <span className="mono">vault/wiki/_seed/meta/reference/standard-os-audit.md</span>.
      </p>

      {error && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            marginBottom: 14,
            borderColor: 'var(--danger)',
            background: 'var(--danger-soft)',
            color: 'var(--danger-text)',
          }}
        >
          <strong>Audit failed:</strong> {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary metrics — reflect what's currently visible. When showDismissed
              is off, counts exclude dismissed findings so the tiles match the list. */}
          <div className="grid-metrics" style={{ marginBottom: 18 }}>
            <Metric
              label="Errors"
              value={String(visibleSummary.error)}
              hint={visibleSummary.error === 0 ? 'clean' : 'blocks CI'}
              severity={visibleSummary.error > 0 ? 'err' : 'ok'}
            />
            <Metric
              label="Warnings"
              value={String(visibleSummary.warn)}
              hint={visibleSummary.warn === 0 ? 'clean' : 'advisory'}
              severity={visibleSummary.warn > 0 ? 'warn' : 'ok'}
            />
            <Metric label="Info" value={String(visibleSummary.info)} hint="advisory" />
            <Metric
              label="Last run"
              value={formatRelative(data.ran_at)}
              hint={`${data.duration_ms} ms · ${formatLocal(data.ran_at).split(' ').slice(0, 2).join(' ')}`}
            />
          </div>

          <LatestArtifactCard
            title="Latest weekly health check"
            path={healthCheckPath}
            storageKey="agentic-os/health-weekly-check-collapsed"
            emptyMessage={
              "No weekly health check has run yet. The runbook fires every Sunday at 08:30 local; Run now from the Schedules page to generate one."
            }
          />

          {visibleFindings.length === 0 ? (
            <div
              className="card"
              style={{
                padding: '32px 24px',
                textAlign: 'center',
                borderColor: 'color-mix(in oklab, var(--success) 30%, var(--border))',
                background: 'var(--success-soft)',
              }}
            >
              <p className="h2" style={{ marginBottom: 6, color: 'var(--success-text)' }}>
                ✓ OS audit clean — no findings.
              </p>
              <p className="subtle">
                {dismissedCount > 0 && !showDismissed
                  ? `${dismissedCount} dismissed finding${dismissedCount === 1 ? '' : 's'} hidden. Toggle above to see them.`
                  : 'All skills, wiki entries, domains, archetypes, router rows, and logs comply with the documented standards. Re-run periodically or after freehand edits.'}
              </p>
            </div>
          ) : (
            <>
              {groups.map((sev) => {
                const items = visibleFindings.filter((f) => f.severity === sev);
                if (items.length === 0) return null;
                return (
                  <div
                    key={sev}
                    className="card"
                    style={{
                      marginBottom: 14,
                      borderColor:
                        sev === 'error'
                          ? 'color-mix(in oklab, var(--danger) 30%, var(--border))'
                          : sev === 'warn'
                            ? 'color-mix(in oklab, var(--warning) 30%, var(--border))'
                            : 'var(--border)',
                    }}
                  >
                    <div
                      className="card-header"
                      style={{
                        background:
                          sev === 'error'
                            ? 'var(--danger-soft)'
                            : sev === 'warn'
                              ? 'var(--warning-soft)'
                              : 'var(--accent-soft)',
                      }}
                    >
                      <h3 className="card-title">
                        {sevSymbol(sev)} {sevLabel(sev)}
                      </h3>
                      <span className={sevBadgeClass(sev)}>
                        <span className="badge-dot" />
                        {items.length}
                      </span>
                    </div>
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {items.map((f, i) => {
                        const onClick = f.path ? navigatorFor(f.path, nav) : null;
                        const isDismissed = f.dismissed === true;
                        return (
                          <li
                            key={`${f.id}-${i}`}
                            style={{
                              padding: '12px 18px',
                              borderBottom: '1px solid var(--border)',
                              opacity: isDismissed ? 0.55 : 1,
                            }}
                            title={isDismissed ? 'Dismissed from the action items panel' : undefined}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 8,
                                marginBottom: 4,
                                flexWrap: 'wrap',
                              }}
                            >
                              <code
                                className="mono"
                                style={{
                                  fontSize: 11.5,
                                  background: 'var(--panel-3)',
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  border: '1px solid var(--border)',
                                  color: 'var(--text-2)',
                                  textDecoration: isDismissed ? 'line-through' : undefined,
                                }}
                              >
                                {f.id}
                              </code>
                              {isDismissed && (
                                <span
                                  className="badge muted"
                                  style={{ fontSize: 10.5 }}
                                  title="Stored in .claude/state/dismissed-action-items.jsonl"
                                >
                                  Dismissed
                                </span>
                              )}
                              {f.path &&
                                (onClick ? (
                                  <button
                                    type="button"
                                    onClick={onClick}
                                    title="Open in the relevant view"
                                    style={{
                                      background: 'none',
                                      border: 0,
                                      padding: 0,
                                      color: 'var(--accent-text)',
                                      font: 'inherit',
                                      fontSize: 12,
                                      fontFamily: 'var(--font-mono)',
                                      cursor: 'pointer',
                                      textDecoration: 'underline',
                                      textDecorationColor: 'rgba(147,184,255,0.3)',
                                    }}
                                  >
                                    {f.path}
                                  </button>
                                ) : (
                                  <code className="mono tiny">{f.path}</code>
                                ))}
                            </div>
                            <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>
                              {f.message}
                            </div>
                            {f.hint && (
                              <div className="tiny" style={{ color: 'var(--muted)' }}>
                                → {f.hint}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
