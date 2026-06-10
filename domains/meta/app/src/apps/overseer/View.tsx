// Overseer — dedicated dashboard surface for lifecycle audits.
//
// Phase 2 of the Overseer arc. Replaces (in capability) the skinny-slice
// Insights "Audits" tab from Phase 1c, with deeper drill-ins:
//
//   - Overview tab: verdict distribution, recent activity, top tuning
//     suggestions across the entire OS install (the "what's the OS learning
//     about itself" landing surface)
//   - Audits tab: filterable list of every audit; click → detail
//   - Audit detail: full audit rendering with per-skill scores +
//     tuning suggestions + body
//   - By Skill tab: per-skill diagnostic surface (score trends, tag
//     frequency, aggregated suggestions) — the actionable view that drives
//     skill-tuning decisions
//   - Patterns tab (placeholder for Phase 2.1): cross-skill / cross-project
//     trend surface
//
// Internal navigation via URL splat (parseRoute) — back/forward + deep
// links work without local state. Same pattern as Vault, PR Review, Research.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getJson, postJson } from '../../lib/api';
import { useDispatch } from '../../lib/dispatch';
import { useNavigation } from '../../lib/navigation';
import { formatRelative } from '../../lib/time';
import { Icons } from '../../shared';
import { DecisionsPanel } from './DecisionsPanel';
import { PendingSuggestionsPanel } from './PendingSuggestionsPanel';
import '../../shared/styles.css';

// Lightweight type mirrors of server's audits.types.ts. Inlined here as
// narrow projections to keep this file's import surface small; update both
// when the wire shape changes.

type AuditStatus = 'pending' | 'provisional' | 'final';
type VerdictOverall = 'good' | 'mixed' | 'poor';

interface AuditScores {
  correctness: number;
  completeness: number;
  efficiency: number;
}

interface PerSkillFinding {
  skill: string;
  phase: string;
  scores: AuditScores;
  tags: string[];
  notes: string;
  evidence_paths: string[];
}

interface TuningSuggestion {
  skill: string;
  suggestion: string;
  confidence: 'low' | 'medium' | 'high';
  evidence_summary: string;
  target_change: string;
}

interface TuningSuggestionStatus {
  dismissed: boolean;
  dismissal_rationale: string | null;
  proposal_state: 'none' | 'diff' | 'rationale-only';
  proposal_diff_path: string | null;
  proposal_rationale_path: string | null;
  decisions: Array<{ id: string; path: string; status: string; title: string }>;
}

interface FollowupSignal {
  followup_change_id: string;
  followup_type: 'fix' | 'refactor' | 'feat-extension' | 'feat-rewrite' | 'test' | 'docs';
  followup_merged_at: string;
  days_after_audited_merge: number;
  overlap_severity: 'low' | 'medium' | 'high';
  correctness_signal: number;
  notes: string;
}

interface AuditSummary {
  id: string;
  path: string;
  title: string;
  audited_change_id: string;
  audited_change_path: string;
  project: string;
  audit_status: AuditStatus;
  verdict_overall: VerdictOverall | null;
  scores: AuditScores | null;
  overseer_model: string | null;
  overseer_completed_at: string | null;
  rubric_version: string;
  audit_cost_usd: number | null;
  audit_duration_ms: number | null;
  tag_count: number;
  tuning_suggestions_count: number;
  has_human_override: boolean;
  has_followups: boolean;
}

interface AuditDetail extends AuditSummary {
  per_skill_findings: PerSkillFinding[];
  tags: string[];
  tuning_suggestions: TuningSuggestion[];
  tuning_suggestion_status: TuningSuggestionStatus[];
  red_flags: string[];
  files_touched: string[];
  followup_signals: FollowupSignal[];
  body: string;
}

interface AuditAggregate {
  scope: { project: string | null };
  total_audits: number;
  verdict_distribution: { good: number; mixed: number; poor: number; unknown: number };
  top_tags: Array<{ tag: string; count: number }>;
  top_tuning_suggestions: Array<{
    skill: string;
    suggestion_summary: string;
    count: number;
    sample_audit_ids: string[];
  }>;
  mean_scores: AuditScores | null;
  time_range: { oldest: string | null; newest: string | null };
}

type TabId = 'overview' | 'audits' | 'by-skill' | 'patterns';

// URL scheme (mounted at /overseer/*):
//   ''                       → overview
//   'overview'               → overview
//   'audits'                 → audits list
//   'audits/<id>'            → audit detail
//   'by-skill'               → by-skill index (skill list)
//   'by-skill/<skill>'       → per-skill drill-in
//   'patterns'               → patterns view
function parseRoute(splat: string): { tab: TabId; subpath: string } {
  if (!splat || splat === 'overview') return { tab: 'overview', subpath: '' };
  if (splat === 'audits' || splat.startsWith('audits/')) {
    return { tab: 'audits', subpath: splat === 'audits' ? '' : splat.slice('audits/'.length) };
  }
  if (splat === 'by-skill' || splat.startsWith('by-skill/')) {
    return {
      tab: 'by-skill',
      subpath: splat === 'by-skill' ? '' : splat.slice('by-skill/'.length),
    };
  }
  if (splat === 'patterns') return { tab: 'patterns', subpath: '' };
  return { tab: 'overview', subpath: '' };
}

