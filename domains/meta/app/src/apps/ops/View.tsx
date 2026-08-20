// Ops — top-level routing between the protocol list (/ops), the New-protocol
// screen (/ops/new), a protocol's contract + report history (/ops/:id), and a
// single dated report (/ops/:id/reports/:file).
//
// Routing is derived from the splat so every screen is deep-linkable and
// back/forward-safe — a report URL pasted into chat opens that report, not the
// list with a hidden selection.
//
// The whole surface is read-only over /api/ops. The only mutation this view can
// cause is dispatching a skill run through the shared runs API; nothing here
// edits a protocol, a report, or anything the ops domain observes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SKILL } from '../../../server/lib/skill-ids';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { type SkillSummary, findSkill } from '../../lib/skills';
import { Toast } from '../../shared';
import '../../shared/styles.css';
import type {
  OpsProtocolDetail,
  OpsProtocolSummary,
  OpsReportDetail,
  OpsReportSummary,
} from './data';
import { ListPage } from './pages/List';
import { NewProtocolPage } from './pages/New';
import { ProtocolPage } from './pages/Protocol';
import { ReportPage } from './pages/Report';

export default function Ops() {
  const navigate = useNavigate();
  // URL shape (mounted at /ops/* by App.tsx):
  //   ''                       → protocol list, grouped by protocol
  //   'new'                    → New-protocol screen (inline scaffold form)
  //   '<id>'                   → one protocol: contract + report history
  //   '<id>/reports/<file>'    → one dated report
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const parts = useMemo(() => splat.split('/').filter(Boolean), [splat]);
  const isNewPage = parts[0] === 'new';
  // 'new' is a sentinel route, never a protocol id.
  const protocolId = !isNewPage && parts[0] ? parts[0] : null;
  const reportFile = parts[1] === 'reports' && parts[2] ? parts[2] : null;

  const [protocols, setProtocols] = useState<OpsProtocolSummary[]>([]);
  const [detail, setDetail] = useState<OpsProtocolDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [report, setReport] = useState<OpsReportDetail | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [addSkill, setAddSkill] = useState<SkillSummary | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // Report rows are fetched per protocol the first time its group expands —
  // a workspace with a dozen protocols and a year of weekly reviews shouldn't
  // pay for every row to render a list nobody has opened. An absent key means
  // "not loaded yet"; the list page requests it.
  const [reportsByProtocol, setReportsByProtocol] = useState<Record<string, OpsReportSummary[]>>(
    {},
  );

  const { startSkillRun, runs } = useDispatch();

  const dispatching = useMemo(
    () => runs.some((r) => r.domain === 'ops' && (r.state === 'queued' || r.state === 'running')),
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

  const refreshProtocols = useCallback(async () => {
    try {
      const r = await fetch('/api/ops');
      if (!r.ok) return;
      const j = (await r.json()) as { protocols: OpsProtocolSummary[] };
      setProtocols(j.protocols ?? []);
    } catch {
      /* silent — the list simply stays as it was */
    }
  }, []);

  const loadReports = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/ops/${encodeURIComponent(id)}/reports`);
      if (!r.ok) return;
      const j = (await r.json()) as { reports: OpsReportSummary[] };
      setReportsByProtocol((prev) => ({ ...prev, [id]: j.reports ?? [] }));
    } catch {
      /* silent — the group stays in its loading state and retries on re-expand */
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/ops/${encodeURIComponent(id)}`);
      if (!r.ok) {
        setDetail(null);
        return;
      }
      setDetail((await r.json()) as OpsProtocolDetail);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const refreshReport = useCallback(async (id: string, file: string) => {
    setReportLoading(true);
    try {
      const r = await fetch(
        `/api/ops/${encodeURIComponent(id)}/reports/${encodeURIComponent(file)}`,
      );
      if (!r.ok) {
        setReport(null);
        return;
      }
      setReport((await r.json()) as OpsReportDetail);
    } catch {
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProtocols();
  }, [refreshProtocols]);

  // The New-protocol screen renders the scaffold form generated from the
  // skill's own inputs schema, so the form can never drift from the skill.
  useEffect(() => {
    if (!isNewPage || addSkill) return;
    findSkill(SKILL.OPS_ADD_PROTOCOL).then(setAddSkill);
  }, [isNewPage, addSkill]);

  useEffect(() => {
    if (!protocolId) {
      setDetail(null);
      return;
    }
    refreshDetail(protocolId);
  }, [protocolId, refreshDetail]);

  useEffect(() => {
    if (!protocolId || !reportFile) {
      setReport(null);
      return;
    }
    refreshReport(protocolId, reportFile);
  }, [protocolId, reportFile, refreshReport]);

  // A finished ops run means a new report on disk (or a fresh stamp on a
  // protocol) — re-fetch whatever is on screen so the UI reflects it without a
  // manual reload.
  useRunTerminal({ domain: 'ops' }, () => {
    refreshProtocols();
    // Drop the per-protocol report cache; expanded groups re-request it.
    setReportsByProtocol({});
    if (protocolId) refreshDetail(protocolId);
    if (protocolId && reportFile) refreshReport(protocolId, reportFile);
  });

  async function runReview(id: string) {
    const prompt = [
      `Run the ${SKILL.OPS_HEALTH_REVIEW} skill for protocol "${id}".`,
      `Read .claude/skills/${SKILL.OPS_HEALTH_REVIEW}/SKILL.md and follow its Procedure exactly.`,
      '',
      'Inputs:',
      `- protocol: ${JSON.stringify(id)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- The review is read-only: never write to, reconfigure, or publish anything',
      '  in the system under review.',
      '- Report a tight summary when done.',
    ].join('\n');
    const res = await startSkillRun(prompt, `Health review ${id}`, {
      skill: SKILL.OPS_HEALTH_REVIEW,
      domain: 'ops',
    });
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

  async function submitNewProtocol(prompt: string) {
    const res = await startSkillRun(prompt, 'Adding review protocol', {
      skill: SKILL.OPS_ADD_PROTOCOL,
      domain: 'ops',
    });
    if ('blocked' in res && res.blocked) {
      toast(
        `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id}). Cancel or wait.`,
      );
      return;
    }
    if ('error' in res && res.error) {
      toast(`Dispatch failed: ${res.error}`);
      return;
    }
    // Dispatch is async — the entry appears in the list once the skill writes
    // it. The run drawer (opened by startSkillRun) carries the live progress.
    navigate('/ops');
  }

  return (
    <div className="page-wide" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!protocolId && !isNewPage && (
          <ListPage
            protocols={protocols}
            reportsByProtocol={reportsByProtocol}
            onNeedReports={loadReports}
            dispatching={dispatching}
            onOpenProtocol={(id) => navigate(`/ops/${id}`)}
            onOpenReport={(id, file) => navigate(`/ops/${id}/reports/${file}`)}
            onNewProtocol={() => navigate('/ops/new')}
            onRunReview={runReview}
          />
        )}

        {isNewPage && (
          <NewProtocolPage
            skill={addSkill}
            onSubmit={submitNewProtocol}
            onCancel={() => navigate('/ops')}
          />
        )}

        {protocolId && !reportFile && detail && (
          <ProtocolPage
            detail={detail}
            dispatching={dispatching}
            onBack={() => navigate('/ops')}
            onRunReview={() => runReview(detail.id)}
            onOpenReport={(file) => navigate(`/ops/${detail.id}/reports/${file}`)}
          />
        )}
        {protocolId && !reportFile && !detail && (
          <div style={{ padding: 24, color: 'var(--muted)' }}>
            {detailLoading ? 'Loading protocol…' : `Protocol "${protocolId}" not found.`}
          </div>
        )}

        {protocolId && reportFile && report && (
          <ReportPage
            report={report}
            protocolTitle={detail?.title ?? protocolId}
            onBack={() => navigate(`/ops/${protocolId}`)}
          />
        )}
        {protocolId && reportFile && !report && (
          <div style={{ padding: 24, color: 'var(--muted)' }}>
            {reportLoading ? 'Loading report…' : `Report "${reportFile}" not found.`}
          </div>
        )}
      </div>
      <Toast msg={toastMsg} />
    </div>
  );
}
