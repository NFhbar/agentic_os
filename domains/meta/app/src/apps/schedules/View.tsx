// Schedules — runbook list with manual run-now. Migrated to apps/ + restyled
// with the prototype design system: .page wrapper, .card per schedule item,
// .btn.btn-primary for run-now, .badge for status, .mono for cron + prompt.

import { useCallback, useEffect, useState } from 'react';
import type {
  ScheduleSummary,
  SchedulesListResponse,
} from '../../../server/routes/schedules.types';
import { ActionRunner } from '../../components/ActionRunner';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { getJson } from '../../lib/api';
import { useNavigation } from '../../lib/navigation';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { formatLocal, formatRelative } from '../../lib/time';
import { Icons } from '../../shared';
import '../../shared/styles.css';

// Local alias — the view only reads `schedules` from the full response, but
// using the canonical shape keeps everything aligned if the server adds new
// top-level fields.
type SchedulesData = SchedulesListResponse;

export default function Schedules() {
  const nav = useNavigation();
  const [data, setData] = useState<SchedulesData | null>(null);
  const [runTarget, setRunTarget] = useState<ScheduleSummary | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addSkill, setAddSkill] = useState<SkillSummary | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    getJson<SchedulesData>('/api/schedules')
      .then(setData)
      .catch(() =>
        setData({
          schedules: [],
          status: { count: 0, next_fire: null, last_24h: { runs: 0, failures: 0 } },
        }),
      );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function openAddForm() {
    let skill = await findSkill('meta-add-schedule');
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill('meta-add-schedule');
    }
    if (!skill) {
      alert('meta-add-schedule skill not found in .claude/skills/');
      return;
    }
    setAddSkill(skill);
    setShowAdd(true);
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (!data) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

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
        <h1 className="h1">Schedules</h1>
        <span className="tiny">
          {data.schedules.length} runbook{data.schedules.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={openAddForm}>
          <Icons.Plus size={13} /> New Schedule
        </button>
      </header>

      <p className="subtle" style={{ marginBottom: 18 }}>
        Scheduled runbooks fire automatically when the tick script runs. Install the launchd agent
        with <span className="mono">./scripts/install-scheduler.sh</span> to enable per-minute
        ticks. Manual <strong>Run now</strong> always works regardless.
      </p>

      {data.schedules.length === 0 ? (
        <div className="card" style={{ padding: 32 }}>
          <p className="h2" style={{ marginBottom: 8 }}>
            No schedules yet.
          </p>
          <p className="subtle">
            A schedule is a <span className="mono">runbook</span> wiki entry with{' '}
            <span className="mono">schedule:</span> and <span className="mono">prompt:</span> fields
            in its frontmatter. Click <strong>+ New Schedule</strong> to scaffold one, or read the
            standard at{' '}
            <span className="mono">vault/wiki/_seed/meta/reference/standard-scheduled-jobs.md</span>
            .
          </p>
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {data.schedules.map((s) => {
            const key = s.id ?? s.path;
            const isExpanded = expanded.has(key);
            // Skipped runs are healthy precondition-gates — render them with a
            // neutral badge, NOT the red "failure" treatment. `lastOk` covers
            // the actual-fired success case (exit 0).
            const lastSkipped = s.last_run?.outcome === 'skipped';
            const lastOk = s.last_run?.exit === 0;
            return (
              <li key={key} className="card">
                {/* Header row */}
                <div className="card-header">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      flexWrap: 'wrap',
                      minWidth: 0,
                    }}
                  >
                    <h3 className="card-title">{s.title}</h3>
                    {s.id && (
                      <span className="mono tiny" style={{ color: 'var(--muted)' }}>
                        {s.id}
                      </span>
                    )}
                    {s.domain && (
                      <span className="badge muted" style={{ fontSize: 10.5 }}>
                        {s.domain}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => setRunTarget(s)}
                    >
                      <Icons.Play size={11} /> Run now
                    </button>
                    {s.id && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => nav.navigateToEntry(s.id as string)}
                      >
                        Open entry
                      </button>
                    )}
                  </div>
                </div>

                {/* Meta grid */}
                <div className="card-body">
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: 14,
                      marginBottom: 12,
                    }}
                  >
                    <Field label="Schedule">
                      <span className="kbd">{s.schedule}</span>
                      {s.trigger && (
                        <span className="tiny" style={{ marginLeft: 6 }}>
                          {s.trigger}
                        </span>
                      )}
                    </Field>
                    <Field label="Next run">
                      <span className="mono tiny" title={s.next_run ?? ''}>
                        {s.next_run ? formatLocal(s.next_run, false) : '—'}
                      </span>
                    </Field>
                    <Field label="Last run">
                      {s.last_run ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span className="tiny mono" title={formatLocal(s.last_run.ts)}>
                            {formatRelative(s.last_run.ts)}
                          </span>
                          <span
                            className={
                              lastSkipped
                                ? 'badge muted'
                                : lastOk
                                  ? 'badge success'
                                  : 'badge danger'
                            }
                            style={{ fontSize: 10.5 }}
                            title={lastSkipped ? s.last_run.skip_reason ?? 'skipped' : undefined}
                          >
                            <span className="badge-dot" />
                            {lastSkipped
                              ? 'skipped'
                              : lastOk
                                ? `exit 0 · ${Math.round(s.last_run.duration_ms / 1000)}s`
                                : `exit ${s.last_run.exit ?? '?'}`}
                          </span>
                        </span>
                      ) : (
                        <span className="tiny">never</span>
                      )}
                    </Field>
                  </div>

                  {/* Prompt */}
                  <Field label="Prompt">
                    <pre
                      className="mono"
                      style={{
                        margin: 0,
                        padding: '10px 12px',
                        background: 'var(--bg-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 12,
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        color: 'var(--text-2)',
                      }}
                    >
                      {s.prompt}
                    </pre>
                  </Field>

                  {/* Last output (collapsible) */}
                  {s.last_run && (
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => toggleExpand(key)}
                      >
                        {isExpanded ? '▾' : '▸'} Last output
                      </button>
                      {isExpanded && (
                        <div style={{ marginTop: 8 }}>
                          {s.last_run.stdout_preview && (
                            <pre
                              className="mono"
                              style={{
                                margin: 0,
                                padding: '10px 12px',
                                background: 'var(--bg-2)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 11.5,
                                lineHeight: 1.55,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                maxHeight: 240,
                                overflow: 'auto',
                              }}
                            >
                              {s.last_run.stdout_preview}
                            </pre>
                          )}
                          {s.last_run.stderr && (
                            <>
                              <label
                                className="tiny"
                                style={{
                                  display: 'block',
                                  marginTop: 8,
                                  marginBottom: 4,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.06em',
                                  color: 'var(--danger-text)',
                                  fontWeight: 600,
                                }}
                              >
                                stderr
                              </label>
                              <pre
                                className="mono"
                                style={{
                                  margin: 0,
                                  padding: '10px 12px',
                                  background: 'var(--danger-soft)',
                                  border:
                                    '1px solid color-mix(in oklab, var(--danger) 30%, var(--border))',
                                  borderRadius: 'var(--radius-sm)',
                                  fontSize: 11.5,
                                  lineHeight: 1.55,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                  color: 'var(--danger-text)',
                                }}
                              >
                                {s.last_run.stderr}
                              </pre>
                            </>
                          )}
                          {!s.last_run.stdout_preview && !s.last_run.stderr && (
                            <p className="tiny">
                              {lastSkipped
                                ? `Skipped: ${s.last_run.skip_reason ?? 'precondition not met'}`
                                : '(no output captured)'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {runTarget && (
        <ActionRunner
          title={`Run ${runTarget.title} (manual)`}
          prompt={runTarget.prompt}
          endpoint="/api/schedules/run-now"
          body={{ id: runTarget.id }}
          onClose={() => {
            setRunTarget(null);
            refresh();
          }}
        />
      )}

      {showAdd && addSkill && (
        <ScaffoldForm
          skill={addSkill}
          title="Add Schedule"
          onCancel={() => setShowAdd(false)}
          onSubmit={(prompt) => {
            setShowAdd(false);
            setPendingPrompt(prompt);
          }}
        />
      )}

      {pendingPrompt && (
        <ActionRunner
          title="Adding schedule…"
          prompt={pendingPrompt}
          onClose={() => {
            setPendingPrompt(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="tiny"
        style={{
          display: 'block',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 4,
          color: 'var(--subtle)',
          fontWeight: 600,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
