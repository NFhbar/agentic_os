// Projects — cross-repo work glue. Migrated to apps/ + restyled with the
// prototype design system: .h1 header, .badge status chips, .card sections
// in detail pane, .metric-style grids for meta blocks.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EditableMarkdown, Rendered } from '../../components/EditableMarkdown';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { getJson } from '../../lib/api';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { useNavigation } from '../../lib/navigation';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { formatLocal, formatRelative } from '../../lib/time';
import { type ManifestEntry, fetchEntry, fetchManifest } from '../../lib/vault';
import { Icons, Stepper } from '../../shared';
import '../../shared/styles.css';
import {
  type EventCatalogEntry,
  type RuleListItem,
  buildSubscriptionMap,
  findEventForStep,
  getEventCatalog,
  listRules,
} from '../notifications/data';

// Wire-shape types re-exported from the server's source-of-truth. Per
// standard-shared-types (sibling .types.ts pattern). Adding fields to any
// of these now requires one edit, not two.
import type {
  BacklinkRef,
  ChangeAggregate,
  Milestone,
  OwnedChangeRef,
  ProjectDetail,
  ProjectRollup,
  ProjectScheduleRef,
  ProjectSummary,
  Reporting,
  StatusReportRef,
} from '../../../server/routes/projects.types';
import type { ResearchReportSummary } from '../../../server/routes/research.types';

// Local alias so existing client code keeps using the shorter name without
// editing each call-site. The server's ResearchReportSummary is a superset
// of the fields the project page actually renders; client tolerates extras.
type ResearchReportRef = ResearchReportSummary;

interface ProjectsResponse {
  projects: ProjectSummary[];
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

function deadlineRelative(date: string | null): string {
  if (!date) return '';
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

function projectStatusBadge(status: string | null): string {
  if (!status) return 'badge muted';
  switch (status) {
    case 'active':
      return 'badge success';
    case 'planning':
      return 'badge info';
    case 'paused':
      return 'badge warning';
    case 'done':
      return 'badge muted';
    case 'cancelled':
      return 'badge error';
    default:
      return 'badge muted';
  }
}

function changeStatusBadge(status: string | null): string {
  if (!status) return 'badge muted';
  switch (status) {
    case 'planning':
      return 'badge info';
    case 'in-progress':
      return 'badge warning';
    case 'in-review':
      return 'badge info';
    case 'merged':
      return 'badge success';
    case 'abandoned':
      return 'badge muted';
    default:
      return 'badge muted';
  }
}

function deadlineBadge(urgency: ReturnType<typeof deadlineUrgency>): string {
  if (urgency === 'overdue') return 'badge error';
  if (urgency === 'soon') return 'badge warning';
  if (urgency === 'ok') return 'badge muted';
  return 'badge muted';
}

const BACKLINK_GROUP_ORDER = ['decision', 'note', 'runbook', 'entity', 'reference', 'project'];

// Kinds rendered on their own tabs (Changes, Research) — exclude from the
// catch-all Related tab so we don't double-render or inflate the badge.
function excludeOwnTabKinds(groups: Record<string, BacklinkRef[]>): Record<string, BacklinkRef[]> {
  const out: Record<string, BacklinkRef[]> = {};
  for (const [k, v] of Object.entries(groups)) {
    if (k === 'change' || k === 'research-report') continue;
    out[k] = v;
  }
  return out;
}

// Valid tab ids — mirrored on the URL. Anything else falls back to
// 'changes' (the default work surface). Kept in module scope so the URL
// parser below + the TABS array below stay aligned.
const VALID_PROJECT_TABS: readonly ProjectTabId[] = [
  'overview',
  'plan',
  'changes',
  'reports',
  'schedules',
  'research',
  'notifications',
  'automation',
  'related',
  'replay',
];

export default function Projects() {
  const nav = useNavigation();
  const navigate = useNavigate();
  // URL routing: app is mounted at `/projects/*` in App.tsx; the splat
  // captures everything after `/projects/`. We treat the first segment
  // as the project id, the optional second as the tab id.
  //   /projects                       → list view
  //   /projects/<id>                  → detail, default tab ('changes')
  //   /projects/<id>/<tab>            → detail at tab
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const splatParts = splat.split('/').filter(Boolean);
  const selected: string | null = splatParts[0] || null;
  const rawTab = splatParts[1] as ProjectTabId | undefined;
  // Validated tab id when the URL has an explicit `<tab>` segment; null
  // when absent. ProjectDetailPane substitutes a plan_status-derived
  // default (Plan vs Changes) when this is null — needs the loaded
  // project, which isn't available here yet.
  const explicitTab: ProjectTabId | null =
    rawTab && VALID_PROJECT_TABS.includes(rawTab) ? rawTab : null;

  const setSelected = useCallback(
    (id: string | null) => {
      navigate(id ? `/projects/${id}` : '/projects');
    },
    [navigate],
  );
  const setTab = useCallback(
    (newTab: ProjectTabId) => {
      if (selected) navigate(`/projects/${selected}/${newTab}`);
    },
    [navigate, selected],
  );

  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [addSkill, setAddSkill] = useState<SkillSummary | null>(null);
  // When set, the dev-add-change scaffold form opens with `project` pre-filled.
  // Tracked separately from addSkill so the two flows don't share state.
  const [addChangeSkill, setAddChangeSkill] = useState<{
    skill: SkillSummary;
    projectId: string;
  } | null>(null);
  // Same shape for the meta-add-schedule flow — project pre-filled.
  const [addScheduleSkill, setAddScheduleSkill] = useState<{
    skill: SkillSummary;
    projectId: string;
  } | null>(null);
  const { startSkillRun, setDrawerFilter, setDrawerOpen } = useDispatch();

  async function dispatch(prompt: string, title: string, skill: string, projectId?: string) {
    const res = await startSkillRun(prompt, title, { skill, project: projectId ?? null });
    if ('blocked' in res && res.blocked) {
      alert(`Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`);
    } else if ('error' in res && res.error) {
      alert(`Dispatch failed: ${res.error}`);
    }
  }

  // Refresh list + detail whenever any project-scoped run terminates.
  // Same trigger as the old ActionRunner.onClose handler.
  useRunTerminal({ project: selected ?? undefined }, async () => {
    try {
      const r = await getJson<ProjectsResponse>('/api/projects');
      setList(r.projects);
    } catch {
      /* keep prior */
    }
    if (selected) {
      try {
        const d = await getJson<ProjectDetail>(`/api/projects/${encodeURIComponent(selected)}`);
        setDetail(d);
      } catch {
        /* keep prior */
      }
    }
  });

  const refresh = useCallback(async () => {
    try {
      const r = await getJson<ProjectsResponse>('/api/projects');
      setList(r.projects);
      if (selected && !r.projects.find((p) => p.id === selected)) {
        setSelected(null);
        setDetail(null);
      }
    } catch {
      setList([]);
    }
  }, [selected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    getJson<ProjectDetail>(`/api/projects/${encodeURIComponent(selected)}`)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selected]);

  async function openAddForm() {
    let skill = await findSkill('meta-add-project');
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill('meta-add-project');
    }
    if (!skill) {
      alert('meta-add-project skill not found in .claude/skills/');
      return;
    }
    setAddSkill(skill);
  }

  // "Add change to this project" — opens the dev-add-change scaffold form
  // with the project field pre-filled, so the user doesn't have to retype
  // the project id (and avoids typos / forgotten links). The form's
  // data-driven inputs handle the rest (repo picker reads the manifest,
  // enum dropdowns for type/size, etc.).
  async function openAddChangeForm(projectId: string) {
    let skill = await findSkill('dev-add-change');
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill('dev-add-change');
    }
    if (!skill) {
      alert('dev-add-change skill not found in .claude/skills/');
      return;
    }
    setAddChangeSkill({ skill, projectId });
  }

  // Same pattern for meta-add-schedule. Scaffolds a runbook entry with
  // schedule/prompt fields; the `project` input gets pre-filled so the
  // resulting runbook is project-scoped (the scheduler skips it when the
  // project's status isn't `active`).
  async function openAddScheduleForm(projectId: string) {
    let skill = await findSkill('meta-add-schedule');
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill('meta-add-schedule');
    }
    if (!skill) {
      alert('meta-add-schedule skill not found in .claude/skills/');
      return;
    }
    setAddScheduleSkill({ skill, projectId });
  }

  // Generates a `kickoff` / `status` / `wrap-up` report via meta-status-report.
  // Defaults to 'status' for backward-compatible callers (the state banner's
  // "Generate final report" button passes 'wrap-up' explicitly).
  function generateReport(
    project: ProjectSummary,
    reportType: 'kickoff' | 'status' | 'wrap-up' = 'status',
  ) {
    if (!project.id) return;
    const prompt = [
      `Run the meta-status-report skill for project "${project.id}".`,
      'Read .claude/skills/meta-status-report/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- project: ${JSON.stringify(project.id)}`,
      `- report_type: ${reportType}`,
      '',
      'IMPORTANT — this is a headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      `- Compose the report per the "${reportType}" variant of the SKILL.md template.`,
      '- Write the file at the new path: vault/output/<domain>/status-reports/<project>-<report_type>-<date>.md.',
      '- Update the project entry (reporting.last_sent / next_due) per the Procedure.',
      '- Report a short summary including the report type at the end.',
    ].join('\n');
    const typeLabel =
      reportType === 'kickoff' ? 'kickoff' : reportType === 'wrap-up' ? 'wrap-up' : 'status';
    dispatch(
      prompt,
      `Generating ${typeLabel} report for ${project.title}`,
      'meta-status-report',
      project.id,
    );
  }

  return (
    <div
      className="view projects"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Projects</h1>
        {list && <span className="tiny">{list.length} total</span>}
        {selected && <span className="badge muted">{selected}</span>}
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={openAddForm}>
          <Icons.Plus size={13} /> New Project
        </button>
      </header>

      {!selected && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {!list ? (
            <p className="subtle" style={{ padding: 18 }}>
              loading…
            </p>
          ) : list.length === 0 ? (
            <div className="card" style={{ margin: 18, padding: 18, maxWidth: 720 }}>
              <p style={{ fontSize: 13, marginTop: 0 }}>
                <strong>No projects yet.</strong>
              </p>
              <p className="subtle" style={{ fontSize: 12.5, marginBottom: 0 }}>
                Click <strong>+ New Project</strong> to scaffold one. Projects are wiki entries with
                optional workflow fields (repo link, milestones, reporting cadence) — they become
                the glue between decisions, schedules, and PRs.
              </p>
            </div>
          ) : (
            <ProjectsTable list={list} onOpen={setSelected} />
          )}
        </div>
      )}

      {selected && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div
            style={{
              padding: '12px 20px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setSelected(null)}
              title="Back to all projects"
            >
              <Icons.ChevronLeft size={12} /> All projects
            </button>
            <span className="tiny subtle">·</span>
            <code className="mono" style={{ fontSize: 11.5 }}>
              {selected}
            </code>
          </div>
          {detailLoading || !detail ? (
            <p className="subtle" style={{ padding: 18 }}>
              loading…
            </p>
          ) : (
            <ProjectDetailPane
              detail={detail}
              explicitTab={explicitTab}
              onSetTab={setTab}
              onGenerateReport={(t) => generateReport(detail.project, t ?? 'status')}
              onScheduleReport={async (cadence) => {
                const pid = detail.project.id;
                if (!pid) return;
                try {
                  const r = await fetch(
                    `/api/projects/${encodeURIComponent(pid)}/schedule-report?cadence=${cadence}`,
                    { method: 'POST' },
                  );
                  const j = (await r.json()) as {
                    ok: boolean;
                    error?: string;
                    run_id?: string;
                    runbook_id?: string;
                  };
                  if (!j.ok) {
                    alert(`Schedule failed: ${j.error ?? 'unknown error'}`);
                    return;
                  }
                  // The endpoint now dispatches meta-add-schedule async; the
                  // runbook file is created by the dispatched run, not
                  // synchronously here. useRunTerminal in the parent
                  // refetches on completion. Open the drawer so the user
                  // sees the run progress.
                  alert(
                    `Scheduling ${cadence} status report — meta-add-schedule dispatched (run ${j.run_id ?? '?'}). The runbook (${j.runbook_id ?? 'pending'}) will appear in the Schedules tab when the run completes.`,
                  );
                  setDrawerFilter({ project: pid });
                  setDrawerOpen(true);
                } catch (e) {
                  alert(`Schedule failed: ${(e as Error).message}`);
                }
              }}
              onOpenEntry={(id) => nav.navigateToEntry(id)}
              onJumpToSchedules={() => nav.setView('schedules')}
              onAddChange={() => {
                const pid = detail.project.id;
                if (pid) openAddChangeForm(pid);
              }}
              onAddSchedule={() => {
                const pid = detail.project.id;
                if (pid) openAddScheduleForm(pid);
              }}
              onRefetchDetail={async () => {
                const pid = detail.project.id;
                if (!pid) return;
                try {
                  const d = await getJson<ProjectDetail>(
                    `/api/projects/${encodeURIComponent(pid)}`,
                  );
                  setDetail(d);
                } catch {
                  /* keep prior */
                }
              }}
              onCompleteProject={async () => {
                const pid = detail.project.id;
                if (!pid) return;
                try {
                  const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/complete`, {
                    method: 'POST',
                  });
                  const j = (await r.json()) as {
                    ok: boolean;
                    error?: string;
                    completed_at?: string;
                    already_completed?: boolean;
                  };
                  if (!j.ok) {
                    alert(`Cannot complete project: ${j.error ?? 'unknown error'}`);
                    return;
                  }
                  // Refetch detail so the banner + badges reflect the new
                  // status/lifecycle_stage_derived/completed_at fields.
                  const d = await getJson<ProjectDetail>(
                    `/api/projects/${encodeURIComponent(pid)}`,
                  );
                  setDetail(d);
                } catch (e) {
                  alert(`Complete failed: ${(e as Error).message}`);
                }
              }}
              onReopenProject={async () => {
                const pid = detail.project.id;
                if (!pid) return;
                if (
                  !window.confirm(
                    `Reopen "${pid}"?\n\nstatus: completed → active, lifecycle_stage: archived → in-progress, completed_at cleared. The project will return to the Active group.`,
                  )
                ) {
                  return;
                }
                try {
                  const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/reopen`, {
                    method: 'POST',
                  });
                  const j = (await r.json()) as { ok: boolean; error?: string };
                  if (!j.ok) {
                    alert(`Cannot reopen project: ${j.error ?? 'unknown error'}`);
                    return;
                  }
                  const d = await getJson<ProjectDetail>(
                    `/api/projects/${encodeURIComponent(pid)}`,
                  );
                  setDetail(d);
                } catch (e) {
                  alert(`Reopen failed: ${(e as Error).message}`);
                }
              }}
            />
          )}
        </div>
      )}

      {addSkill && (
        <ScaffoldForm
          skill={addSkill}
          title="Add Project"
          onCancel={() => setAddSkill(null)}
          onSubmit={(prompt) => {
            setAddSkill(null);
            dispatch(prompt, 'Adding project…', 'meta-add-project');
          }}
        />
      )}

      {addChangeSkill && (
        <ScaffoldForm
          skill={addChangeSkill.skill}
          title={`Add Change to ${addChangeSkill.projectId}`}
          initialValues={{ project: addChangeSkill.projectId }}
          onCancel={() => setAddChangeSkill(null)}
          onSubmit={(prompt) => {
            const pid = addChangeSkill.projectId;
            setAddChangeSkill(null);
            dispatch(prompt, `Adding change to ${pid}…`, 'dev-add-change', pid);
          }}
        />
      )}

      {addScheduleSkill && (
        <ScaffoldForm
          skill={addScheduleSkill.skill}
          title={`Add Schedule to ${addScheduleSkill.projectId}`}
          initialValues={{
            project: addScheduleSkill.projectId,
            // meta-add-schedule requires a domain; default to meta since
            // most project-scoped schedules live under meta/runbook/.
            domain: 'meta',
          }}
          onCancel={() => setAddScheduleSkill(null)}
          onSubmit={(prompt) => {
            const pid = addScheduleSkill.projectId;
            setAddScheduleSkill(null);
            dispatch(prompt, `Adding schedule to ${pid}…`, 'meta-add-schedule', pid);
          }}
        />
      )}
    </div>
  );
}

