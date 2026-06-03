// Overview — landing dashboard. Migrated to apps/ + restyled with the
// prototype design system: .page wrapper, .h1 header, Metric tiles for the
// stats grid, .card sections for brief/index/activity, .badge severity chips.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ScheduleStatus, SchedulesListResponse } from '../../../server/routes/schedules.types';
import { LatestArtifactCard } from '../../components/LatestArtifactCard';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { getJson } from '../../lib/api';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { useNavigation } from '../../lib/navigation';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { formatLocal, formatRelative } from '../../lib/time';
import { type Manifest, fetchManifest } from '../../lib/vault';
import { Icons, Metric } from '../../shared';
import '../../shared/styles.css';

interface DomainNode {
  name: string;
  path: string;
  children: DomainNode[];
}
interface CurationData {
  items: string[];
}
interface SkillsData {
  skills: { name: string; parseError?: string | null }[];
}
interface DomainsData {
  domains: DomainNode[];
}
interface FreshnessData {
  generated: string | null;
  newest_mtime: string | null;
  stale: boolean;
  newer_count: number;
  total_files: number;
}
interface AuditResponse {
  ok: boolean;
  ran_at: string;
  duration_ms: number;
  findings: { id: string; severity: 'error' | 'warn' | 'info' }[];
  summary: { error: number; warn: number; info: number };
  error?: string;
}
// Local alias — overview only reads the `status` slice of the schedules
// response, but we use the canonical wire type so any new top-level field
// is visible automatically.
type SchedulesResponse = SchedulesListResponse;
interface EventSummary {
  ts: string;
  source: string;
  kind: 'router' | 'dashboard' | 'schedule' | 'unknown';
  summary: string;
}
interface EventsResponse {
  events: EventSummary[];
}
interface ProjectAutomationSummary {
  enabled: boolean;
  state: { phase: 'idle' | 'running' | 'paused' | 'failed' };
}
interface ProjectSummary {
  id: string | null;
  path: string;
  title: string;
  domain: string | null;
  status: string | null;
  deadline: string | null;
  automation: ProjectAutomationSummary | null;
}
interface ProjectsResponse {
  projects: ProjectSummary[];
}

interface NotificationRule {
  id: string;
}
interface NotificationRulesResponse {
  rules: NotificationRule[];
}
interface NotificationEvent {
  ts: string;
  action: string;
  status: string | null;
}
interface NotificationEventsResponse {
  events: NotificationEvent[];
}

const WELCOME_KEY = 'agentic-os/welcome-dismissed';

type QuickAction =
  | { kind: 'skill'; skill: string; label: string; title: string }
  | { kind: 'navigate'; href: string; label: string; title: string }
  | { kind: 'separator' };

const QUICK_SCAFFOLDERS: QuickAction[] = [
  // Work primitives — most-used scaffolders for actual work.
  { kind: 'skill', skill: 'dev-ingest-repo', label: 'Repo', title: 'Ingest Repo' },
  { kind: 'skill', skill: 'meta-add-project', label: 'Project', title: 'Add Project' },
  { kind: 'skill', skill: 'dev-add-change', label: 'Change', title: 'Add Change' },
  { kind: 'skill', skill: 'research-write', label: 'Research', title: 'Add Research Report' },
  { kind: 'skill', skill: 'meta-add-note', label: 'Note', title: 'Add Note' },
  { kind: 'separator' },
  // Meta-infrastructure scaffolders — extending the OS itself.
  { kind: 'skill', skill: 'meta-add-domain', label: 'Domain', title: 'Add Domain' },
  { kind: 'skill', skill: 'meta-add-skill', label: 'Skill', title: 'Add Skill' },
  { kind: 'skill', skill: 'meta-add-schedule', label: 'Schedule', title: 'Add Schedule' },
  { kind: 'skill', skill: 'meta-add-archetype', label: 'Archetype', title: 'Add Archetype' },
  // Navigate-only — opens the rule editor in create mode. Not a skill
  // dispatch; the editor reads its inputs from a form and writes the
  // rule entry server-side via the notifications routes.
  {
    kind: 'navigate',
    href: '/notifications/rules/new',
    label: 'Notification rule',
    title: 'Add Notification Rule',
  },
];

function countDomains(nodes: DomainNode[]): number {
  let total = 0;
  for (const n of nodes) total += 1 + countDomains(n.children);
  return total;
}