export default function Overseer() {
  const navigate = useNavigate();
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const { tab, subpath } = parseRoute(splat);

  const setTab = useCallback(
    (t: TabId) => {
      navigate(t === 'overview' ? '/overseer' : `/overseer/${t}`);
    },
    [navigate],
  );

  return (
    <div className="page page-wide">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 className="h1" style={{ marginBottom: 2 }}>
            Overseer
          </h1>
          <div className="tiny subtle">
            Lifecycle audits — how well the OS does its own work, observed.
          </div>
        </div>
        <span className="spacer" />
        {/* audit-ignore: app-design-stepper — tabs are independent views
            (Overview, Audits, By skill, Patterns), not a sequential workflow.
            A Stepper would mislead users into thinking they need to progress
            through them in order. */}
        <div className="tabs" role="tablist" aria-label="Overseer view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'overview'}
            className="tab"
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'audits'}
            className="tab"
            onClick={() => setTab('audits')}
          >
            Audits
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'by-skill'}
            className="tab"
            onClick={() => setTab('by-skill')}
          >
            By skill
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'patterns'}
            className="tab"
            onClick={() => setTab('patterns')}
          >
            Patterns
          </button>
        </div>
      </header>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'audits' && (subpath ? <AuditDetailView id={subpath} /> : <AuditsListTab />)}
      {tab === 'by-skill' && (subpath ? <BySkillDrillIn skill={subpath} /> : <BySkillIndex />)}
      {tab === 'patterns' && <PatternsTab />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared utilities

function verdictBadgeStyle(verdict: VerdictOverall | null) {
  if (verdict === 'good') {
    return {
      background: 'var(--success-bg, rgba(80,200,120,0.12))',
      color: 'var(--success-text, #4caf80)',
      border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
    };
  }
  if (verdict === 'mixed') {
    return {
      background: 'var(--warning-bg, rgba(250,200,80,0.1))',
      color: 'var(--warning-text, #e0a02a)',
      border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
    };
  }
  if (verdict === 'poor') {
    return {
      background: 'var(--danger-bg, rgba(250,80,80,0.1))',
      color: 'var(--danger-text, #e05050)',
      border: '1px solid var(--danger-border, rgba(250,80,80,0.4))',
    };
  }
  return {
    background: 'var(--bg-2, rgba(255,255,255,0.04))',
    color: 'var(--text-3)',
    border: '1px solid var(--border)',
  };
}

// Followup-type badge color — negative signal types in danger tones,
// neutral in muted, slightly-positive (feat-extension) in success tones.
function followupTypeBadgeStyle(t: FollowupSignal['followup_type']) {
  if (t === 'fix' || t === 'feat-rewrite') {
    return {
      background: 'var(--danger-bg, rgba(250,80,80,0.1))',
      color: 'var(--danger-text, #e05050)',
      border: '1px solid var(--danger-border, rgba(250,80,80,0.4))',
    };
  }
  if (t === 'refactor' || t === 'test') {
    return {
      background: 'var(--warning-bg, rgba(250,200,80,0.1))',
      color: 'var(--warning-text, #e0a02a)',
      border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
    };
  }
  if (t === 'feat-extension') {
    return {
      background: 'var(--success-bg, rgba(80,200,120,0.12))',
      color: 'var(--success-text, #4caf80)',
      border: '1px solid var(--success-border, rgba(80,200,120,0.4))',
    };
  }
  return {
    background: 'var(--bg-2, rgba(255,255,255,0.04))',
    color: 'var(--text-3)',
    border: '1px solid var(--border)',
  };
}

// Distribution bar — small horizontal stacked bar showing
// good/mixed/poor proportions. Used in Overview + By Skill.
function VerdictDistributionBar({
  good,
  mixed,
  poor,
  unknown,
  height = 8,
}: {
  good: number;
  mixed: number;
  poor: number;
  unknown: number;
  height?: number;
}) {
  const total = good + mixed + poor + unknown;
  if (total === 0) return null;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      style={{
        display: 'flex',
        height,
        borderRadius: height / 2,
        overflow: 'hidden',
        background: 'var(--bg-2)',
        minWidth: 100,
      }}
      title={`${good} good · ${mixed} mixed · ${poor} poor${unknown > 0 ? ` · ${unknown} unknown` : ''}`}
    >
      {good > 0 && <div style={{ background: 'var(--success-text, #4caf80)', width: pct(good) }} />}
      {mixed > 0 && (
        <div style={{ background: 'var(--warning-text, #e0a02a)', width: pct(mixed) }} />
      )}
      {poor > 0 && <div style={{ background: 'var(--danger-text, #e05050)', width: pct(poor) }} />}
      {unknown > 0 && <div style={{ background: 'var(--text-3)', width: pct(unknown) }} />}
    </div>
  );
}

