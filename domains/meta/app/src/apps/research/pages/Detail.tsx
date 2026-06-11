// Research detail view — header, state-aware action banner, lifecycle stepper,
// 7-tab body. Mirrors prototype's detail.jsx.

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNavigation } from '../../../lib/navigation';
import { formatRelative } from '../../../lib/time';
import { ActionBanner, Icons, Stepper, type StepperStep } from '../../../shared';
import {
  type EventCatalogEntry,
  buildSubscriptionMap,
  findEventForStep,
  getEventCatalog,
  listRules,
} from '../../notifications/data';
import {
  RReviewBadge,
  RStatusBadge,
  RunResearchUpdateModal,
  type TabDef,
  Tabbar,
} from '../components';
import type { ResearchReportDetail, ResearchReportSummary, ResearchUiState } from '../data';
import { stateFor } from '../data';
import {
  MaterialsTab,
  NotesTab,
  OverviewTab,
  RecChangesTab,
  ReplayTab,
  ReportTab,
  ReviewsTab,
  UpdatesTab,
} from './DetailTabs';

type TabId =
  | 'overview'
  | 'report'
  | 'recommended'
  | 'materials'
  | 'reviews'
  | 'updates'
  | 'notes'
  | 'replay';

export interface DetailPageProps {
  detail: ResearchReportDetail;
  dispatching: boolean;
  onBack: () => void;
  onReview: (r: ResearchReportSummary) => void;
  onRevise: (r: ResearchReportSummary) => void;
  onMarkApproved: (r: ResearchReportSummary) => void;
  onScaffoldAll: (r: ResearchReportSummary) => void;
  onScaffoldOne: (r: ResearchReportSummary, index: number) => void;
  onRunUpdate: (r: ResearchReportSummary, notes: string) => void;
  onRefetchDetail: () => void;
  toast: (msg: string) => void;
}