export default function Overview() {
  const nav = useNavigation();
  const navigate = useNavigate();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [curation, setCuration] = useState<CurationData | null>(null);
  const [skills, setSkills] = useState<SkillsData | null>(null);
  const [domains, setDomains] = useState<DomainsData | null>(null);
  const [freshness, setFreshness] = useState<FreshnessData | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [schedules, setSchedules] = useState<SchedulesResponse | null>(null);
  const [events, setEvents] = useState<EventsResponse | null>(null);
  const [projects, setProjects] = useState<ProjectsResponse | null>(null);
  const [notifRules, setNotifRules] = useState<NotificationRulesResponse | null>(null);
  const [notifEvents, setNotifEvents] = useState<NotificationEventsResponse | null>(null);
  // Bumped on each run-terminal callback so the LatestArtifactCard re-fetches
  // the brief file after `/os brief` lands.
  const [briefRefreshKey, setBriefRefreshKey] = useState(0);

  const [formSkill, setFormSkill] = useState<SkillSummary | null>(null);
  const [formTitle, setFormTitle] = useState<string>('');
  const { startSkillRun } = useDispatch();

  async function dispatch(prompt: string, title: string, skill: string) {
    const res = await startSkillRun(prompt, title, { skill });
    if ('blocked' in res && res.blocked) {
      // Overview dispatches aren't tied to a specific change so this should
      // be rare — surface via the alert for now.
      alert(`Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`);
    } else if ('error' in res && res.error) {
      alert(`Dispatch failed: ${res.error}`);
    }
  }

  // Refresh dashboard data whenever any run terminates — Overview is a
  // global view, so subscribe to all runs.
  useRunTerminal({}, () => {
    // refresh is defined below — call it via the function so we get the
    // latest closure. Wrapped in setTimeout(0) to break the read-before-decl
    // cycle without a forward reference.
    setTimeout(() => refresh(), 0);
  });

  const [reindexing, setReindexing] = useState(false);
  const [reindexErr, setReindexErr] = useState<string | null>(null);
  const [reindexResult, setReindexResult] = useState<{ entries: number; ms: number } | null>(null);

  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WELCOME_KEY) === '1';
    } catch {
      return false;
    }
  });

  const refresh = useCallback(() => {
    fetchManifest()
      .catch(() => ({ version: 1, generated: null, entries: [] }))
      .then(setManifest);
    getJson<CurationData>('/api/curation')
      .catch(() => ({ items: [] }))
      .then(setCuration);
    getJson<SkillsData>('/api/skills')
      .catch(() => ({ skills: [] }))
      .then(setSkills);
    getJson<DomainsData>('/api/domains')
      .catch(() => ({ domains: [] }))
      .then(setDomains);
    getJson<FreshnessData>('/api/vault/freshness')
      .catch(
        () =>
          ({
            generated: null,
            newest_mtime: null,
            stale: false,
            newer_count: 0,
            total_files: 0,
          }) satisfies FreshnessData,
      )
      .then(setFreshness);
    getJson<AuditResponse>('/api/audit')
      .catch(
        () =>
          ({
            ok: false,
            ran_at: new Date().toISOString(),
            duration_ms: 0,
            findings: [],
            summary: { error: 0, warn: 0, info: 0 },
            error: 'audit endpoint unreachable',
          }) satisfies AuditResponse,
      )
      .then(setAudit);
    getJson<SchedulesResponse>('/api/schedules')
      .catch(
        () =>
          ({
            schedules: [],
            status: {
              count: 0,
              next_fire: null,
              last_24h: { runs: 0, failures: 0 },
            },
          }) satisfies SchedulesResponse,
      )
      .then(setSchedules);
    getJson<EventsResponse>('/api/events?limit=8')
      .catch(() => ({ events: [] }))
      .then(setEvents);
    getJson<ProjectsResponse>('/api/projects?status=active')
      .catch(() => ({ projects: [] }))
      .then(setProjects);
    getJson<NotificationRulesResponse>('/api/notifications/rules')
      .catch(() => ({ rules: [] }))
      .then(setNotifRules);
    {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      getJson<NotificationEventsResponse>(
        `/api/notifications/events?since=${encodeURIComponent(since)}&limit=1000`,
      )
        .catch(() => ({ events: [] }))
        .then(setNotifEvents);
    }
    // Brief is owned by <LatestArtifactCard>; bump its refreshKey so the
    // card re-fetches the latest brief markdown on every refresh tick.
    setBriefRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function openForm(skillName: string, title: string) {
    let skill = await findSkill(skillName);
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill(skillName);
    }
    if (!skill) {
      alert(`${skillName} not found in .claude/skills/`);
      return;
    }
    setFormSkill(skill);
    setFormTitle(title);
  }

  function runBrief() {
    dispatch('/os brief', 'Running /os brief', 'os');
  }

  function dismissWelcome() {
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      /* localStorage may be unavailable */
    }
    setWelcomeDismissed(true);
  }

  function showWelcome() {
    try {
      localStorage.removeItem(WELCOME_KEY);
    } catch {
      /* localStorage may be unavailable */
    }
    setWelcomeDismissed(false);
  }

  async function rebuildIndex() {
    setReindexing(true);
    setReindexErr(null);
    setReindexResult(null);
    const started = performance.now();
    const minDisplayMs = 600;
    try {
      const [resp] = await Promise.all([
        fetch('/api/vault/reindex', { method: 'POST' }),
        new Promise((r) => setTimeout(r, minDisplayMs)),
      ]);
      const j = (await resp.json()) as { ok?: boolean; error?: string; entries?: number };
      if (!j.ok) throw new Error(j.error ?? `HTTP ${resp.status}`);
      const elapsed = Math.round(performance.now() - started);
      setReindexResult({ entries: j.entries ?? 0, ms: elapsed });
      refresh();
      setTimeout(() => setReindexResult(null), 5000);
    } catch (e) {
      setReindexErr(e instanceof Error ? e.message : String(e));
    } finally {
      setReindexing(false);
    }
  }

  if (!manifest || !curation || !skills || !domains) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  const totalDomains = countDomains(domains.domains);
  const status = schedules?.status;

  const auditSeverity: 'ok' | 'warn' | 'err' = !audit
    ? 'ok'
    : audit.summary.error > 0
      ? 'err'
      : audit.summary.warn > 0
        ? 'warn'
        : 'ok';
  const auditStatus = !audit
    ? '—'
    : audit.summary.error > 0
      ? `${audit.summary.error} err`
      : audit.summary.warn > 0
        ? `${audit.summary.warn} warn`
        : 'clean';

  const schedSeverity: 'ok' | 'warn' | 'err' =
    status && status.last_24h.failures > 0 ? 'err' : 'ok';
  const schedStatus = !status
    ? '—'
    : status.count === 0
      ? '0 scheduled'
      : status.last_24h.failures > 0
        ? `${status.last_24h.failures} failed`
        : `${status.count} healthy`;

  const brokenSkills = skills.skills.filter((s) => s.parseError);

  // Automation tile — count active projects with automation.enabled, group
  // by phase. Failed counts as paused for the hint (the orchestrator pauses
  // on failure rather than maintaining a distinct failed phase in practice).
  const autoProjects = (projects?.projects ?? []).filter(
    (p) => p.automation && p.automation.enabled,
  );
  const autoCounts = autoProjects.reduce(
    (acc, p) => {
      const phase = p.automation?.state?.phase ?? 'idle';
      acc[phase] = (acc[phase] ?? 0) + 1;
      return acc;
    },
    { idle: 0, running: 0, paused: 0, failed: 0 } as Record<string, number>,
  );
  const autoSeverity: 'ok' | 'warn' | 'err' =
    autoCounts.failed > 0 ? 'err' : autoCounts.paused > 0 ? 'warn' : 'ok';
  const autoValue =
    autoProjects.length === 0
      ? '0 enabled'
      : autoCounts.running > 0
        ? `${autoCounts.running} running`
        : autoCounts.paused > 0
          ? `${autoCounts.paused} paused`
          : autoCounts.failed > 0
            ? `${autoCounts.failed} failed`
            : `${autoCounts.idle} idle`;
  const autoHint =
    autoProjects.length === 0
      ? undefined
      : `${autoProjects.length} project${autoProjects.length === 1 ? '' : 's'} · ${autoCounts.idle}i ${autoCounts.running}r ${autoCounts.paused}p${autoCounts.failed > 0 ? ` ${autoCounts.failed}f` : ''}`;

  // Notifications tile — rule count + 24h dispatch outcome breakdown.
  const ruleCount = notifRules?.rules.length ?? 0;
  const notifEventList = notifEvents?.events ?? [];
  const notifSent = notifEventList.filter((e) => e.action === 'sent').length;
  const notifFailed = notifEventList.filter((e) => e.action === 'failed').length;
  const notifSeverity: 'ok' | 'warn' | 'err' = notifFailed > 0 ? 'err' : 'ok';
  const notifValue =
    ruleCount === 0
      ? '0 rules'
      : notifFailed > 0
        ? `${notifFailed} failed`
        : notifSent > 0
          ? `${notifSent} sent / 24h`
          : `${ruleCount} rule${ruleCount === 1 ? '' : 's'}`;
  const notifHint =
    ruleCount === 0
      ? 'Add a rule on the Notifications view'
      : `${ruleCount} rule${ruleCount === 1 ? '' : 's'} · ${notifSent} sent · ${notifFailed} failed (24h)`;

  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Overview</h1>
        <span className="spacer" />
        {welcomeDismissed && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={showWelcome}
            title="Re-open the welcome card"
          >
            ? Help
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm"
          onClick={refresh}
          title="Re-fetch all signals on this page"
        >
          <Icons.Refresh size={11} /> Refresh
        </button>
      </header>

      <ActionItemsPanel />

      {!welcomeDismissed && (
        <section className="card" style={{ marginBottom: 18, padding: 18, position: 'relative' }}>
          <button
            type="button"
            onClick={dismissWelcome}
            title="Hide this card (re-open via ? Help)"
            style={{
              position: 'absolute',
              top: 8,
              right: 10,
              background: 'none',
              border: 'none',
              color: 'var(--text-3)',
              cursor: 'pointer',
              fontSize: 18,
              padding: 4,
              lineHeight: 1,
            }}
          >
            ×
          </button>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              marginBottom: 8,
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ fontSize: 14 }}>Welcome to the Agentic OS.</strong>
            <button type="button" className="btn btn-sm" onClick={() => nav.setView('guide')}>
              Open the Guide →
            </button>
          </div>
          <p className="subtle" style={{ fontSize: 13, marginTop: 0, marginBottom: 8 }}>
            A self-extending workflow OS built on five core ideas:
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 13,
              lineHeight: 1.7,
              color: 'var(--text-2)',
            }}
          >
            <li>
              <strong>Domains</strong> organize related work (code, research, ops)
            </li>
            <li>
              <strong>Skills</strong> are invokable actions Claude follows
            </li>
            <li>
              <strong>Apps</strong> are optional visual UIs over domain state
            </li>
            <li>
              <strong>Vault</strong> is structured memory: <code className="mono">raw/</code> →{' '}
              <code className="mono">wiki/</code> → <code className="mono">output/</code>
            </li>
            <li>
              <code className="mono">/os &lt;intent&gt;</code> is how you do everything — the router
              dispatches to the right skill
            </li>
          </ul>
        </section>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        {QUICK_SCAFFOLDERS.map((q, i) => {
          if (q.kind === 'separator') {
            return (
              <span
                key={`sep-${i}`}
                aria-hidden
                style={{
                  width: 1,
                  alignSelf: 'stretch',
                  background: 'var(--border)',
                  margin: '0 4px',
                }}
              />
            );
          }
          if (q.kind === 'navigate') {
            return (
              <button
                key={q.href}
                type="button"
                className="btn btn-sm"
                onClick={() => navigate(q.href)}
                title={`Open ${q.href}`}
              >
                <Icons.Plus size={11} /> {q.label}
              </button>
            );
          }
          return (
            <button
              key={q.skill}
              type="button"
              className="btn btn-sm"
              onClick={() => openForm(q.skill, q.title)}
              title={`Open ${q.skill} scaffolder`}
            >
              <Icons.Plus size={11} /> {q.label}
            </button>
          );
        })}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={runBrief}
          title="Invoke /os brief — session summary"
        >
          <Icons.Sparkles size={11} /> Run brief
        </button>
      </div>

      <LatestArtifactCard
        title="Latest brief"
        path="vault/output/meta/brief/latest.md"
        storageKey="agentic-os/brief-collapsed"
        staleAfterHours={24}
        emptyMessage="No brief yet. Click Run brief above to generate one."
        onRefresh={runBrief}
        refreshKey={briefRefreshKey}
      />

      {freshness?.stale && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            padding: '12px 16px',
            background: 'var(--warning-bg)',
            borderColor: 'var(--warning-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ flex: 1, fontSize: 13 }}>
            {freshness.newer_count > 0 ? (
              <>
                <strong>Vault index is stale.</strong> {freshness.newer_count} wiki entr
                {freshness.newer_count === 1 ? 'y has' : 'ies have'} changed since the last index
                rebuild.
              </>
            ) : (
              <>
                <strong>Vault index is missing.</strong> Run a rebuild to populate{' '}
                <code className="mono">vault/.index/manifest.json</code>.
              </>
            )}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={reindexing}
            onClick={rebuildIndex}
          >
            {reindexing ? 'Rebuilding…' : 'Rebuild now'}
          </button>
        </div>
      )}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
          marginBottom: 18,
        }}
      >
        <ClickableMetric onClick={() => nav.setView('health')}>
          <Metric
            label="OS Health"
            value={auditStatus}
            hint={auditHint(audit)}
            severity={auditSeverity}
          />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('schedules')}>
          <Metric
            label="Scheduler"
            value={schedStatus}
            hint={schedHint(status)}
            severity={schedSeverity}
          />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('domains')}>
          <Metric label="Domains" value={String(totalDomains)} />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('skills')}>
          <Metric
            label="Skills"
            value={String(skills.skills.length)}
            hint={brokenSkills.length > 0 ? `${brokenSkills.length} broken` : undefined}
            severity={brokenSkills.length > 0 ? 'err' : 'ok'}
          />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('vault')}>
          <Metric label="Wiki entries" value={String(manifest.entries.length)} />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('curation')}>
          <Metric
            label="Pending curation"
            value={String(curation.items.length)}
            severity={curation.items.length > 0 ? 'warn' : 'ok'}
          />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('projects')}>
          <Metric label="Automation" value={autoValue} hint={autoHint} severity={autoSeverity} />
        </ClickableMetric>
        <ClickableMetric onClick={() => nav.setView('notifications')}>
          <Metric
            label="Notifications"
            value={notifValue}
            hint={notifHint}
            severity={notifSeverity}
          />
        </ClickableMetric>
      </section>

      <section className="card" style={{ marginBottom: 18, padding: 0 }}>
        <div className="card-header">
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Recent activity</h3>
          <button type="button" className="btn btn-sm" onClick={() => nav.setView('activity')}>
            See all →
          </button>
        </div>
        <div style={{ padding: 12 }}>
          {!events || events.events.length === 0 ? (
            <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
              No events recorded yet. Use <code className="mono">/os &lt;intent&gt;</code>, click
              dashboard actions, or wait for a scheduled job to fire.
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {events.events.map((e, i) => (
                <li
                  key={`${e.ts}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 8px',
                    fontSize: 12.5,
                    borderRadius: 4,
                  }}
                >
                  <span className="tiny mono" title={formatLocal(e.ts)} style={{ minWidth: 80 }}>
                    {formatRelative(e.ts)}
                  </span>
                  <span
                    className={`badge ${eventBadgeKind(e.kind)}`}
                    style={{ minWidth: 70, textAlign: 'center' }}
                  >
                    {e.kind}
                  </span>
                  <span style={{ flex: 1, color: 'var(--text-2)' }}>{e.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {projects && projects.projects.length > 0 && (
        <section className="card" style={{ marginBottom: 18, padding: 0 }}>
          <div className="card-header">
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Active projects</h3>
            <button type="button" className="btn btn-sm" onClick={() => nav.setView('projects')}>
              See all →
            </button>
          </div>
          <ul
            style={{
              listStyle: 'none',
              padding: 12,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {projects.projects.map((p) => {
              const urgency = deadlineUrgency(p.deadline);
              return (
                <li
                  key={p.path}
                  style={{
                    padding: '6px 8px',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => p.id && nav.navigateToEntry(p.id)}
                    disabled={!p.id}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'var(--accent)',
                      cursor: p.id ? 'pointer' : 'not-allowed',
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    {p.title}
                  </button>
                  {p.domain && <span className="tiny">({p.domain})</span>}
                  {p.deadline && (
                    <>
                      <span className="tiny">deadline</span>
                      <span className={`badge ${urgencyBadge(urgency)}`} title={p.deadline}>
                        {deadlineRelative(p.deadline)}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card" style={{ marginBottom: 18, padding: 0 }}>
        <div className="card-header">
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Vault index</h3>
          <button type="button" className="btn btn-sm" disabled={reindexing} onClick={rebuildIndex}>
            {reindexing ? 'Rebuilding…' : 'Rebuild now'}
          </button>
        </div>
        <div style={{ padding: 14 }}>
          <div style={{ fontSize: 13 }}>
            Last rebuilt:{' '}
            {manifest.generated ? (
              <span title={manifest.generated}>
                {formatRelative(manifest.generated)}{' '}
                <span className="subtle">({formatLocal(manifest.generated)})</span>
              </span>
            ) : (
              <em className="subtle">never</em>
            )}
          </div>
          {freshness && (
            <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
              {freshness.total_files} wiki file{freshness.total_files === 1 ? '' : 's'} on disk
              {freshness.newest_mtime && (
                <>
                  {' · '}newest modified{' '}
                  <span title={freshness.newest_mtime}>
                    {formatRelative(freshness.newest_mtime)}
                  </span>
                </>
              )}
            </div>
          )}
          {reindexResult && (
            <div
              style={{
                marginTop: 8,
                fontSize: 12.5,
                color: 'var(--success-text)',
              }}
            >
              ✓ Rebuilt — {reindexResult.entries} entr
              {reindexResult.entries === 1 ? 'y' : 'ies'} indexed in {reindexResult.ms}ms
            </div>
          )}
          {reindexErr && (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--error-text)' }}>
              Rebuild failed: {reindexErr}
            </div>
          )}
          <p className="subtle" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            The index auto-rebuilds when Claude Code edits files in{' '}
            <code className="mono">vault/wiki/</code>. External edits (git pull, manual file
            changes) need a manual rebuild.
          </p>
        </div>
      </section>

      {formSkill && (
        <ScaffoldForm
          skill={formSkill}
          title={formTitle}
          onCancel={() => setFormSkill(null)}
          onSubmit={(prompt) => {
            const skill = formSkill?.name ?? 'unknown';
            setFormSkill(null);
            dispatch(prompt, formTitle, skill);
          }}
        />
      )}
    </div>
  );
}

function ClickableMetric({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  );
}

function auditHint(audit: AuditResponse | null): string | undefined {
  if (!audit) return undefined;
  if (!audit.ok) return audit.error ?? 'audit failed';
  return `ran ${formatRelative(audit.ran_at)}`;
}

function schedHint(status: ScheduleStatus | undefined): string | undefined {
  if (!status) return undefined;
  if (status.next_fire) {
    return `next in ${formatRelativeFuture(status.next_fire.ts)}`;
  }
  return status.last_24h.runs > 0 ? `${status.last_24h.runs} runs / 24h` : 'no upcoming';
}

function eventBadgeKind(kind: EventSummary['kind']): string {
  switch (kind) {
    case 'router':
      return 'info';
    case 'dashboard':
      return 'muted';
    case 'schedule':
      return 'success';
    default:
      return 'muted';
  }
}

function deadlineUrgency(deadline: string | null): 'overdue' | 'soon' | 'ok' | null {
  if (!deadline) return null;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return null;
  const diffDays = Math.floor((t - Date.now()) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays < 7) return 'soon';
  return 'ok';
}

function urgencyBadge(urgency: ReturnType<typeof deadlineUrgency>): string {
  if (urgency === 'overdue') return 'error';
  if (urgency === 'soon') return 'warning';
  return 'muted';
}

function formatRelativeFuture(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const seconds = Math.floor((t - Date.now()) / 1000);
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'tomorrow';
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}

function deadlineRelative(date: string): string {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return date;
  const diffDays = Math.floor((t - Date.now()) / 86400000);
  if (diffDays < -1) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === -1) return '1 day overdue';
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays < 7) return `in ${diffDays} days`;
  if (diffDays < 30) return `in ${Math.floor(diffDays / 7)} weeks`;
  return `in ${Math.floor(diffDays / 30)} months`;
}

// ---------------------------------------------------------------------------
// Action Items panel — the self-healing surface
//
// Reads /api/health/action-items, renders each finding with severity color +
// a contextual button row:
//   - Accept    → dispatches the proposedAction (skill | navigate | rebuild)
//   - Dismiss   → POSTs to /dismiss; the item disappears (until the user
//                 re-opens via "Show dismissed")
//   - View      → opens the item's source path in a new tab or routes via
//                 react-router for in-app paths
//
// Architecture note: the panel owns its own ActionRunner instance so skill
// dispatches stay isolated from the main app's pendingPrompt state. Closing
// the runner refreshes the items list so terminal-state findings disappear.
// ---------------------------------------------------------------------------

type ItemSeverity = 'error' | 'warn' | 'info';
interface PanelProposedAction {
  type: 'skill' | 'navigate' | 'rebuild-manifest' | 'accept-drafts';
  skill?: string;
  args?: Record<string, unknown>;
  href?: string;
  // For type=accept-drafts — target change id.
  changeId?: string;
}
interface PanelActionItem {
  id: string;
  severity: ItemSeverity;
  title: string;
  message: string;
  hint?: string;
  source: { kind: 'audit' | 'lifecycle' | 'runbook'; path?: string };
  proposedAction?: PanelProposedAction;
  dismissed?: boolean;
}
interface PanelResponse {
  items: PanelActionItem[];
  summary: { error: number; warn: number; info: number; dismissed: number };
}

function ActionItemsPanel() {
  const navigate = useNavigate();
  const nav = useNavigation();
  const [data, setData] = useState<PanelResponse | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const { startSkillRun } = useDispatch();

  const refresh = useCallback(async () => {
    try {
      const url = showDismissed
        ? '/api/health/action-items?include_dismissed=1'
        : '/api/health/action-items';
      const r = await getJson<PanelResponse>(url);
      setData(r);
    } catch {
      setData({ items: [], summary: { error: 0, warn: 0, info: 0, dismissed: 0 } });
    }
  }, [showDismissed]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function dismiss(id: string) {
    try {
      await fetch(`/api/health/action-items/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      /* server records nothing; UI still hides */
    }
    refresh();
  }

  function accept(item: PanelActionItem) {
    const action = item.proposedAction;
    if (!action) return;
    if (action.type === 'navigate' && action.href) {
      // In-app paths (starting with /) go through the router; others open
      // in a new tab. Today all proposed hrefs are in-app.
      if (action.href.startsWith('/')) navigate(action.href);
      else window.open(action.href, '_blank', 'noreferrer');
      return;
    }
    if (action.type === 'rebuild-manifest') {
      fetch('/api/health/rebuild-manifest', { method: 'POST' })
        .then(() => refresh())
        .catch(() => refresh());
      return;
    }
    if (action.type === 'accept-drafts' && action.changeId) {
      // POST to the change's accept-drafts endpoint, then refresh the
      // panel. After success, the audit's change-body-template-placeholder
      // finding for this change disappears on the next audit run.
      fetch(`/api/changes/${encodeURIComponent(action.changeId)}/accept-drafts`, {
        method: 'POST',
      })
        .then(() => refresh())
        .catch(() => refresh());
      return;
    }
    if (action.type === 'skill' && action.skill) {
      const args = action.args ?? {};
      const argLines = Object.entries(args).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`);
      const prompt = [
        `Run the ${action.skill} skill — proposed action from the Overview action-items panel.`,
        `Read .claude/skills/${action.skill}/SKILL.md and follow its Procedure exactly.`,
        '',
        'Inputs:',
        ...argLines,
        '',
        'IMPORTANT — headless dashboard-driven call:',
        '- Do NOT use AskUserQuestion or any interactive prompt.',
        '- Report the tight summary block at the end (per the SKILL.md).',
      ].join('\n');
      const changeId =
        typeof (args as Record<string, unknown>).change === 'string'
          ? (args as Record<string, string>).change
          : null;
      startSkillRun(prompt, `Accepting: ${item.title}`, {
        skill: action.skill,
        change_id: changeId,
      }).then((res) => {
        if ('blocked' in res && res.blocked) {
          alert(
            `Already running on this target: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`,
          );
        } else if ('error' in res && res.error) {
          alert(`Dispatch failed: ${res.error}`);
        }
      });
    }
  }

  // Refetch action items whenever any run terminates — same trigger as the
  // old ActionRunner.onClose handler. Drift findings cleared by the accepted
  // skill disappear from the panel on next refresh.
  useRunTerminal({}, () => {
    refresh();
  });

  // Collapsed by default when there's nothing actionable AND no dismissed.
  // Still rendered (with a "0 items" line) so the user knows the system is
  // healthy — not just silent because something broke.
  const total = data?.items.length ?? 0;
  const sum = data?.summary ?? { error: 0, warn: 0, info: 0, dismissed: 0 };
  const hasActionable = sum.error > 0 || sum.warn > 0;
  const headerColor = hasActionable ? 'var(--warn-text)' : 'var(--muted)';

  return (
    <>
      <section className="card" style={{ marginBottom: 18, padding: 0 }}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="card-header"
          style={{
            background: 'transparent',
            border: 0,
            width: '100%',
            textAlign: 'left',
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          {collapsed ? (
            <Icons.ChevronRight size={14} style={{ color: 'var(--muted)' }} />
          ) : (
            <Icons.ChevronDown size={14} style={{ color: 'var(--muted)' }} />
          )}
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: headerColor }}>
            Action items
          </h4>
          <span className="tiny" style={{ color: 'var(--muted)' }}>
            {sum.error > 0 && (
              <span style={{ color: 'var(--danger-text)' }}>{sum.error} error · </span>
            )}
            {sum.warn > 0 && <span style={{ color: 'var(--warn-text)' }}>{sum.warn} warn · </span>}
            {sum.info > 0 && `${sum.info} info · `}
            {sum.dismissed > 0 && (
              <span style={{ color: 'var(--muted)' }}>{sum.dismissed} dismissed</span>
            )}
            {total === 0 && 'all clear'}
          </span>
          <span className="spacer" />
          {/* Show-dismissed toggle rendered AFTER the collapse-toggle button (as a sibling, not nested) — nesting <button> inside <button> is invalid HTML and the a11y lint rule will flag it. */}
        </button>
        {!collapsed && sum.dismissed > 0 && (
          <div style={{ padding: '0 16px 6px' }}>
            <button
              type="button"
              onClick={() => setShowDismissed((s) => !s)}
              className="tiny"
              style={{
                background: 'transparent',
                border: 0,
                color: 'var(--text-2)',
                cursor: 'pointer',
                padding: 0,
              }}
              title={showDismissed ? 'Hide dismissed items' : 'Include dismissed items in the list'}
            >
              {showDismissed ? '◉ Showing dismissed' : '◯ Show dismissed'}
            </button>
          </div>
        )}
        {!collapsed && (
          <div style={{ padding: '0 16px 14px' }}>
            {total === 0 && (
              <p className="subtle" style={{ margin: 0, fontSize: 12.5 }}>
                No action items — the OS audit + lifecycle scan are clean. The panel will repopulate
                as drift surfaces.
              </p>
            )}
            {data?.items.map((item) => (
              <ActionItemRow
                key={item.id}
                item={item}
                onAccept={() => accept(item)}
                onDismiss={() => dismiss(item.id)}
                onView={() => {
                  const path = item.source.path;
                  if (!path) return;
                  // In-app router paths.
                  if (path.startsWith('/')) {
                    navigate(path);
                    return;
                  }
                  // Wiki entry paths — resolve slug from filename (entry id by
                  // convention) and route through the vault detail view.
                  if (path.startsWith('vault/wiki/') && path.endsWith('.md')) {
                    const slug = path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
                    nav.navigateToEntry(slug);
                    return;
                  }
                  // Synthetic event-catalog references emitted by the
                  // notification-template-missing-override audit. Route to
                  // the rules matrix where the event row is visible.
                  if (path.startsWith('event-catalog:')) {
                    navigate('/notifications/rules');
                    return;
                  }
                  // Real http URL — open in a new tab.
                  if (/^https?:\/\//.test(path)) {
                    window.open(path, '_blank', 'noreferrer');
                    return;
                  }
                  // Unknown shape — log and noop rather than producing a
                  // browser-side relative-URL guess that 404s.
                  console.warn(`Action item source path not routable: ${path}`);
                }}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function ActionItemRow({
  item,
  onAccept,
  onDismiss,
  onView,
}: {
  item: PanelActionItem;
  onAccept: () => void;
  onDismiss: () => void;
  onView: () => void;
}) {
  const sevColor =
    item.severity === 'error'
      ? 'var(--danger-text)'
      : item.severity === 'warn'
        ? 'var(--warn-text)'
        : 'var(--muted)';
  const sevIcon =
    item.severity === 'error' ? (
      <Icons.X size={11} />
    ) : item.severity === 'warn' ? (
      <Icons.AlertTriangle size={11} />
    ) : (
      <Icons.AlertTriangle size={11} />
    );
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '14px 1fr auto',
        gap: 10,
        padding: '10px 0',
        borderBottom: '1px solid var(--border)',
        fontSize: 12.5,
        opacity: item.dismissed ? 0.55 : 1,
      }}
    >
      <span style={{ color: sevColor, marginTop: 2 }}>{sevIcon}</span>
      <div>
        <div style={{ fontWeight: 500 }}>
          {item.title}
          {item.dismissed && (
            <span className="tiny" style={{ marginLeft: 8, color: 'var(--muted)' }}>
              (dismissed)
            </span>
          )}
        </div>
        <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{item.message}</div>
        {item.hint && (
          <div className="tiny" style={{ color: 'var(--muted)', marginTop: 3 }}>
            → {item.hint}
          </div>
        )}
        {item.source.path && (
          <div className="tiny mono" style={{ color: 'var(--muted)', marginTop: 3 }}>
            source: {item.source.path}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        {item.proposedAction && !item.dismissed && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onAccept}
            title={
              item.proposedAction.type === 'skill'
                ? `Dispatches the ${item.proposedAction.skill} skill via ActionRunner`
                : item.proposedAction.type === 'navigate'
                  ? `Opens ${item.proposedAction.href} — you'll fix it there by hand`
                  : item.proposedAction.type === 'accept-drafts'
                    ? `Strips DRAFT-marker blockquotes from the body of ${item.proposedAction.changeId}. Idempotent.`
                    : 'Runs the local rebuild hook'
            }
          >
            {item.proposedAction.type === 'navigate' ? 'Open' : 'Accept'}
          </button>
        )}
        {item.source.path && (
          <button type="button" className="btn btn-sm" onClick={onView} title="Open source">
            View
          </button>
        )}
        {!item.dismissed && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onDismiss}
            title="Suppress this finding from the panel (recorded in .claude/state/dismissed-action-items.jsonl)"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
