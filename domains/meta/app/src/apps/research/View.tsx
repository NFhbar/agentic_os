// Research — top-level routing between the list view (/research) and a
// per-report detail view (/research/:id). Mirrors PR Review's shape.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { Toast } from '../../shared';
import '../../shared/styles.css';
import type { ResearchReportDetail, ResearchReportSummary } from './data';
import { AddPage } from './pages/Add';
import { DetailPage } from './pages/Detail';
import { ListPage } from './pages/List';

interface ProjectChip {
  id: string;
  name: string;
}

export default function Research() {
  const navigate = useNavigate();
  // URL shape (mounted at /research/* by App.tsx):
  //   ''             → list view
  //   'new'          → add page (replaces the prior AddResearchReportModal)
  //   '<id>'         → detail view for that report id
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const reportId = useMemo(() => {
    const parts = splat.split('/').filter(Boolean);
    const first = parts[0] ?? null;
    // Treat 'new' as a sentinel route, not a report id.
    return first === 'new' ? null : first;
  }, [splat]);
  const isAddPage = useMemo(() => {
    const parts = splat.split('/').filter(Boolean);
    return parts[0] === 'new';
  }, [splat]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [reports, setReports] = useState<ResearchReportSummary[]>([]);
  const [detail, setDetail] = useState<ResearchReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [projects, setProjects] = useState<ProjectChip[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // Legacy URL migration: `?add=1&project=<id>` used to open a modal in place.
  // Phase 4.x replaced the modal with /research/new — redirect old links so
  // bookmarks and stale buttons keep working. Strips the params + navigates
  // once on mount.
  useEffect(() => {
    if (searchParams.get('add') === '1') {
      const proj = searchParams.get('project');
      navigate(proj ? `/research/new?project=${encodeURIComponent(proj)}` : '/research/new', {
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { startSkillRun, runs, setDrawerFilter, setDrawerOpen } = useDispatch();

  // Bespoke server endpoints (research/:id/update, /write, /scaffold-recommendations)
  // dispatch via the server's startRun, NOT the client's startSkillRun helper, so the
  // drawer state isn't auto-updated. Pages that call those endpoints use this helper
  // to mirror startSkillRun's drawer behavior: pick the most relevant tag and open.
  function showDispatchInDrawer(tags: {
    change_id?: string | null;
    project?: string | null;
    repo?: string | null;
    skill?: string | null;
  }) {
    if (tags.change_id) setDrawerFilter({ change_id: tags.change_id });
    else if (tags.project) setDrawerFilter({ project: tags.project });
    else if (tags.repo) setDrawerFilter({ repo: tags.repo });
    else if (tags.skill) setDrawerFilter({ skill: tags.skill });
    else setDrawerFilter({});
    setDrawerOpen(true);
  }

  const dispatching = useMemo(
    () =>
      runs.some((r) => r.domain === 'research' && (r.state === 'queued' || r.state === 'running')),
    [runs],
  );

  function toast(msg: string) {
    setToastMsg(msg);
  }

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 2400);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const refreshReports = useCallback(async () => {
    try {
      const r = await fetch('/api/research');
      if (!r.ok) return;
      const j = (await r.json()) as { reports: ResearchReportSummary[] };
      setReports(j.reports ?? []);
    } catch {
      /* silent */
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const r = await fetch('/api/projects');
      if (!r.ok) return;
      const j = (await r.json()) as { projects: Array<{ id: string; title?: string }> };
      const chips: ProjectChip[] = (j.projects ?? []).map((p) => ({
        id: p.id,
        name: p.title ?? p.id,
      }));
      setProjects(chips);
    } catch {
      /* silent */
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/research/${encodeURIComponent(id)}`);
      if (!r.ok) {
        setDetail(null);
        return;
      }
      const j = (await r.json()) as ResearchReportDetail;
      setDetail(j);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshReports();
    refreshProjects();
  }, [refreshReports, refreshProjects]);

  useEffect(() => {
    if (!reportId) {
      setDetail(null);
      return;
    }
    refreshDetail(reportId);
  }, [reportId, refreshDetail]);

  // Re-fetch list + open detail whenever a research-domain run terminates so
  // the UI reflects the new state without a manual reload.
  useRunTerminal({ domain: 'research' }, () => {
    refreshReports();
    if (reportId) refreshDetail(reportId);
  });

  const openReport = useCallback(
    (id: string) => {
      navigate(`/research/${id}`);
    },
    [navigate],
  );

  const backToList = useCallback(() => {
    navigate('/research');
  }, [navigate]);

  async function dispatchSkill(
    prompt: string,
    title: string,
    tags: {
      skill: string;
      project?: string | null;
      domain?: string | null;
      // report_id is the research-report's frontmatter `id`. Passing it as an
      // explicit tag here is the canonical attribution path — events recorded
      // by the dispatched skill inherit it, which drives the Replay tab on
      // the report detail page + per-report cost rollup.
      report_id?: string | null;
    },
  ) {
    const res = await startSkillRun(prompt, title, tags);
    if ('blocked' in res && res.blocked) {
      toast(
        `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id}). Cancel or wait.`,
      );
      return;
    }
    if ('error' in res && res.error) {
      toast(`Dispatch failed: ${res.error}`);
    }
  }

  function reviewReport(d: ResearchReportSummary) {
    dispatchSkillForReport(d, 'research-review', 'Reviewing');
  }
  function reviseReport(d: ResearchReportSummary) {
    dispatchSkillForReport(d, 'research-revise', 'Revising');
  }
  function markApproved(d: ResearchReportSummary) {
    if (
      !window.confirm(
        `Mark "${d.title}" as approved?\n\nThis overrides the reviewer's verdict. review_status flips: request-changes → approved.`,
      )
    ) {
      return;
    }
    fetch(`/api/research/${encodeURIComponent(d.id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; error?: string; approved_at?: string }) => {
        if (!j.ok) {
          toast(`Mark approved failed: ${j.error ?? 'unknown error'}`);
          return;
        }
        refreshDetail(d.id);
        refreshReports();
      })
      .catch(() => toast('Mark approved failed — network error'));
  }

  function scaffoldAll(d: ResearchReportSummary) {
    fetch(`/api/research/${encodeURIComponent(d.id)}/scaffold-recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; run_id?: string; error?: string }) => {
        if (!j.ok) {
          toast(`Scaffold failed: ${j.error ?? 'unknown error'}`);
          return;
        }
        showDispatchInDrawer({ project: d.project, skill: 'research-scaffold-recommendations' });
      })
      .catch(() => toast('Scaffold dispatch failed — network error'));
  }
  function scaffoldOne(d: ResearchReportSummary, index: number) {
    fetch(`/api/research/${encodeURIComponent(d.id)}/scaffold-recommendations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subset: [index] }),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; error?: string }) => {
        if (!j.ok) {
          toast(`Scaffold failed: ${j.error ?? 'unknown error'}`);
          return;
        }
        showDispatchInDrawer({ project: d.project, skill: 'research-scaffold-recommendations' });
      })
      .catch(() => toast('Scaffold dispatch failed — network error'));
  }

  function runUpdate(d: ResearchReportSummary, notes: string) {
    fetch(`/api/research/${encodeURIComponent(d.id)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trigger_source: 'manual',
        notes,
      }),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; error?: string }) => {
        if (!j.ok) {
          toast(`Update failed: ${j.error ?? 'unknown error'}`);
          return;
        }
        showDispatchInDrawer({ project: d.project, skill: 'research-update' });
      })
      .catch(() => toast('Update dispatch failed — network error'));
  }

  function dispatchSkillForReport(d: ResearchReportSummary, skill: string, verbLabel: string) {
    const prompt = [
      `Run the ${skill} skill for report "${d.id}".`,
      `Read .claude/skills/${skill}/SKILL.md and follow its Procedure exactly.`,
      '',
      'Inputs:',
      `- report_id: ${JSON.stringify(d.id)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Report a tight summary when done.',
    ].join('\n');
    dispatchSkill(prompt, `${verbLabel} ${d.id}`, {
      skill,
      project: d.project,
      domain: 'research',
      report_id: d.id,
    });
  }

  async function submitAddReport(args: {
    project: string;
    report_topic: string;
    notes: string;
    materials: {
      urls: string[];
      wikilinks: string[];
      files: Array<{ filename: string; size: number; content_base64: string }>;
    };
  }) {
    // Seed staged files first so research-write picks them up alongside URLs
    // and wikilinks on its first material walk. Files-upload failure is non-
    // fatal — we surface a warning toast and still dispatch write so the user
    // doesn't lose the rest of the form.
    if (args.materials.files.length > 0) {
      try {
        const seedRes = await fetch('/api/research/seed-materials', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: args.project,
            report_topic: args.report_topic,
            files: args.materials.files.map((f) => ({
              filename: f.filename,
              content_base64: f.content_base64,
            })),
          }),
        });
        const seedJson = (await seedRes.json()) as {
          ok: boolean;
          error?: string;
          materials?: Array<{ ok: boolean; path?: string; error?: string }>;
        };
        if (!seedJson.ok) {
          toast(`File staging warning: ${seedJson.error ?? 'unknown error'} — dispatching anyway`);
        } else if (seedJson.materials?.some((m) => !m.ok)) {
          const failedCount = seedJson.materials.filter((m) => !m.ok).length;
          toast(`${failedCount} of ${args.materials.files.length} file(s) failed to stage`);
        }
      } catch (e) {
        toast(`File staging failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const id = `${args.project}-${args.report_topic}`;
    fetch(`/api/research/${encodeURIComponent(id)}/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project: args.project,
        report_topic: args.report_topic,
        notes: args.notes,
        materials: { urls: args.materials.urls, wikilinks: args.materials.wikilinks },
      }),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; run_id?: string; error?: string }) => {
        if (!j.ok) {
          toast(`Add failed: ${j.error ?? 'unknown error'}`);
          return;
        }
        toast(`Research write dispatched (${id})`);
        // Navigate back to the list view — dispatch is async; the new report
        // entry shows up once research-write writes the file, at which point
        // it's visible in the list. Drawer surfaces the live run.
        navigate('/research');
        showDispatchInDrawer({ project: args.project, skill: 'research-write' });
      })
      .catch(() => toast('Add dispatch failed — network error'));
  }

  return (
    <div className="page-wide" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!reportId && !isAddPage && (
          <ListPage
            reports={reports}
            projects={projects}
            searchParams={searchParams}
            setSearchParams={setSearchParams}
            onOpen={openReport}
            onAddReport={() => navigate('/research/new')}
          />
        )}
        {isAddPage && (
          <AddPage
            projects={projects}
            onSubmit={submitAddReport}
            onCancel={() => {
              /* AddPage navigates back to /research on its own; nothing else
                 to do here in the parent. */
            }}
            toast={toast}
          />
        )}
        {reportId && detail && (
          <DetailPage
            detail={detail}
            dispatching={dispatching}
            onBack={backToList}
            onReview={reviewReport}
            onRevise={reviseReport}
            onMarkApproved={markApproved}
            onScaffoldAll={scaffoldAll}
            onScaffoldOne={scaffoldOne}
            onRunUpdate={runUpdate}
            onRefetchDetail={() => refreshDetail(reportId)}
            toast={toast}
          />
        )}
        {reportId && !detail && (
          <div style={{ padding: 24, color: 'var(--muted)' }}>
            {detailLoading ? 'Loading research report…' : `Report "${reportId}" not found.`}
          </div>
        )}
      </div>
      <Toast msg={toastMsg} />
    </div>
  );
}