export const DetailPage: React.FC<DetailPageProps> = ({
  detail,
  dispatching,
  onBack,
  onReview,
  onRevise,
  onMarkApproved,
  onScaffoldAll,
  onScaffoldOne,
  onRunUpdate,
  onRefetchDetail,
  toast,
}) => {
  const navigate = useNavigate();
  const nav = useNavigation();
  const { report, recommended_changes, materials, review, triggers, body, timeline } = detail;
  const [tab, setTab] = useState<TabId>('overview');
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [triggerDismissed, setTriggerDismissed] = useState(false);

  const triggerActive = triggers.length > 0 && !triggerDismissed;
  const uiState = useMemo(
    () => stateFor(report, recommended_changes),
    [report, recommended_changes],
  );

  const tabs: TabDef[] = [
    { id: 'overview', label: 'Overview', icon: <Icons.Eye size={13} /> },
    { id: 'report', label: 'Report', icon: <Icons.FileText size={13} /> },
    {
      id: 'recommended',
      label: 'Recommended changes',
      icon: <Icons.Lightbulb size={13} />,
      count: recommended_changes.length,
    },
    {
      id: 'materials',
      label: 'Materials',
      icon: <Icons.Folder size={13} />,
      count: materials.length,
    },
    { id: 'reviews', label: 'Reviews', icon: <Icons.Star size={13} />, count: review ? 1 : 0 },
    {
      id: 'updates',
      label: 'Updates',
      icon: <Icons.Sparkles size={13} />,
      count: report.update_count,
    },
    {
      id: 'notes',
      label: 'Notes',
      icon: <Icons.Bell size={13} />,
      count: detail.notes.length,
    },
    { id: 'replay', label: 'Replay', icon: <Icons.Clock size={13} /> },
  ];

  const [subscriptionMap, setSubscriptionMap] = useState<Map<string, string>>(() => new Map());
  const [catalog, setCatalog] = useState<EventCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listRules(), getEventCatalog()])
      .then(([rules, cat]) => {
        if (cancelled) return;
        setSubscriptionMap(buildSubscriptionMap(rules.rules, report.project));
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
  }, [report.project]);

  const lifecycleSteps = computeLifecycle(
    report,
    (id) => {
      if (id === 'drafted') setTab('report');
      else if (id === 'reviewed') setTab('reviews');
      else if (id === 'approved') setTab('recommended');
      else if (id === 'updated') setTab('updates');
    },
    (eventType, existingRuleId) => {
      if (existingRuleId) {
        navigate(`/notifications/rules/${encodeURIComponent(existingRuleId)}`);
        return;
      }
      const params = new URLSearchParams({ event_type: eventType });
      if (report.project) params.set('filter_project', report.project);
      navigate(`/notifications/rules/new?${params.toString()}`);
    },
    subscriptionMap,
    catalog,
  );

  function openProject() {
    if (!report.project) return;
    navigate(`/projects/${report.project}`);
  }

  return (
    <div
      className="page page-wide"
      style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          title="Back to research list"
          style={{ marginTop: 2 }}
        >
          <Icons.ChevronLeft size={16} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: 6,
            }}
          >
            {report.project && (
              <button
                type="button"
                onClick={openProject}
                className="mono"
                style={{
                  background: 'none',
                  border: 0,
                  color: 'var(--muted)',
                  fontSize: 13,
                  padding: 0,
                  cursor: 'pointer',
                }}
                title={`Open project ${report.project}`}
              >
                {report.project}
              </button>
            )}
            <span style={{ color: 'var(--subtle)' }}>/</span>
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 13 }}>
              research
            </span>
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 13 }}>
              · {report.id}
            </span>
            <RStatusBadge status={report.status} />
            <RReviewBadge status={report.review_status} />
            {report.report_revision && report.report_revision > 1 && (
              <span className="badge">
                <Icons.GitCommit size={11} /> rev {report.report_revision}
              </span>
            )}
          </div>
          <h1 className="h1" style={{ margin: 0 }}>
            {report.title}
          </h1>
          <div className="tiny" style={{ marginTop: 6, color: 'var(--muted)' }}>
            created {report.created ? formatRelative(report.created) : '—'} · last ingest{' '}
            {report.last_data_ingest ? formatRelative(report.last_data_ingest) : 'never'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-sm" onClick={() => setTab('materials')}>
            <Icons.Folder size={13} /> View materials
            <span className="badge muted" style={{ height: 18, padding: '0 6px', marginLeft: 4 }}>
              {materials.length}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setUpdateModalOpen(true)}
            disabled={dispatching || (!triggerActive && report.review_status !== 'approved')}
            style={
              triggerActive && !dispatching
                ? { borderColor: 'var(--warning)', color: 'var(--warning-text)' }
                : undefined
            }
            title={
              dispatching
                ? 'Disabled — another research run is in flight.'
                : triggerActive
                  ? 'Update trigger active — run research-update to fold in the new context.'
                  : 'Manual research-update run (only enabled when approved).'
            }
          >
            <Icons.Refresh size={13} /> Run research-update
          </button>
        </div>
      </div>

      {/* State-aware action banner */}
      <BannerForState
        uiState={uiState}
        report={report}
        triggerActive={triggerActive}
        dispatching={dispatching}
        onReview={() => onReview(report)}
        onRevise={() => onRevise(report)}
        onMarkApproved={() => onMarkApproved(report)}
        onScaffoldAll={() => onScaffoldAll(report)}
        onRunUpdate={() => setUpdateModalOpen(true)}
        onDismissTrigger={() => {
          setTriggerDismissed(true);
          for (const t of triggers) {
            fetch(`/api/research/${encodeURIComponent(report.id)}/triggers/dismiss`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ trigger_id: t.id }),
            }).catch(() => undefined);
          }
        }}
      />

      {/* Lifecycle stepper */}
      <section className="card" style={{ padding: 0 }}>
        <div className="card-header">
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Lifecycle</h4>
        </div>
        <Stepper steps={lifecycleSteps} />
      </section>

      {/* Tabbar */}
      <Tabbar tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />

      {/* Tab content */}
      {tab === 'overview' && (
        <OverviewTab
          report={report}
          body={body}
          recommendations={recommended_changes}
          onGoTab={(t) => setTab(t)}
          onScaffoldAll={() => onScaffoldAll(report)}
          onOpenProject={openProject}
        />
      )}
      {tab === 'report' && (
        <ReportTab body={body} report={report} onOpenEntry={nav.navigateToEntry} />
      )}
      {tab === 'recommended' && (
        <RecChangesTab
          recommendations={recommended_changes}
          onScaffoldOne={(rc) => onScaffoldOne(report, rc.index)}
          onScaffoldAll={() => onScaffoldAll(report)}
          onOpenChange={(id) => navigate(`/changes/${id}`)}
        />
      )}
      {tab === 'materials' && (
        <MaterialsTab
          report={report}
          materials={materials}
          onReingest={() => setUpdateModalOpen(true)}
          onChanged={(msg) => toast(msg)}
        />
      )}
      {tab === 'reviews' && <ReviewsTab review={review} report={report} />}
      {tab === 'updates' && (
        <UpdatesTab report={report} body={body} onRunUpdate={() => setUpdateModalOpen(true)} />
      )}
      {tab === 'notes' && (
        <NotesTab
          notes={detail.notes}
          reportId={report.id}
          onAdded={onRefetchDetail}
          toast={toast}
        />
      )}
      {tab === 'replay' && <ReplayTab timeline={timeline} />}

      {updateModalOpen && (
        <RunResearchUpdateModal
          report={report}
          newMaterials={materials
            .filter((m) => !m.ingested)
            .map((m) => ({ name: m.name, size: m.size }))}
          triggerSource={triggers[0]?.kind ?? 'manual'}
          onCancel={() => setUpdateModalOpen(false)}
          onConfirm={({ notes }) => {
            setUpdateModalOpen(false);
            onRunUpdate(report, notes);
            setTriggerDismissed(true);
          }}
        />
      )}
    </div>
  );
};