function EmptyState({
  title,
  body,
  showOptInSnippet = false,
}: {
  title: string;
  body: React.ReactNode;
  showOptInSnippet?: boolean;
}) {
  return (
    <div className="card" style={{ padding: 24 }}>
      <h3 className="card-title" style={{ marginBottom: 8 }}>
        {title}
      </h3>
      <div className="subtle" style={{ marginBottom: 12 }}>
        {body}
      </div>
      {showOptInSnippet && (
        <>
          <div className="subtle" style={{ marginBottom: 8, fontSize: 13 }}>
            Add this to a project's frontmatter to enable auditing on change-automation-complete:
          </div>
          <pre
            className="mono"
            style={{
              fontSize: 12,
              padding: 10,
              background: 'var(--bg-2)',
              borderRadius: 4,
              overflowX: 'auto',
            }}
          >
            {`audit:
  enabled: true
  mode: on-complete   # or: sampled (with sample_rate: N) | manual`}
          </pre>
          <div className="subtle" style={{ fontSize: 12, marginTop: 12 }}>
            Or run a one-off audit manually: open any merged or abandoned change in the{' '}
            <button
              type="button"
              onClick={() => {
                window.location.href = '/changes';
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-text)',
                cursor: 'pointer',
                padding: 0,
                font: 'inherit',
              }}
            >
              Changes app
            </button>{' '}
            and click the <strong>Audit lifecycle</strong> button in its header. (Equivalent to{' '}
            <code className="mono">/os audit lifecycle &lt;change-id&gt;</code> from the CLI.)
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Overview tab — landing surface

function OverviewTab() {
  const [aggregate, setAggregate] = useState<AuditAggregate | null>(null);
  const [recent, setRecent] = useState<AuditSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getJson<AuditAggregate>('/api/audits/aggregate'),
      getJson<{ audits: AuditSummary[] }>('/api/audits'),
    ])
      .then(([agg, list]) => {
        if (cancelled) return;
        setAggregate(agg);
        setRecent(list.audits.slice(0, 10));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="subtle">Loading audits…</p>;
  }
  if (error) {
    return (
      <div
        className="card"
        style={{
          padding: '10px 14px',
          borderColor: 'var(--danger)',
          background: 'var(--danger-soft)',
          color: 'var(--danger-text)',
        }}
      >
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  if (!aggregate || aggregate.total_audits === 0) {
    return (
      <EmptyState
        title="No audits yet"
        body={
          <>
            The Overseer (<code className="mono">meta-overseer-review</code>) produces a structured
            assessment of each completed change's lifecycle. Aggregated across many audits, the
            signal drives skill improvement. Audits are opt-in per project.
          </>
        }
        showOptInSnippet
      />
    );
  }

  const { verdict_distribution, mean_scores, top_tags, top_tuning_suggestions, time_range } =
    aggregate;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Headline tiles */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 16,
        }}
      >
        <HeadlineTile label="Total audits" value={String(aggregate.total_audits)} />
        <HeadlineTile
          label="Verdict mix"
          value={
            <VerdictDistributionBar
              good={verdict_distribution.good}
              mixed={verdict_distribution.mixed}
              poor={verdict_distribution.poor}
              unknown={verdict_distribution.unknown}
              height={12}
            />
          }
          sub={`${verdict_distribution.good} good · ${verdict_distribution.mixed} mixed · ${verdict_distribution.poor} poor`}
        />
        <HeadlineTile
          label="Mean correctness"
          value={mean_scores ? mean_scores.correctness.toFixed(2) : '—'}
          sub="1-5 scale across all per-skill findings"
        />
        <HeadlineTile
          label="Mean completeness"
          value={mean_scores ? mean_scores.completeness.toFixed(2) : '—'}
          sub="1-5 scale across all per-skill findings"
        />
        <HeadlineTile
          label="Mean efficiency"
          value={mean_scores ? mean_scores.efficiency.toFixed(2) : '—'}
          sub="1-5 scale across all per-skill findings"
        />
      </div>

      {/* Top tuning suggestions — the actionable surface */}
      <section className="card" style={{ padding: 0 }}>
        <div className="card-header">
          <h3 className="card-title">Top recurring tuning suggestions</h3>
          <span className="tiny subtle">
            patterns the Overseer raised across multiple audits — candidates for real skill changes
          </span>
        </div>
        {top_tuning_suggestions.length === 0 ? (
          <div className="subtle" style={{ padding: 18 }}>
            No recurring tuning suggestions yet. Either the rubric isn't flagging much, or you don't
            have enough audits for patterns to emerge.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {top_tuning_suggestions.map((s) => (
              <li
                key={`${s.skill}-${s.suggestion_summary.slice(0, 40)}`}
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span
                    className="badge"
                    style={{
                      fontSize: 11,
                      background: 'var(--accent-bg, rgba(80,160,250,0.12))',
                      color: 'var(--accent-text, #5aa0fa)',
                      border: '1px solid var(--accent-border, rgba(80,160,250,0.35))',
                    }}
                  >
                    {s.count}× — {s.skill}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => navigate(`/overseer/by-skill/${s.skill}`)}
                    title={`Open ${s.skill}'s drill-in view`}
                  >
                    Drill in
                  </button>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>{s.suggestion_summary}</div>
                <div className="tiny subtle">
                  example audits:{' '}
                  {s.sample_audit_ids.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <button
                        type="button"
                        onClick={() => navigate(`/overseer/audits/${id}`)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent-text)',
                          cursor: 'pointer',
                          padding: 0,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                        }}
                      >
                        {id}
                      </button>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Decisions — Phase 4.1 polish. Lists every Phase 4 decision with
          inline Accept + Apply controls so users don't have to fish in the
          Vault. Sits between top-suggestions (signal source) and top-tags
          (cross-audit aggregate). */}
      <DecisionsPanel />

      {/* Pending suggestions — Phase 4.1 enhancement. Cross-audit roll-up of
          suggestions that haven't been actioned (promoted / proposed /
          dismissed). Distinct from Decisions: this is "needs authoring,"
          Decisions is "needs accept/apply." */}
      <PendingSuggestionsPanel />

      {/* Top tags + recent audits — side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: 16 }}>
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Top tags</h3>
            <span className="tiny subtle">categorical patterns across audits</span>
          </div>
          {top_tags.length === 0 ? (
            <div className="subtle" style={{ padding: 16 }}>
              No tags raised yet.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: '8px 0', margin: 0 }}>
              {top_tags.map((t) => (
                <li
                  key={t.tag}
                  style={{
                    padding: '6px 16px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12.5,
                  }}
                >
                  <code className="mono">{t.tag}</code>
                  <span className="mono" style={{ color: 'var(--text-2)' }}>
                    {t.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Recent audits</h3>
            {recent && recent.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => navigate('/overseer/audits')}
              >
                See all <Icons.ArrowRight size={11} />
              </button>
            )}
          </div>
          {!recent || recent.length === 0 ? (
            <div className="subtle" style={{ padding: 16 }}>
              No audits yet.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {recent.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="clickable"
                    onClick={() => navigate(`/overseer/audits/${a.id}`)}
                    style={{
                      width: '100%',
                      background: 'none',
                      border: 'none',
                      borderTop: '1px solid var(--border)',
                      padding: '10px 16px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: 'inherit',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}
                  >
                    <span
                      className="badge"
                      style={{ fontSize: 10, ...verdictBadgeStyle(a.verdict_overall) }}
                    >
                      {a.verdict_overall ?? a.audit_status}
                    </span>
                    <span style={{ fontSize: 13, flex: 1 }}>{a.title}</span>
                    <span className="tiny subtle">
                      {a.overseer_completed_at ? formatRelative(a.overseer_completed_at) : '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Footer: time range + rubric note */}
      <div className="tiny subtle" style={{ padding: '0 4px' }}>
        Audits range:{' '}
        {time_range.oldest && time_range.newest
          ? `${formatRelative(time_range.oldest)} → ${formatRelative(time_range.newest)}`
          : '—'}
        . Rubric: see <code className="mono">archetype-lifecycle-audit</code>.
      </div>
    </div>
  );
}

function HeadlineTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div
        className="tiny subtle"
        style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}
      >
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      {sub && (
        <div className="tiny subtle" style={{ marginTop: 4, fontSize: 11 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Audits tab — list view (filterable)

function AuditsListTab() {
  const [audits, setAudits] = useState<AuditSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<'all' | VerdictOverall>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<{ audits: AuditSummary[] }>('/api/audits')
      .then((r) => {
        if (cancelled) return;
        setAudits(r.audits);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projects = useMemo(() => {
    if (!audits) return [];
    return Array.from(new Set(audits.map((a) => a.project).filter(Boolean))).sort();
  }, [audits]);

  const filtered = useMemo(() => {
    if (!audits) return [];
    return audits.filter((a) => {
      if (verdictFilter !== 'all' && a.verdict_overall !== verdictFilter) return false;
      if (projectFilter !== 'all' && a.project !== projectFilter) return false;
      return true;
    });
  }, [audits, verdictFilter, projectFilter]);

  if (loading) return <p className="subtle">Loading…</p>;
  if (error) {
    return (
      <div
        className="card"
        style={{
          padding: '10px 14px',
          borderColor: 'var(--danger)',
          background: 'var(--danger-soft)',
          color: 'var(--danger-text)',
        }}
      >
        <strong>Failed to load:</strong> {error}
      </div>
    );
  }
  if (!audits || audits.length === 0) {
    return (
      <EmptyState
        title="No audits yet"
        body="Enable auditing on a project to start producing audits."
        showOptInSnippet
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Filter row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tabs">
          {(['all', 'good', 'mixed', 'poor'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className="tab"
              aria-selected={verdictFilter === v}
              onClick={() => setVerdictFilter(v)}
            >
              {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <select
          className="input"
          style={{ height: 32, fontSize: 12 }}
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
        >
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <span className="tiny subtle">
          {filtered.length} of {audits.length} audit{audits.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* List */}
      <div className="card" style={{ padding: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>Verdict</th>
              <th>Change audited</th>
              <th style={{ width: 130 }}>Project</th>
              <th style={{ width: 160 }}>Scores (C/Cm/E)</th>
              <th style={{ width: 70 }}>Tags</th>
              <th style={{ width: 110 }}>Suggestions</th>
              <th style={{ width: 100 }}>Audited</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr
                key={a.id}
                className="clickable"
                onClick={() => navigate(`/overseer/audits/${a.id}`)}
                style={{ cursor: 'pointer' }}
              >
                <td>
                  <span
                    className="badge"
                    style={{ fontSize: 11, ...verdictBadgeStyle(a.verdict_overall) }}
                  >
                    {a.verdict_overall ?? a.audit_status}
                  </span>
                </td>
                <td>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{a.title}</div>
                  <div className="tiny mono" style={{ marginTop: 2, color: 'var(--muted)' }}>
                    → {a.audited_change_id}
                  </div>
                </td>
                <td className="mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>
                  {a.project}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {a.scores
                    ? `${a.scores.correctness.toFixed(1)} / ${a.scores.completeness.toFixed(1)} / ${a.scores.efficiency.toFixed(1)}`
                    : '—'}
                </td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  {a.tag_count}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {a.tuning_suggestions_count > 0 ? (
                    <strong style={{ color: 'var(--accent-text)' }}>
                      {a.tuning_suggestions_count}
                    </strong>
                  ) : (
                    <span style={{ color: 'var(--text-3)' }}>—</span>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {a.overseer_completed_at ? formatRelative(a.overseer_completed_at) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Audit detail view

function AuditDetailView({ id }: { id: string }) {
  const [audit, setAudit] = useState<AuditDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const nav = useNavigation();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<AuditDetail>(`/api/audits/${encodeURIComponent(id)}`)
      .then((d) => {
        if (cancelled) return;
        setAudit(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) return <p className="subtle">Loading audit…</p>;
  if (error) return <p style={{ color: 'var(--danger-text)' }}>Failed to load: {error}</p>;
  if (!audit) return <p>Audit not found.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button
        type="button"
        className="btn btn-sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => navigate('/overseer/audits')}
      >
        <Icons.ArrowRight size={11} style={{ transform: 'rotate(180deg)' }} /> All audits
      </button>

      {/* Header card */}
      <section className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 8 }}>
          <span
            className="badge"
            style={{ fontSize: 12, ...verdictBadgeStyle(audit.verdict_overall) }}
          >
            {audit.verdict_overall ?? audit.audit_status}
          </span>
          <h2 style={{ margin: 0, fontSize: 18 }}>{audit.title}</h2>
        </div>
        <div className="tiny subtle" style={{ marginBottom: 12 }}>
          Audited change:{' '}
          <button
            type="button"
            onClick={() => nav.navigateToEntry(audit.audited_change_id)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent-text)',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              padding: 0,
              fontSize: 11,
            }}
          >
            {audit.audited_change_id}
          </button>
          {' · '}project: <code className="mono">{audit.project}</code>
          {' · '}rubric: <code className="mono">{audit.rubric_version}</code>
          {audit.overseer_model && (
            <>
              {' · '}model: <code className="mono">{audit.overseer_model}</code>
            </>
          )}
        </div>
        {audit.scores && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <ScoreChip label="Correctness" value={audit.scores.correctness} />
            <ScoreChip label="Completeness" value={audit.scores.completeness} />
            <ScoreChip label="Efficiency" value={audit.scores.efficiency} />
          </div>
        )}
      </section>

      {/* Per-skill findings */}
      {audit.per_skill_findings.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Per-skill findings</h3>
            <span className="tiny subtle">
              {audit.per_skill_findings.length} skill
              {audit.per_skill_findings.length !== 1 ? 's' : ''} assessed
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {audit.per_skill_findings.map((f, i) => (
              <li
                key={`${f.skill}-${f.phase}-${i}`}
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'baseline',
                    marginBottom: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <code className="mono" style={{ fontWeight: 600 }}>
                    {f.skill}
                  </code>
                  <span
                    className="badge muted"
                    style={{ fontSize: 11 }}
                    title={`Phase: ${f.phase}`}
                  >
                    {f.phase}
                  </span>
                  <ScoreChip label="C" value={f.scores.correctness} compact />
                  <ScoreChip label="Cm" value={f.scores.completeness} compact />
                  <ScoreChip label="E" value={f.scores.efficiency} compact />
                  {f.tags.map((t) => (
                    <code key={t} className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      #{t}
                    </code>
                  ))}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{f.notes}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Tuning suggestions */}
      {audit.tuning_suggestions.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Tuning suggestions</h3>
            <span className="tiny subtle">
              {audit.tuning_suggestions.length} concrete recommendation
              {audit.tuning_suggestions.length !== 1 ? 's' : ''} for skill changes
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {audit.tuning_suggestions.map((s, i) => (
              <li
                key={i}
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'baseline',
                    marginBottom: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <code className="mono" style={{ fontWeight: 600 }}>
                    {s.skill}
                  </code>
                  <span className="badge muted" style={{ fontSize: 11 }}>
                    {s.confidence} confidence
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginBottom: 6,
                    opacity: audit.tuning_suggestion_status?.[i]?.dismissed ? 0.55 : 1,
                  }}
                >
                  {s.suggestion}
                </div>
                <div className="tiny subtle" style={{ marginBottom: 4 }}>
                  <strong>Evidence:</strong> {s.evidence_summary}
                </div>
                <div className="tiny subtle" style={{ marginBottom: 8 }}>
                  <strong>Target:</strong> {s.target_change}
                </div>
                <TuningSuggestionStatusBadges
                  status={audit.tuning_suggestion_status?.[i]}
                  navigateToEntry={(id: string) => nav.navigateToEntry(id)}
                />
                <TuningSuggestionActions
                  auditId={audit.id}
                  suggestionIndex={i}
                  confidence={s.confidence}
                  recurrenceCount={1}
                  onActionDone={() => {
                    // Re-fetch the audit to refresh status badges. The route
                    // re-walks the dismissals + decisions index so the new
                    // state is reflected immediately.
                    getJson<AuditDetail>(`/api/audits/${encodeURIComponent(audit.id)}`).then(
                      (d) => setAudit(d),
                      () => {},
                    );
                  }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Followup signals (Phase 3 — appended by meta-audit-followups) */}
      {audit.followup_signals && audit.followup_signals.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Follow-up signals</h3>
            <span className="tiny subtle">
              {audit.followup_signals.length} subsequent change
              {audit.followup_signals.length !== 1 ? 's' : ''} touched these files — retroactive
              Correctness adjustment applied
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {audit.followup_signals.map((s) => (
              <li
                key={s.followup_change_id}
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'baseline',
                    marginBottom: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    className="badge"
                    style={{
                      fontSize: 11,
                      ...followupTypeBadgeStyle(s.followup_type),
                    }}
                  >
                    {s.followup_type}
                  </span>
                  <code className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                    {s.followup_change_id}
                  </code>
                  <span className="tiny subtle">
                    +{s.days_after_audited_merge}d · overlap {s.overlap_severity}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color:
                        s.correctness_signal < 0
                          ? 'var(--danger-text)'
                          : s.correctness_signal > 0
                            ? 'var(--success-text)'
                            : 'var(--text-3)',
                    }}
                    title="Correctness adjustment from this signal"
                  >
                    {s.correctness_signal > 0 ? '+' : ''}
                    {s.correctness_signal.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{s.notes}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Tags summary */}
      {audit.tags.length > 0 && (
        <section className="card" style={{ padding: 14 }}>
          <h3 className="card-title" style={{ marginBottom: 8 }}>
            All tags
          </h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {audit.tags.map((t) => (
              <code
                key={t}
                className="mono"
                style={{
                  fontSize: 11,
                  padding: '2px 6px',
                  background: 'var(--bg-2)',
                  borderRadius: 3,
                }}
              >
                #{t}
              </code>
            ))}
          </div>
        </section>
      )}

      {/* Full audit body (rendered as markdown via raw text — we let users
          drill into the Vault renderer for the proper markdown view) */}
      <section className="card" style={{ padding: 14 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginBottom: 8,
          }}
        >
          <h3 className="card-title">Body</h3>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => nav.navigateToEntry(audit.id)}
            title="Open the audit entry in the Vault for the markdown-rendered view"
          >
            Open in Vault <Icons.ArrowRight size={11} />
          </button>
        </div>
        <pre
          style={{
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            background: 'var(--bg-2)',
            padding: 12,
            borderRadius: 4,
            margin: 0,
            maxHeight: 480,
            overflow: 'auto',
          }}
        >
          {audit.body}
        </pre>
      </section>
    </div>
  );
}

function ScoreChip({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: number;
  compact?: boolean;
}) {
  const color =
    value >= 4
      ? 'var(--success-text)'
      : value >= 2.5
        ? 'var(--warning-text)'
        : 'var(--danger-text)';
  return (
    <span
      className="mono"
      style={{
        fontSize: compact ? 11 : 13,
        padding: compact ? '2px 6px' : '4px 10px',
        background: 'var(--bg-2)',
        borderRadius: 3,
        color,
        fontWeight: 600,
      }}
      title={`${label} score: ${value.toFixed(2)} of 5`}
    >
      {label}: {value.toFixed(1)}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// By Skill — the diagnostic surface

function BySkillIndex() {
  const [audits, setAudits] = useState<AuditSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    getJson<{ audits: AuditSummary[] }>('/api/audits')
      .then((r) => {
        if (cancelled) return;
        setAudits(r.audits);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAudits([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // We need per-skill data, but AuditSummary doesn't include per_skill_findings.
  // For v1 of this view, fetch all audit details to compute the skill index.
  // For projects with many audits this gets expensive — Phase 2.1 will move
  // this aggregation server-side (a new /api/audits/by-skill endpoint).
  const [skillRollup, setSkillRollup] = useState<Map<
    string,
    { count: number; verdictMix: { good: number; mixed: number; poor: number; unknown: number } }
  > | null>(null);

  useEffect(() => {
    if (!audits || audits.length === 0) {
      setSkillRollup(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      audits.map((a) =>
        getJson<AuditDetail>(`/api/audits/${encodeURIComponent(a.id)}`).catch(() => null),
      ),
    ).then((details) => {
      if (cancelled) return;
      const m = new Map<
        string,
        {
          count: number;
          verdictMix: { good: number; mixed: number; poor: number; unknown: number };
        }
      >();
      details.forEach((d, i) => {
        if (!d) return;
        const verdict = audits[i].verdict_overall;
        const seen = new Set<string>();
        for (const f of d.per_skill_findings) {
          if (seen.has(f.skill)) continue;
          seen.add(f.skill);
          const existing = m.get(f.skill) ?? {
            count: 0,
            verdictMix: { good: 0, mixed: 0, poor: 0, unknown: 0 },
          };
          existing.count++;
          if (verdict === 'good') existing.verdictMix.good++;
          else if (verdict === 'mixed') existing.verdictMix.mixed++;
          else if (verdict === 'poor') existing.verdictMix.poor++;
          else existing.verdictMix.unknown++;
          m.set(f.skill, existing);
        }
      });
      setSkillRollup(m);
    });
    return () => {
      cancelled = true;
    };
  }, [audits]);

  if (loading || !skillRollup) return <p className="subtle">Loading…</p>;
  if (skillRollup.size === 0) {
    return (
      <EmptyState
        title="No skill data yet"
        body="No skills appear in any audit's per-skill findings."
      />
    );
  }

  const sortedSkills = [...skillRollup.entries()].sort((a, b) => b[1].count - a[1].count);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h3 className="card-title">Skills with audits</h3>
        <span className="tiny subtle">
          click any skill to drill into its score trends + tag frequency + recurring suggestions
        </span>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sortedSkills.map(([skill, data]) => (
          <li key={skill}>
            <button
              type="button"
              onClick={() => navigate(`/overseer/by-skill/${skill}`)}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                borderTop: '1px solid var(--border)',
                padding: '12px 16px',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'inherit',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
              }}
            >
              <code className="mono" style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
                {skill}
              </code>
              <span className="tiny subtle" style={{ minWidth: 90 }}>
                {data.count} audit{data.count !== 1 ? 's' : ''}
              </span>
              <div style={{ width: 120 }}>
                <VerdictDistributionBar
                  good={data.verdictMix.good}
                  mixed={data.verdictMix.mixed}
                  poor={data.verdictMix.poor}
                  unknown={data.verdictMix.unknown}
                />
              </div>
              <Icons.ArrowRight size={13} style={{ color: 'var(--text-3)' }} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BySkillDrillIn({ skill }: { skill: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<{
    audits: AuditSummary[];
    details: AuditDetail[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<{ audits: AuditSummary[] }>('/api/audits')
      .then((r) =>
        Promise.all(
          r.audits.map((a) =>
            getJson<AuditDetail>(`/api/audits/${encodeURIComponent(a.id)}`).catch(() => null),
          ),
        ).then((details) => ({
          audits: r.audits,
          details: details.filter(Boolean) as AuditDetail[],
        })),
      )
      .then(({ audits, details }) => {
        if (cancelled) return;
        // Filter to only audits where this skill appears
        const filtered = details.filter((d) => d.per_skill_findings.some((f) => f.skill === skill));
        setData({
          audits: filtered.map((d) => audits.find((a) => a.id === d.id)!).filter(Boolean),
          details: filtered,
        });
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill]);

  if (loading || !data) return <p className="subtle">Loading…</p>;
  if (data.details.length === 0) {
    return (
      <p className="subtle">
        No audits found for skill: <code className="mono">{skill}</code>
      </p>
    );
  }

  // Aggregate per-skill scores across all audits
  const allFindings = data.details.flatMap((d) =>
    d.per_skill_findings.filter((f) => f.skill === skill),
  );
  const meanCorrectness =
    allFindings.reduce((s, f) => s + f.scores.correctness, 0) / allFindings.length;
  const meanCompleteness =
    allFindings.reduce((s, f) => s + f.scores.completeness, 0) / allFindings.length;
  const meanEfficiency =
    allFindings.reduce((s, f) => s + f.scores.efficiency, 0) / allFindings.length;

  // Tag frequency
  const tagCounts = new Map<string, number>();
  for (const f of allFindings) {
    for (const t of f.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Tuning suggestions for this skill
  const skillSuggestions = data.details.flatMap((d) =>
    d.tuning_suggestions.filter((s) => s.skill === skill).map((s) => ({ ...s, auditId: d.id })),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button
        type="button"
        className="btn btn-sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => navigate('/overseer/by-skill')}
      >
        <Icons.ArrowRight size={11} style={{ transform: 'rotate(180deg)' }} /> All skills
      </button>

      <section className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>
          <code className="mono">{skill}</code>
        </h2>
        <div className="tiny subtle" style={{ marginTop: 4, marginBottom: 12 }}>
          {data.details.length} audit{data.details.length !== 1 ? 's' : ''} · {allFindings.length}{' '}
          finding{allFindings.length !== 1 ? 's' : ''} across phases
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <ScoreChip label="Mean Correctness" value={meanCorrectness} />
          <ScoreChip label="Mean Completeness" value={meanCompleteness} />
          <ScoreChip label="Mean Efficiency" value={meanEfficiency} />
        </div>
      </section>

      {topTags.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">Tag frequency for this skill</h3>
          </div>
          <ul style={{ listStyle: 'none', padding: '8px 0', margin: 0 }}>
            {topTags.map(([tag, count]) => (
              <li
                key={tag}
                style={{
                  padding: '6px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12.5,
                }}
              >
                <code className="mono">#{tag}</code>
                <span className="mono" style={{ color: 'var(--text-2)' }}>
                  {count} / {data.details.length}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {skillSuggestions.length > 0 && (
        <section className="card" style={{ padding: 0 }}>
          <div className="card-header">
            <h3 className="card-title">All tuning suggestions for this skill</h3>
            <span className="tiny subtle">
              {skillSuggestions.length} suggestion{skillSuggestions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {skillSuggestions.map((s, i) => (
              <li
                key={i}
                style={{
                  padding: '12px 16px',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <span className="badge muted" style={{ fontSize: 11 }}>
                    {s.confidence}
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate(`/overseer/audits/${s.auditId}`)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent-text)',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      padding: 0,
                    }}
                  >
                    {s.auditId}
                  </button>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>{s.suggestion}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Patterns tab — Phase 2.1 placeholder

function PatternsTab() {
  return (
    <EmptyState
      title="Patterns view — coming in Phase 2.1"
      body={
        <>
          Cross-skill, cross-project trend surface. Will show: regressing skills (negative score
          trends), recurring red flags, weekly self-review summaries auto-generated from aggregated
          audits. Deferred to validate the Overview + By Skill surfaces first.
        </>
      }
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — Tuning suggestion actions
//
// Three buttons per suggestion: Propose edit / Promote to decision / Dismiss.
// Each opens a self-managed modal. Hybrid warning fires when evidence is
// `confidence: low` AND `recurrenceCount === 1` — informational, not blocking,
// to preserve user agency while flagging the epistemic risk.

interface TuningSuggestionActionsProps {
  auditId: string;
  suggestionIndex: number;
  confidence: 'low' | 'medium' | 'high';
  recurrenceCount: number;
  // Fired after any successful action (propose/promote/dismiss) so the
  // caller can re-fetch the audit and re-render status badges. Phase 4
  // closes the visual feedback loop — clicks now have visible effect.
  onActionDone?: () => void;
}

type ActiveModal = null | 'promote' | 'dismiss';

function TuningSuggestionActions({
  auditId,
  suggestionIndex,
  confidence,
  recurrenceCount,
  onActionDone,
}: TuningSuggestionActionsProps) {
  const [active, setActive] = useState<ActiveModal>(null);
  const [proposing, setProposing] = useState(false);
  const [proposeToast, setProposeToast] = useState<string | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const { startSkillRun } = useDispatch();
  const showWeakEvidenceWarning = confidence === 'low' && recurrenceCount === 1;

  const closeAndRefresh = () => {
    setActive(null);
    onActionDone?.();
  };

  // Inline Propose dispatch — matches PendingSuggestionsPanel's pattern.
  // Drops the bespoke modal-bound /api/tuning-suggestions/propose endpoint
  // in favor of startSkillRun, which routes through the canonical runs.ts
  // dispatch path: first-class runs-db row, drawer surfaces the stream, cost
  // + duration captured uniformly, effort propagation via resolveEffortForRun.
  // Closes #416 for this surface (the only remaining UI caller of /propose).
  async function propose() {
    if (proposing) return;
    setProposing(true);
    setProposeError(null);
    setProposeToast(null);
    try {
      const prompt =
        `/os apply tuning suggestion audit=${auditId} ` +
        `suggestion_index=${suggestionIndex} mode=propose`;
      const result = await startSkillRun(prompt, `Propose: ${auditId} #${suggestionIndex}`, {
        skill: 'meta-apply-tuning-suggestion',
      });
      if ('error' in result && result.error) throw new Error(result.error);
      if ('blocked' in result && result.blocked) throw new Error('Propose blocked');
      if ('run_id' in result && result.run_id) {
        setProposeToast(`Run ${result.run_id.slice(0, 10)}… — drawer open`);
        // Refresh after a delay so the audit detail re-fetches and status
        // badges flip from 'none' to 'diff' once the artifact lands.
        setTimeout(() => onActionDone?.(), 4000);
      }
    } catch (e) {
      setProposeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProposing(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-sm" onClick={propose} disabled={proposing}>
          {proposing ? '…' : 'Propose edit'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setActive('promote')}>
          Promote to decision
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setActive('dismiss')}>
          Dismiss
        </button>
        {proposeToast && (
          <span style={{ color: 'var(--accent-text)', fontSize: 11 }}>✓ {proposeToast}</span>
        )}
        {proposeError && (
          <span style={{ color: 'var(--danger-text)', fontSize: 11 }}>✗ {proposeError}</span>
        )}
        {showWeakEvidenceWarning && (
          <span
            className="tiny"
            style={{ color: 'var(--warning-text, #e0a02a)', fontSize: 11 }}
            title="Confidence low + only 1× in the audit corpus. Consider waiting for corroboration before promoting to decision."
          >
            ⚠ single-instance, low confidence — consider waiting for corroboration
          </span>
        )}
      </div>

      {active === 'promote' && (
        <PromoteModal
          auditId={auditId}
          suggestionIndex={suggestionIndex}
          onClose={closeAndRefresh}
        />
      )}
      {active === 'dismiss' && (
        <DismissModal
          auditId={auditId}
          suggestionIndex={suggestionIndex}
          onClose={closeAndRefresh}
        />
      )}
    </>
  );
}

// Compact horizontal row of status badges shown above the action buttons.
// Renders nothing when no actions have been taken on this suggestion (clean
// state). Each badge is clickable where useful — proposal opens vault, each
// decision opens its entry.
function TuningSuggestionStatusBadges({
  status,
  navigateToEntry,
}: {
  status: TuningSuggestionStatus | undefined;
  navigateToEntry: (id: string) => void;
}) {
  if (!status) return null;
  const hasAny =
    status.dismissed ||
    status.proposal_state !== 'none' ||
    (status.decisions && status.decisions.length > 0);
  if (!hasAny) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        alignItems: 'center',
        marginBottom: 8,
      }}
    >
      {status.proposal_state === 'diff' && (
        <span
          className="badge"
          style={{
            fontSize: 11,
            background: 'var(--accent-bg, rgba(80,160,250,0.12))',
            color: 'var(--accent-text, #5aa0fa)',
            border: '1px solid var(--accent-border, rgba(80,160,250,0.35))',
          }}
          title={`Proposal diff at ${status.proposal_diff_path}. Click "Propose edit" to regenerate.`}
        >
          ✎ proposal written
        </span>
      )}
      {status.proposal_state === 'rationale-only' && (
        <span
          className="badge muted"
          style={{ fontSize: 11 }}
          title={
            status.proposal_rationale_path
              ? `Non-skill target — no diff possible. Rationale at ${status.proposal_rationale_path}. Route via Promote to decision.`
              : 'Non-skill target — no diff possible. Route via Promote to decision.'
          }
        >
          ⓘ propose ran — non-skill target
        </span>
      )}
      {status.decisions.map((d) => (
        <button
          type="button"
          key={d.id}
          onClick={() => navigateToEntry(d.id)}
          className="badge"
          style={{
            fontSize: 11,
            background:
              d.status === 'accepted'
                ? 'var(--success-bg, rgba(80,200,120,0.12))'
                : 'var(--warning-bg, rgba(250,200,80,0.10))',
            color:
              d.status === 'accepted'
                ? 'var(--success-text, #4caf80)'
                : 'var(--warning-text, #e0a02a)',
            border:
              d.status === 'accepted'
                ? '1px solid var(--success-border, rgba(80,200,120,0.4))'
                : '1px solid var(--warning-border, rgba(250,200,80,0.4))',
            cursor: 'pointer',
          }}
          title={`Open decision entry: ${d.title}`}
        >
          → decision: {d.id} ({d.status})
        </button>
      ))}
      {status.dismissed && (
        <span
          className="badge muted"
          style={{ fontSize: 11 }}
          title={status.dismissal_rationale ?? 'Dismissed (no rationale provided)'}
        >
          ✕ dismissed
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Generic modal shell — fixed-position overlay with backdrop click-to-close.

function ModalShell({
  title,
  onClose,
  children,
  footer,
  width = 720,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          width,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 80px)',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h3 className="card-title" style={{ margin: 0 }}>
            {title}
          </h3>
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <div
            style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Promote modal — vault scaffold; show success + open-in-vault.

function PromoteModal({
  auditId,
  suggestionIndex,
  onClose,
}: {
  auditId: string;
  suggestionIndex: number;
  onClose: () => void;
}) {
  const nav = useNavigation();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    decision_id: string;
    decision_path: string;
    title: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await postJson<{
        ok: boolean;
        decision_id?: string;
        decision_path?: string;
        title?: string;
        error?: string;
        existing_path?: string;
      }>('/api/tuning-suggestions/promote', {
        audit_id: auditId,
        suggestion_index: suggestionIndex,
      });
      if (!r.ok) {
        setError(r.error || 'unknown error');
        if (r.existing_path) {
          setError(`${r.error}. Existing: ${r.existing_path}`);
        }
      } else if (r.decision_id && r.decision_path && r.title) {
        setResult({ decision_id: r.decision_id, decision_path: r.decision_path, title: r.title });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title={`Promote to decision — ${auditId} #${suggestionIndex}`}
      onClose={onClose}
      footer={
        result ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                nav.navigateToEntry(result.decision_id);
                onClose();
              }}
            >
              Open in Vault
            </button>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm" disabled={submitting} onClick={submit}>
              {submitting ? 'Scaffolding…' : 'Scaffold decision entry'}
            </button>
          </>
        )
      }
    >
      {!result && !error && (
        <div className="subtle" style={{ lineHeight: 1.5 }}>
          Scaffolds a new decision-archetype entry at{' '}
          <code className="mono">vault/wiki/meta/decision/</code> pre-filled with this suggestion's
          evidence + the <code className="mono">implements_tuning_suggestions</code> gate field
          citing audit <code className="mono">{auditId}</code> suggestion #{suggestionIndex}.
          <br />
          <br />
          The scaffolded entry has stub sections (Context, Options, Decision, Rationale,
          Consequences, How to apply). You'll fill in the rationale + decision in the Vault, then
          (when <code className="mono">status: accepted</code>) run the suggested apply command at
          the bottom of the entry to materialize the SKILL.md edit.
        </div>
      )}
      {error && (
        <div
          style={{
            color: 'var(--danger-text)',
            background: 'var(--danger-bg, rgba(250,80,80,0.1))',
            padding: 8,
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}
      {result && (
        <div>
          <div
            style={{
              padding: 10,
              background: 'var(--success-bg, rgba(80,200,120,0.12))',
              color: 'var(--success-text, #4caf80)',
              borderRadius: 4,
              marginBottom: 12,
            }}
          >
            ✓ Decision scaffolded
          </div>
          <div className="tiny subtle" style={{ marginBottom: 4 }}>
            <strong>Title:</strong> {result.title}
          </div>
          <div className="tiny subtle" style={{ marginBottom: 4 }}>
            <strong>Path:</strong> <code className="mono">{result.decision_path}</code>
          </div>
          <div className="tiny subtle" style={{ marginTop: 12 }}>
            Open it in the Vault to fill in your rationale. Once status flips to{' '}
            <code className="mono">accepted</code>, the bottom of the entry has the exact{' '}
            <code className="mono">/os apply tuning suggestion …</code> command to materialize the
            edit.
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Dismiss modal — append to dismissed-action-items.jsonl with optional rationale.

function DismissModal({
  auditId,
  suggestionIndex,
  onClose,
}: {
  auditId: string;
  suggestionIndex: number;
  onClose: () => void;
}) {
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await postJson<{ ok: boolean; dismissal_id?: string; error?: string }>(
        '/api/tuning-suggestions/dismiss',
        {
          audit_id: auditId,
          suggestion_index: suggestionIndex,
          rationale: rationale || null,
        },
      );
      if (!r.ok) setError(r.error || 'unknown error');
      else setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title={`Dismiss suggestion — ${auditId} #${suggestionIndex}`}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm" disabled={submitting} onClick={submit}>
              {submitting ? 'Dismissing…' : 'Dismiss'}
            </button>
          </>
        )
      }
    >
      {!done && !error && (
        <>
          <div className="subtle" style={{ marginBottom: 8, lineHeight: 1.5 }}>
            Append a dismissal entry to{' '}
            <code className="mono">.claude/state/dismissed-action-items.jsonl</code> for this
            suggestion. Future renders of this suggestion (if the dashboard filters out dismissed
            items) will skip it. The audit's <code className="mono">tuning_suggestions[]</code>{' '}
            array itself is NOT mutated — dismissal is a per-install preference, not a change to the
            audit data.
          </div>
          <label className="tiny subtle" style={{ display: 'block', marginBottom: 4 }}>
            Rationale (optional but recommended — captures why this isn't worth acting on):
          </label>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="e.g. Already shipped as task #428. Or: low-confidence + single instance — see corroboration first. Or: orchestrator-level; not a skill change."
            style={{
              width: '100%',
              minHeight: 80,
              padding: 8,
              fontFamily: 'inherit',
              fontSize: 12,
              background: 'var(--bg-2)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              resize: 'vertical',
            }}
          />
        </>
      )}
      {error && (
        <div
          style={{
            color: 'var(--danger-text)',
            background: 'var(--danger-bg, rgba(250,80,80,0.1))',
            padding: 8,
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}
      {done && (
        <div
          style={{
            padding: 10,
            background: 'var(--success-bg, rgba(80,200,120,0.12))',
            color: 'var(--success-text, #4caf80)',
            borderRadius: 4,
          }}
        >
          ✓ Dismissed. The suggestion remains in the audit's data; it's just hidden from
          dismissal-aware views.
        </div>
      )}
    </ModalShell>
  );
}