// Full-width tabular projects list. Replaces the narrow stacked-card picker.
// Columns scan well left-to-right; click any row to open the detail.
function ProjectsTable({
  list,
  onOpen,
}: {
  list: ProjectSummary[];
  onOpen: (id: string) => void;
}) {
  return (
    <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th>Status</th>
          <th>Title</th>
          <th>Lifecycle</th>
          <th>Repos</th>
          <th>Changes</th>
          <th>Deadline</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p) => {
          const urgency = deadlineUrgency(p.deadline);
          // Prefer the derived lifecycle stage (computed server-side from
          // owned-change counts). Falls back to frontmatter when null.
          const lifecycle = p.lifecycle_stage_derived ?? p.lifecycle_stage;
          const agg = p.changes;
          const inFlight = agg ? agg.planning + agg.in_progress + agg.in_review : 0;
          const changesLabel = agg
            ? agg.total === 0
              ? '—'
              : inFlight > 0
                ? `${inFlight} in flight · ${agg.merged}/${agg.total} merged`
                : `${agg.merged}/${agg.total} merged${agg.abandoned > 0 ? ` · ${agg.abandoned} abandoned` : ''}`
            : '—';
          return (
            <tr
              key={p.path}
              onClick={() => p.id && onOpen(p.id)}
              style={{ cursor: p.id ? 'pointer' : 'default' }}
              title={p.id ?? undefined}
            >
              <td style={{ whiteSpace: 'nowrap' }}>
                {p.status && <span className={projectStatusBadge(p.status)}>{p.status}</span>}
              </td>
              <td style={{ fontWeight: 500 }}>{p.title}</td>
              <td>
                {lifecycle && (
                  <span className="badge muted" style={{ fontSize: 10.5 }}>
                    {lifecycle}
                  </span>
                )}
              </td>
              <td className="mono tiny" title={p.repos.join(', ') || undefined}>
                {p.repos.length === 0
                  ? '—'
                  : p.repos.length === 1
                    ? p.repos[0]
                    : `${p.repos[0]} +${p.repos.length - 1}`}
              </td>
              <td
                className="tiny"
                title={
                  agg
                    ? `${agg.planning} planning · ${agg.in_progress} in-progress · ${agg.in_review} in-review · ${agg.merged} merged${agg.abandoned > 0 ? ` · ${agg.abandoned} abandoned` : ''}`
                    : undefined
                }
              >
                {changesLabel}
              </td>
              <td className="tiny" title={p.deadline ?? undefined}>
                {p.deadline ? (
                  <span className={deadlineBadge(urgency)} style={{ fontSize: 10.5 }}>
                    {deadlineRelative(p.deadline)}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type ReportType = 'kickoff' | 'status' | 'wrap-up';

type ProjectTabId =
  | 'overview'
  | 'plan'
  | 'changes'
  | 'reports'
  | 'schedules'
  | 'research'
  | 'notifications'
  | 'automation'
  | 'related'
  | 'replay';

// Default tab for `/projects/<id>` (no explicit `<tab>` segment). Projects
// whose plan lifecycle hasn't progressed past in-research land on Plan;
// everything else lands on Changes.
function defaultTabFor(planStatus: string | null): ProjectTabId {
  if (planStatus == null || planStatus === 'pending' || planStatus === 'in-research') {
    return 'plan';
  }
  return 'changes';
}

function ProjectDetailPane({
  detail,
  explicitTab,
  onSetTab,
  onGenerateReport,
  onOpenEntry,
  onJumpToSchedules,
  onAddChange,
  onAddSchedule,
  onCompleteProject,
  onReopenProject,
  onScheduleReport,
  onRefetchDetail,
}: {
  detail: ProjectDetail;
  // null when the URL has no explicit `/<tab>` segment; in that case the
  // default is derived from plan_status (Plan vs Changes). Otherwise the
  // validated tab id from the URL.
  explicitTab: ProjectTabId | null;
  onSetTab: (t: ProjectTabId) => void;
  onGenerateReport: (type?: ReportType) => void;
  onOpenEntry: (id: string) => void;
  onJumpToSchedules: () => void;
  // Opens dev-add-change scaffold form with `project:` pre-filled.
  onAddChange: () => void;
  // Opens meta-add-schedule scaffold form with `project:` pre-filled.
  onAddSchedule: () => void;
  // POSTs /api/projects/:id/complete — vault-only closure transition.
  onCompleteProject: () => void;
  // POSTs /api/projects/:id/reopen — inverse transition (completed → active).
  onReopenProject: () => void;
  // POSTs /api/projects/:id/schedule-report?cadence=daily|weekly — scaffolds
  // a runbook entry for recurring status reports.
  onScheduleReport: (cadence: 'daily' | 'weekly') => void;
  // Re-pulls the project detail. Used after server-side mutations that
  // change the surface (research note added, etc.) so the UI refreshes
  // without a full page reload.
  onRefetchDetail: () => void;
}) {
  const nav = useNavigation();
  const navigate = useNavigate();
  const p = detail.project;
  const reporting = p.reporting;
  const hasReporting = reporting?.cadence && reporting.cadence !== 'none';

  // `explicitTab` is the URL-derived tab (null when the URL has no tab
  // segment). When null, fall back to a plan_status-derived default so
  // fresh projects land on Plan and worked-on projects land on Changes.
  const tab: ProjectTabId = explicitTab ?? defaultTabFor(p.plan_status);

  // Badge counts for the tab bar. Research is derived from the backlinks
  // filtered by domain (mirrors the ResearchSection filter); related is
  // total backlinks minus research (so the same entry doesn't count twice).
  const researchCount = useMemo(() => {
    let n = 0;
    for (const refs of Object.values(detail.backlinks.owned)) {
      for (const r of refs) if (r.domain === 'research') n += 1;
    }
    for (const refs of Object.values(detail.backlinks.referenced)) {
      for (const r of refs) if (r.domain === 'research') n += 1;
    }
    return n;
  }, [detail.backlinks]);
  const relatedCount = useMemo(() => {
    // Exclude what other tabs already render: research-reports go under
    // Research, changes under Changes. Related is the catch-all for
    // everything else (decisions, notes, runbooks, references, …).
    let n = 0;
    for (const [kind, refs] of Object.entries(detail.backlinks.owned)) {
      if (kind === 'change' || kind === 'research-report') continue;
      for (const r of refs) if (r.domain !== 'research') n += 1;
    }
    for (const [kind, refs] of Object.entries(detail.backlinks.referenced)) {
      if (kind === 'change' || kind === 'research-report') continue;
      for (const r of refs) if (r.domain !== 'research') n += 1;
    }
    return n;
  }, [detail.backlinks]);
  const inFlightChanges = detail.owned_changes.filter(
    (c) => c.status === 'planning' || c.status === 'in-progress' || c.status === 'in-review',
  ).length;

  const TABS: Array<{ id: ProjectTabId; label: string; badge?: React.ReactNode }> = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'plan',
      label: 'Plan',
      // Dot indicator: success when a plan-equivalent spec exists (either the
      // legacy plan_path from /plan/research OR one+ research-reports from
      // /research-write), muted otherwise. Both paths produce a spec for
      // the Plan tab to render — see decision-research-report-vs-project-plan.
      badge: (() => {
        const planLike = !!p.plan_path || detail.research_reports.length > 0;
        const title = p.plan_path
          ? `plan_status: ${p.plan_status ?? 'pending'}`
          : detail.research_reports.length > 0
            ? `research-driven: ${detail.research_reports.length} report(s)`
            : 'no plan yet';
        return (
          <span className={planLike ? 'count' : 'count muted'} title={title}>
            {planLike ? '●' : '○'}
          </span>
        );
      })(),
    },
    {
      id: 'changes',
      label: 'Changes',
      badge:
        detail.owned_changes.length > 0 ? (
          <span className="count" title={`${inFlightChanges} in flight`}>
            {detail.owned_changes.length}
          </span>
        ) : undefined,
    },
    {
      id: 'reports',
      label: 'Reports',
      badge:
        detail.status_reports.length > 0 ? (
          <span className="count">{detail.status_reports.length}</span>
        ) : undefined,
    },
    {
      id: 'schedules',
      label: 'Schedules',
      badge:
        detail.schedules.length > 0 ? (
          <span className="count">{detail.schedules.length}</span>
        ) : undefined,
    },
    {
      id: 'research',
      label: 'Research',
      badge: researchCount > 0 ? <span className="count">{researchCount}</span> : undefined,
    },
    {
      id: 'notifications',
      label: 'Notifications',
    },
    {
      id: 'automation',
      label: 'Automation',
      // Status dot reflects the live automation phase so the user can see at
      // a glance whether automation is idle / running / paused without
      // opening the tab. Filled accent dot when running, muted otherwise.
      badge: (() => {
        const phase = p.automation?.state.phase ?? 'idle';
        const enabled = p.automation?.enabled === true;
        if (!enabled) return undefined;
        const cls =
          phase === 'running'
            ? 'count'
            : phase === 'paused' || phase === 'failed'
              ? 'count'
              : 'count muted';
        const title = `automation ${phase}`;
        return (
          <span className={cls} title={title}>
            {phase === 'running' ? '●' : phase === 'paused' ? '◐' : phase === 'failed' ? '⊗' : '○'}
          </span>
        );
      })(),
    },
    {
      id: 'related',
      label: 'Related',
      badge: relatedCount > 0 ? <span className="count">{relatedCount}</span> : undefined,
    },
    { id: 'replay', label: 'Replay' },
  ];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{p.title}</h2>
        {p.status && <span className={projectStatusBadge(p.status)}>{p.status}</span>}
        {(p.lifecycle_stage_derived ?? p.lifecycle_stage) && (
          <span
            className="badge muted"
            title={
              p.lifecycle_stage_derived && p.lifecycle_stage_derived !== p.lifecycle_stage
                ? `Derived from owned-change counts. Frontmatter has "${p.lifecycle_stage ?? '—'}" but live data says "${p.lifecycle_stage_derived}".`
                : 'Lifecycle stage from project frontmatter.'
            }
          >
            {p.lifecycle_stage_derived ?? p.lifecycle_stage}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onAddChange}
          disabled={p.status === 'completed'}
          title={
            p.status === 'completed'
              ? 'Project is completed — click Reopen on the status banner to add more changes.'
              : 'Scaffold a new change under this project. The project field is pre-filled; you choose repo, title, type, size, and description in the form.'
          }
        >
          <Icons.Plus size={11} /> Add change
        </button>
      </header>

      <ProjectStateBanner
        project={p}
        researchUpdatesPending={detail.research_reports.filter((r) => r.has_updates_pending).length}
        onGenerateReport={onGenerateReport}
        onCompleteProject={onCompleteProject}
        onReopenProject={onReopenProject}
        onViewResearch={() => {
          navigate(`/research?project=${encodeURIComponent(p.id ?? '')}`);
        }}
      />

      <ProjectRollupStrip rollup={detail.rollup} />

      <div
        className="tabs"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border)',
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => onSetTab(t.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <ProjectQuickStats detail={detail} />

          <ProjectPhaseTimeline project={p} />

          {/* Mirrored from the Changes tab — surfaces the per-stage change
              distribution on Overview too, so the user sees lifecycle health
              without navigating away. Auto-updates as changes progress
              (same data source as the Changes-tab instance). */}
          {detail.owned_changes.length > 0 && (
            <ChangesLifecycleStepper changes={detail.owned_changes} />
          )}

          {/* Project Pulse — derived metrics from events.db rollup +
              owned_changes + manifest. Distinct from About-this-project
              (human charter) and ChangesLifecycleStepper (per-change state):
              this card aggregates ops data into health/velocity signals.
              First instance of the self-improvement loop's visible surface
              (Task #425). */}
          {detail.owned_changes.length > 0 && (
            <ProjectPulseCard
              projectId={detail.project.id ?? ''}
              ownedChanges={detail.owned_changes}
              rollup={detail.rollup}
              researchReports={detail.research_reports}
            />
          )}

          <ApprovedResearchCard reports={detail.research_reports} onOpenEntry={onOpenEntry} />
          {detail.body && <ProjectDescriptionCard path={detail.project.path} body={detail.body} />}

          {detail.status_reports.length > 0 && (
            <LatestStatusReportCard
              report={detail.status_reports[0]}
              onOpen={() => {
                // status reports live under vault/output, not vault/wiki —
                // open the file via the entry endpoint by path stem.
                onSetTab('reports');
              }}
            />
          )}

          <ProjectRecentActivity projectId={p.id as string} onOpenEntry={onOpenEntry} />

          <div
            className="card"
            style={{
              padding: 16,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}
          >
            {p.domain && (
              <MetaItem label="Domain">
                <span style={{ fontSize: 12.5 }}>{p.domain}</span>
              </MetaItem>
            )}
            {p.repos.length > 0 && (
              <MetaItem label={`Repos (${p.repos.length})`}>
                <span style={{ fontSize: 12.5 }}>
                  {p.repos.map((r, i) => (
                    <React.Fragment key={r}>
                      <button
                        type="button"
                        className="link-inline"
                        onClick={() => onOpenEntry(r)}
                        style={linkStyle}
                      >
                        {r}
                      </button>
                      {i < p.repos.length - 1 && <span className="subtle">, </span>}
                    </React.Fragment>
                  ))}
                </span>
              </MetaItem>
            )}
            {p.deadline && (
              <MetaItem label="Deadline">
                <span style={{ fontSize: 12.5 }}>
                  {p.deadline} <span className="subtle">({deadlineRelative(p.deadline)})</span>
                </span>
              </MetaItem>
            )}
            {p.stakeholders.length > 0 && (
              <MetaItem label="Stakeholders">
                <span style={{ fontSize: 12.5 }}>{p.stakeholders.join(', ')}</span>
              </MetaItem>
            )}
          </div>

          {p.milestones.length > 0 && (
            <Section title="Milestones">
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {p.milestones.map((m, i) => {
                  const done = m.status === 'done';
                  return (
                    <li
                      key={`${m.date ?? 'no-date'}-${i}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '6px 10px',
                        fontSize: 13,
                        opacity: done ? 0.6 : 1,
                        textDecoration: done ? 'line-through' : 'none',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 16,
                          textAlign: 'center',
                          color: done ? 'var(--success-text)' : 'var(--text-3)',
                        }}
                      >
                        {done ? '✓' : '○'}
                      </span>
                      <span style={{ flex: 1 }}>{m.label}</span>
                      {m.date && <span className="tiny mono">{m.date}</span>}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </>
      )}

      {tab === 'plan' && (
        <ProjectPlanTab
          project={p}
          researchReports={detail.research_reports}
          currentCostUsd={detail.rollup?.cost_usd ?? 0}
          onSetTab={onSetTab}
          onRefetchDetail={onRefetchDetail}
        />
      )}

      {tab === 'changes' && (
        <Section
          title={`Changes (${detail.owned_changes.length})`}
          action={
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={onAddChange}
                title="Scaffold a new change under this project (project field is pre-filled)."
              >
                <Icons.Plus size={11} /> Add change
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => nav.setView('changes')}
                title="Open the Changes app"
              >
                All changes →
              </button>
            </div>
          }
        >
          {/* Distribution view across the change lifecycle. Expands the
              plan-lifecycle's compressed `active` cell into where each
              individual change actually sits today. */}
          {detail.owned_changes.length > 0 && (
            <ChangesLifecycleStepper changes={detail.owned_changes} />
          )}
          {detail.owned_changes.length === 0 ? (
            <p className="subtle" style={{ margin: 0, fontSize: 12.5, padding: '6px 0 4px' }}>
              No changes scoped to this project yet. Click <strong>Add change</strong> to scaffold
              the first one. The project will be linked automatically.
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {detail.owned_changes.map((ch, i, arr) => {
                // Insert a small divider when transitioning from in-flight
                // status (planning / in-progress / in-review) to terminal
                // status (merged / abandoned). The server sorts terminal
                // after in-flight, so the boundary is a clean cut.
                const IN_FLIGHT = new Set(['planning', 'in-progress', 'in-review']);
                const prev = arr[i - 1];
                const isFirstTerminal =
                  i > 0 &&
                  prev &&
                  ch.status &&
                  !IN_FLIGHT.has(ch.status) &&
                  prev.status &&
                  IN_FLIGHT.has(prev.status);
                return (
                  <React.Fragment key={ch.path}>
                    {isFirstTerminal && (
                      <li
                        aria-hidden="true"
                        style={{
                          listStyle: 'none',
                          padding: '8px 12px',
                          fontSize: 10.5,
                          color: 'var(--text-3)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.6,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                        }}
                      >
                        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                        <span>Terminal</span>
                        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                      </li>
                    )}
                    <li>
                      <button
                        type="button"
                        // Primary click → Changes app's detail page. Most users want
                        // the rich lifecycle view (PR card, plan/review tabs, etc.),
                        // not the raw vault markdown. The vault-entry path stays
                        // reachable via the small "vault" link at the end of the row.
                        onClick={() => navigate(`/changes/${ch.id}`)}
                        title={`Open ${ch.id} in the Changes app`}
                        style={{
                          width: '100%',
                          background: 'none',
                          border: 'none',
                          padding: '8px 12px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          color: 'var(--text)',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--bg-2)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        {ch.derived_from_report && (
                          <span
                            title={`Scaffolded from research report ${ch.derived_from_report}`}
                            style={{ color: 'var(--accent-text)', display: 'inline-flex' }}
                          >
                            <Icons.Lightbulb size={13} />
                          </span>
                        )}
                        {ch.derived_from_report &&
                          ch.recommendation_index != null &&
                          ch.recommendations_total != null && (
                            <code
                              className="mono"
                              style={{
                                color: 'var(--accent-text)',
                                fontSize: 11,
                                fontWeight: 500,
                              }}
                              title={`Step ${ch.recommendation_index + 1} of ${ch.recommendations_total} from ${ch.derived_from_report}`}
                            >
                              [{ch.recommendation_index + 1}/{ch.recommendations_total}]
                            </code>
                          )}
                        <strong style={{ flex: 1, fontSize: 13 }}>{ch.title}</strong>
                        {ch.status && (
                          <span className={changeStatusBadge(ch.status)}>{ch.status}</span>
                        )}
                        {ch.repo && (
                          <span className="mono tiny" title={`repo: ${ch.repo}`}>
                            {ch.repo}
                          </span>
                        )}
                        {ch.pr_url && (
                          <a
                            href={ch.pr_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open PR on GitHub"
                            style={{
                              fontSize: 11.5,
                              color: 'var(--accent)',
                              padding: '2px 6px',
                              border: '1px solid var(--border)',
                              borderRadius: 4,
                            }}
                          >
                            PR
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenEntry(ch.id);
                          }}
                          title="Open the raw vault entry (markdown)"
                          style={{
                            fontSize: 11.5,
                            color: 'var(--muted)',
                            padding: '2px 6px',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            background: 'transparent',
                            cursor: 'pointer',
                          }}
                        >
                          vault
                        </button>
                      </button>
                    </li>
                  </React.Fragment>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      {tab === 'reports' && (
        <>
          {/* Generate-on-demand buttons — always available regardless of
           * configured cadence. Three report variants from the same skill:
           * kickoff (forward-looking, project start), status (running update),
           * wrap-up (retrospective, before completing). Filename is type-
           * prefixed so a project can carry one of each per day. */}
          <Section
            title="Generate report"
            action={
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onGenerateReport('kickoff')}
                  disabled={!p.id}
                  title="Forward-looking report — intent, plan, milestones. Use at project start."
                >
                  Kickoff
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onGenerateReport('status')}
                  disabled={!p.id}
                  title="Default running report — recent activity, owned changes, next steps. Use anytime."
                >
                  Status report
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onGenerateReport('wrap-up')}
                  disabled={!p.id}
                  title="Retrospective — what shipped, lessons learned, total cost. Use before completing the project."
                >
                  Wrap-up
                </button>
              </div>
            }
          >
            <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
              Each click dispatches <code>meta-status-report</code> and writes a type-prefixed
              markdown file under <code>vault/output/&lt;domain&gt;/status-reports/</code>. One
              report per type per day; previous reports of the same type aren't overwritten.
            </p>
          </Section>

          {/* Schedule auto-firing of status reports on a daily or weekly
           * cadence. Each click scaffolds a runbook entry tied to this
           * project; the scheduler-tick fires it on cron. 409 if a runbook
           * for the same (project, cadence) already exists — user edits
           * via the Schedules tab. */}
          <Section
            title="Auto-schedule"
            action={
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onScheduleReport('daily')}
                  disabled={!p.id}
                  title="Scaffold a runbook that fires a status report every day at 09:00 local time. Manage via Schedules tab."
                >
                  <Icons.Clock size={11} /> Schedule daily
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onScheduleReport('weekly')}
                  disabled={!p.id}
                  title="Scaffold a runbook that fires a status report every Monday at 09:00 local time."
                >
                  <Icons.Clock size={11} /> Schedule weekly
                </button>
              </div>
            }
          >
            <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
              Each click creates a <code>runbook</code> entry tied to this project; the scheduler
              tick fires <code>meta-status-report</code> on the cadence. See the{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => onSetTab('schedules')}
                style={{ padding: 0, display: 'inline' }}
              >
                Schedules tab
              </button>{' '}
              to edit or remove.
            </p>
          </Section>

          {hasReporting && reporting && (
            <Section title="Reporting cadence">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: 14,
                }}
              >
                <MetaItem label="Cadence">
                  <span style={{ fontSize: 12.5 }}>{reporting.cadence}</span>
                </MetaItem>
                <MetaItem label="Target">
                  <span style={{ fontSize: 12.5 }}>
                    {reporting.target}
                    {reporting.target_ref && (
                      <code className="mono" style={{ marginLeft: 6, fontSize: 11.5 }}>
                        {reporting.target_ref}
                      </code>
                    )}
                  </span>
                </MetaItem>
                <MetaItem label="Last sent">
                  {reporting.last_sent ? (
                    <span title={formatLocal(reporting.last_sent)} style={{ fontSize: 12.5 }}>
                      {formatRelative(reporting.last_sent)}
                    </span>
                  ) : (
                    <span className="subtle" style={{ fontSize: 12.5 }}>
                      never
                    </span>
                  )}
                </MetaItem>
                <MetaItem label="Next due">
                  {reporting.next_due ? (
                    <span style={{ fontSize: 12.5 }}>{reporting.next_due}</span>
                  ) : (
                    <span className="subtle" style={{ fontSize: 12.5 }}>
                      —
                    </span>
                  )}
                </MetaItem>
              </div>
            </Section>
          )}

          {/* Reports listing — grouped by kind, newest-first within each
           * group. Sections collapse to nothing when empty so the page stays
           * tight on projects that only ever produce status reports. */}
          {(() => {
            const all = detail.status_reports;
            if (all.length === 0) {
              return (
                <Section title="Reports">
                  <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
                    No reports yet. Use the buttons above to generate one.
                  </p>
                </Section>
              );
            }
            const byKind: Record<string, StatusReportRef[]> = {
              kickoff: [],
              status: [],
              'wrap-up': [],
              other: [],
            };
            for (const r of all) {
              const k = r.kind ?? 'other';
              (byKind[k] ?? byKind.other).push(r);
            }
            const sortNewestFirst = (arr: StatusReportRef[]) =>
              [...arr].sort((a, b) => b.mtime.localeCompare(a.mtime));
            const groups: Array<{ kind: string; title: string; reports: StatusReportRef[] }> = [
              { kind: 'kickoff', title: 'Kickoff', reports: sortNewestFirst(byKind.kickoff) },
              { kind: 'status', title: 'Status', reports: sortNewestFirst(byKind.status) },
              { kind: 'wrap-up', title: 'Wrap-up', reports: sortNewestFirst(byKind['wrap-up']) },
              { kind: 'other', title: 'Other', reports: sortNewestFirst(byKind.other) },
            ];
            return (
              <>
                {groups
                  .filter((g) => g.reports.length > 0)
                  .map((g) => (
                    <Section key={g.kind} title={`${g.title} (${g.reports.length})`}>
                      <ul
                        style={{
                          listStyle: 'none',
                          padding: 0,
                          margin: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        {g.reports.map((r, i) => (
                          <li key={r.path}>
                            <StatusReportRow report={r} defaultOpen={i === 0} />
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ))}
              </>
            );
          })()}
        </>
      )}

      {tab === 'schedules' && (
        <ProjectSchedulesSection
          projectId={p.id ?? ''}
          schedules={detail.schedules}
          onJumpToSchedules={onJumpToSchedules}
          onAddSchedule={onAddSchedule}
        />
      )}

      {tab === 'research' && (
        <ResearchSection
          projectId={p.id ?? ''}
          researchReports={detail.research_reports}
          owned={detail.backlinks.owned}
          referenced={detail.backlinks.referenced}
          onOpenEntry={onOpenEntry}
          onOpenReport={(id) => navigate(`/research/${id}`)}
          onChanged={onRefetchDetail}
        />
      )}

      {tab === 'notifications' && (
        <ProjectNotificationsTab
          projectId={p.id ?? ''}
          onOpenRule={(id) => navigate(`/notifications/rules/${encodeURIComponent(id)}`)}
          onAddRule={() =>
            navigate(`/notifications/rules/new?filter_project=${encodeURIComponent(p.id ?? '')}`)
          }
        />
      )}

      {tab === 'related' && (
        <>
          <BacklinkSection
            title="Owned by this project"
            emptyHint={
              <>
                No entries owned by this project yet. Decisions/notes captured under this project's
                work should set <code className="mono">project: {p.id}</code> in their frontmatter —
                they appear here automatically.
              </>
            }
            groups={excludeOwnTabKinds(detail.backlinks.owned)}
            onOpenEntry={onOpenEntry}
          />
          <BacklinkSection
            title="Referenced from elsewhere"
            emptyHint={
              <>
                No external references yet. Other entries can link to this project via{' '}
                <code className="mono">[[{p.id}]]</code> in their body — they appear here
                automatically.
              </>
            }
            groups={excludeOwnTabKinds(detail.backlinks.referenced)}
            onOpenEntry={onOpenEntry}
          />
        </>
      )}

      {tab === 'automation' && (
        <ProjectAutomationTab
          projectId={p.id ?? ''}
          ownedChanges={detail.owned_changes}
          onRefetchDetail={onRefetchDetail}
          onOpenChange={onOpenEntry}
        />
      )}

      {tab === 'replay' && <ProjectReplaySection projectId={p.id ?? ''} />}
    </div>
  );
}

// Notifications tab body — lists notification rules scoped to this project
// (filter.project === projectId) plus a quick "+ Add rule for this project"
// affordance that hops to the global RuleEditor with filter_project pre-filled.
// Cross-project rules and global rules don't appear here — the global Matrix
// at /notifications/rules is the canonical surface for those.
function ProjectNotificationsTab({
  projectId,
  onOpenRule,
  onAddRule,
}: {
  projectId: string;
  onOpenRule: (id: string) => void;
  onAddRule: () => void;
}) {
  const [rules, setRules] = useState<RuleListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRules()
      .then((r) => {
        if (cancelled) return;
        setRules(r.rules.filter((rule) => rule.filter?.project === projectId));
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>
          Notifications scoped to <code className="mono">{projectId}</code>
        </h3>
        <button type="button" className="btn btn-sm" onClick={onAddRule}>
          <Icons.Plus size={11} /> Add rule for this project
        </button>
      </div>
      <p className="tiny subtle" style={{ margin: 0 }}>
        Rules with <code>filter.project = {projectId}</code>. Global rules (no project filter) also
        fire for events tagged to this project — see the full Matrix at{' '}
        <code>/notifications/rules</code>.
      </p>

      {error && (
        <div
          className="card"
          style={{ padding: 12, color: 'var(--danger-text)', borderColor: 'var(--danger-border)' }}
        >
          Failed to load rules: {error}
        </div>
      )}

      {rules == null && !error && <p className="subtle">Loading rules…</p>}

      {rules && rules.length === 0 && !error && (
        <div className="card" style={{ padding: 16 }}>
          <p className="subtle" style={{ margin: 0 }}>
            No project-scoped notification rules yet. Click{' '}
            <strong>Add rule for this project</strong> to scaffold one with{' '}
            <code>filter.project</code> pre-filled.
          </p>
        </div>
      )}

      {rules && rules.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Title</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Event</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Channel</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Recipient</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onOpenRule(r.id)}
                      style={{ padding: 0, textAlign: 'left' }}
                    >
                      {r.title}
                    </button>
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <code className="tiny">{r.event_type}</code>
                  </td>
                  <td style={{ padding: '8px 12px' }}>{r.channel}</td>
                  <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-2)' }}>
                    {recipientLabel(r)}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 12 }}>
                    {r.enabled ? (
                      <span style={{ color: 'var(--success-text)' }}>enabled</span>
                    ) : (
                      <span className="subtle">disabled</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function recipientLabel(r: RuleListItem): string {
  if (r.channel === 'slack') {
    // Show what the rule actually specifies. The active transport (bot-token
    // vs webhook) determines whether this value is honored at delivery time:
    // bot-token routes per-rule; webhook delivers to the webhook's bound
    // channel regardless. Server mode shown on the Rule Editor; this column
    // is the rule's intent.
    const ch = (r.delivery.slack_channel ?? '').trim();
    return ch ? `slack: ${ch}` : 'slack';
  }
  if (r.channel === 'email') {
    const to = r.delivery.to;
    if (Array.isArray(to) && to.length > 0) return to.join(', ');
    return 'email (no recipients)';
  }
  if (r.channel === 'desktop') {
    return r.delivery.urgency ? `desktop (${r.delivery.urgency})` : 'desktop';
  }
  return r.channel;
}

// Format a date-range to "Apr 1 – Apr 7, 2026" style for the report row.
// Handles partial info (start-only / end-only). Uses local timezone since
// these are user-facing date labels, not machine timestamps.
function formatTimeframe(start: string | null, end: string | null): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  if (start && end) return `Covers ${fmt(start)} – ${fmt(end)}`;
  if (start) return `Since ${fmt(start)}`;
  if (end) return `Through ${fmt(end)}`;
  return '';
}

// Status report row — expandable card that fetches the file on first open
// and renders the markdown inline. Newest report is auto-opened by the
// list above (defaultOpen=true) so the latest wrap-up is one click away.
function StatusReportRow({
  report,
  defaultOpen,
}: {
  report: StatusReportRef;
  defaultOpen: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(defaultOpen);
  const [content, setContent] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy fetch — only on first open. Avoids paying for the read when the
  // list is long and the user only cares about the newest.
  useEffect(() => {
    if (!open || content != null || error != null) return;
    let cancelled = false;
    fetchEntry(report.path)
      .then((e) => {
        if (!cancelled) setContent(e.content);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, content, error, report.path]);

  return (
    <div className="card" style={{ padding: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="card-header"
        style={{
          background: 'transparent',
          border: 0,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          color: 'inherit',
          padding: '10px 14px',
        }}
        title={open ? 'Hide report content' : 'Show report content'}
      >
        {open ? (
          <Icons.ChevronDown size={13} style={{ color: 'var(--muted)' }} />
        ) : (
          <Icons.ChevronRight size={13} style={{ color: 'var(--muted)' }} />
        )}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <code className="mono" style={{ fontSize: 11.5 }}>
            {report.name}
          </code>
          {(report.timeframe_start || report.timeframe_end) && (
            <span className="tiny subtle">
              {formatTimeframe(report.timeframe_start, report.timeframe_end)}
            </span>
          )}
        </div>
        <span className="tiny" title={formatLocal(report.mtime)}>
          {formatRelative(report.mtime)}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div
            style={{
              padding: '6px 14px',
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-2)',
            }}
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setShowRaw((s) => !s)}
              title={
                showRaw
                  ? 'Show the markdown-rendered view'
                  : 'Show the raw markdown source (toggle for copy/paste)'
              }
            >
              {showRaw ? 'Rendered' : 'Raw'}
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const slug = report.path.replace(/^vault\/output\//, '');
                navigate(`/vault/output/${slug}`);
              }}
              title="Open this file in the Vault app's Output tab (deep link)."
            >
              <Icons.External size={11} /> Open in Vault
            </button>
          </div>
          <div style={{ padding: '8px 16px 14px', maxHeight: 560, overflow: 'auto' }}>
            {error && (
              <p className="tiny" style={{ color: 'var(--danger-text)', margin: 0 }}>
                Failed to load: {error}
              </p>
            )}
            {!content && !error && (
              <p className="subtle tiny" style={{ margin: 0 }}>
                Loading…
              </p>
            )}
            {content &&
              (showRaw ? (
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    fontSize: 12,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--text-2)',
                  }}
                >
                  {content}
                </pre>
              ) : (
                <Rendered content={content} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// State-aware banner — mirrors the change-detail primary-action area.
// Reads the project's status + change roll-up + derived lifecycle stage
// and surfaces the obvious next move. Hidden when the project has no
// changes yet (the empty state in the Changes section is enough).
// Compact rollup strip — total cost / wall-time / run-count across every
// billable event tagged to this project or its owned changes. Hides when
// nothing's been spent yet. Hover tooltip carries the per-skill breakdown.
function ProjectRollupStrip({
  rollup,
}: {
  rollup: ProjectDetail['rollup'];
}) {
  if (!rollup || rollup.ai_prompt_runs === 0) return null;
  const minutes = Math.round(rollup.duration_ms / 60000);
  const breakdown = rollup.by_skill
    .map(
      (s) =>
        `${s.skill}: ${s.count} run${s.count !== 1 ? 's' : ''} · $${s.cost_usd.toFixed(4)} · ${Math.round(s.duration_ms / 1000)}s`,
    )
    .join('\n');
  return (
    <section
      className="card"
      style={{
        padding: '10px 14px',
        display: 'flex',
        gap: 18,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 12.5,
      }}
      title={`Per-skill breakdown:\n${breakdown}`}
    >
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Icons.Sparkles size={12} style={{ color: 'var(--muted)' }} />
        <strong>${rollup.cost_usd.toFixed(2)}</strong>
        <span className="subtle tiny">total cost</span>
      </span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Icons.Clock size={12} style={{ color: 'var(--muted)' }} />
        <strong>{minutes}m</strong>
        <span className="subtle tiny">wall-time</span>
      </span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Icons.Activity size={12} style={{ color: 'var(--muted)' }} />
        <strong>{rollup.ai_prompt_runs}</strong>
        <span className="subtle tiny">
          run{rollup.ai_prompt_runs !== 1 ? 's' : ''} across {rollup.skill_count} skill
          {rollup.skill_count !== 1 ? 's' : ''}
        </span>
      </span>
      {rollup.failed_runs > 0 && (
        <span
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            color: 'var(--warn-text)',
          }}
        >
          <Icons.AlertTriangle size={12} />
          <strong>{rollup.failed_runs}</strong>
          <span className="tiny">failed</span>
        </span>
      )}
      <span className="spacer" />
      <span className="tiny subtle">hover for per-skill breakdown</span>
    </section>
  );
}

function ProjectStateBanner({
  project,
  researchUpdatesPending,
  onGenerateReport,
  onCompleteProject,
  onReopenProject,
  onViewResearch,
}: {
  project: ProjectSummary;
  researchUpdatesPending: number;
  onGenerateReport: (type?: ReportType) => void;
  onCompleteProject: () => void;
  onReopenProject: () => void;
  onViewResearch: () => void;
}) {
  const agg = project.changes;
  // Project-scoped dispatching — true when at least one queued/running run is
  // tagged to this project. Drives the disabled state + "Working…" label on
  // the wrap-up action buttons so double-clicks don't fire duplicate runs.
  const { runs } = useDispatch();
  const dispatching = runs.some(
    (r) => r.project === project.id && (r.state === 'queued' || r.state === 'running'),
  );

  // Non-terminal: research reports under this project have pending update
  // triggers. Surfaces above the tabbar so it's visible from every tab.
  // Shown alongside (not in place of) the change-progress banner below.
  const researchBanner =
    researchUpdatesPending > 0 ? (
      <div
        className="card"
        style={{
          padding: '10px 14px',
          background: 'var(--warning-soft, rgba(190, 130, 30, 0.08))',
          border: '1px solid var(--warning-border, var(--warning-text))',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <Icons.Sparkles size={14} style={{ color: 'var(--warning-text)', flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 12.5, color: 'var(--warning-text)' }}>
          <strong>
            {researchUpdatesPending} research report{researchUpdatesPending === 1 ? '' : 's'}
          </strong>{' '}
          suggest{researchUpdatesPending === 1 ? 's' : ''} updates — new materials, milestones, or
          merged changes since the last run.
        </span>
        <button type="button" className="btn btn-sm" onClick={onViewResearch}>
          <Icons.Eye size={11} /> View research
        </button>
      </div>
    ) : null;

  if (!agg || agg.total === 0) {
    return researchBanner;
  }

  // Terminal: project is completed. Green confirmation + Reopen escape hatch
  // for when a post-Complete gap surfaces and the project needs to absorb
  // additional work.
  if (project.status === 'completed') {
    return (
      <>
        {researchBanner}
        <div
          className="card"
          style={{
            padding: '12px 16px',
            background: 'var(--success-soft, rgba(60, 160, 90, 0.08))',
            border: '1px solid var(--success-border, var(--success-text))',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <Icons.Check size={14} style={{ color: 'var(--success-text)' }} />
          <span style={{ fontSize: 13, color: 'var(--success-text)', fontWeight: 500 }}>
            Project completed.
          </span>
          <span className="tiny subtle" style={{ flex: 1 }}>
            {agg.merged} change{agg.merged !== 1 ? 's' : ''} shipped
            {agg.abandoned > 0 && `, ${agg.abandoned} abandoned`}.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onReopenProject}
            title="Vault-only transition: status: completed → active, lifecycle_stage → in-progress, clears completed_at. Use when a follow-up gap surfaces and you need to scaffold more changes under this project."
          >
            <Icons.Refresh size={11} /> Reopen
          </button>
        </div>
      </>
    );
  }

  const inFlight = agg.planning + agg.in_progress + agg.in_review;
  const allTerminal = inFlight === 0 && agg.total > 0;

  if (allTerminal) {
    // All changes are terminal but project status hasn't transitioned —
    // the canonical "wrap it up" moment.
    return (
      <>
        {researchBanner}
        <div
          className="card"
          style={{
            padding: '12px 14px',
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent-border)',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Icons.Sparkles size={14} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, minWidth: 240 }}>
            <strong>
              All {agg.total} change{agg.total !== 1 ? 's' : ''} terminal
            </strong>
            {agg.merged > 0 && ` — ${agg.merged} shipped`}
            {agg.abandoned > 0 && `${agg.merged > 0 ? ', ' : ' — '}${agg.abandoned} abandoned`}.
            Wrap up the project: generate a final status report, then mark complete.
            {dispatching && (
              <span className="subtle" style={{ marginLeft: 8, fontStyle: 'italic' }}>
                · dispatching…
              </span>
            )}
          </span>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onGenerateReport('wrap-up')}
              disabled={dispatching}
              title={
                dispatching
                  ? 'Disabled — another skill run is in flight for this project. Wait for it to finish.'
                  : "Runs meta-status-report with report_type: wrap-up — retrospective covering every owned change (merged + abandoned), total cost, what worked / didn't, follow-ups. Recommended before completing the project so the audit trail captures the closing artifact."
              }
            >
              <Icons.Sparkles size={11} /> {dispatching ? 'Working…' : 'Generate wrap-up report'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onCompleteProject}
              disabled={dispatching}
              title={
                dispatching
                  ? 'Disabled — generate the wrap-up report first so the closure has an artifact, or wait for the in-flight run to finish.'
                  : 'Vault-only transition: status: active → completed, lifecycle_stage → archived, stamps completed_at. Refuses if any owned change is still in-flight (the gate already passed since all your changes are terminal). NO GitHub side-effects.'
              }
            >
              <Icons.Check size={11} /> Complete project
            </button>
          </div>
        </div>
      </>
    );
  }

  // Mixed state — work in flight. Brief progress signal without a hard CTA.
  const pct = agg.total > 0 ? Math.round((agg.merged / agg.total) * 100) : 0;
  return (
    <>
      {researchBanner}
      <div
        className="card"
        style={{
          padding: '10px 14px',
          background: 'var(--bg-2)',
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          fontSize: 12.5,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ color: 'var(--text-2)' }}>
          <strong>
            {agg.merged} / {agg.total}
          </strong>{' '}
          shipped ({pct}%).
        </span>
        <span className="tiny subtle">
          {agg.in_review > 0 && `${agg.in_review} in review · `}
          {agg.in_progress > 0 && `${agg.in_progress} in progress · `}
          {agg.planning > 0 && `${agg.planning} planning · `}
          {agg.abandoned > 0 && `${agg.abandoned} abandoned`}
        </span>
      </div>
    </>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h4>
        {action}
      </div>
      <div style={{ padding: '12px 16px' }}>{children}</div>
    </section>
  );
}

// Project Replay — collapsible autobiography of the project. Default
// collapsed; expands to lazily fetch /api/projects/:id/replay and render
// a chronological timeline of change-state markers + events + commits.
// Mirrors the change Replay tab visually so the same patterns are reused.
interface ProjectReplayResponse {
  ok: true;
  project_id: string;
  rollup: {
    cost_usd: number;
    duration_ms: number;
    skill_count: number;
    by_skill: Array<{ skill: string; count: number; cost_usd: number; duration_ms: number }>;
    ai_prompt_runs: number;
    failed_runs: number;
  };
  owned_change_count: number;
  change_markers: Array<{
    ts: string;
    change_id: string;
    change_title: string;
    kind: 'scaffolded' | 'merged' | 'abandoned';
  }>;
  commits: Array<{
    sha: string;
    short_sha: string;
    subject: string;
    author: string;
    ts: string;
    body: string;
    change_id: string;
    repo: string | null;
  }>;
  timeline: Array<
    | {
        ts: string;
        kind: 'change-marker';
        change_marker: {
          ts: string;
          change_id: string;
          change_title: string;
          kind: 'scaffolded' | 'merged' | 'abandoned';
        };
      }
    | {
        ts: string;
        kind: 'event';
        event: {
          id: number;
          action: string | null;
          skill: string | null;
          duration_ms: number | null;
          exit_status: string | null;
          cost_usd: number | null;
          change_id: string | null;
          run_id: string | null;
        };
      }
    | {
        ts: string;
        kind: 'commit';
        commit: {
          sha: string;
          short_sha: string;
          subject: string;
          author: string;
          ts: string;
          body: string;
          change_id: string;
          repo: string | null;
        };
      }
  >;
}

// Automation tab body — Phase 4. Filtered view over owned changes' per-change
// automation. Source of truth is the change entry's `automation:` block; this
// tab renders a list with inline controls + bulk actions across the project.
// All mutations go through `/api/changes/:id/automation/*` (the Phase 2
// endpoints). The legacy project-level `/api/projects/:id/automation/*`
// endpoints still exist for backward compat but are no longer surfaced here.
function ProjectAutomationTab({
  projectId,
  ownedChanges,
  onRefetchDetail,
  onOpenChange,
}: {
  projectId: string;
  ownedChanges: OwnedChangeRef[];
  onRefetchDetail: () => void;
  onOpenChange: (id: string) => void;
}) {
  const [busyChange, setBusyChange] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-change endpoint helper. Refetches the project detail on success so
  // the table reflects the new automation state (owned_changes carries the
  // automation block).
  const callChange = useCallback(
    async (changeId: string, suffix: string, body: Record<string, unknown> = {}) => {
      setBusyChange(`${changeId}:${suffix}`);
      setError(null);
      try {
        const r = await fetch(`/api/changes/${encodeURIComponent(changeId)}/automation/${suffix}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = (await r.json()) as { ok?: boolean; error?: string };
        if (!r.ok || j.ok === false) {
          setError(j.error ?? `HTTP ${r.status}`);
        }
        onRefetchDetail();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyChange(null);
      }
    },
    [onRefetchDetail],
  );

  // Eligibility for automation: change has been plan-approved AND isn't
  // already in a terminal state. Used to filter bulk actions + to decide
  // whether a row shows action buttons.
  function isEligible(c: OwnedChangeRef): boolean {
    if (c.status === 'merged' || c.status === 'abandoned') return false;
    return (
      c.review_status === 'approved' ||
      c.review_status === 'not-required' ||
      c.review_status === 'overridden'
    );
  }

  const eligibleChanges = useMemo(() => ownedChanges.filter(isEligible), [ownedChanges]);
  const automatedChanges = useMemo(
    () => ownedChanges.filter((c) => c.automation?.enabled === true),
    [ownedChanges],
  );
  const runningCount = automatedChanges.filter(
    (c) => c.automation?.state.phase === 'running',
  ).length;
  const pausedCount = automatedChanges.filter((c) => c.automation?.state.phase === 'paused').length;
  const completeCount = automatedChanges.filter(
    (c) => c.automation?.state.phase === 'complete',
  ).length;

  // Bulk: enable every eligible change that doesn't already have automation
  // configured. Helpful when scaffolding a fresh project to opt all approved
  // changes into automation in one click.
  async function bulkEnableEligible() {
    const targets = eligibleChanges.filter((c) => c.automation?.enabled !== true);
    for (const c of targets) {
      await callChange(c.id, 'enable');
    }
  }

  // Bulk: pause every change that's actively running. Doesn't touch changes
  // that are idle/paused/complete.
  async function bulkPauseRunning() {
    const targets = automatedChanges.filter((c) => c.automation?.state.phase === 'running');
    for (const c of targets) {
      await callChange(c.id, 'pause', { reason: 'bulk-pause from project automation tab' });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header card — context + bulk actions */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Project automation</h3>
          <span className="tiny subtle">
            {automatedChanges.length} of {ownedChanges.length} change
            {ownedChanges.length === 1 ? '' : 's'} automated
          </span>
        </div>
        <div className="card-body" style={{ padding: '14px 18px 18px' }}>
          <p className="tiny" style={{ marginTop: 0, color: 'var(--muted)', marginBottom: 14 }}>
            Each change owns its automation config (see the change's Automation tab). This view
            shows every change in the project + inline controls. Bulk actions apply to all eligible
            / matching changes at once.
          </p>

          {/* Summary chips */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
            <SummaryChip
              label="Eligible"
              value={eligibleChanges.length}
              hint="review_status: approved AND status != merged/abandoned"
            />
            <SummaryChip
              label="Automated"
              value={automatedChanges.length}
              severity={automatedChanges.length > 0 ? 'accent' : 'muted'}
            />
            {runningCount > 0 && (
              <SummaryChip label="Running" value={runningCount} severity="accent" />
            )}
            {pausedCount > 0 && <SummaryChip label="Paused" value={pausedCount} severity="warn" />}
            {completeCount > 0 && (
              <SummaryChip label="Complete" value={completeCount} severity="success" />
            )}
          </div>

          {/* Bulk actions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busyChange !== null || eligibleChanges.length === 0}
              title={
                eligibleChanges.length === 0
                  ? 'No eligible changes (need review_status: approved + status != terminal)'
                  : `Enable automation for the ${eligibleChanges.filter((c) => c.automation?.enabled !== true).length} eligible change(s) not already automated`
              }
              onClick={bulkEnableEligible}
            >
              Enable all eligible
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busyChange !== null || runningCount === 0}
              title={
                runningCount === 0
                  ? 'No changes are currently running'
                  : `Pause ${runningCount} running change(s)`
              }
              onClick={bulkPauseRunning}
            >
              Pause all running
            </button>
            {busyChange && (
              <span className="tiny" style={{ alignSelf: 'center', color: 'var(--muted)' }}>
                {busyChange}…
              </span>
            )}
            {error && (
              <span
                className="tiny"
                style={{ alignSelf: 'center', color: 'var(--danger-text)' }}
                title={error}
              >
                Error: {error.slice(0, 80)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Per-change table */}
      <div className="card" style={{ padding: 0 }}>
        {ownedChanges.length === 0 ? (
          <p className="subtle" style={{ padding: 18, fontSize: 13, margin: 0 }}>
            No changes in this project yet.
          </p>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Change</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 110 }}>Review</th>
                <th style={{ width: 60, textAlign: 'center' }}>Auto</th>
                <th style={{ width: 220 }}>Automation state</th>
                <th style={{ width: 200 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {ownedChanges.map((c) => (
                <AutomationRow
                  key={c.id}
                  change={c}
                  eligible={isEligible(c)}
                  busyKey={busyChange}
                  onCall={callChange}
                  onOpen={onOpenChange}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Loop diagram (collapsed-by-default) */}
      <details className="card" style={{ padding: '10px 16px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 500 }}>
          The automation loop (v1)
        </summary>
        <pre
          className="mono tiny"
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 10,
            margin: '8px 0 0',
            overflow: 'auto',
            lineHeight: 1.5,
          }}
        >
          {`EXECUTE → OPEN-PR → PR-REVIEW ─┬─ no blockers → complete
                                │              (auto-flips pr_review_status: ready-for-human)
                                │
                                └─ needs-changes → ADDRESS-COMMENTS → PR-REVIEW
                                                   (loops; caps per change.iteration_cap)`}
        </pre>
        <p className="tiny subtle" style={{ marginTop: 8, marginBottom: 0 }}>
          See <code className="mono">[[standard-automation-loop]]</code> for the full state machine,
          transition rules, and extension points.
        </p>
      </details>
    </div>
  );
}

// Single row in the per-change automation table. Renders the change's state
// + automation phase/step/iteration + contextual action buttons.
function AutomationRow({
  change,
  eligible,
  busyKey,
  onCall,
  onOpen,
}: {
  change: OwnedChangeRef;
  eligible: boolean;
  busyKey: string | null;
  onCall: (changeId: string, suffix: string, body?: Record<string, unknown>) => void;
  onOpen: (id: string) => void;
}) {
  const a = change.automation;
  const phase = a?.state.phase ?? null;
  const enabled = a?.enabled === true;
  const isRunning = phase === 'running';
  const isPaused = phase === 'paused';
  const isComplete = phase === 'complete';
  const isIdle = phase === 'idle';
  const isTerminal = change.status === 'merged' || change.status === 'abandoned';
  const busy = (suffix: string) => busyKey === `${change.id}:${suffix}`;
  const anyBusy = busyKey !== null;

  function StatusBadge({ value }: { value: string | null }) {
    if (!value) return <span className="tiny subtle">—</span>;
    const cls =
      value === 'merged'
        ? 'badge success'
        : value === 'abandoned'
          ? 'badge muted'
          : value === 'in-review'
            ? 'badge accent'
            : value === 'in-progress'
              ? 'badge warning'
              : 'badge muted';
    return <span className={`${cls} tiny`}>{value}</span>;
  }

  function ReviewBadge({ value }: { value: string | null }) {
    if (!value) return <span className="tiny subtle">—</span>;
    const cls =
      value === 'approved'
        ? 'badge success'
        : value === 'request-changes' || value === 'rejected'
          ? 'badge warning'
          : value === 'not-required' || value === 'overridden'
            ? 'badge accent'
            : 'badge muted';
    return <span className={`${cls} tiny`}>{value}</span>;
  }

  function PhaseBadge() {
    if (!a) return <span className="tiny subtle">—</span>;
    if (!enabled) return <span className="tiny subtle">disabled</span>;
    const cls =
      phase === 'running'
        ? 'badge accent'
        : phase === 'paused'
          ? 'badge warning'
          : phase === 'complete'
            ? 'badge success'
            : 'badge muted';
    return (
      <span
        className={`${cls} tiny`}
        title={a.state.paused_reason ?? a.state.current_step ?? phase ?? 'idle'}
      >
        {phase}
        {a.state.current_step ? ` · ${a.state.current_step}` : ''}
        {a.state.iteration_count > 0 ? ` · iter ${a.state.iteration_count}/${a.iteration_cap}` : ''}
      </span>
    );
  }

  return (
    <tr style={{ opacity: isTerminal ? 0.55 : 1 }}>
      <td>
        <button
          type="button"
          onClick={() => onOpen(change.id)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'var(--accent)',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 13,
          }}
          title={`Open ${change.id}`}
        >
          {change.title}
        </button>
      </td>
      <td>
        <StatusBadge value={change.status} />
      </td>
      <td>
        <ReviewBadge value={change.review_status} />
      </td>
      <td style={{ textAlign: 'center' }}>
        {isTerminal ? (
          <span className="tiny subtle">—</span>
        ) : (
          <input
            type="checkbox"
            checked={enabled}
            disabled={anyBusy}
            onChange={(e) => onCall(change.id, e.target.checked ? 'enable' : 'disable')}
            title={
              enabled
                ? 'Disable automation for this change'
                : eligible
                  ? 'Enable automation for this change'
                  : 'Plan must be reviewed + approved before automation can run'
            }
          />
        )}
      </td>
      <td>
        <PhaseBadge />
      </td>
      <td>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {enabled && !isTerminal && (
            <>
              {(isIdle || isPaused) && !isComplete && eligible && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={anyBusy}
                  onClick={() => onCall(change.id, 'start')}
                  title={
                    isPaused
                      ? 'Resume automation'
                      : a?.state.current_step
                        ? 'Continue automation'
                        : 'Start automation (first dispatch)'
                  }
                >
                  {busy('start')
                    ? '…'
                    : isPaused
                      ? 'Resume'
                      : a?.state.current_step
                        ? 'Continue'
                        : 'Start'}
                </button>
              )}
              {isRunning && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={anyBusy}
                  onClick={() => onCall(change.id, 'pause')}
                >
                  {busy('pause') ? '…' : 'Pause'}
                </button>
              )}
              {(a?.state.iteration_count ?? 0) > 0 && !isRunning && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={anyBusy}
                  onClick={() => onCall(change.id, 'reset')}
                  title="Wipe state (phase: idle, current_step: null, iteration_count: 0)"
                >
                  {busy('reset') ? '…' : 'Reset'}
                </button>
              )}
              {isComplete && (
                <span className="tiny subtle" style={{ alignSelf: 'center' }}>
                  awaiting human merge
                </span>
              )}
            </>
          )}
          {!enabled && !isTerminal && !eligible && (
            <span className="tiny subtle" style={{ alignSelf: 'center' }}>
              not eligible
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// Small chip for the header summary. Reuses the prototype badge styles.
function SummaryChip({
  label,
  value,
  hint,
  severity,
}: {
  label: string;
  value: number;
  hint?: string;
  severity?: 'muted' | 'accent' | 'warn' | 'success';
}) {
  const cls =
    severity === 'accent'
      ? 'badge accent'
      : severity === 'warn'
        ? 'badge warning'
        : severity === 'success'
          ? 'badge success'
          : 'badge muted';
  return (
    <div
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
      title={hint}
    >
      <span className={`${cls} tiny`}>{value}</span>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
    </div>
  );
}

function ProjectReplaySection({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProjectReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazy fetch: only on first open. Project replays can be large (every
  // event for every owned change), so pay the read cost only when the user
  // actually wants the autobiography.
  useEffect(() => {
    if (!open || data || error || !projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/replay`)
      .then((r) => r.json())
      .then((j: ProjectReplayResponse | { ok: false; error?: string }) => {
        if (cancelled) return;
        if ('ok' in j && j.ok) setData(j as ProjectReplayResponse);
        else setError(('error' in j && j.error) || 'replay failed');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, data, error, projectId]);

  return (
    <Section
      title={`Replay${data ? ` (${data.timeline.length})` : ''}`}
      action={
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setOpen((v) => !v)}
          title={
            open
              ? 'Hide the chronological replay'
              : 'Show the chronological autobiography — every event + commit + change-state marker across every owned change.'
          }
        >
          {open ? (
            <>
              <Icons.ChevronDown size={11} /> Hide
            </>
          ) : (
            <>
              <Icons.ChevronRight size={11} /> Show timeline
            </>
          )}
        </button>
      }
    >
      {!open ? (
        <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
          Click <strong>Show timeline</strong> to load every event, run, commit, and change-state
          marker for this project, in chronological order. Loads on demand.
        </p>
      ) : error ? (
        <p className="tiny" style={{ color: 'var(--danger-text)', margin: 0 }}>
          Replay unavailable: {error}
        </p>
      ) : !data ? (
        <p className="subtle tiny" style={{ margin: 0 }}>
          Loading…
        </p>
      ) : (
        <ProjectReplayTimeline data={data} onOpenRun={(rid) => navigate(`/processes#${rid}`)} />
      )}
    </Section>
  );
}

function ProjectReplayTimeline({
  data,
  onOpenRun,
}: {
  data: ProjectReplayResponse;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <ol
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderLeft: '2px solid var(--border)',
        marginLeft: 8,
        paddingLeft: 16,
        maxHeight: 600,
        overflowY: 'auto',
      }}
    >
      {[...data.timeline]
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
        .map((entry, i) => (
          <li key={`${entry.ts}-${i}`}>
            {entry.kind === 'change-marker' && (
              <ProjectReplayChangeMarker marker={entry.change_marker} />
            )}
            {entry.kind === 'event' && (
              <ProjectReplayEventRow ts={entry.ts} event={entry.event} onOpenRun={onOpenRun} />
            )}
            {entry.kind === 'commit' && (
              <ProjectReplayCommitRow ts={entry.ts} commit={entry.commit} />
            )}
          </li>
        ))}
    </ol>
  );
}

function ProjectReplayChangeMarker({
  marker,
}: {
  marker: ProjectReplayResponse['change_markers'][number];
}) {
  const tone =
    marker.kind === 'merged'
      ? {
          bg: 'var(--success-soft, rgba(60,160,90,0.08))',
          border: 'var(--success-border, var(--success-text))',
          icon: 'check' as const,
          color: 'var(--success-text)',
        }
      : marker.kind === 'abandoned'
        ? { bg: 'var(--bg-2)', border: 'var(--border)', icon: 'x' as const, color: 'var(--muted)' }
        : {
            bg: 'var(--accent-soft)',
            border: 'var(--accent-border)',
            icon: 'plus' as const,
            color: 'var(--accent-text)',
          };
  return (
    <div
      style={{
        padding: '6px 10px',
        margin: '6px 0',
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 6,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        fontSize: 12.5,
      }}
    >
      {tone.icon === 'check' && <Icons.Check size={12} style={{ color: tone.color }} />}
      {tone.icon === 'x' && <Icons.X size={12} style={{ color: tone.color }} />}
      {tone.icon === 'plus' && <Icons.Plus size={12} style={{ color: tone.color }} />}
      <strong style={{ color: tone.color }}>Change {marker.kind}:</strong>
      <code className="mono tiny">{marker.change_id}</code>
      <span style={{ flex: 1, minWidth: 0 }}>{marker.change_title}</span>
      <span className="tiny" title={marker.ts}>
        {formatRelative(marker.ts)}
      </span>
    </div>
  );
}

interface ProjectReplayEventPayload {
  id: number;
  action: string | null;
  skill: string | null;
  duration_ms: number | null;
  exit_status: string | null;
  cost_usd: number | null;
  change_id: string | null;
  run_id: string | null;
}

function ProjectReplayEventRow({
  ts,
  event,
  onOpenRun,
}: {
  ts: string;
  event: ProjectReplayEventPayload;
  onOpenRun: (runId: string) => void;
}) {
  const isAiPrompt = event.action === 'ai-prompt';
  return (
    <div
      style={{
        padding: '4px 8px',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        fontSize: 12,
      }}
    >
      <span className="tiny subtle" style={{ minWidth: 84 }}>
        {formatRelative(ts)}
      </span>
      <Icons.Sparkles size={11} style={{ color: 'var(--muted)' }} />
      <code className="mono" style={{ fontSize: 11 }}>
        {event.skill ?? '—'}
      </code>
      <span className="tiny subtle">·</span>
      <span>{event.action ?? '(event)'}</span>
      {event.change_id && (
        <span className="tiny subtle mono" title={`change_id: ${event.change_id}`}>
          [{event.change_id.slice(0, 28)}
          {event.change_id.length > 28 ? '…' : ''}]
        </span>
      )}
      <span className="spacer" />
      {isAiPrompt && event.cost_usd != null && (
        <span className="run-row-cost">${event.cost_usd.toFixed(4)}</span>
      )}
      {event.duration_ms != null && (
        <span className="tiny subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(event.duration_ms / 1000)}s
        </span>
      )}
      {event.run_id && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ fontSize: 10.5, padding: '0 6px' }}
          onClick={() => onOpenRun(event.run_id as string)}
          title={`Open run ${event.run_id} in the Processes view.`}
        >
          run →
        </button>
      )}
    </div>
  );
}

function ProjectReplayCommitRow({
  ts,
  commit,
}: {
  ts: string;
  commit: ProjectReplayResponse['commits'][number];
}) {
  return (
    <div
      style={{
        padding: '6px 10px',
        margin: '4px 0',
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        fontSize: 12,
      }}
    >
      <Icons.GitCommit size={12} style={{ color: 'var(--muted)' }} />
      <code className="mono" style={{ fontSize: 11 }}>
        {commit.short_sha}
      </code>
      <span style={{ flex: 1, color: 'var(--text)' }}>{commit.subject}</span>
      <span className="tiny subtle mono" title={`change: ${commit.change_id}`}>
        [{commit.change_id.slice(0, 24)}
        {commit.change_id.length > 24 ? '…' : ''}]
      </span>
      <span className="tiny subtle">{commit.author}</span>
      <span className="tiny" title={ts}>
        {formatRelative(ts)}
      </span>
    </div>
  );
}

// Project-scoped schedules — surfaces every runbook with
// `project: <id>` + `schedule: <cron>`. Each row carries the next-fire
// timestamp + most recent firing snapshot so the user can see at a glance
// whether the schedule is healthy. The "Add schedule" button opens the
// existing meta-add-schedule scaffold form with project pre-filled.
function ProjectSchedulesSection({
  projectId,
  schedules,
  onJumpToSchedules,
  onAddSchedule,
}: {
  projectId: string;
  schedules: ProjectScheduleRef[];
  onJumpToSchedules: () => void;
  onAddSchedule: () => void;
}) {
  return (
    <Section
      title={`Schedules (${schedules.length})`}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onAddSchedule}
            disabled={!projectId}
            title="Scaffold a new scheduled runbook with project pre-filled. The scheduler skips it when the project's status isn't `active`."
          >
            <Icons.Plus size={11} /> Add schedule
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onJumpToSchedules}
            title="Open the global Schedules app"
          >
            All schedules →
          </button>
        </div>
      }
    >
      {schedules.length === 0 ? (
        <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
          No schedules attached to this project. Click <strong>+ Add schedule</strong> to scaffold a
          runbook with <code className="mono">project: {projectId}</code> in its frontmatter — the
          scheduler will fire it on the cron expression you configure, but only while the project is{' '}
          <code className="mono">status: active</code>.
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {schedules.map((s) => (
            <ProjectScheduleRow key={s.path} schedule={s} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ProjectScheduleRow({ schedule }: { schedule: ProjectScheduleRef }) {
  const last = schedule.last_run;
  // Color the last-run badge by outcome:
  //   fired exit:0 → success; fired non-zero → danger;
  //   skipped → muted (intentional precondition gate); spawn-error → danger.
  const lastBadgeClass = !last
    ? 'badge muted'
    : last.outcome === 'fired' && (last.exit ?? 0) === 0
      ? 'badge success'
      : last.outcome === 'skipped'
        ? 'badge muted'
        : 'badge danger';
  const lastBadgeText = !last
    ? 'never fired'
    : last.outcome === 'fired'
      ? `last: fired · exit ${last.exit ?? '?'}`
      : last.outcome === 'skipped'
        ? `last: skipped${last.skip_reason ? ` (${last.skip_reason.slice(0, 32)}${last.skip_reason.length > 32 ? '…' : ''})` : ''}`
        : `last: ${last.outcome ?? 'unknown'}`;
  return (
    <li
      style={{
        padding: '8px 10px',
        border: '1px solid var(--border)',
        borderRadius: 6,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 13,
      }}
    >
      <strong style={{ fontSize: 13 }}>{schedule.title}</strong>
      <code
        className="mono tiny"
        style={{ background: 'var(--bg-2)', padding: '1px 6px', borderRadius: 3 }}
        title="Cron expression (machine local time)"
      >
        {schedule.schedule}
      </code>
      <span className={lastBadgeClass} style={{ fontSize: 10.5 }} title={last?.ts ?? undefined}>
        {lastBadgeText}
      </span>
      {schedule.next_run && (
        <span className="tiny subtle" title={schedule.next_run}>
          next: {formatRelative(schedule.next_run)}
        </span>
      )}
      <span
        className="subtle tiny"
        style={{
          flex: 1,
          minWidth: 200,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={schedule.prompt}
      >
        {schedule.prompt.slice(0, 80)}
        {schedule.prompt.length > 80 && '…'}
      </span>
    </li>
  );
}

// Research section — first-class surface for research-domain entries
// linked to this project (owned via `project: <id>` frontmatter OR
// referenced via [[<project-id>]] body wikilinks). Adds a one-click
// "Add research note" form that POSTs /api/projects/:id/research.
//
// Both halves of the backlinks come in pre-grouped by archetype; we
// flatten and filter to domain==='research'. Most research projects
// produce `note`, `reference`, and `decision` entries; the section
// shows them mixed, sorted newest-first.
function ResearchSection({
  projectId,
  researchReports,
  owned,
  referenced,
  onOpenEntry,
  onOpenReport,
  onChanged,
}: {
  projectId: string;
  researchReports: ResearchReportRef[];
  owned: Record<string, BacklinkRef[]>;
  referenced: Record<string, BacklinkRef[]>;
  onOpenEntry: (id: string) => void;
  onOpenReport: (id: string) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');

  // Flatten + filter to research domain. Each entry tagged with
  // {owned: true|false} so the row can show provenance.
  const items = useMemo(() => {
    const all: Array<BacklinkRef & { ownership: 'owned' | 'referenced' }> = [];
    for (const refs of Object.values(owned)) {
      for (const r of refs) {
        if (r.domain === 'research') all.push({ ...r, ownership: 'owned' });
      }
    }
    for (const refs of Object.values(referenced)) {
      for (const r of refs) {
        if (r.domain === 'research') all.push({ ...r, ownership: 'referenced' });
      }
    }
    // Newest first; nulls sink.
    all.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
    return all;
  }, [owned, referenced]);

  async function submit() {
    if (!draftTitle.trim()) {
      setError('title is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/research`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: draftTitle.trim(), body: draftBody.trim() }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string; id?: string };
      if (!j.ok) {
        setError(j.error ?? `request failed (${r.status})`);
        return;
      }
      setDraftTitle('');
      setDraftBody('');
      setAdding(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ResearchReportsSubsection
        reports={researchReports}
        projectId={projectId}
        onOpenReport={onOpenReport}
      />
      <Section
        title={`Notes (${items.length}) — free-form`}
        action={
          !adding && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setAdding(true);
                setError(null);
              }}
              disabled={!projectId}
              title="Scaffold a new research note linked to this project. Lands at vault/wiki/research/note/<slug>.md with domain: research + project: <id> pre-filled. Edit content via the vault editor after creation."
            >
              <Icons.Plus size={11} /> Add research note
            </button>
          )
        }
      >
        {adding && (
          <div
            className="card"
            style={{
              padding: 12,
              marginBottom: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              background: 'var(--bg-2)',
            }}
          >
            <input
              type="text"
              placeholder="Note title (e.g. retry backoff strategies — survey of go libs)"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              disabled={submitting}
              style={{ fontSize: 13, padding: '6px 10px' }}
              autoFocus
            />
            <textarea
              placeholder="Optional initial body (markdown). You can edit later from the vault."
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              disabled={submitting}
              rows={4}
              style={{ fontSize: 12.5, padding: '8px 10px', fontFamily: 'inherit' }}
            />
            {error && (
              <span className="tiny" style={{ color: 'var(--danger-text)' }}>
                {error}
              </span>
            )}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={submit}
                disabled={submitting || !draftTitle.trim()}
              >
                {submitting ? 'Creating…' : 'Create note'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setAdding(false);
                  setDraftTitle('');
                  setDraftBody('');
                  setError(null);
                }}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {items.length === 0 && !adding ? (
          <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
            No research entries yet. Click <strong>+ Add research note</strong> to capture an
            observation, finding, or reading; the note lands under{' '}
            <code className="mono">vault/wiki/research/note/</code> linked to this project. Research
            decisions can then inform downstream changes (see the research playbook for the
            canonical flow).
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {items.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  onClick={() => onOpenEntry(r.id)}
                  title={`Open ${r.id} in Vault · ${r.ownership}`}
                  style={{
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    padding: '6px 10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    color: 'var(--text)',
                    textAlign: 'left',
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span
                    className="badge muted"
                    style={{ fontSize: 10, minWidth: 60, textAlign: 'center' }}
                  >
                    {r.type ?? 'entry'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{r.title}</span>
                  {r.ownership === 'referenced' && (
                    <span
                      className="tiny subtle"
                      title="External — references this project but not owned"
                    >
                      ↗
                    </span>
                  )}
                  <span className="tiny subtle">{r.updated ? formatRelative(r.updated) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ResearchReportsSubsection({
  reports,
  projectId,
  onOpenReport,
}: {
  reports: ResearchReportRef[];
  // Owning project id — used to deep-link the Add button to
  // /research/new?project=<id> so the form opens pre-selected on this
  // project. Optional so other call sites without a project context can
  // still render the list.
  projectId?: string;
  onOpenReport: (id: string) => void;
}) {
  const navigate = useNavigate();
  // Render even when empty so the user always has a path to create one.
  // The empty-state hint sits inside the Section.
  const addButton = projectId ? (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      onClick={() => navigate(`/research/new?project=${encodeURIComponent(projectId)}`)}
      title="Scaffold a research-report entry under this project. Opens the Research app's Add page pre-selected on this project; you supply the topic + materials."
    >
      <Icons.Plus size={11} /> Add research report
    </button>
  ) : null;
  if (reports.length === 0) {
    return (
      <Section title="Research reports (0)" action={addButton}>
        <div
          className="subtle"
          style={{ padding: '10px 4px', fontSize: 12.5, color: 'var(--text-3)' }}
        >
          No research reports yet for this project. Click <strong>Add research report</strong> to
          scaffold one — research-write captures materials, composes a structured report, and lands
          it under <code className="mono">vault/wiki/research/research-report/</code>.
        </div>
      </Section>
    );
  }
  return (
    <Section title={`Research reports (${reports.length})`} action={addButton}>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {reports.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onOpenReport(r.id)}
              title={`Open ${r.id} in Research`}
              style={{
                width: '100%',
                background: 'none',
                border: 'none',
                padding: '8px 12px',
                borderRadius: 6,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--text)',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <strong style={{ flex: 1, fontSize: 13 }}>{r.title}</strong>
              {r.has_updates_pending && (
                <span title="Update trigger pending" style={{ color: 'var(--warning-text)' }}>
                  <Icons.AlertTriangle size={13} />
                </span>
              )}
              {r.status && (
                <span className={`badge ${statusToBadgeCls(r.status)}`}>{r.status}</span>
              )}
              {r.review_status && (
                <span className="badge muted" style={{ fontSize: 10 }}>
                  {r.review_status}
                </span>
              )}
              {r.report_revision && r.report_revision > 1 && (
                <code className="tiny mono" style={{ color: 'var(--muted)' }}>
                  rev {r.report_revision}
                </code>
              )}
              <span className="tiny subtle">{r.updated ? formatRelative(r.updated) : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function statusToBadgeCls(status: string): string {
  switch (status) {
    case 'approved':
      return 'success';
    case 'reviewed':
      return 'warning';
    case 'updated':
      return 'accent';
    default:
      return 'muted';
  }
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="tiny" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

// ── Overview sections ────────────────────────────────────────────────────
// High-density at-a-glance content for the Overview tab. Each card is
// conditional on having data — empty projects (no changes, no reports, no
// body) collapse to just the existing metadata grid.

function ProjectQuickStats({ detail }: { detail: ProjectDetail }) {
  const agg = detail.project.changes;
  const rollup = detail.rollup;
  if (!agg || agg.total === 0) return null;
  const hasRollup = rollup && rollup.ai_prompt_runs > 0;
  const minutes = hasRollup ? Math.round(rollup.duration_ms / 60000) : 0;
  // Sum plan_revision across owned changes — surfaces how much review-driven
  // iteration the project went through. plan_revision counts WRITES (initial
  // is 1), so revisions = (max(plan_revision, 1) - 1) summed.
  const planRevisions = detail.owned_changes
    .map((c) => {
      // OwnedChangeRef doesn't carry plan_revision today — we read from
      // backlinks.owned.change[] where the manifest lifts it.
      const m = detail.backlinks.owned?.change?.find((b) => b.id === c.id) as
        | (BacklinkRef & { plan_revision?: number | null })
        | undefined;
      return (m?.plan_revision ?? 1) - 1;
    })
    .reduce((a, b) => a + b, 0);
  const latestActivity = agg.latest_change_updated;
  return (
    <section
      className="card"
      style={{
        padding: 14,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 12,
      }}
    >
      <StatCell
        label="Changes"
        value={`${agg.total}`}
        sub={
          [
            agg.merged > 0 ? `${agg.merged} shipped` : null,
            agg.in_progress + agg.in_review + agg.planning > 0
              ? `${agg.in_progress + agg.in_review + agg.planning} in flight`
              : null,
            agg.abandoned > 0 ? `${agg.abandoned} abandoned` : null,
          ]
            .filter(Boolean)
            .join(' · ') || null
        }
      />
      {hasRollup && (
        <StatCell
          label="Cost"
          value={`$${rollup.cost_usd.toFixed(2)}`}
          sub={`${rollup.ai_prompt_runs} run${rollup.ai_prompt_runs !== 1 ? 's' : ''} · ${rollup.skill_count} skill${rollup.skill_count !== 1 ? 's' : ''}`}
        />
      )}
      {hasRollup && (
        <StatCell
          label="Wall-time"
          value={minutes > 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`}
          sub={
            rollup.failed_runs > 0
              ? `${rollup.failed_runs} failed run${rollup.failed_runs !== 1 ? 's' : ''}`
              : null
          }
        />
      )}
      {planRevisions > 0 && (
        <StatCell label="Plan revisions" value={`${planRevisions}`} sub="from review findings" />
      )}
      {latestActivity && (
        <StatCell
          label="Last activity"
          value={formatRelative(latestActivity)}
          sub={formatLocal(latestActivity)}
        />
      )}
    </section>
  );
}

function StatCell({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="tiny" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <strong style={{ fontSize: 18, fontWeight: 600 }}>{value}</strong>
      {sub && (
        <span className="tiny subtle" style={{ fontSize: 11 }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// Visual stepper showing project's position in the broader plan + run + close
// lifecycle. Combines plan_status (research → reviewed-pending → approved →
// scaffolded → active) and project.status (active → completed). Falls back to
// "planning" when neither plan_status nor changes yet exist.
function ProjectPhaseTimeline({ project }: { project: ProjectSummary }) {
  // Prefer the derived value when present — research-driven projects never
  // populate frontmatter `plan_status`, so without this fallback the
  // timeline gets stuck at the leftmost stage. Same fix as the sibling
  // ProjectPlanLifecycleStepper. See [[plan-lifecycle-derived-from-research-flow]].
  const ps = project.plan_status_derived ?? project.plan_status;
  const st = project.status;
  // Determine current phase index by walking the canonical order.
  const PHASES: Array<{ id: string; label: string; tooltip: string }> = [
    {
      id: 'planning',
      label: 'Planning',
      tooltip: 'Project entry scaffolded; plan lifecycle not yet started.',
    },
    {
      id: 'in-research',
      label: 'Research',
      tooltip: 'meta-research-project running — assembling materials + drafting plan.',
    },
    {
      id: 'reviewed-pending',
      label: 'Plan written',
      tooltip: 'Plan drafted, awaiting review (meta-review-project-plan).',
    },
    {
      id: 'request-changes',
      label: 'Plan reviewed',
      tooltip:
        'Review returned request-changes (or revise-then-reviewed). Working through revisions.',
    },
    {
      id: 'approved',
      label: 'Approved',
      tooltip: 'Plan approved by reviewer. Ready to scaffold children.',
    },
    {
      id: 'scaffolded',
      label: 'Scaffolded',
      tooltip: 'Children scaffolded — project now executing across owned changes.',
    },
    { id: 'active', label: 'Active', tooltip: 'Changes in flight. Watching cost + cadence.' },
    {
      id: 'completed',
      label: 'Completed',
      tooltip: 'Project terminal. All changes shipped or abandoned.',
    },
  ];
  // Map current state to phase index. For completed projects we set
  // currentIdx past the last phase so every dot renders as done (filled
  // checkmark) — completed is terminal, not "about to be completed".
  let currentIdx = 0;
  if (st === 'completed') currentIdx = PHASES.length;
  else if (ps === 'active') currentIdx = 6;
  else if (ps === 'scaffolded') currentIdx = 5;
  else if (ps === 'approved') currentIdx = 4;
  else if (ps === 'request-changes') currentIdx = 3;
  else if (ps === 'reviewed-pending') currentIdx = 2;
  else if (ps === 'in-research') currentIdx = 1;
  else currentIdx = 0;

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Lifecycle</h4>
        <span className="tiny">
          {currentIdx >= PHASES.length
            ? `${PHASES.length} of ${PHASES.length} complete`
            : `phase ${currentIdx + 1} of ${PHASES.length}`}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${PHASES.length}, minmax(0, 1fr))`,
          gap: 0,
          padding: '16px 16px 8px',
          position: 'relative',
        }}
      >
        {PHASES.map((ph, i) => {
          const isDone = i < currentIdx;
          const isCurrent = i === currentIdx;
          const dotFill = isDone ? 'var(--success-text)' : isCurrent ? 'var(--bg)' : 'var(--bg-2)';
          const dotBorder = isDone
            ? 'var(--success-text)'
            : isCurrent
              ? 'var(--accent)'
              : 'var(--border)';
          const lineColor = isDone ? 'var(--success-text)' : 'var(--border)';
          return (
            <div
              key={ph.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                position: 'relative',
                padding: '0 4px',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 9,
                  left: 0,
                  right: 0,
                  height: 2,
                  display: 'flex',
                }}
              >
                {i > 0 && <div style={{ flex: 1, background: lineColor, height: 2 }} />}
                <div style={{ width: 20 }} />
                {i < PHASES.length - 1 && (
                  <div
                    style={{
                      flex: 1,
                      background: i < currentIdx ? 'var(--success-text)' : 'var(--border)',
                      height: 2,
                    }}
                  />
                )}
              </div>
              <div
                title={ph.tooltip}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: dotFill,
                  border: `2px solid ${dotBorder}`,
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {isDone && <Icons.Check size={11} />}
                {isCurrent && (
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: isCurrent ? 600 : 500,
                  marginTop: 8,
                  textAlign: 'center',
                  color: isCurrent
                    ? 'var(--accent-text)'
                    : isDone
                      ? 'var(--text-2)'
                      : 'var(--text-3)',
                  lineHeight: 1.3,
                }}
              >
                {ph.label}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Project Pulse — derived metrics from ops data + change frontmatter. Lives
// alongside About-this-project (human charter) on the Overview tab. Distinct
// from ChangesLifecycleStepper (per-change state) and ProjectPhaseTimeline
// (plan-lifecycle position): this card surfaces aggregate signals that turn
// the OS's operational data into a self-observation surface.
//
// v1 sources (no API change needed):
//   - detail.owned_changes (lifecycle status, pr_review_passes, merged_at)
//   - detail.rollup (cost_usd, duration_ms, failed_runs, by_skill)
//   - detail.research_reports (upstream research health)
//
// v2 candidates (need server work):
//   - comment-severity mix across owned PR-reviews
//   - notification fire counts scoped to project
//   - reviews-to-approve historical avg
// Lightweight audit-aggregate shape — mirrors the server's AuditAggregate
// type at domains/meta/app/server/routes/audits.types.ts. Inlined here as
// a narrow projection rather than importing from server.types to keep this
// file's dependency surface small. Update both when the wire shape changes.
interface PulseAuditAggregate {
  total_audits: number;
  verdict_distribution: { good: number; mixed: number; poor: number; unknown: number };
  top_tags: Array<{ tag: string; count: number }>;
  top_tuning_suggestions: Array<{ skill: string; count: number }>;
  mean_scores: { correctness: number; completeness: number; efficiency: number } | null;
}

function ProjectPulseCard({
  projectId,
  ownedChanges,
  rollup,
  researchReports,
}: {
  // Project id — used to scope the audits-aggregate fetch via
  // /api/audits/aggregate?project=<id>. Empty string is a valid no-op
  // (the request still works, returns global aggregate; tile renders
  // an opt-in hint instead).
  projectId: string;
  ownedChanges: OwnedChangeRef[];
  rollup: ProjectRollup;
  researchReports: ResearchReportSummary[];
}) {
  // Audit aggregate — fetched on mount. Null while loading; null after
  // failure (tile gracefully degrades to the "enable audits" hint).
  const [auditAggregate, setAuditAggregate] = useState<PulseAuditAggregate | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getJson<PulseAuditAggregate>(`/api/audits/aggregate?project=${encodeURIComponent(projectId)}`)
      .then((r) => {
        if (!cancelled) setAuditAggregate(r);
      })
      .catch(() => {
        // Silent — audits are opt-in, missing aggregate is normal.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  // Lifecycle distribution
  const lifecycle = ownedChanges.reduce<Record<string, number>>((acc, c) => {
    const k = c.status ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const merged = lifecycle['merged'] ?? 0;
  const inFlight =
    (lifecycle['planning'] ?? 0) + (lifecycle['in-progress'] ?? 0) + (lifecycle['in-review'] ?? 0);
  const abandoned = lifecycle['abandoned'] ?? 0;

  // PR-review velocity — sum across changes that have a review entry.
  // pr_review_passes lives on the change frontmatter; we can't get it via
  // OwnedChangeRef today (only status fields). For v1 use a derived signal:
  // count changes currently blocked (in-review + pr_review_status=needs-changes).
  // Sum of passes is a v2 candidate (would require adding pr_review_passes to
  // OwnedChangeRef on the server side).
  const blocked = ownedChanges.filter(
    (c) => c.status === 'in-review' && c.pr_review_status === 'needs-changes',
  ).length;
  const readyForHuman = ownedChanges.filter(
    (c) => c.status === 'in-review' && c.pr_review_status === 'ready-for-human',
  ).length;

  // (Weekly-throughput chart was here in v1 but pulled — at the densities
  // typical for this OS's deliberate-change workflow it added visual noise
  // without conveying signal beyond what the In-flight tile already shows.
  // V2 should replace this space with lifecycle-velocity / review-efficiency /
  // bottleneck-stage metrics derived from per-stage timestamps once the
  // server exposes them on OwnedChangeRef.)

  // Top-N skills by cost — readable when there are 2-3 dominant skills.
  const topSkills = [...rollup.by_skill].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 3);

  // Research upstream — count by review_status. Different from owned changes;
  // these are the research-reports the project's plan was derived from.
  const researchByStatus = researchReports.reduce<Record<string, number>>((acc, r) => {
    const k = r.review_status ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <div>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Project pulse</h4>
          <div
            className="tiny subtle"
            style={{ marginTop: 2, fontSize: 11 }}
            title="All values derived at render time from events.db + owned_changes + research_reports. Not stored."
          >
            Derived from ops data
          </div>
        </div>
        {rollup.failed_runs > 0 && (
          <span
            className="badge"
            style={{
              fontSize: 11,
              gap: 4,
              background: 'var(--warning-bg, rgba(250,200,80,0.1))',
              color: 'var(--warning-text, #e0a02a)',
              border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
            }}
            title={`${rollup.failed_runs} skill run${rollup.failed_runs !== 1 ? 's' : ''} terminated abnormally on changes owned by this project. Inspect via the Runs drawer.`}
          >
            ⚠ {rollup.failed_runs} failed run{rollup.failed_runs !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Five metric tiles — top row. auto-fit so a 5th tile wraps gracefully
          on narrower screens rather than forcing 5 cramped columns. */}
      <div
        style={{
          padding: '12px 16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 16,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <PulseTile
          label="In-flight changes"
          value={String(inFlight)}
          sub={`${merged} merged · ${abandoned} abandoned`}
          tooltip="Changes currently in planning, in-progress, or in-review. Captures work the OS is actively driving."
        />
        <PulseTile
          label="PR-review state"
          value={
            blocked > 0 ? `${blocked} blocked` : readyForHuman > 0 ? `${readyForHuman} ready` : '—'
          }
          sub={
            blocked + readyForHuman > 0
              ? `${blocked} needs-changes · ${readyForHuman} ready-for-human`
              : 'No PRs awaiting action'
          }
          tooltip="Changes whose PR-review status is needs-changes (action required) or ready-for-human (awaiting your merge)."
          severity={blocked > 0 ? 'warn' : 'neutral'}
        />
        <PulseTile
          label="Spend"
          value={`$${rollup.cost_usd.toFixed(2)}`}
          sub={`${rollup.ai_prompt_runs} run${rollup.ai_prompt_runs !== 1 ? 's' : ''} · ${formatDurationMs(rollup.duration_ms)}`}
          tooltip="Aggregate cost across all AI-prompt skill runs attributed to this project. Baseline for cost-per-change tracking."
        />
        <PulseTile
          label="Research upstream"
          value={String(researchReports.length)}
          sub={
            researchReports.length > 0
              ? Object.entries(researchByStatus)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(' · ')
              : 'None'
          }
          tooltip="Research-report entries owned by this project, grouped by review_status."
        />
        <PulseTile
          label="Audits"
          value={
            auditAggregate && auditAggregate.total_audits > 0
              ? String(auditAggregate.total_audits)
              : 'Off'
          }
          sub={
            auditAggregate && auditAggregate.total_audits > 0
              ? `${auditAggregate.verdict_distribution.good} good · ${auditAggregate.verdict_distribution.mixed} mixed · ${auditAggregate.verdict_distribution.poor} poor`
              : 'Enable in project frontmatter'
          }
          tooltip={
            auditAggregate && auditAggregate.total_audits > 0
              ? `${auditAggregate.total_audits} lifecycle audits produced by meta-overseer-review. ${auditAggregate.top_tuning_suggestions.length > 0 ? `${auditAggregate.top_tuning_suggestions.length} recurring tuning suggestions raised — see Insights → Audits.` : 'No recurring tuning suggestions yet.'}`
              : 'Lifecycle audits are opt-in per project. Add `audit: { enabled: true, mode: on-complete }` to project frontmatter to auto-fire the Overseer when changes merge. Audits feed the self-improvement loop.'
          }
          severity={
            auditAggregate && auditAggregate.verdict_distribution.poor > 0 ? 'warn' : 'neutral'
          }
        />
      </div>

      {/* Top-N skills by cost — readable as a small leaderboard */}
      {topSkills.length > 0 && (
        <div style={{ padding: '12px 16px' }}>
          <div className="tiny subtle" style={{ fontSize: 11, marginBottom: 6 }}>
            Top skills by cost
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {topSkills.map((s) => (
              <div
                key={s.skill}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-2)',
                }}
              >
                <span>{s.skill}</span>
                <span>
                  ${s.cost_usd.toFixed(2)} <span className="subtle">·</span> {s.count} call
                  {s.count !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer note on derivation + v2 candidates */}
      <div
        className="tiny subtle"
        style={{
          padding: '8px 16px 12px',
          fontSize: 10.5,
          borderTop: '1px solid var(--border)',
          color: 'var(--text-3)',
        }}
      >
        Live derive from events.db + owned-changes manifest. V2 candidates: lifecycle velocity (plan
        → merged median), review efficiency (passes-to-approve median), bottleneck-stage wall-time,
        comment-severity mix.
      </div>
    </section>
  );
}

function PulseTile({
  label,
  value,
  sub,
  tooltip,
  severity,
}: {
  label: string;
  value: string;
  sub: string;
  tooltip: string;
  severity?: 'neutral' | 'warn';
}) {
  const valueColor = severity === 'warn' ? 'var(--warning-text, #e0a02a)' : 'var(--text)';
  return (
    <div
      title={tooltip}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      }}
    >
      <span
        className="tiny subtle"
        style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}
      >
        {label}
      </span>
      <span style={{ fontSize: 17, fontWeight: 600, color: valueColor }}>{value}</span>
      <span className="tiny subtle" style={{ fontSize: 10.5 }}>
        {sub}
      </span>
    </div>
  );
}

// Compact wall-time formatter — duration_ms → "12m 34s" / "1h 23m" / "2d 4h".
// Mirrors the shape used by the Runs drawer's elapsed cell.
function formatDurationMs(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function ProjectDescriptionCard({ path, body }: { path: string; body: string }) {
  // Pass the project's path to EditableMarkdown so the user can edit Goal /
  // Scope / Milestones / Stakeholders / Decisions / Notes inline. Note: body
  // narrative sections are human-curated; the frontmatter `milestones` and
  // `stakeholders` arrays are what drives the status-report skill and the
  // project meta card — body sections are read mostly by humans + LLMs
  // during research/review.
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>About this project</h4>
      </div>
      <div style={{ padding: '12px 16px', fontSize: 13, lineHeight: 1.55 }}>
        <EditableMarkdown path={path} content={body} />
      </div>
    </section>
  );
}

// ApprovedResearchCard — renders a small card on Overview when the project
// has at least one approved research-report. Closes #395: prior UX left the
// "About this project" card as template placeholder text even after the
// research-driven flow had produced an approved report; users had to find
// it via the Research tab. This card surfaces approved research right above
// the description so the project's actual shape is visible at a glance.
//
// Approach: NON-destructive. We don't auto-rewrite the project body (that
// stays a human charter). Instead we add a sibling card pointing at the
// approved report(s). Renders nothing when no report has been approved yet,
// so empty / early-stage projects don't show clutter.
function ApprovedResearchCard({
  reports,
  onOpenEntry,
}: {
  reports: ResearchReportRef[];
  onOpenEntry: (id: string) => void;
}) {
  // Filter to reports that have actually been approved (the gate the user
  // cares about). Sort by reviewed_at desc so the most recent approval
  // surfaces first when a project has multiple approved reports.
  const approved = reports
    .filter((r) => r.review_status === 'approved')
    .sort((a, b) => (b.reviewed_at ?? '').localeCompare(a.reviewed_at ?? ''));
  if (approved.length === 0) return null;

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: 'var(--success-text, var(--accent))', marginRight: 6 }}>✓</span>
          Approved research{approved.length > 1 ? ` (${approved.length})` : ''}
        </h4>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {approved.map((r) => (
          <li key={r.id} style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={() => onOpenEntry(r.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--accent-text)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  textAlign: 'left',
                }}
                title={`Open research-report ${r.id} in Vault`}
              >
                {r.title}
              </button>
              {r.report_revision != null && r.report_revision > 1 && (
                <span className="tiny subtle">rev {r.report_revision}</span>
              )}
              <span className="spacer" />
              {r.reviewed_at && (
                <span className="tiny subtle" title={r.reviewed_at}>
                  approved {formatRelative(r.reviewed_at)}
                </span>
              )}
            </div>
            {r.recommended_changes_count > 0 && (
              <div className="tiny subtle" style={{ fontSize: 11, marginTop: 4 }}>
                {r.recommended_changes_count} recommended change
                {r.recommended_changes_count !== 1 ? 's' : ''}
                {r.recommended_changes_scaffolded > 0
                  ? ` · ${r.recommended_changes_scaffolded} scaffolded`
                  : ''}
                {r.recommended_changes_merged > 0
                  ? ` · ${r.recommended_changes_merged} merged`
                  : ''}
                {r.recommended_changes_abandoned > 0
                  ? ` · ${r.recommended_changes_abandoned} abandoned`
                  : ''}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LatestStatusReportCard({
  report,
  onOpen,
}: {
  report: StatusReportRef;
  onOpen: () => void;
}) {
  const label =
    report.kind === 'wrap-up'
      ? 'Wrap-up report'
      : report.kind === 'kickoff'
        ? 'Kickoff report'
        : report.kind === 'status'
          ? 'Status report'
          : 'Latest report';
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
          {label} <span className="subtle tiny">· {formatRelative(report.mtime)}</span>
        </h4>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onOpen}
          style={{ marginLeft: 'auto', fontSize: 11 }}
          title="Open the Reports tab to see all status reports for this project."
        >
          Open Reports tab →
        </button>
      </div>
      <div
        style={{
          padding: '12px 16px',
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--text-2)',
        }}
      >
        {report.preview ? (
          <span>{report.preview}…</span>
        ) : (
          <span className="subtle tiny">No preview available.</span>
        )}
      </div>
    </section>
  );
}

// Recent activity feed — fetches the last few items from /api/projects/:id/replay
// and renders a compact bullet list. Shows up to 5 of the most recent events
// (commits, change-state markers, skill runs, scheduler fires). Sparse on empty.
function ProjectRecentActivity({
  projectId,
  onOpenEntry,
}: {
  projectId: string;
  onOpenEntry: (id: string) => void;
}) {
  interface TimelineItem {
    ts: string;
    kind: string;
    title?: string;
    change_id?: string | null;
    skill?: string | null;
    state?: string | null;
    sha?: string | null;
    message?: string | null;
  }
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getJson<{ timeline: TimelineItem[] }>(
          `/api/projects/${encodeURIComponent(projectId)}/replay`,
        );
        if (!cancelled) setItems(r.timeline.slice(0, 5));
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  if (items === null) {
    return (
      <section className="card" style={{ padding: '12px 16px' }}>
        <span className="tiny subtle">Loading recent activity…</span>
      </section>
    );
  }
  if (items.length === 0) {
    return null;
  }
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Recent activity</h4>
      </div>
      <ul
        style={{
          listStyle: 'none',
          padding: '8px 16px 12px',
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {items.map((it, i) => (
          <li
            key={`${it.ts}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              fontSize: 12.5,
              padding: '3px 0',
            }}
          >
            <span
              className="tiny mono subtle"
              style={{ width: 70, flexShrink: 0 }}
              title={formatLocal(it.ts)}
            >
              {formatRelative(it.ts)}
            </span>
            <span style={{ flex: 1, lineHeight: 1.5 }}>
              <RecentActivityLine item={it} onOpenEntry={onOpenEntry} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentActivityLine({
  item,
  onOpenEntry,
}: {
  // Timeline item shape from /api/projects/:id/replay. The kind field
  // discriminates which of the nested payload objects is populated.
  item: {
    kind: string;
    change_marker?: {
      change_id?: string | null;
      kind?: 'scaffolded' | 'merged' | 'abandoned';
    };
    event?: {
      action?: string | null;
      skill?: string | null;
      change_id?: string | null;
      exit_status?: number | null;
      cost_usd?: number | null;
      duration_ms?: number | null;
    };
    commit?: {
      sha?: string | null;
      message?: string | null;
      author?: string | null;
    };
  };
  onOpenEntry: (id: string) => void;
}) {
  if (item.kind === 'commit' && item.commit) {
    const c = item.commit;
    return (
      <span>
        commit <code className="mono tiny">{(c.sha ?? '').slice(0, 7)}</code>{' '}
        <span className="subtle">{c.message}</span>
      </span>
    );
  }
  if (item.kind === 'change-marker' && item.change_marker?.change_id) {
    const m = item.change_marker;
    return (
      <span>
        change{' '}
        <button
          type="button"
          className="link-inline"
          onClick={() => onOpenEntry(m.change_id as string)}
          style={linkStyle}
        >
          {m.change_id}
        </button>{' '}
        <span className="subtle">→ {m.kind}</span>
      </span>
    );
  }
  if (item.kind === 'event' && item.event) {
    const ev = item.event;
    const exitOk = ev.exit_status === 0 || ev.exit_status == null;
    return (
      <span>
        {ev.skill ? (
          <code className="mono tiny">{ev.skill}</code>
        ) : (
          <span className="subtle">{ev.action ?? 'event'}</span>
        )}
        {ev.change_id && (
          <>
            {' '}
            on{' '}
            <button
              type="button"
              className="link-inline"
              onClick={() => onOpenEntry(ev.change_id as string)}
              style={linkStyle}
            >
              {ev.change_id}
            </button>
          </>
        )}{' '}
        <span className="subtle" style={{ color: exitOk ? undefined : 'var(--warning-text)' }}>
          {ev.action ? `· ${ev.action}` : ''}
          {ev.cost_usd != null ? ` · $${ev.cost_usd.toFixed(2)}` : ''}
          {!exitOk ? ` · exit ${ev.exit_status}` : ''}
        </span>
      </span>
    );
  }
  return <span className="subtle">{item.kind}</span>;
}

function BacklinkSection({
  title,
  emptyHint,
  groups,
  onOpenEntry,
}: {
  title: string;
  emptyHint: React.ReactNode;
  groups: Record<string, BacklinkRef[]>;
  onOpenEntry: (id: string) => void;
}) {
  // Ordered groups first (BACKLINK_GROUP_ORDER), then any kinds NOT in that
  // list under an "other" bucket so new archetypes don't silently disappear
  // from the UI — a recurring bug shape (count includes everything, render
  // only walks the known list).
  const knownKinds = new Set(BACKLINK_GROUP_ORDER);
  const otherEntries: Array<[string, BacklinkRef[]]> = Object.entries(groups)
    .filter(([k, v]) => !knownKinds.has(k) && v.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const orderedKinds: string[] = BACKLINK_GROUP_ORDER.filter((k) => (groups[k]?.length ?? 0) > 0);
  const total =
    orderedKinds.reduce((n, k) => n + (groups[k]?.length ?? 0), 0) +
    otherEntries.reduce((n, [, v]) => n + v.length, 0);

  const renderGroup = (kind: string, items: BacklinkRef[]) => (
    <div key={kind}>
      <div
        className="tiny"
        style={{
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 4,
        }}
      >
        {kind} ({items.length})
      </div>
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
        {items.map((b) => (
          <li key={b.path} style={{ padding: '4px 0', fontSize: 12.5 }}>
            <button type="button" onClick={() => onOpenEntry(b.id)} style={linkStyle}>
              <strong>{b.title}</strong>
            </button>
            {b.updated && (
              <span className="tiny" style={{ marginLeft: 8 }}>
                {' · '}
                <span title={b.updated}>{formatRelative(b.updated)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <Section title={`${title} (${total})`}>
      {total === 0 ? (
        <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
          {emptyHint}
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {orderedKinds.map((kind) => renderGroup(kind, groups[kind] as BacklinkRef[]))}
          {otherEntries.map(([kind, items]) => renderGroup(kind, items))}
        </div>
      )}
    </Section>
  );
}

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--accent)',
  cursor: 'pointer',
  fontSize: 12.5,
  textAlign: 'left',
};

// ─── Plan tab ────────────────────────────────────────────────────────────────
//
// State-aware Plan tab — mirrors the change-detail page's banner + stepper +
// artifact-card pattern, scoped to the project plan lifecycle. Drives the
// state machine off `project.plan_status` (canonical enum from
// `archetype-project.md`).

interface PlanMaterial {
  name: string;
  path: string;
  size: number;
  mtime: string;
}

interface MaterialsResponse {
  ok: boolean;
  materials: PlanMaterial[];
  error?: string;
}

function ProjectPlanTab({
  project,
  researchReports,
  currentCostUsd,
  onSetTab,
  onRefetchDetail,
}: {
  project: ProjectSummary;
  researchReports: ResearchReportRef[];
  currentCostUsd: number;
  onSetTab: (t: ProjectTabId) => void;
  onRefetchDetail: () => void;
}) {
  const dispatchCtx = useDispatch();
  const projectId = project.id ?? '';
  const [dispatching, setDispatching] = useState(false);
  const [wikilinkPicks, setWikilinkPicks] = useState<string[]>([]);
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);

  function openProjectDrawer() {
    if (!projectId) return;
    dispatchCtx.setDrawerFilter({ project: projectId });
    dispatchCtx.setDrawerOpen(true);
  }

  async function postOk(
    path: string,
    body: unknown,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) return { ok: false, error: j.error ?? `request failed (${r.status})` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function startResearch(prompt: string): Promise<boolean> {
    if (!projectId) return false;
    setDispatching(true);
    try {
      const res = await postOk(`/api/projects/${encodeURIComponent(projectId)}/research`, {
        prompt,
        materials: { wikilinks: wikilinkPicks },
      });
      if (!res.ok) {
        alert(`Start research failed: ${res.error}`);
        return false;
      }
      openProjectDrawer();
      // The skill flips plan_status to in-research as it runs; useRunTerminal
      // in the parent refetches on completion. Refetch now so the banner
      // updates promptly without waiting for the run to finish.
      onRefetchDetail();
      return true;
    } finally {
      setDispatching(false);
    }
  }

  async function reviewPlan() {
    if (!projectId) return;
    setDispatching(true);
    try {
      const res = await postOk(`/api/projects/${encodeURIComponent(projectId)}/plan/review`, {});
      if (!res.ok) {
        alert(`Review failed: ${res.error}`);
        return;
      }
      openProjectDrawer();
      onRefetchDetail();
    } finally {
      setDispatching(false);
    }
  }

  async function revisePlan() {
    if (!projectId) return;
    setDispatching(true);
    try {
      const res = await postOk(`/api/projects/${encodeURIComponent(projectId)}/plan/revise`, {});
      if (!res.ok) {
        alert(`Revise failed: ${res.error}`);
        return;
      }
      openProjectDrawer();
      onRefetchDetail();
    } finally {
      setDispatching(false);
    }
  }

  async function scaffoldFromReport(reportId: string) {
    setDispatching(true);
    try {
      const res = await postOk(
        `/api/research/${encodeURIComponent(reportId)}/scaffold-recommendations`,
        {},
      );
      if (!res.ok) {
        alert(`Scaffold from report failed: ${res.error}`);
        return;
      }
      openProjectDrawer();
      onRefetchDetail();
    } finally {
      setDispatching(false);
    }
  }

  async function scaffold(items: string[]): Promise<boolean> {
    if (!projectId) return false;
    setDispatching(true);
    try {
      const res = await postOk(`/api/projects/${encodeURIComponent(projectId)}/plan/scaffold`, {
        items,
      });
      if (!res.ok) {
        alert(`Scaffold failed: ${res.error}`);
        return false;
      }
      openProjectDrawer();
      onRefetchDetail();
      return true;
    } finally {
      setDispatching(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ProjectPlanStateBanner
        project={project}
        hasResearchReports={researchReports.length > 0}
        dispatching={dispatching}
        onStartResearch={() => setResearchOpen(true)}
        onReviewPlan={reviewPlan}
        onRevisePlan={revisePlan}
        onReReview={reviewPlan}
        onScaffold={() => setScaffoldOpen(true)}
        onReResearch={() => setResearchOpen(true)}
        onOpenChangesTab={() => onSetTab('changes')}
      />

      {researchOpen && (
        <StartResearchForm
          projectId={projectId}
          materialsWikilinks={wikilinkPicks}
          dispatching={dispatching}
          onCancel={() => setResearchOpen(false)}
          onSubmit={async (prompt) => {
            const ok = await startResearch(prompt);
            if (ok) setResearchOpen(false);
          }}
        />
      )}

      <ProjectPlanLifecycleStepper
        // Prefer the derived value when present — it reflects the actual
        // research-driven flow state (research-write → review → approve →
        // scaffold-recommendations), which doesn't touch the frontmatter
        // `plan_status` field. Falls back to frontmatter for legacy plan flow.
        planStatus={project.plan_status_derived ?? project.plan_status}
        planRevision={project.plan_revision}
        projectId={projectId}
        projectStatus={project.status}
      />

      {researchReports.length > 0 && (
        <ProjectPlanResearchReportsCard
          reports={researchReports}
          dispatching={dispatching}
          onOpenReport={(id) => {
            window.location.href = `/research/${encodeURIComponent(id)}`;
          }}
          onScaffoldFromReport={scaffoldFromReport}
        />
      )}

      {project.plan_path && (
        <ProjectPlanArtifactCard
          planPath={project.plan_path}
          planRevision={project.plan_revision}
          planRevisedAt={project.plan_revised_at}
          planGeneratedAt={project.plan_generated_at}
        />
      )}

      {project.plan_review_path && (
        <ProjectPlanReviewCard
          reviewPath={project.plan_review_path}
          planStatus={project.plan_status}
          planRevisedAt={project.plan_revised_at}
          planReviewedAt={project.plan_reviewed_at}
          dispatching={dispatching}
          onApplyFindings={revisePlan}
          onReReview={reviewPlan}
        />
      )}

      <ProjectMaterialsSection
        projectId={projectId}
        wikilinkPicks={wikilinkPicks}
        setWikilinkPicks={setWikilinkPicks}
      />

      {scaffoldOpen && project.plan_path && (
        <ScaffoldPlanDialog
          projectId={projectId}
          planPath={project.plan_path}
          currentCostUsd={currentCostUsd}
          dispatching={dispatching}
          onClose={() => setScaffoldOpen(false)}
          onSubmit={async (items) => {
            const ok = await scaffold(items);
            if (ok) setScaffoldOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ProjectPlanStateBanner({
  project,
  hasResearchReports,
  dispatching,
  onStartResearch,
  onReviewPlan,
  onRevisePlan,
  onReReview,
  onScaffold,
  onReResearch,
  onOpenChangesTab,
}: {
  project: ProjectSummary;
  hasResearchReports: boolean;
  dispatching: boolean;
  onStartResearch: () => void;
  onReviewPlan: () => void;
  onRevisePlan: () => void;
  onReReview: () => void;
  onScaffold: () => void;
  onReResearch: () => void;
  onOpenChangesTab: () => void;
}) {
  const status = project.plan_status ?? 'pending';
  let hint: React.ReactNode;
  let primary: { label: string; onClick: () => void; tooltip: string } | null = null;
  let secondary: { label: string; onClick: () => void; tooltip: string } | null = null;
  let bg = 'var(--bg-2)';

  switch (status) {
    case 'pending':
      hint = hasResearchReports ? (
        <>
          <strong>Research-driven project.</strong> Spec already exists via{' '}
          <code>/research-write</code> — see the Research reports card below to scaffold
          recommendations. The legacy plan flow below is optional for projects on this lifecycle.
        </>
      ) : (
        <>
          <strong>No plan yet.</strong> Add a research prompt + materials below, then start research
          to draft the plan.
        </>
      );
      primary = hasResearchReports
        ? null
        : {
            label: 'Start research',
            onClick: onStartResearch,
            tooltip:
              'Opens a small form to capture a research prompt. POSTs /research with your prompt + the accumulated materials wikilinks.',
          };
      break;
    case 'in-research':
      hint = (
        <>
          <strong>Research running.</strong> Watch the drawer for live output. The plan will appear
          once the skill finishes writing it.
        </>
      );
      bg = 'var(--accent-soft)';
      break;
    case 'reviewed-pending':
      hint = (
        <>
          <strong>
            Plan written
            {project.plan_revision != null && project.plan_revision > 1
              ? ` (revision ${project.plan_revision})`
              : ''}
            .
          </strong>{' '}
          Review it before approving.
        </>
      );
      primary = {
        label: 'Review plan',
        onClick: onReviewPlan,
        tooltip:
          'Runs meta-review-project-plan: walks the plan + cited repos + project body, produces a structured verdict.',
      };
      break;
    case 'request-changes':
      hint = (
        <>
          <strong>Review found concerns.</strong> Revise the plan to address them, or override by
          editing plan_status to approved.
        </>
      );
      primary = {
        label: 'Revise plan',
        onClick: onRevisePlan,
        tooltip:
          'Runs meta-revise-project-plan: folds the review verdict back into the plan in place, bumps plan_revision, resets plan_status to reviewed-pending.',
      };
      secondary = {
        label: 'Re-review',
        onClick: onReReview,
        tooltip: 'Re-run review against the current plan without revising first.',
      };
      bg = 'var(--warning-soft, var(--bg-2))';
      break;
    case 'approved':
      hint = (
        <>
          <strong>Plan approved.</strong> Click Scaffold to create the changes / schedules / reports
          the plan proposes.
        </>
      );
      primary = {
        label: 'Scaffold…',
        onClick: onScaffold,
        tooltip:
          'Opens the Scaffold dialog: per-item checkboxes for every Proposed change / schedule / reporting-cadence / touchpoint in the plan.',
      };
      break;
    case 'scaffolded':
      hint = (
        <>
          <strong>Children scaffolded.</strong> Re-run research to add another iteration, or jump to
          the Changes tab to inspect the spawned work.
        </>
      );
      primary = {
        label: 'Re-research',
        onClick: onReResearch,
        tooltip:
          'Restart research to refresh the plan. Research is restartable post-scaffold per the plan_status lifecycle.',
      };
      secondary = {
        label: 'Open Changes tab',
        onClick: onOpenChangesTab,
        tooltip: 'Jump to the Changes tab to inspect scaffolded children.',
      };
      break;
    case 'active':
      hint = (
        <>
          <strong>Project active</strong> — children running. Re-research to add an iteration, or
          jump to the Changes tab to track progress.
        </>
      );
      primary = {
        label: 'Re-research',
        onClick: onReResearch,
        tooltip:
          'Restart research. Research is restartable post-scaffold per the plan_status lifecycle.',
      };
      secondary = {
        label: 'Open Changes tab',
        onClick: onOpenChangesTab,
        tooltip: 'Jump to the Changes tab to track running children.',
      };
      break;
    default:
      hint = (
        <>
          <strong>plan_status: {status}</strong>. No standard action for this state — edit the
          project entry to fix.
        </>
      );
  }

  return (
    <div
      className="card"
      style={{
        padding: 14,
        background: bg,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ flex: 1, fontSize: 13, lineHeight: 1.5, minWidth: 240 }}>{hint}</span>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {secondary && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={secondary.onClick}
            disabled={dispatching}
            title={secondary.tooltip}
          >
            {secondary.label}
          </button>
        )}
        {primary && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={primary.onClick}
            disabled={dispatching}
            title={primary.tooltip}
          >
            {dispatching ? 'Working…' : primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

type PlanStageStatus = 'done' | 'current' | 'pending';

interface PlanStage {
  id: string;
  label: string;
  status: PlanStageStatus;
}

const PLAN_STAGE_ORDER: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'pending', label: 'pending' },
  { id: 'in-research', label: 'in-research' },
  { id: 'reviewed-pending', label: 'reviewed-pending' },
  { id: 'approved', label: 'approved' },
  { id: 'scaffolded', label: 'scaffolded' },
  { id: 'active', label: 'active' },
];

// Step → event_type mapping moved to vault/wiki/_seed/meta/reference/
// event-catalog.md (the `lifecycle_step` column with values `project:<id>`).
// Single source of truth — fetched + queried via findEventForStep below.

// ── Changes lifecycle stepper ────────────────────────────────────────────────
//
// Distribution view across the change lifecycle. The plan-lifecycle stepper's
// `active` stage compresses everything from "first change in-progress" to
// "5 of 6 merged" into one cell; this expands that into a per-stage count.
//
// Stages from archetype-change: planning → in-progress → in-review → merged
// with `abandoned` as a terminal failure off the main line. The `abandoned`
// cell is always present (muted when zero) so layout stays stable and
// abandonments stand out when they happen.
const CHANGE_LIFECYCLE_STAGES: ReadonlyArray<{
  id: string;
  label: string;
  tooltip: string;
}> = [
  {
    id: 'planning',
    label: 'planning',
    tooltip: 'Scaffolded, body being refined; not yet dispatched to dev-write-change.',
  },
  {
    id: 'in-progress',
    label: 'in-progress',
    tooltip: 'dev-write-change running or completed; code committed locally, PR not yet opened.',
  },
  {
    id: 'in-review',
    label: 'in-review',
    tooltip: 'PR opened; review skill running or awaiting verdict.',
  },
  { id: 'merged', label: 'merged', tooltip: 'PR merged. Terminal success.' },
  {
    id: 'abandoned',
    label: 'abandoned',
    tooltip: 'Change explicitly dropped. Terminal failure path.',
  },
];

function ChangesLifecycleStepper({ changes }: { changes: OwnedChangeRef[] }) {
  const total = changes.length;
  const counts: Record<string, number> = {};
  for (const c of changes) {
    const s = c.status ?? 'planning';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const merged = counts.merged ?? 0;
  const percent = total > 0 ? Math.round((merged / total) * 100) : 0;

  return (
    <section
      className="card"
      style={{
        padding: 0,
        marginBottom: 14,
      }}
    >
      <div
        className="card-header"
        style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}
      >
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Changes lifecycle</h4>
        <span className="tiny" style={{ color: 'var(--muted)' }}>
          {merged} of {total} merged {total > 0 ? `· ${percent}%` : ''}
        </span>
      </div>
      <div style={{ padding: '12px 16px 14px' }}>
        {/* Progress bar — headline metric per the design lock. */}
        <div
          style={{
            position: 'relative',
            height: 8,
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'hidden',
            marginBottom: 14,
          }}
          title={`${merged} of ${total} changes merged (${percent}%)`}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${percent}%`,
              background: 'var(--success)',
              transition: 'width 200ms ease',
            }}
          />
        </div>
        {/* Stage cells — always 5, muted when count is 0. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 8,
          }}
        >
          {CHANGE_LIFECYCLE_STAGES.map((stage) => {
            const count = counts[stage.id] ?? 0;
            const hasItems = count > 0;
            const isMerged = stage.id === 'merged';
            const isAbandoned = stage.id === 'abandoned';
            return (
              <div
                key={stage.id}
                title={stage.tooltip}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  background: hasItems
                    ? isAbandoned
                      ? 'var(--danger-soft)'
                      : isMerged
                        ? 'var(--success-soft)'
                        : 'var(--accent-soft)'
                    : 'transparent',
                  opacity: hasItems ? 1 : 0.55,
                  transition: 'background 200ms ease, opacity 200ms ease',
                }}
              >
                <div
                  className="tiny"
                  style={{
                    fontSize: 10.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--muted)',
                    marginBottom: 2,
                  }}
                >
                  {stage.label}
                </div>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    color: hasItems
                      ? isAbandoned
                        ? 'var(--danger-text)'
                        : isMerged
                          ? 'var(--success-text)'
                          : 'var(--text)'
                      : 'var(--subtle)',
                  }}
                >
                  {count}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ProjectPlanLifecycleStepper({
  planStatus,
  planRevision,
  projectId,
  projectStatus,
}: {
  planStatus: string | null;
  planRevision: number | null;
  projectId: string;
  // When the project itself is `completed`, every plan stage renders as done
  // regardless of `plan_status`. Mirrors ProjectPhaseTimeline's behavior so
  // the two steppers stay consistent on terminal projects.
  projectStatus: string | null;
}) {
  const navigate = useNavigate();
  const [subscriptionMap, setSubscriptionMap] = useState<Map<string, string>>(() => new Map());
  const [catalog, setCatalog] = useState<EventCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listRules(), getEventCatalog()])
      .then(([rules, cat]) => {
        if (cancelled) return;
        setSubscriptionMap(buildSubscriptionMap(rules.rules, projectId || null));
        setCatalog(cat.entries);
      })
      .catch(() => {
        if (cancelled) return;
        setSubscriptionMap(new Map());
        setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const status = planStatus ?? 'pending';
  const currentIdx = PLAN_STAGE_ORDER.findIndex((s) => s.id === status);
  // request-changes is a side branch from reviewed-pending — main strip
  // shows pending+in-research as done and reviewed-pending as current.
  const isSideBranch = status === 'request-changes';
  // Terminal-project special-case: completed projects show every stage as
  // done. Without this, a completed project with `plan_status: active` would
  // render "5 of 6 complete" forever (active as current) — misleading.
  const isCompleted = projectStatus === 'completed';
  const stages: PlanStage[] = PLAN_STAGE_ORDER.map((s, i) => {
    if (isCompleted) {
      return { ...s, status: 'done' };
    }
    if (isSideBranch) {
      return {
        ...s,
        status: i < 2 ? 'done' : i === 2 ? 'current' : 'pending',
      };
    }
    if (currentIdx === -1) {
      return { ...s, status: 'pending' };
    }
    return {
      ...s,
      status: i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'pending',
    };
  });

  const doneCount = stages.filter((s) => s.status === 'done').length;

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Plan lifecycle</h4>
        <span className="tiny">
          {doneCount} of {stages.length} complete
          {planRevision != null && planRevision > 1 ? ` · plan revision ${planRevision}` : ''}
        </span>
      </div>
      <Stepper
        steps={stages.map((s) => {
          const eventType = findEventForStep(catalog, 'project', s.id);
          const subscribedRuleId = eventType ? (subscriptionMap.get(eventType) ?? null) : null;
          return {
            id: s.id,
            label: s.label,
            status: s.status,
            onNotify: eventType
              ? () => {
                  if (subscribedRuleId) {
                    navigate(`/notifications/rules/${encodeURIComponent(subscribedRuleId)}`);
                    return;
                  }
                  const params = new URLSearchParams({ event_type: eventType });
                  if (projectId) params.set('filter_project', projectId);
                  navigate(`/notifications/rules/new?${params.toString()}`);
                }
              : undefined,
            notifyHint: eventType
              ? subscribedRuleId
                ? `Edit existing rule for ${eventType}${projectId ? ` (project ${projectId})` : ''}`
                : `Notify on ${eventType}${projectId ? ` (filtered to project ${projectId})` : ''}`
              : null,
            subscribedRuleId,
          };
        })}
      />
      {isSideBranch && (
        <div
          className="tiny"
          style={{
            padding: '8px 16px 14px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-2)',
            color: 'var(--text-2)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span className="badge warning" style={{ fontSize: 10.5 }}>
            request-changes
          </span>
          <span>
            Side branch from reviewed-pending. Revise the plan (or override) to return to the
            mainline.
          </span>
        </div>
      )}
    </section>
  );
}

// PlanStageMarker + planStageColors deleted — superseded by shared Stepper
// (lifecycle-wiring Change 3 port).

function ProjectPlanArtifactCard({
  planPath,
  planRevision,
  planRevisedAt,
  planGeneratedAt,
}: {
  planPath: string;
  planRevision: number | null;
  planRevisedAt: string | null;
  planGeneratedAt: string | null;
}) {
  const navigate = useNavigate();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEntry(planPath)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [planPath]);

  const stamp = planRevisedAt ?? planGeneratedAt;
  const verb = planRevisedAt ? 'revised' : 'generated';

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Plan</h4>
        {planRevision != null && planRevision > 1 && (
          <span className="badge muted" style={{ fontSize: 10.5 }}>
            revision {planRevision}
          </span>
        )}
        {stamp && (
          <span className="tiny" title={stamp}>
            {verb} {formatRelative(stamp)}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setShowRaw((s) => !s)}
          title={
            showRaw
              ? 'Show the markdown-rendered view'
              : 'Show the raw markdown source (toggle for copy/paste)'
          }
        >
          {showRaw ? 'Rendered' : 'Raw'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            const slug = planPath.replace(/^vault\/(output|raw)\//, '');
            const prefix = planPath.startsWith('vault/output/') ? 'output' : 'raw';
            navigate(`/vault/${prefix}/${slug}`);
          }}
          title="Open the Vault app's output tab at this file"
        >
          <Icons.External size={11} /> Open in Vault
        </button>
      </div>
      <div style={{ padding: '0 16px' }}>
        {error && (
          <p className="tiny" style={{ padding: '14px 0', color: 'var(--danger-text)', margin: 0 }}>
            Failed to load: {error}
          </p>
        )}
        {!content && !error && (
          <p className="subtle" style={{ padding: '14px 0', fontSize: 12.5, margin: 0 }}>
            Loading…
          </p>
        )}
        {content &&
          (showRaw ? (
            <pre
              className="mono"
              style={{
                margin: 0,
                padding: '14px 0',
                background: 'transparent',
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--text-2)',
              }}
            >
              {content}
            </pre>
          ) : (
            <div style={{ padding: '4px 0 14px' }}>
              <EditableMarkdown path={planPath} content={content} onSaved={(c) => setContent(c)} />
            </div>
          ))}
      </div>
      <div
        className="tiny"
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-2)',
          color: 'var(--muted)',
        }}
      >
        <code className="mono">{planPath}</code>
      </div>
    </div>
  );
}

function ProjectPlanReviewCard({
  reviewPath,
  planStatus,
  planRevisedAt,
  planReviewedAt,
  dispatching,
  onApplyFindings,
  onReReview,
}: {
  reviewPath: string;
  planStatus: string | null;
  planRevisedAt: string | null;
  planReviewedAt: string | null;
  dispatching: boolean;
  onApplyFindings: () => void;
  onReReview: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchEntry(reviewPath)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reviewPath]);

  // Verdict badge is driven by plan_status (single source of truth), not by
  // parsing the markdown's first line. Same source of truth as the banner.
  let verdictBadge: { label: string; cls: string } | null = null;
  if (planStatus === 'request-changes') {
    verdictBadge = { label: 'request-changes', cls: 'badge warning' };
  } else if (
    planStatus === 'reviewed-pending' ||
    planStatus === 'approved' ||
    planStatus === 'scaffolded' ||
    planStatus === 'active'
  ) {
    verdictBadge = { label: 'approved', cls: 'badge success' };
  }

  const reviewIsStale =
    planRevisedAt != null && planReviewedAt != null && planRevisedAt > planReviewedAt;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Review</h4>
        {verdictBadge && (
          <span className={verdictBadge.cls} style={{ fontSize: 10.5 }}>
            {verdictBadge.label}
          </span>
        )}
        {reviewIsStale && (
          <span
            className="badge warning"
            style={{ fontSize: 10 }}
            title="Plan was revised after the most recent review — verdict describes the prior revision."
          >
            review stale
          </span>
        )}
        {planReviewedAt && (
          <span className="tiny" title={planReviewedAt}>
            reviewed {formatRelative(planReviewedAt)}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setShowRaw((s) => !s)}
          title={
            showRaw
              ? 'Show the markdown-rendered view'
              : 'Show the raw markdown source (toggle for copy/paste)'
          }
        >
          {showRaw ? 'Rendered' : 'Raw'}
        </button>
        {planStatus === 'request-changes' && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={onApplyFindings}
            disabled={dispatching}
            title="Runs meta-revise-project-plan: folds the review verdict into the plan, bumps plan_revision, resets plan_status to reviewed-pending."
          >
            <Icons.Refresh size={11} /> Apply findings
          </button>
        )}
        {reviewIsStale && planStatus !== 'request-changes' && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onReReview}
            disabled={dispatching}
            title="Re-run review against the revised plan."
          >
            Re-review
          </button>
        )}
      </div>
      <div style={{ padding: '0 16px' }}>
        {error && (
          <p className="tiny" style={{ padding: '14px 0', color: 'var(--danger-text)', margin: 0 }}>
            Failed to load: {error}
          </p>
        )}
        {!content && !error && (
          <p className="subtle" style={{ padding: '14px 0', fontSize: 12.5, margin: 0 }}>
            Loading…
          </p>
        )}
        {content &&
          (showRaw ? (
            <pre
              className="mono"
              style={{
                margin: 0,
                padding: '14px 0',
                background: 'transparent',
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--text-2)',
              }}
            >
              {content}
            </pre>
          ) : (
            <div style={{ padding: '4px 0 14px' }}>
              <Rendered content={content} />
            </div>
          ))}
      </div>
      <div
        className="tiny"
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-2)',
          color: 'var(--muted)',
        }}
      >
        <code className="mono">{reviewPath}</code>
      </div>
    </div>
  );
}

// Research-reports card on the Plan tab. Per
// decision-research-report-vs-project-plan (Inline option), the Plan tab
// renders research-reports as a first-class spec surface when project
// research_paths is populated. Stacks alongside (not instead of) the legacy
// plan_path artifact when both exist.
function ProjectPlanResearchReportsCard({
  reports,
  dispatching,
  onOpenReport,
  onScaffoldFromReport,
}: {
  reports: ResearchReportRef[];
  dispatching: boolean;
  onOpenReport: (id: string) => void;
  onScaffoldFromReport: (id: string) => void;
}) {
  // Sort newest-first so the most recent report is the most prominent.
  const sorted = [...reports].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, flex: 1 }}>
          Research reports
          {reports.length > 1 && (
            <span className="badge muted" style={{ fontSize: 10.5, marginLeft: 6 }}>
              {reports.length}
            </span>
          )}
        </h4>
        <span className="tiny subtle">
          Spec produced via <code>/research-write</code> · scaffold-from-recommendations to fan out
          changes.
        </span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {sorted.map((r) => {
          const fullyScaffolded =
            r.recommended_changes_count > 0 &&
            r.recommended_changes_scaffolded >= r.recommended_changes_count;
          const scaffoldDisabled =
            dispatching || r.recommended_changes_count === 0 || fullyScaffolded;
          const scaffoldTitle = dispatching
            ? 'Another skill run is in flight for this project. Wait for it to finish.'
            : r.recommended_changes_count === 0
              ? 'This report has no recommended_changes — nothing to scaffold.'
              : fullyScaffolded
                ? `All ${r.recommended_changes_count} recommendations already scaffolded. Re-running would no-op or prompt.`
                : `Dispatch research-scaffold-recommendations on this report. ${
                    r.recommended_changes_count - r.recommended_changes_scaffolded
                  } recommendation(s) remaining.`;
          return (
            <li
              key={r.id}
              style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenReport(r.id)}
                  style={{ padding: 0, textAlign: 'left', fontSize: 13, fontWeight: 500 }}
                  title={`Open /research/${r.id}`}
                >
                  {r.title}
                </button>
                <div
                  className="tiny subtle"
                  style={{ marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap' }}
                >
                  {r.status && <span>status: {r.status}</span>}
                  {r.review_status && <span>· review: {r.review_status}</span>}
                  {r.report_revision != null && r.report_revision > 1 && (
                    <span>· revision {r.report_revision}</span>
                  )}
                  {r.has_updates_pending && (
                    <span style={{ color: 'var(--warning-text)' }}>· updates pending</span>
                  )}
                </div>
              </div>
              <div
                className="tiny"
                style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-2)' }}
              >
                <span title="scaffolded / total recommendations">
                  {r.recommended_changes_scaffolded}/{r.recommended_changes_count} scaffolded
                </span>
                {r.recommended_changes_merged > 0 && (
                  <span style={{ color: 'var(--success-text)' }}>
                    {r.recommended_changes_merged} merged
                  </span>
                )}
                {r.recommended_changes_abandoned > 0 && (
                  <span className="subtle">{r.recommended_changes_abandoned} abandoned</span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onScaffoldFromReport(r.id)}
                disabled={scaffoldDisabled}
                title={scaffoldTitle}
              >
                <Icons.Sparkles size={11} /> {dispatching ? 'Working…' : 'Scaffold recommendations'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProjectMaterialsSection({
  projectId,
  wikilinkPicks,
  setWikilinkPicks,
}: {
  projectId: string;
  wikilinkPicks: string[];
  setWikilinkPicks: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [materials, setMaterials] = useState<PlanMaterial[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [urlsDraft, setUrlsDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ManifestEntry[] | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [wikilinkQuery, setWikilinkQuery] = useState('');

  const refreshMaterials = useCallback(async () => {
    if (!projectId) return;
    try {
      const r = await getJson<MaterialsResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/materials`,
      );
      setMaterials(r.materials ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    refreshMaterials();
  }, [refreshMaterials]);

  async function loadManifestOnce() {
    if (manifest != null || manifestError != null) return;
    try {
      const m = await fetchManifest();
      setManifest(m.entries);
    } catch (e) {
      setManifestError(e instanceof Error ? e.message : String(e));
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0 || !projectId) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        const content = await readFileAsBase64(file);
        const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/materials`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'file',
            filename: file.name,
            content,
            content_encoding: 'base64',
          }),
        });
        const j = (await r.json()) as { ok: boolean; error?: string };
        if (!j.ok) {
          setUploadError(j.error ?? `upload failed for ${file.name}`);
          break;
        }
      }
      await refreshMaterials();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function submitUrls() {
    if (!projectId) return;
    const urls = urlsDraft
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (urls.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/materials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'url', urls }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!j.ok) {
        setUploadError(j.error ?? 'url fetch failed');
        return;
      }
      setUrlsDraft('');
      await refreshMaterials();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  const filteredManifest = useMemo(() => {
    if (!manifest) return [];
    const q = wikilinkQuery.trim().toLowerCase();
    if (!q) return manifest.slice(0, 50);
    return manifest
      .filter((e) => {
        if (!e.id) return false;
        if (wikilinkPicks.includes(e.id)) return false;
        const idMatch = e.id.toLowerCase().includes(q);
        const titleMatch = (e.title ?? '').toLowerCase().includes(q);
        return idMatch || titleMatch;
      })
      .slice(0, 50);
  }, [manifest, wikilinkQuery, wikilinkPicks]);

  function addWikilink(id: string) {
    if (!id || wikilinkPicks.includes(id)) return;
    setWikilinkPicks((prev) => [...prev, id]);
    setWikilinkQuery('');
  }

  function removeWikilink(id: string) {
    setWikilinkPicks((prev) => prev.filter((x) => x !== id));
  }

  return (
    <Section title={`Materials (${materials.length})`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div
            className="tiny"
            style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}
          >
            Files
          </div>
          <input
            type="file"
            multiple
            disabled={uploading || !projectId}
            onChange={(e) => uploadFiles(e.target.files)}
            style={{ fontSize: 12.5 }}
          />
        </div>

        <div>
          <div
            className="tiny"
            style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}
          >
            URLs (one per line)
          </div>
          <textarea
            value={urlsDraft}
            onChange={(e) => setUrlsDraft(e.target.value)}
            disabled={uploading || !projectId}
            rows={3}
            placeholder="https://example.com/doc&#10;https://other.com/post"
            style={{ width: '100%', fontSize: 12.5, padding: '6px 8px', fontFamily: 'inherit' }}
          />
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={submitUrls}
              disabled={uploading || !projectId || urlsDraft.trim().length === 0}
            >
              {uploading ? 'Fetching…' : 'Fetch URLs'}
            </button>
          </div>
        </div>

        <div>
          <div
            className="tiny"
            style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}
          >
            Wikilinks ({wikilinkPicks.length})
          </div>
          {wikilinkPicks.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {wikilinkPicks.map((id) => (
                <span
                  key={id}
                  className="badge muted"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}
                >
                  <code className="mono" style={{ fontSize: 10.5 }}>
                    {id}
                  </code>
                  <button
                    type="button"
                    onClick={() => removeWikilink(id)}
                    aria-label={`Remove ${id}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--muted)',
                      padding: 0,
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text"
            value={wikilinkQuery}
            placeholder={
              manifest ? 'search vault entries by id or title…' : 'click to load vault index…'
            }
            onFocus={loadManifestOnce}
            onChange={(e) => setWikilinkQuery(e.target.value)}
            list={`wikilink-picker-${projectId}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && wikilinkQuery.trim()) {
                addWikilink(wikilinkQuery.trim());
              }
            }}
            style={{ width: '100%', fontSize: 12.5, padding: '6px 8px' }}
          />
          {manifest && (
            <datalist id={`wikilink-picker-${projectId}`}>
              {filteredManifest.map((e) => (
                <option key={e.path} value={e.id ?? ''}>
                  {e.title ?? e.id ?? e.path}
                </option>
              ))}
            </datalist>
          )}
          {manifestError && (
            <p className="tiny" style={{ color: 'var(--danger-text)', marginTop: 4 }}>
              Wikilink index failed to load ({manifestError}). You can still type an id manually and
              hit Enter.
            </p>
          )}
        </div>

        {uploadError && (
          <p className="tiny" style={{ color: 'var(--danger-text)', margin: 0 }}>
            {uploadError}
          </p>
        )}

        <div>
          <div
            className="tiny"
            style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}
          >
            Current files ({materials.length})
          </div>
          {loadError ? (
            <p className="tiny" style={{ color: 'var(--danger-text)', margin: 0 }}>
              Failed to list materials: {loadError}
            </p>
          ) : materials.length === 0 ? (
            <p className="subtle tiny" style={{ margin: 0 }}>
              No materials yet. Drop files above or paste URLs.
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
              {materials.map((m) => (
                <li
                  key={m.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    padding: '4px 0',
                  }}
                >
                  <code
                    className="mono"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {m.name}
                  </code>
                  <span className="tiny subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatBytes(m.size)}
                  </span>
                  <span className="tiny subtle" title={m.mtime}>
                    {formatRelative(m.mtime)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}

function StartResearchForm({
  projectId,
  materialsWikilinks,
  dispatching,
  onCancel,
  onSubmit,
}: {
  projectId: string;
  materialsWikilinks: string[];
  dispatching: boolean;
  onCancel: () => void;
  onSubmit: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  return (
    <div
      className="card"
      style={{
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--bg-2)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>Start research</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={dispatching || !projectId}
        rows={4}
        placeholder="What should research focus on? (e.g. survey the dashboard's current scheduler UX, identify gaps, propose changes)"
        style={{ width: '100%', fontSize: 12.5, padding: '8px 10px', fontFamily: 'inherit' }}
        autoFocus
      />
      {materialsWikilinks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <span className="tiny subtle">materials:</span>
          {materialsWikilinks.map((id) => (
            <span key={id} className="badge muted" style={{ fontSize: 10.5 }}>
              <code className="mono" style={{ fontSize: 10 }}>
                {id}
              </code>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => onSubmit(prompt.trim())}
          disabled={dispatching || !projectId || prompt.trim().length === 0}
        >
          {dispatching ? 'Dispatching…' : 'Start research'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={dispatching}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Markdown section parser shared with meta-scaffold-project-plan's contract.
// Walks the plan markdown looking for the four canonical sections and
// extracts each numbered/bulleted item into a {kind, n, label, raw} record
// with a stable id of `<kind>-<n>` so the server can correlate the picks.
interface ProposedItem {
  id: string;
  kind: 'change' | 'schedule' | 'reporting-cadence' | 'touchpoint';
  label: string;
  raw: string;
}

const PROPOSED_SECTIONS: ReadonlyArray<{
  heading: string;
  kind: ProposedItem['kind'];
}> = [
  { heading: 'Proposed changes', kind: 'change' },
  { heading: 'Proposed schedules', kind: 'schedule' },
  { heading: 'Reporting cadence', kind: 'reporting-cadence' },
  { heading: 'Reporting touchpoints', kind: 'touchpoint' },
];

function parseProposedItems(markdown: string): {
  items: ProposedItem[];
  unparseableSections: string[];
} {
  const lines = markdown.split('\n');
  const items: ProposedItem[] = [];
  const unparseableSections: string[] = [];

  for (const { heading, kind } of PROPOSED_SECTIONS) {
    const sectionStart = lines.findIndex(
      (l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`,
    );
    if (sectionStart < 0) continue;

    let i = sectionStart + 1;
    let count = 0;
    let buffer: string[] | null = null;

    function flush() {
      if (!buffer) return;
      count += 1;
      const raw = buffer.join('\n');
      const firstLine = (buffer[0] ?? '').replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim();
      const label = (firstLine || '(unnamed item)').slice(0, 200);
      items.push({ id: `${kind}-${count}`, kind, label, raw });
      buffer = null;
    }

    while (i < lines.length && !lines[i].startsWith('## ')) {
      const line = lines[i];
      const isNewItem = /^\s*(?:\d+[.)]\s+|[-*]\s+)/.test(line);
      if (isNewItem) {
        flush();
        buffer = [line];
      } else if (buffer) {
        buffer.push(line);
      }
      i += 1;
    }
    flush();

    if (count === 0) {
      unparseableSections.push(heading);
      console.warn(`parseProposedItems: section "${heading}" present but yielded 0 items`);
    }
  }

  return { items, unparseableSections };
}

function ScaffoldPlanDialog({
  projectId,
  planPath,
  currentCostUsd,
  dispatching,
  onClose,
  onSubmit,
}: {
  projectId: string;
  planPath: string;
  currentCostUsd: number;
  dispatching: boolean;
  onClose: () => void;
  onSubmit: (items: string[]) => void;
}) {
  const [items, setItems] = useState<ProposedItem[]>([]);
  const [unparseable, setUnparseable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchEntry(planPath)
      .then((r) => {
        if (cancelled) return;
        const parsed = parseProposedItems(r.content);
        setItems(parsed.items);
        setUnparseable(parsed.unparseableSections);
        // Default-check all items.
        setChecked(new Set(parsed.items.map((it) => it.id)));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [planPath]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const checkedCount = checked.size;
  const grouped = useMemo(() => {
    const out: Record<ProposedItem['kind'], ProposedItem[]> = {
      change: [],
      schedule: [],
      'reporting-cadence': [],
      touchpoint: [],
    };
    for (const it of items) out[it.kind].push(it);
    return out;
  }, [items]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 92vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
        }}
      >
        <div className="card-header">
          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Scaffold plan items</h4>
          <span className="tiny subtle">
            Project cost so far: <strong>${currentCostUsd.toFixed(2)}</strong>
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onClose}
            disabled={dispatching}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
          {loading && (
            <p className="subtle tiny" style={{ margin: 0 }}>
              Loading plan…
            </p>
          )}
          {error && (
            <p className="tiny" style={{ color: 'var(--danger-text)', margin: 0 }}>
              Failed to load plan: {error}
            </p>
          )}
          {!loading && !error && items.length === 0 && (
            <p className="subtle tiny" style={{ margin: 0 }}>
              No scaffoldable items found in the plan. Check that the plan has at least one of:
              <code className="mono"> ## Proposed changes</code>,{' '}
              <code className="mono">## Proposed schedules</code>,{' '}
              <code className="mono">## Reporting cadence</code>,{' '}
              <code className="mono">## Reporting touchpoints</code>.
            </p>
          )}
          {unparseable.length > 0 && (
            <p className="tiny" style={{ color: 'var(--warn-text)', margin: '0 0 10px' }}>
              ⚠ {unparseable.length} section
              {unparseable.length !== 1 ? 's' : ''} present but yielded 0 items:{' '}
              {unparseable.join(', ')}. Open the plan in Vault to inspect formatting.
            </p>
          )}
          {!loading &&
            items.length > 0 &&
            (['change', 'schedule', 'reporting-cadence', 'touchpoint'] as const).map((kind) => {
              const group = grouped[kind];
              if (group.length === 0) return null;
              return (
                <div key={kind} style={{ marginBottom: 14 }}>
                  <div
                    className="tiny"
                    style={{
                      textTransform: 'uppercase',
                      letterSpacing: 0.4,
                      marginBottom: 4,
                    }}
                  >
                    {kindLabel(kind)} ({group.length})
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {group.map((it) => (
                      <li
                        key={it.id}
                        style={{
                          padding: '6px 0',
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          fontSize: 12.5,
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(it.id)}
                          onChange={() => toggle(it.id)}
                          disabled={dispatching}
                          style={{ marginTop: 3 }}
                        />
                        <span style={{ flex: 1 }}>{it.label}</span>
                        <code className="mono tiny subtle">{it.id}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
        </div>
        <div
          className="card-header"
          style={{
            borderTop: '1px solid var(--border)',
            borderBottom: 'none',
            background: 'var(--bg-2)',
          }}
        >
          <span className="tiny subtle">
            {checkedCount} of {items.length} selected
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={dispatching}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => onSubmit(Array.from(checked))}
            disabled={dispatching || checkedCount === 0}
          >
            {dispatching
              ? 'Dispatching…'
              : `Scaffold ${checkedCount} item${checkedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function kindLabel(kind: ProposedItem['kind']): string {
  switch (kind) {
    case 'change':
      return 'Proposed changes';
    case 'schedule':
      return 'Proposed schedules';
    case 'reporting-cadence':
      return 'Reporting cadence';
    case 'touchpoint':
      return 'Reporting touchpoints';
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      // result is a data URL like `data:<mime>;base64,<payload>` — strip the prefix.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