function BannerForState({
  uiState,
  report,
  triggerActive,
  dispatching,
  onReview,
  onRevise,
  onMarkApproved,
  onScaffoldAll,
  onRunUpdate,
  onDismissTrigger,
}: {
  uiState: ResearchUiState;
  report: ResearchReportSummary;
  triggerActive: boolean;
  dispatching: boolean;
  onReview: () => void;
  onRevise: () => void;
  onMarkApproved: () => void;
  onScaffoldAll: () => void;
  onRunUpdate: () => void;
  onDismissTrigger: () => void;
}) {
  if (triggerActive) {
    return (
      <ActionBanner
        tone="warning"
        icon={<Icons.AlertTriangle size={18} />}
        title="Update trigger fired — incorporate?"
        desc="Run research-update to fold new context into the report and re-derive recommendations."
        dispatching={dispatching}
        actions={{
          primary: { label: 'Run research-update', onClick: onRunUpdate },
          secondary: { label: 'Dismiss', onClick: onDismissTrigger, ghost: true },
        }}
      />
    );
  }
  if (uiState === 'awaiting-review') {
    return (
      <ActionBanner
        tone="accent"
        icon={<Icons.Eye size={18} />}
        title="Research drafted, awaiting review."
        desc="The reviewer will check for material coverage, evidence quality, and recommendation soundness."
        dispatching={dispatching}
        actions={{ primary: { label: 'Review research', onClick: onReview } }}
      />
    );
  }
  if (uiState === 'pre-revise') {
    return (
      <ActionBanner
        tone="warning"
        icon={<Icons.AlertTriangle size={18} />}
        title="Reviewer requested changes."
        desc="Open Reviews to see the verdict, then revise. The reviewer's notes will guide the revision."
        dispatching={dispatching}
        actions={{
          primary: { label: 'Revise research', onClick: onRevise },
          secondary: { label: 'Mark approved', onClick: onMarkApproved, ghost: true },
        }}
      />
    );
  }
  if (uiState === 'post-revise') {
    return (
      <ActionBanner
        tone="accent"
        icon={<Icons.Refresh size={18} />}
        title="Research revised — verdict below describes the prior revision."
        desc="Re-run the reviewer against the new draft to refresh the verdict."
        dispatching={dispatching}
        actions={{
          primary: { label: 'Re-review research', onClick: onReview },
          secondary: { label: 'Mark approved', onClick: onMarkApproved, ghost: true },
        }}
      />
    );
  }
  if (uiState === 'ready-to-scaffold') {
    const n = report.recommended_changes_proposed;
    return (
      <ActionBanner
        tone="success"
        icon={<Icons.Check size={18} />}
        title={`Research approved · ${n} unscaffolded recommendation${n === 1 ? '' : 's'}.`}
        desc="Scaffolding feeds these into the project's change pipeline."
        dispatching={dispatching}
        actions={{
          primary: { label: 'Scaffold recommended changes', onClick: onScaffoldAll },
        }}
      />
    );
  }
  if (uiState === 'approved-clean') {
    return (
      <ActionBanner
        tone="success"
        icon={<Icons.Check size={18} />}
        title="Research approved."
        desc="All recommendations are either scaffolded or merged. Updates will trigger when new context arrives."
      />
    );
  }
  return null;
}

// Step → event_type mapping moved to vault/wiki/_seed/meta/reference/
// event-catalog.md (the `lifecycle_step` column with values `research-report:<id>`).
// Single source of truth — fetched + queried via findEventForStep below.

function computeLifecycle(
  r: ResearchReportSummary,
  onClick: (id: 'drafted' | 'reviewed' | 'approved' | 'updated') => void,
  onNotify: (eventType: string, existingRuleId: string | null) => void,
  subscriptionMap: Map<string, string>,
  catalog: EventCatalogEntry[],
): StepperStep[] {
  // Step statuses are server-computed (lib/lifecycle-state.ts deriveReportSteps)
  // — this function only decorates them with click/notify handlers. Deriving
  // here from raw frontmatter was the Finding 4.3 dialect-drift pattern.
  const { drafted, reviewed, approved, updated } = r.step_statuses;

  const decorate = (
    step: StepperStep & { id: 'drafted' | 'reviewed' | 'approved' | 'updated' },
  ): StepperStep => {
    const eventType = findEventForStep(catalog, 'research-report', step.id);
    if (!eventType) return step;
    const subscribedRuleId = subscriptionMap.get(eventType) ?? null;
    return {
      ...step,
      onNotify: () => onNotify(eventType, subscribedRuleId),
      notifyHint: subscribedRuleId
        ? `Edit existing rule for ${eventType}${r.project ? ` (project ${r.project})` : ''}`
        : `Notify on ${eventType}${r.project ? ` (filtered to project ${r.project})` : ''}`,
      subscribedRuleId,
    };
  };

  return [
    decorate({
      id: 'drafted',
      label: 'Drafted',
      status: drafted,
      onClick: () => onClick('drafted'),
    }),
    decorate({
      id: 'reviewed',
      label: 'Reviewed',
      status: reviewed,
      onClick: () => onClick('reviewed'),
    }),
    decorate({
      id: 'approved',
      label: 'Approved',
      status: approved,
      onClick: () => onClick('approved'),
    }),
    decorate({
      id: 'updated',
      label: 'Updated',
      status: updated,
      hint: r.update_count > 0 ? `×${r.update_count}` : undefined,
      onClick: () => onClick('updated'),
    }),
  ];
}
