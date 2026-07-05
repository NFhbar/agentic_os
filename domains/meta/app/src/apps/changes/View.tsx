// Changes — atomic code-work units. Migrated to apps/ + restyled with the
// prototype design system: header chrome upgraded to .h1 + .btn-primary;
// list rows wrapped in .card with .badge status; detail uses .card sections.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ConfirmModal } from '../../components/ConfirmModal';
import { EditableMarkdown, Rendered } from '../../components/EditableMarkdown';
import { LatestArtifactCard } from '../../components/LatestArtifactCard';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { getJson, postJson } from '../../lib/api';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { useNavigation } from '../../lib/navigation';
import { type RunRecord, listRuns } from '../../lib/runs';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { formatRelative } from '../../lib/time';
import { fetchEntry } from '../../lib/vault';
import { Icons, SectionToggleRow, Stepper, useCollapsedFlag } from '../../shared';
import '../../shared/styles.css';
import {
  type EventCatalogEntry,
  buildSubscriptionMap,
  findEventForStep,
  getEventCatalog,
  listRules,
} from '../notifications/data';

interface ChangeSummary {
  id: string | null;
  path: string;
  title: string;
  domain: string | null;
  status: string | null;
  repo: string | null;
  branch: string | null;
  scope: string | null;
  pr_url: string | null;
  size: string | null;
  project: string | null;
  parent_change: string | null;
  updated: string | null;
  review_required: boolean | null;
  review_status: string | null;
  plan_path: string | null;
  review_path: string | null;
  plan_generated_at: string | null;
  reviewed_at: string | null;
  // Plan-revision tracking (managed by dev-revise-plan). plan_revision is
  // implicit 1 on the original plan; bumped to 2, 3, … each revision.
  plan_revision: number | null;
  plan_revised_at: string | null;
  plan_revised_from_review: string | null;
  // PR review summary (managed by dev-pr-review when invoked with a change input)
  pr_review_status: string | null;
  pr_review_path: string | null;
  pr_review_passes: number | null;
  pr_reviewed_at: string | null;
  // Set by dev-mark-pr-ready when the user clicks Mark ready.
  pr_ready_at: string | null;
  // Set by dev-close-change (or runbook-pr-ci-monitor) when the PR is
  // confirmed merged on GitHub.
  merged_at: string | null;
  // Set by POST /:id/abandon. Always paired with abandoned_reason.
  abandoned_at: string | null;
  abandoned_reason: string | null;
  // CI rollup state managed by pr-ci-poll runbook (pass / fail / running / none).
  ci_state: string | null;
  ci_completed_at: string | null;
  // Research-attribution: set when a change was scaffolded from a research-
  // report's recommended_changes[]. Used to render the [N+1/M] step
  // indicator on the title.
  derived_from_report: string | null;
  recommendation_index: number | null;
  recommendations_total: number | null;
  // Per-change automation config. Null when the change has no `automation:`
  // block — the canonical signal that automation has never been touched.
  automation: ChangeAutomation | null;
}

// [N+1/M] indicator prefix for derived-change titles. Empty string when the
// change isn't research-derived OR the totals aren't yet known.
function stepPrefix(c: {
  derived_from_report?: string | null;
  recommendation_index?: number | null;
  recommendations_total?: number | null;
}): string {
  if (!c.derived_from_report) return '';
  if (c.recommendation_index == null || c.recommendations_total == null) return '';
  return `[${c.recommendation_index + 1}/${c.recommendations_total}] `;
}

interface ChangesResponse {
  changes: ChangeSummary[];
}

interface FileRef {
  path: string;
  mtime: string;
  preview: string;
}

// StageStatus + LifecycleStage now imported from the server's wire-shape
// definitions per standard-shared-types — single source of truth across
// server emit + client render.
import type {
  ChangeAutomation,
  LifecycleStage,
  StageStatus,
} from '../../../server/routes/changes.types';

interface ChangeEvent {
  id: number;
  ts: string;
  kind: string;
  action: string | null;
  skill: string | null;
  duration_ms: number | null;
  exit_status: string | null;
  cost_usd: number | null;
}

interface RelatedEntities {
  project: string | null;
  repo: string | null;
  parent_change: string | null;
  skills_used: string[];
  mcps_used: string[];
  artifacts: Array<{ kind: string; path: string }>;
}

interface ChangeDetail {
  change: ChangeSummary;
  body: string;
  content: string;
  plan: FileRef | null;
  review: FileRef | null;
  body_has_placeholders: boolean;
  // Count of `**DRAFT**` markers in the body. When > 0 (and placeholders
  // are clean), the user can one-click accept via POST /:id/accept-drafts
  // instead of editing the markdown by hand.
  body_draft_marker_count?: number;
  lifecycle: LifecycleStage[];
  events: ChangeEvent[];
  related: RelatedEntities;
  // Rollup of every billable event (ai-prompt) tagged to this change_id.
  // Surfaces "$X cost · Yh wall-time · N runs" on the detail header.
  rollup?: {
    cost_usd: number;
    duration_ms: number;
    skill_count: number;
    by_skill: Array<{ skill: string; count: number; cost_usd: number; duration_ms: number }>;
    ai_prompt_runs: number;
  };
  // Phase 5 — count of comments on the latest pr-review pass that the
  // ADDRESS-COMMENTS phase of dev-write-change would re-implement. 0 when
  // no linked review or no qualifying comments.
  comments_to_address: number;
  // Count of latest-pass comments still `status: new` (untriaged). Gates the
  // Mark-ready affordance — comment disposition is a merge invariant.
  untriaged_comments: number;
  // Phase 4 reflection — true when the linked pr-review entry's frontmatter
  // carries `published: true` (i.e. dev-pr-review-publish has fired). Drives
  // the "Published to GitHub" indicator on the PR card.
  pr_review_published?: boolean;
  // GitHub review id captured on any comment in the latest pass. Used to
  // deep-link the "Published to GitHub" indicator to the actual GitHub
  // review event. Null when the review has never been published.
  pr_review_github_review_id?: number | null;
  // Timestamp of the most recent `pr-review-publish` event in events.db
  // matching this review id. Used to show "published 2h ago" in the card.
  pr_review_published_at?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  planning: 'planning',
  'in-progress': 'in-progress',
  'in-review': 'in-review',
  merged: 'merged',
  abandoned: 'abandoned',
};

// Map workflow states to prototype severity badge classes.
function statusBadgeClass(status: string | null): string {
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

function reviewBadgeClass(reviewStatus: string | null): string {
  if (!reviewStatus) return 'badge muted';
  switch (reviewStatus) {
    case 'approved':
      return 'badge success';
    case 'pending':
      return 'badge warning';
    case 'overridden':
      return 'badge warning';
    case 'request-changes':
      return 'badge error';
    case 'rejected':
      return 'badge error';
    case 'not-required':
      return 'badge muted';
    default:
      return 'badge muted';
  }
}

type ChangesViewMode = 'list' | 'kanban';

export default function Changes() {
  const nav = useNavigation();
  const navigate = useNavigate();
  const [list, setList] = useState<ChangeSummary[] | null>(null);
  // URL-backed selection. App.tsx mounts this view at `/changes/*` so the
  // splat captures everything after `/changes/`. For now we treat it as the
  // selected change id; future sub-routes would nest <Routes> here.
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const selected: string | null = splat.length > 0 ? splat : null;
  const setSelected = useCallback(
    (id: string | null) => {
      navigate(id ? `/changes/${id}` : '/changes');
    },
    [navigate],
  );
  const [viewMode, setViewMode] = useState<ChangesViewMode>('list');
  const [detail, setDetail] = useState<ChangeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [addSkill, setAddSkill] = useState<SkillSummary | null>(null);
  // Most-recent dispatch outcome — surfaces a small inline toast for blocked /
  // error states. Successful dispatches just open the run drawer (no toast).
  const [lastDispatchToast, setLastDispatchToast] = useState<string | null>(null);
  // Pending close-local target — when set, the ConfirmModal renders. Cleared
  // on cancel or after the close-local fetch returns.
  const [closeLocalTarget, setCloseLocalTarget] = useState<string | null>(null);
  // Pending abandon target + reason buffer.
  const [abandonTarget, setAbandonTarget] = useState<string | null>(null);
  const [abandonReason, setAbandonReason] = useState('');

  const { startSkillRun, runs } = useDispatch();

  // True when at least one queued/running run is tagged to the currently
  // selected change. Drives the same disabled-state semantics that the old
  // `dispatching={Boolean(pendingPrompt)}` flag provided.
  const dispatching = useMemo(() => {
    if (!selected) return false;
    return runs.some(
      (r) => r.change_id === selected && (r.state === 'queued' || r.state === 'running'),
    );
  }, [runs, selected]);

  // Refetch list + detail whenever a run tagged to the open change reaches
  // a terminal state — same trigger as the old ActionRunner.onClose handler.
  useRunTerminal({ change_id: selected ?? undefined }, async () => {
    try {
      const r = await getJson<ChangesResponse>('/api/changes');
      setList(r.changes);
    } catch {
      /* ignore */
    }
    if (selected) {
      try {
        const d = await getJson<ChangeDetail>(`/api/changes/${encodeURIComponent(selected)}`);
        setDetail(d);
      } catch {
        /* keep previous */
      }
    }
  });

  // Common dispatch helper — emits a toast on blocked / error, opens the
  // drawer on success (drawer-open is handled inside startSkillRun).
  async function dispatchSkill(
    prompt: string,
    title: string,
    tags: {
      skill: string;
      change_id?: string | null;
      repo?: string | null;
      project?: string | null;
      domain?: string | null;
    },
  ) {
    setLastDispatchToast(null);
    const res = await startSkillRun(prompt, title, tags);
    if ('blocked' in res && res.blocked) {
      setLastDispatchToast(
        `Already running on this change: ${res.blocking.skill ?? 'unknown skill'} (${res.blocking.run_id}). Cancel or wait.`,
      );
      return;
    }
    if ('error' in res && res.error) {
      setLastDispatchToast(`Dispatch failed: ${res.error}`);
      return;
    }
  }

  // Resolve change tags (domain, repo, project) from the loaded detail when
  // available — falls back to nulls if the user hasn't opened the change yet.
  function tagsForChange(changeId: string) {
    const fromList = list?.find((c) => c.id === changeId);
    return {
      skill: '',
      change_id: changeId,
      repo: fromList?.repo ?? null,
      project: fromList?.project ?? null,
      domain: fromList?.domain ?? null,
    };
  }

  // Dispatch dev-write-change with an optional phase hint that drives the
  // run-row title. dev-write-change can run PLAN, EXECUTE, or ADDRESS-COMMENTS
  // — the skill picks based on change state, but the *caller* often knows
  // which phase it's triggering (button labels already disambiguate). Passing
  // the hint here makes the runs-list label match what the user clicked, so
  // a PLAN-only step doesn't show up as "Writing/executing" (Task #426).
  function invokeWriteChange(
    changeId: string,
    phaseHint?: 'plan' | 'execute' | 'address-comments',
  ) {
    const prompt = [
      `Run the dev-write-change skill for change "${changeId}".`,
      'Read .claude/skills/dev-write-change/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Follow the state machine: PLAN if review_status is pending and no plan exists; EXECUTE if approved/overridden/not-required; otherwise report state and stop.',
      '- Never deviate from the plan mid-execute. If tests fail in EXECUTE, write the log and stop.',
      '- Report a short summary of what phase ran and what to do next.',
    ].join('\n');
    const title =
      phaseHint === 'plan'
        ? `Planning change ${changeId}`
        : phaseHint === 'execute'
          ? `Executing change ${changeId}`
          : phaseHint === 'address-comments'
            ? `Addressing comments on ${changeId}`
            : `Writing change ${changeId}`;
    dispatchSkill(prompt, title, {
      ...tagsForChange(changeId),
      skill: 'dev-write-change',
    });
  }

  function invokeReviewChange(changeId: string) {
    const prompt = [
      `Run the dev-review-change skill for change "${changeId}".`,
      'Read .claude/skills/dev-review-change/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — read-only review. You MUST NOT edit code, create branches, or run tests.',
      'Walk the plan + repo + conventions. Produce a structured verdict (approve / request-changes / reject).',
      "Write the review file and update the change entry's review_status. Report a short summary.",
    ].join('\n');
    dispatchSkill(prompt, `Reviewing change plan: ${changeId}`, {
      ...tagsForChange(changeId),
      skill: 'dev-review-change',
    });
  }

  // Dispatches dev-revise-plan — reads plan_path + review_path, rewrites the
  // plan in place to address the reviewer's findings, bumps plan_revision.
  // Does NOT touch review_status (the prior verdict still describes the prior
  // plan revision). Lifecycle stays at code-executed current — the user can
  // re-execute or optionally re-review.
  function invokeRevisePlan(changeId: string) {
    const prompt = [
      `Run the dev-revise-plan skill for change "${changeId}".`,
      'Read .claude/skills/dev-revise-plan/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — read-only against the repo. You MUST NOT edit code, create branches, or run tests.',
      'Read plan_path + review_path, fold every concern/nit/suggested-change into a revised plan, overwrite plan_path.',
      "Bump the change entry's plan_revision and stamp plan_revised_at + plan_revised_from_review.",
      'Preserve review_status, review_path, reviewed_at — the prior verdict still stands for the prior plan revision.',
      'Report a short summary including the new revision number and the count of findings addressed.',
    ].join('\n');
    dispatchSkill(prompt, `Revising plan: ${changeId}`, {
      ...tagsForChange(changeId),
      skill: 'dev-revise-plan',
    });
  }

  function invokeOpenPr(changeId: string) {
    const prompt = [
      `Run the dev-open-pr skill for change "${changeId}".`,
      'Read .claude/skills/dev-open-pr/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Pre-flight: run `node scripts/check-mcp.mjs github --json`. If non-zero exit, stop and report the hint verbatim.',
      '- Idempotent: if `pr_url` is already set, stop politely and report the existing URL.',
      '- The branch must already be committed locally (from dev-write-change EXECUTE).',
      "- On success, update the change entry's pr_url + status: in-review + updated, and log via record-dashboard-action.mjs.",
      '- Report a short summary including the PR URL and the next-step hint.',
    ].join('\n');
    dispatchSkill(prompt, `Opening PR for ${changeId}`, {
      ...tagsForChange(changeId),
      skill: 'dev-open-pr',
    });
  }

  function invokeCloseChange(changeId: string) {
    const prompt = [
      `Run the dev-close-change skill to close change "${changeId}".`,
      'Read .claude/skills/dev-close-change/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- The skill calls mcp__github__get_pull_request to verify the merge state.',
      '- Report the tight summary block at the end (✓ or ↻ format per the SKILL.md).',
    ].join('\n');
    dispatchSkill(prompt, `Closing ${changeId}`, {
      ...tagsForChange(changeId),
      skill: 'dev-close-change',
    });
  }

  // Vault-only closure for changes that never had a PR (typically OS-internal
  // changes against agentic-os, which has no remote). Hits the close-local
  // endpoint — no GitHub interaction, no skill dispatch, no cost. Opens the
  // ConfirmModal; the actual fetch fires from runCloseLocal after confirm.
  function invokeCloseLocal(changeId: string) {
    setCloseLocalTarget(changeId);
  }

  async function runCloseLocal(changeId: string) {
    setCloseLocalTarget(null);
    try {
      const r = await fetch(`/api/changes/${encodeURIComponent(changeId)}/close-local`, {
        method: 'POST',
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (j.ok) {
        window.location.reload();
      } else {
        setLastDispatchToast(`Close (local) failed: ${j.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setLastDispatchToast(`Close (local) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Mark a change abandoned with a mandatory reason. Opens the ConfirmModal
  // with a textarea; runAbandon fires after confirm. Server-side: flips status
  // to abandoned, stamps abandoned_at + abandoned_reason, appends a `##
  // Abandoned` body section, AND patches the source research-report's
  // recommended_changes[<index>] when the change is research-derived.
  function invokeAbandon(changeId: string) {
    setAbandonTarget(changeId);
    setAbandonReason('');
  }

  // Dispatch meta-overseer-review to produce a lifecycle audit for this change.
  // Equivalent to running `/os audit lifecycle <id>` from the CLI — but tracked
  // in the runs drawer. The skill self-validates: rejects if the change isn't
  // in terminal state, if the project hasn't opted in to auditing (unless
  // force: true is passed), or if an audit already exists within the 24h
  // debounce window. The rejection message surfaces in the run output;
  // re-dispatch with force from the runs drawer if needed.
  function invokeAudit(changeId: string) {
    const prompt = [
      `Run the meta-overseer-review skill to audit change "${changeId}".`,
      'Read .claude/skills/meta-overseer-review/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      "- Honor the skill's gates: terminal state required (status: merged or abandoned), project must have audit.enabled OR force: true.",
      "- If the gate trips, exit with the skill's rejection message verbatim so the user can decide whether to re-run with force.",
      '- On success, report the audit id + verdict + cost so the user can navigate to the Overseer audits tab.',
    ].join('\n');
    dispatchSkill(prompt, `Audit lifecycle: ${changeId}`, {
      ...tagsForChange(changeId),
      skill: 'meta-overseer-review',
    });
  }

  async function runAbandon(changeId: string, reason: string) {
    setAbandonTarget(null);
    try {
      const r = await fetch(`/api/changes/${encodeURIComponent(changeId)}/abandon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (j.ok) {
        window.location.reload();
      } else {
        setLastDispatchToast(`Abandon failed: ${j.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setLastDispatchToast(`Abandon failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function invokeMarkPrReady(changeId: string) {
    const prompt = [
      `Run the dev-mark-pr-ready skill to mark change "${changeId}" ready for human review.`,
      'Read .claude/skills/dev-mark-pr-ready/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- This skill is vault-only: NO GitHub calls, NO PR mutations.',
      '- Report the tight summary block at the end (✓ or ↻ format per the SKILL.md).',
    ].join('\n');
    dispatchSkill(prompt, `Marking ${changeId} ready for human`, {
      ...tagsForChange(changeId),
      skill: 'dev-mark-pr-ready',
    });
  }

  function invokeReviewPr(changeId: string, prUrl: string) {
    const prompt = [
      `Run the dev-pr-review skill against the PR opened for change "${changeId}".`,
      'Read .claude/skills/dev-pr-review/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- pr: ${JSON.stringify(prUrl)}`,
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Default pass_kind to auto (skill picks new vs continuation by file existence).',
      '- Write the pr-review archetype entry to vault/wiki/development/pr-review/.',
      '- Report a tight summary (counts by category + final result) at the end.',
    ].join('\n');
    dispatchSkill(prompt, `Reviewing PR for ${changeId}`, {
      ...tagsForChange(changeId),
      skill: 'dev-pr-review',
    });
  }

  const refresh = useCallback(async () => {
    try {
      const r = await getJson<ChangesResponse>('/api/changes');
      setList(r.changes);
      if (selected && !r.changes.find((c) => c.id === selected)) {
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
    getJson<ChangeDetail>(`/api/changes/${encodeURIComponent(selected)}`)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selected]);

  async function openAddForm() {
    let skill = await findSkill('dev-add-change');
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill('dev-add-change');
    }
    if (!skill) {
      alert('dev-add-change skill not found in .claude/skills/');
      return;
    }
    setAddSkill(skill);
  }

  return (
    <div
      className="view changes"
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
        <h1 className="h1">Changes</h1>
        {list && <span className="tiny">{list.length} total</span>}
        {selected && viewMode === 'list' && <span className="badge muted">{selected}</span>}
        <span className="spacer" />
        <div className="tabs" style={{ display: 'flex', gap: 2, marginRight: 8 }}>
          <button
            type="button"
            className={viewMode === 'list' ? 'tab active' : 'tab'}
            onClick={() => setViewMode('list')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icons.File size={12} /> List
          </button>
          <button
            type="button"
            className={viewMode === 'kanban' ? 'tab active' : 'tab'}
            onClick={() => setViewMode('kanban')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icons.Folder size={12} /> Kanban
          </button>
        </div>
        <button type="button" className="btn btn-primary" onClick={openAddForm}>
          <Icons.Plus size={13} /> New Change
        </button>
      </header>

      {viewMode === 'kanban' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {!list ? (
            <p className="subtle" style={{ padding: 18 }}>
              loading…
            </p>
          ) : (
            <KanbanBoard
              list={list}
              onOpen={(id) => {
                setSelected(id);
                setViewMode('list');
              }}
            />
          )}
        </div>
      )}

      {viewMode === 'list' && !selected && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div style={{ padding: '14px 24px 0' }}>
            <LatestArtifactCard
              title="Latest weekly triage"
              path="vault/output/meta/triage/latest.md"
              storageKey="agentic-os/changes-weekly-triage-collapsed"
              emptyMessage={
                'No weekly triage report has run yet. The runbook fires every Monday at 09:00 local; Run now from the Schedules page to generate one.'
              }
            />
          </div>
          {!list ? (
            <p className="subtle" style={{ padding: 18 }}>
              loading…
            </p>
          ) : list.length === 0 ? (
            <div className="card" style={{ margin: 18, padding: 18, maxWidth: 720 }}>
              <p style={{ fontSize: 13, marginTop: 0 }}>
                <strong>No changes yet.</strong>
              </p>
              <p className="subtle" style={{ fontSize: 12.5, marginBottom: 0 }}>
                A change is the atomic unit of code work — single repo, single branch, single PR.
                Click <strong>+ New Change</strong> to scaffold one. Cross-repo work composes via{' '}
                <strong>projects</strong> (one project owns multiple changes).
              </p>
            </div>
          ) : (
            <ChangesTable list={list} onOpen={setSelected} />
          )}
        </div>
      )}

      {viewMode === 'list' && selected && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div
            style={{
              padding: '12px 20px 0',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderBottom: '1px solid var(--border)',
              paddingBottom: 12,
            }}
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setSelected(null)}
              title="Back to all changes"
            >
              <Icons.ChevronLeft size={12} /> All changes
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
            <ChangeDetailPane
              detail={detail}
              onOpenEntry={(id) => nav.navigateToEntry(id)}
              onJumpToProjects={() => nav.setView('projects')}
              onWriteChange={(phase) => invokeWriteChange(detail.change.id as string, phase)}
              onReviewChange={() => invokeReviewChange(detail.change.id as string)}
              onRevisePlan={() => invokeRevisePlan(detail.change.id as string)}
              onOpenPr={() => invokeOpenPr(detail.change.id as string)}
              onReviewPr={(prUrl) => invokeReviewPr(detail.change.id as string, prUrl)}
              onMarkPrReady={() => invokeMarkPrReady(detail.change.id as string)}
              onCloseChange={() => invokeCloseChange(detail.change.id as string)}
              onCloseLocal={() => invokeCloseLocal(detail.change.id as string)}
              onAbandon={() => invokeAbandon(detail.change.id as string)}
              onAudit={() => invokeAudit(detail.change.id as string)}
              dispatching={dispatching}
            />
          )}
        </div>
      )}

      {addSkill && (
        <ScaffoldForm
          skill={addSkill}
          title="Add Change"
          onCancel={() => setAddSkill(null)}
          onSubmit={(prompt) => {
            setAddSkill(null);
            dispatchSkill(prompt, 'Adding change…', { skill: 'dev-add-change' });
          }}
        />
      )}

      {lastDispatchToast && (
        <DispatchToast message={lastDispatchToast} onDismiss={() => setLastDispatchToast(null)} />
      )}

      {closeLocalTarget && (
        <ConfirmModal
          title="Mark change as merged locally?"
          message={
            <>
              <p>
                This flips <code>status: in-progress → merged</code> and stamps{' '}
                <code>merged_at</code> on <code>{closeLocalTarget}</code> — without opening a PR.
              </p>
              <p className="subtle">
                Use this only for inline work that never went through GitHub (typically OS-internal
                changes against agentic-os). For changes with a remote, close them through{' '}
                <code>dev-close-change</code> after the PR merges so GitHub state stays consistent.
              </p>
            </>
          }
          confirmLabel="Mark merged"
          onCancel={() => setCloseLocalTarget(null)}
          onConfirm={() => runCloseLocal(closeLocalTarget)}
        />
      )}

      {abandonTarget && (
        <ConfirmModal
          title="Abandon this change?"
          message={
            <>
              <p>
                This flips <code>status: → abandoned</code> on <code>{abandonTarget}</code>, stamps{' '}
                <code>abandoned_at</code> + <code>abandoned_reason</code>, and appends an{' '}
                <code>## Abandoned</code> section to the body. If the change is research-derived,
                the source research-report's <code>recommended_changes[].status</code> is flipped to{' '}
                <code>abandoned</code> in lockstep.
              </p>
              <p className="subtle">
                A reason is required. It surfaces on the change detail page and on the source
                report's recommended-changes table.
              </p>
              <div className="form-field" style={{ marginTop: 12 }}>
                <label htmlFor="abandon-reason" style={{ fontSize: 12.5, fontWeight: 500 }}>
                  Reason
                </label>
                <textarea
                  id="abandon-reason"
                  autoFocus
                  rows={3}
                  value={abandonReason}
                  onChange={(e) => setAbandonReason(e.target.value)}
                  placeholder="e.g. Deferred to v2 pending Gmail MCP; SMTP setup too high-friction for v1."
                  style={{
                    width: '100%',
                    marginTop: 6,
                    padding: '8px 10px',
                    fontSize: 13,
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  }}
                />
              </div>
            </>
          }
          confirmLabel="Abandon change"
          destructive
          onCancel={() => {
            setAbandonTarget(null);
            setAbandonReason('');
          }}
          onConfirm={() => {
            if (!abandonReason.trim()) return;
            runAbandon(abandonTarget, abandonReason.trim());
          }}
        />
      )}
    </div>
  );
}

function ChangeDetailPane({
  detail,
  onOpenEntry,
  onJumpToProjects,
  onWriteChange,
  onReviewChange,
  onRevisePlan,
  onOpenPr,
  onReviewPr,
  onMarkPrReady,
  onCloseChange,
  onCloseLocal,
  onAbandon,
  onAudit,
  dispatching,
}: {
  detail: ChangeDetail;
  onOpenEntry: (id: string) => void;
  onJumpToProjects: () => void;
  // Optional phase hint disambiguates the run-row title between PLAN /
  // EXECUTE / ADDRESS-COMMENTS — the same dev-write-change skill runs all
  // three based on change state, but the button context tells us which to
  // expect. See Task #426.
  onWriteChange: (phase?: 'plan' | 'execute' | 'address-comments') => void;
  onReviewChange: () => void;
  // Dispatches dev-revise-plan — rewrites the plan to address review findings.
  // Surfaced as a button on the Review tab whenever a review exists; the skill
  // itself refuses cleanly if the review has no findings to address.
  onRevisePlan: () => void;
  onOpenPr: () => void;
  // Dispatches dev-pr-review against the change's open PR. Receives the
  // canonical PR URL from PullRequestTab once the live PR data is loaded.
  onReviewPr: (prUrl: string) => void;
  // Dispatches dev-mark-pr-ready — flips pr_review_status to ready-for-human.
  onMarkPrReady: () => void;
  // Dispatches dev-close-change — verifies merge state via MCP, transitions
  // status to merged + stamps merged_at.
  onCloseChange: () => void;
  // Vault-only closure for changes that never had a PR (no remote / inline
  // work). POSTs to /:id/close-local; no skill dispatch, no GitHub.
  onCloseLocal: () => void;
  // Vault-only abandonment with mandatory reason. POSTs to /:id/abandon;
  // also patches the source research-report when derived_from_report is set.
  onAbandon: () => void;
  // Dispatches meta-overseer-review for terminal-state changes (merged or
  // abandoned). Surfaced as a button in the header next to Abandon. The skill
  // self-validates the audit-opt-in gate + 24h debounce; rejections surface in
  // the run drawer (re-dispatch with force from there if needed).
  onAudit: () => void;
  dispatching: boolean;
}) {
  const navigate = useNavigate();
  const c = detail.change;
  const reviewStatus = c.review_status ?? 'pending';
  const planExists = detail.plan !== null;
  const reviewGateOk =
    reviewStatus === 'approved' || reviewStatus === 'overridden' || reviewStatus === 'not-required';
  const prOpened = c.pr_url != null;

  // Live PR state from GitHub. Polled on mount + whenever pr_url changes.
  // Used to surface the "Close change" banner when GitHub reports merged=true
  // but the change frontmatter is still status: in-review. Hoisted here from
  // PullRequestTab so the primary-action area can react to merge state
  // regardless of which tab is currently open.
  const [livePr, setLivePr] = useState<PrFetchResponse | null>(null);
  useEffect(() => {
    if (!c.pr_url || !c.id) {
      setLivePr(null);
      return;
    }
    let cancelled = false;
    getJson<PrFetchResponse>(`/api/changes/${encodeURIComponent(c.id)}/pr`)
      .then((r) => {
        if (!cancelled) setLivePr(r);
      })
      .catch(() => {
        if (!cancelled) setLivePr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [c.id, c.pr_url]);
  const githubMerged =
    !!livePr && (livePr as PrFetchOk).ok === true && (livePr as PrFetchOk).pr.merged === true;

  let primaryAction: { label: string; onClick: () => void; tooltip?: string } | null = null;
  // Optional secondary action shown next to the primary as a ghost button.
  // Used today by the ready-for-human banner to keep Re-implement reachable
  // without making it the loud CTA.
  let secondaryAction: { label: string; onClick: () => void; tooltip?: string } | null = null;
  let stateHint: string | null = null;
  let hintSeverity: 'info' | 'warn' = 'info';

  // Phase 5 — when the change is in-review (PR opened) and the linked
  // pr-review has accepted/published comments not yet acted-on, the OS-side
  // primary action is to re-implement against them. Takes precedence over
  // the in-progress → Open PR action below.
  //
  // Exception: once `pr_review_status: ready-for-human` is set, the user has
  // explicitly signed off on the PR. The Re-implement banner becomes
  // misleading at that point — the next move is on GitHub, not in the OS.
  // We surface a softer "signed off" hint and demote re-implement to a
  // secondary text mention (still possible, but no longer the primary CTA).
  const commentsToAddress = detail.comments_to_address ?? 0;
  const readyForHuman = c.pr_review_status === 'ready-for-human';

  // Top precedence: PR has been merged on GitHub but the change is still
  // status: in-review locally. dev-close-change is the next action — verify
  // + transition to merged. Wins over the ready-for-human banner because
  // merging supersedes "ready for merge".
  if (c.status === 'in-review' && githubMerged) {
    const merged_at_iso =
      livePr && (livePr as PrFetchOk).ok === true ? (livePr as PrFetchOk).pr.merged_at : null;
    primaryAction = {
      label: 'Close change',
      onClick: onCloseChange,
      tooltip:
        'Runs dev-close-change: verifies the PR is merged via mcp__github__get_pull_request, transitions status to merged + stamps merged_at, auto-checks Done-when boxes, and cleans up the local clone (checkout default branch, delete the feature branch). Idempotent on the vault side — but note the local checkout switch.',
    };
    stateHint = `PR was merged on GitHub${merged_at_iso ? ` ${formatRelative(merged_at_iso)}` : ''}. The change is still status: in-review locally — click Close change to transition it to merged (also flips the lifecycle stepper's "merged" stage to done).`;
  } else if (c.status === 'in-review' && readyForHuman) {
    primaryAction = c.pr_url
      ? {
          label: 'View PR on GitHub',
          onClick: () => {
            window.open(c.pr_url as string, '_blank', 'noreferrer');
          },
          tooltip:
            'You signed off via Mark ready for human — the OS-side flow is done. Open the PR on GitHub to merge it (the OS never auto-merges).',
        }
      : null;
    if (commentsToAddress > 0) {
      // Re-implement is still possible after signing off — but as a ghost
      // secondary action, not the loud primary CTA. Lets the user change
      // their mind without the banner nagging them every visit.
      secondaryAction = {
        label: `Re-implement ${commentsToAddress} anyway`,
        onClick: () => onWriteChange('address-comments'),
        tooltip:
          'Runs dev-write-change in ADDRESS-COMMENTS mode despite the ready-for-human sign-off. Useful when you flipped Mark Ready prematurely and want to address comments after all.',
      };
    }
    stateHint =
      commentsToAddress > 0
        ? `Signed off — pr_review_status is ready-for-human${c.pr_ready_at ? ` since ${formatRelative(c.pr_ready_at)}` : ''}. ${commentsToAddress} review comment${
            commentsToAddress !== 1 ? 's were' : ' was'
          } intentionally left unaddressed in code; click Re-implement to address ${commentsToAddress !== 1 ? 'them' : 'it'} anyway, or merge the PR on GitHub.`
        : `Signed off — pr_review_status is ready-for-human${c.pr_ready_at ? ` since ${formatRelative(c.pr_ready_at)}` : ''}. Merge the PR on GitHub when ready; the OS never auto-merges.`;
  } else if (c.status === 'in-review' && commentsToAddress > 0) {
    primaryAction = {
      label: `Re-implement · ${commentsToAddress} comment${commentsToAddress !== 1 ? 's' : ''}`,
      onClick: () => onWriteChange('address-comments'),
      tooltip:
        'Runs dev-write-change in ADDRESS-COMMENTS mode: reads the accepted comments from the latest PR review pass, makes the code edits on the existing branch, commits the follow-up, then marks each comment status: acted-on. Do this BEFORE Mark ready for human — that way the review is actually addressed in code before you sign off.',
    };
    stateHint = `The latest PR review has ${commentsToAddress} accepted/published comment${
      commentsToAddress !== 1 ? 's' : ''
    } not yet addressed in code. dev-write-change's ADDRESS-COMMENTS phase will re-implement against them on the existing branch.`;
  } else if (c.status === 'planning' && detail.body_has_placeholders) {
    stateHint =
      "This change's Why and Approach sections are still placeholder text. Edit the body below to describe what's broken/needed and how you plan to address it — then generate the plan.";
    hintSeverity = 'warn';
  } else if (
    c.status === 'planning' &&
    (detail.body_draft_marker_count ?? 0) > 0 &&
    !detail.body_has_placeholders
  ) {
    // DRAFT markers from dev-add-change's auto-draft step. One-click resolution
    // via POST /:id/accept-drafts — no markdown editing required.
    const n = detail.body_draft_marker_count ?? 0;
    primaryAction = {
      label: `Accept ${n} draft${n !== 1 ? 's' : ''}`,
      onClick: async () => {
        try {
          await fetch(`/api/changes/${encodeURIComponent(c.id as string)}/accept-drafts`, {
            method: 'POST',
          });
          // Hard refresh: simplest way to refetch detail + transition out
          // of this banner state. The accept is idempotent so a double-fire
          // is safe if anything races.
          window.location.reload();
        } catch {
          /* silent — user can retry */
        }
      },
      tooltip: `Strips all ${n} > **DRAFT** — ... blockquotes from the body. The auto-drafted content under each marker is preserved. Idempotent — safe to re-click.`,
    };
    stateHint = `The change body has ${n} unaccepted DRAFT marker${
      n !== 1 ? 's' : ''
    } from dev-add-change's auto-draft step. Review the body below; when satisfied, click Accept to strip the markers and unblock dev-write-change. (The actual draft content stays — only the marker blockquotes are removed.)`;
  } else if (c.status === 'in-progress' && reviewGateOk && !prOpened) {
    primaryAction = { label: 'Open PR', onClick: onOpenPr };
    stateHint =
      'Code is committed locally. Open the pull request via the github MCP — this pushes the branch and creates the PR. Status transitions to in-review.';
  } else if (c.status === 'planning') {
    if (reviewStatus === 'pending' && !planExists) {
      primaryAction = { label: 'Write plan', onClick: () => onWriteChange('plan') };
      stateHint = 'Plan not yet generated. Run /os write-change to produce the plan.';
    } else if (reviewStatus === 'pending' && planExists) {
      primaryAction = { label: 'Review plan', onClick: onReviewChange };
      stateHint = 'Plan exists, awaiting review. Run /os review-change to gate execution.';
    } else if (reviewGateOk) {
      primaryAction = { label: 'Execute plan', onClick: () => onWriteChange('execute') };
      stateHint =
        reviewStatus === 'approved'
          ? 'Approved by reviewer. Ready to execute.'
          : reviewStatus === 'overridden'
            ? 'Reviewer concerns overridden. Executing will be audit-logged.'
            : 'No review required for this change. Ready to execute.';
    } else if (reviewStatus === 'request-changes') {
      // Surgical revise is the common path — dev-revise-plan folds findings
      // into the existing plan, bumps plan_revision. Full re-plan-from-scratch
      // is the rare escape hatch; users who want it can edit the change file
      // and re-run write-change with force_replan:true via the CLI.
      //
      // After a revise lands, the verdict still describes the prior plan rev,
      // so review_status stays request-changes. Flip the primary action to
      // Re-review so the loud CTA matches the actual next step.
      const planRevisedAt = c.plan_revised_at;
      const reviewedAt = c.reviewed_at;
      const reviewIsStale =
        planRevisedAt != null && reviewedAt != null && planRevisedAt > reviewedAt;
      if (reviewIsStale) {
        primaryAction = { label: 'Re-review', onClick: onReviewChange };
        stateHint =
          'Plan was revised to address the findings. The verdict below still describes the prior revision — click Re-review to fire dev-review-change against the revised plan.';
      } else {
        primaryAction = { label: 'Revise plan', onClick: onRevisePlan };
        stateHint =
          'Reviewer requested changes. Click Revise plan to fold the findings into the plan (dev-revise-plan, bumps plan_revision). After it lands, re-review or proceed to execute.';
      }
    } else if (reviewStatus === 'rejected') {
      stateHint = 'Reviewer rejected the plan. Consider setting status: abandoned.';
    }
  }

  // Close-local — vault-only closure for changes done inline without a PR.
  // Surfaces as a secondary action whenever the change is non-terminal and
  // has no pr_url. Doesn't override Open PR / Re-implement / etc. — the user
  // picks the right path based on whether the repo has a remote. For
  // OS-internal changes against agentic-os, this is the close path.
  if (!c.pr_url && (c.status === 'in-progress' || c.status === 'in-review') && !secondaryAction) {
    secondaryAction = {
      label: 'Mark merged (local)',
      onClick: onCloseLocal,
      tooltip:
        'Vault-only closure. Flips status to merged + stamps merged_at without opening a PR. Use for inline work that never went through GitHub (typically OS-internal changes against agentic-os).',
    };
    if (!stateHint) {
      stateHint =
        'No PR opened. If this work was done inline without a remote, click Mark merged (local) to close it. Otherwise run /os open-pr first.';
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Line 1: title + headline status. The status is the one fact that
            answers "where is this change right now". */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
            {stepPrefix(c) && (
              <span
                className="mono"
                style={{ color: 'var(--accent-text)', fontSize: 14, marginRight: 8 }}
                title={
                  c.derived_from_report
                    ? `Scaffolded from research-report "${c.derived_from_report}"`
                    : undefined
                }
              >
                {stepPrefix(c).trim()}
              </span>
            )}
            {c.title}
          </h2>
          {c.status && (
            <span className={statusBadgeClass(c.status)}>
              {STATUS_LABELS[c.status] ?? c.status}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {/* Abandon — destructive, terminal. Shown only for non-terminal
              changes. Opens a confirm modal that collects a mandatory reason
              and patches the source research-report when derived. */}
          {c.status !== 'merged' && c.status !== 'abandoned' && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onAbandon}
              disabled={dispatching}
              title="Mark this change abandoned. Requires a reason. If research-derived, also flips the source report's recommended_changes[].status to abandoned and stamps abandoned_reason there for traceability."
              style={{
                color: 'var(--warning-text)',
                borderColor: 'var(--warning-border)',
              }}
            >
              <Icons.X size={11} /> Abandon
            </button>
          )}
          {(c.status === 'merged' || c.status === 'abandoned') && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onAudit}
              disabled={dispatching}
              title="Dispatch meta-overseer-review to produce a lifecycle audit (Correctness / Completeness / Efficiency rubric + tuning suggestions). Requires audit.enabled: true on the owning project (or force re-run from the drawer). Equivalent to `/os audit lifecycle <change-id>` from the CLI — tracked in the runs drawer."
            >
              <Icons.Eye size={11} /> Audit lifecycle
            </button>
          )}
        </div>
        {/* Line 2: quieter context — id (for clarity), size, plan-review state.
            "plan review" is explicit because the change may also be in PR
            review (status: in-review) and the two are easy to confuse. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 12,
            color: 'var(--text-3)',
          }}
        >
          {c.id && (
            <code className="mono" style={{ fontSize: 12 }}>
              {c.id}
            </code>
          )}
          {c.size && (
            <>
              <span className="subtle">·</span>
              <span>
                size: <strong>{c.size}</strong>
              </span>
            </>
          )}
          {c.review_status && (
            <>
              <span className="subtle">·</span>
              <span>
                plan review:{' '}
                <span className={reviewBadgeClass(c.review_status)} style={{ fontSize: 10.5 }}>
                  {c.review_status}
                </span>
              </span>
            </>
          )}
        </div>
      </header>

      {stateHint && (
        <div
          className="card"
          style={{
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: hintSeverity === 'warn' ? 'var(--warning-bg)' : 'var(--info-bg)',
            borderColor: hintSeverity === 'warn' ? 'var(--warning-border)' : 'var(--info-border)',
          }}
        >
          <div style={{ flex: 1, fontSize: 13, lineHeight: 1.5 }}>
            {stateHint}
            {dispatching && (
              <span className="subtle" style={{ marginLeft: 8, fontStyle: 'italic' }}>
                · dispatching…
              </span>
            )}
          </div>
          {secondaryAction && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={secondaryAction.onClick}
              disabled={dispatching}
              title={
                dispatching
                  ? 'Disabled — another skill run is in flight. Wait for it to finish.'
                  : secondaryAction.tooltip
              }
            >
              {secondaryAction.label}
            </button>
          )}
          {primaryAction && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={primaryAction.onClick}
              disabled={dispatching}
              title={
                dispatching
                  ? 'Disabled — another skill run is in flight. Wait for it to finish.'
                  : primaryAction.tooltip
              }
            >
              {dispatching ? 'Working…' : primaryAction.label}
            </button>
          )}
        </div>
      )}

      {/* Abandonment banner — pinned at top of body when status: abandoned.
          Carries the abandoned_reason prominently so the change's terminal
          state has a documented "why" without scrolling into Notes. */}
      {c.status === 'abandoned' && c.abandoned_reason && (
        <div
          className="card"
          style={{
            padding: '14px 18px',
            background: 'var(--warning-bg, var(--bg-2))',
            borderColor: 'var(--warning-border)',
            borderLeft: '3px solid var(--warning-text)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 6,
            }}
          >
            <Icons.X size={14} style={{ color: 'var(--warning-text)' }} />
            <strong style={{ fontSize: 13, color: 'var(--warning-text)' }}>Abandoned</strong>
            {c.abandoned_at && (
              <span className="tiny subtle">· {formatRelative(c.abandoned_at)}</span>
            )}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>
            <strong>Reason:</strong> {c.abandoned_reason}
          </div>
          {c.derived_from_report && (
            <div className="tiny" style={{ marginTop: 6, color: 'var(--text-3)' }}>
              Source research-report's recommended_changes[
              {c.recommendation_index ?? '?'}].status was flipped to{' '}
              <code className="mono">abandoned</code> in lockstep.
            </div>
          )}
        </div>
      )}

      <LifecycleStepper
        stages={detail.lifecycle}
        changeProject={detail.change.project}
        onNotifyStep={(eventType, existingRuleId) => {
          if (existingRuleId) {
            navigate(`/notifications/rules/${encodeURIComponent(existingRuleId)}`);
            return;
          }
          const project = detail.change.project ?? '';
          const params = new URLSearchParams({ event_type: eventType });
          if (project) params.set('filter_project', project);
          navigate(`/notifications/rules/new?${params.toString()}`);
        }}
      />

      <ChangeRollupStrip rollup={detail.rollup} />

      <DetailTabs
        detail={detail}
        onOpenEntry={onOpenEntry}
        onJumpToProjects={onJumpToProjects}
        onReviewChange={onReviewChange}
        onRevisePlan={onRevisePlan}
        onReviewPr={onReviewPr}
        onMarkPrReady={onMarkPrReady}
        dispatching={dispatching}
      />
    </div>
  );
}

type DetailTabId =
  | 'overview'
  | 'plan'
  | 'review'
  | 'pr'
  | 'automation'
  | 'related'
  | 'activity'
  | 'replay';

function DetailTabs({
  detail,
  onOpenEntry,
  onJumpToProjects,
  onReviewChange,
  onRevisePlan,
  onReviewPr,
  onMarkPrReady,
  dispatching,
}: {
  detail: ChangeDetail;
  onOpenEntry: (id: string) => void;
  onJumpToProjects: () => void;
  // Re-runs dev-review-change. Used by the Review tab's "Re-review" shortcut
  // when the plan has been revised since the most recent review.
  onReviewChange: () => void;
  // Dispatches dev-revise-plan from the Review tab's "Apply findings" button.
  onRevisePlan: () => void;
  onReviewPr: (prUrl: string) => void;
  onMarkPrReady: () => void;
  dispatching: boolean;
}) {
  const [tab, setTab] = useState<DetailTabId>('overview');
  const c = detail.change;
  const hasPr = c.pr_url != null;

  const TABS: Array<{ id: DetailTabId; label: string; badge?: React.ReactNode }> = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'plan',
      label: 'Plan',
      badge: detail.plan ? <DotIndicator kind="success" /> : <DotIndicator kind="muted" />,
    },
    {
      id: 'review',
      label: 'Review',
      badge: detail.review ? <DotIndicator kind="success" /> : <DotIndicator kind="muted" />,
    },
    {
      id: 'pr',
      label: 'Pull request',
      badge: hasPr ? <DotIndicator kind="success" /> : <DotIndicator kind="muted" />,
    },
    {
      id: 'automation',
      label: 'Automation',
      badge: automationDot(c.automation),
    },
    { id: 'related', label: 'Related' },
    {
      id: 'activity',
      label: 'Activity',
      badge:
        detail.events.length > 0 ? (
          <span className="count">{detail.events.length}</span>
        ) : undefined,
    },
    { id: 'replay', label: 'Replay' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
            onClick={() => setTab(t.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab
          c={c}
          detail={detail}
          onOpenEntry={onOpenEntry}
          onJumpToProjects={onJumpToProjects}
        />
      )}

      {tab === 'plan' &&
        (detail.plan ? (
          <>
            {(c.plan_revision ?? 1) > 1 && (
              <div
                className="tiny subtle"
                style={{
                  marginBottom: 8,
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <span
                  className="badge accent"
                  style={{ fontSize: 10 }}
                  title={`Plan has been revised ${(c.plan_revision ?? 1) - 1} time${(c.plan_revision ?? 1) - 1 !== 1 ? 's' : ''} via dev-revise-plan. See the "Revision N notes" section at the end of the plan for the per-revision changelog.`}
                >
                  revision {c.plan_revision}
                </span>
                {c.plan_revised_at && (
                  <span title={c.plan_revised_at}>revised {formatRelative(c.plan_revised_at)}</span>
                )}
              </div>
            )}
            <ArtifactCard kind="plan" file={detail.plan} />
          </>
        ) : (detail.body_draft_marker_count ?? 0) > 0 && !detail.body_has_placeholders ? (
          <PlanBlockedByDraftsCard
            changeId={detail.change.id as string}
            count={detail.body_draft_marker_count ?? 0}
          />
        ) : detail.body_has_placeholders ? (
          <EmptyTab
            title="Plan blocked — change body has placeholder text"
            hint="dev-write-change's PLAN phase refuses to run while the change's Why/Approach/Done-when sections contain template placeholder text. Edit the body (Overview tab → Markdown) to fill it in, then re-run write-change. (If the body has DRAFT markers too, accept them first.)"
          />
        ) : (
          <EmptyTab
            title="No plan yet"
            hint="Run `/os write-change` to compose the structured plan (touched files, tests, risks)."
          />
        ))}

      {tab === 'review' &&
        (detail.review ? (
          <>
            <ReviseFromReviewCard
              change={c}
              dispatching={dispatching}
              onRevisePlan={onRevisePlan}
              onReviewChange={onReviewChange}
            />
            <ArtifactCard kind="review" file={detail.review} />
          </>
        ) : (
          <EmptyTab
            title="No review yet"
            hint="Run `/os review-change` after a plan exists to peer-review it (read-only verdict)."
          />
        ))}

      {tab === 'pr' && (
        <PullRequestTab
          change={c}
          commentsToAddress={detail.comments_to_address ?? 0}
          untriagedCount={detail.untriaged_comments ?? 0}
          reviewPublished={detail.pr_review_published ?? false}
          reviewGithubReviewId={detail.pr_review_github_review_id ?? null}
          reviewPublishedAt={detail.pr_review_published_at ?? null}
          onReviewPr={onReviewPr}
          onMarkPrReady={onMarkPrReady}
          dispatching={dispatching}
        />
      )}

      {tab === 'automation' && <AutomationTab changeId={c.id ?? ''} automation={c.automation} />}

      {tab === 'related' && (
        <RelatedEntitiesCard related={detail.related} onOpenEntry={onOpenEntry} />
      )}

      {tab === 'activity' &&
        (detail.events.length > 0 ? (
          <ActivityTimeline events={detail.events} />
        ) : (
          <EmptyTab
            title="No recorded events"
            hint="Events appear here when a skill, scheduler, or dashboard action tags this change_id. The first event lands when /os write-change runs."
          />
        ))}

      {tab === 'replay' && <ReplayTab changeId={c.id ?? ''} />}
    </div>
  );
}

function DotIndicator({ kind }: { kind: 'success' | 'muted' }) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: kind === 'success' ? 'var(--success-text)' : 'var(--border)',
        display: 'inline-block',
      }}
    />
  );
}

// Dot color matches the change's automation phase. null/disabled = muted;
// running = accent; paused = warning; complete = success.
function automationDot(automation: ChangeAutomation | null): React.ReactNode {
  if (!automation || !automation.enabled) return <DotIndicator kind="muted" />;
  const phase = automation.state.phase;
  let bg = 'var(--border)';
  if (phase === 'running') bg = 'var(--accent)';
  else if (phase === 'paused') bg = 'var(--warning-text)';
  else if (phase === 'complete') bg = 'var(--success-text)';
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: bg,
        display: 'inline-block',
      }}
    />
  );
}

// ── Automation tab (Phase 3) ────────────────────────────────────────────────
//
// Source-of-truth UI for per-change automation. Reads the change's
// automation block (already loaded as part of ChangeDetail). Mutations go
// through /api/changes/:id/automation/* endpoints; on each ok response we
// refetch via dispatch-broadcast (the page-level useRunTerminal already
// triggers a detail refetch on any run terminal — we lean on that).

interface AutomationStatusBody {
  ok: boolean;
  automation: ChangeAutomation | null;
  change_summary: unknown;
  error?: string;
}

function AutomationTab({
  changeId,
  automation,
}: {
  changeId: string;
  automation: ChangeAutomation | null;
}) {
  const [local, setLocal] = useState<ChangeAutomation | null>(automation);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refresh local when prop changes (parent refetch after run terminal).
  useEffect(() => {
    setLocal(automation);
  }, [automation]);

  async function callEndpoint(suffix: string, body?: Record<string, unknown>) {
    setBusy(suffix);
    setError(null);
    try {
      const r = await fetch(`/api/changes/${encodeURIComponent(changeId)}/automation/${suffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : '{}',
      });
      const j = (await r.json()) as AutomationStatusBody;
      if (!r.ok || !j.ok) {
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      if (j.automation) setLocal(j.automation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const isEnabled = local?.enabled === true;
  const phase = local?.state.phase ?? 'idle';
  const isRunning = phase === 'running';
  const isPaused = phase === 'paused';
  const isComplete = phase === 'complete';
  const isIdle = phase === 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header strip — phase + current_step + iteration count */}
      <div
        className="card"
        style={{
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {automationDot(local)}
          <strong style={{ fontSize: 13 }}>{!local || !local.enabled ? 'Disabled' : phase}</strong>
        </div>
        {local?.state.current_step && (
          <span className="badge muted tiny mono">{local.state.current_step}</span>
        )}
        {local && (
          <span className="tiny subtle">
            iteration {local.state.iteration_count} / {local.iteration_cap}
          </span>
        )}
        {local?.state.paused_reason && (
          <span
            className="tiny"
            style={{ color: 'var(--warning-text)' }}
            title={local.state.paused_reason}
          >
            paused: {local.state.paused_reason}
          </span>
        )}
        {local?.state.last_transition && <span className="spacer" />}
        {local?.state.last_transition && (
          <span className="tiny subtle">
            transitioned {formatRelative(local.state.last_transition)}
          </span>
        )}
      </div>

      {/* Controls row */}
      <div
        className="card"
        style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={isEnabled}
              disabled={busy !== null}
              onChange={(e) => callEndpoint(e.target.checked ? 'enable' : 'disable')}
            />
            Automation enabled
          </label>
          {local && (
            <label
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              title="Max EXECUTE → PR-REVIEW loop iterations before parking"
            >
              Iteration cap
              <input
                type="number"
                min={1}
                max={20}
                value={local.iteration_cap}
                disabled={busy !== null || !isEnabled}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1 && n <= 20) {
                    callEndpoint('enable', { iteration_cap: n });
                  }
                }}
                style={{ width: 60, fontSize: 13, padding: '2px 6px' }}
              />
            </label>
          )}
        </div>

        {isEnabled && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(isIdle || isPaused) && !isComplete && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => callEndpoint('start')}
                disabled={busy !== null}
                title={
                  isPaused
                    ? 'Resume automation — transitions paused → idle and dispatches the next step'
                    : local?.state.current_step
                      ? 'Continue automation — dispatches the next step in the loop'
                      : 'Start automation — dispatches the first step (EXECUTE)'
                }
              >
                <Icons.Play size={11} />
                {isPaused ? ' Resume' : local?.state.current_step ? ' Continue' : ' Start'}
              </button>
            )}
            {isRunning && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => callEndpoint('pause')}
                disabled={busy !== null}
                title="Pause automation — the running skill finishes, but no further steps dispatch"
              >
                Pause
              </button>
            )}
            {local && local.state.iteration_count > 0 && !isRunning && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => callEndpoint('reset')}
                disabled={busy !== null}
                title="Wipe state to initial (phase: idle, current_step: null, iteration_count: 0). Doesn't change enabled."
              >
                Reset
              </button>
            )}
            {isComplete && (
              <span className="tiny subtle" style={{ alignSelf: 'center' }}>
                PR is open and locally reviewed — awaiting human merge on GitHub.
              </span>
            )}
          </div>
        )}

        {error && (
          <div
            className="tiny"
            style={{
              color: 'var(--error-text)',
              padding: '6px 10px',
              background: 'var(--error-bg)',
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Loop diagram + boundary explainer */}
      <div className="card" style={{ padding: '14px 16px' }}>
        <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>The loop</h4>
        <pre
          className="mono tiny"
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: 10,
            margin: 0,
            overflow: 'auto',
            lineHeight: 1.5,
          }}
        >
          {`EXECUTE → OPEN-PR → PR-REVIEW ─┬─ no blockers → complete
                                │
                                └─ needs-changes → ADDRESS-COMMENTS → PR-REVIEW
                                                   (loops; caps at iteration ${local?.iteration_cap ?? 4})`}
        </pre>
        <p className="tiny subtle" style={{ marginTop: 8, marginBottom: 0 }}>
          Boundary: automation stops at <strong>complete</strong> (PR open + reviewed clean,
          awaiting human merge on GitHub). PLAN and plan-review stay manual — automation runs only
          on changes with <code className="mono">status: in-progress</code>.
        </p>
      </div>

      {/* Last run link */}
      {local?.state.last_run_id && (
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="tiny subtle">Most recent dispatch:</span>
            <code className="mono tiny">{local.state.last_run_id}</code>
            <span className="spacer" />
            <span className="tiny subtle">Open the runs drawer to see status.</span>
          </div>
        </div>
      )}

      {/* Automation timeline — orchestrator decisions + dispatched runs in
          chronological order. Always rendered (not just on complete) so the
          narrative is visible mid-cycle too. Decisions live in events.db as
          change-automation-* events; runs live in the runs table. The
          timeline interleaves them by timestamp so post-mortem reading
          works without bouncing between drawer and event log. Closes #429. */}
      <AutomationHistory changeId={changeId} />
    </div>
  );
}

interface AutomationDecisionRow {
  id: number;
  ts: string;
  action: string;
  step: string | null;
  run_id: string | null;
  iteration_count: number | null;
  reason: string | null;
  marked_ready_for_human: boolean | null;
}

type TimelineEntry =
  | { kind: 'run'; ts: string; key: string; run: RunRecord }
  | { kind: 'decision'; ts: string; key: string; decision: AutomationDecisionRow };

function AutomationHistory({ changeId }: { changeId: string }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [decisions, setDecisions] = useState<AutomationDecisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listRuns({ change_id: changeId, limit: 100 }),
      fetch(`/api/changes/${encodeURIComponent(changeId)}/automation/decisions`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
        .then((j: { ok: boolean; decisions: AutomationDecisionRow[]; error?: string }) => {
          if (!j.ok) throw new Error(j.error ?? 'decisions endpoint failed');
          return j.decisions;
        }),
    ])
      .then(([runsJson, decisionsArr]) => {
        if (cancelled) return;
        setRuns(runsJson.runs);
        setDecisions(decisionsArr);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [changeId]);

  if (error) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <span className="tiny" style={{ color: 'var(--error-text)' }}>
          Timeline unavailable: {error}
        </span>
      </div>
    );
  }
  if (runs === null || decisions === null) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <span className="tiny subtle">Loading automation timeline…</span>
      </div>
    );
  }
  if (runs.length === 0 && decisions.length === 0) {
    return (
      <div className="card" style={{ padding: '14px 16px' }}>
        <span className="tiny subtle">
          No automation activity yet. Once you enable automation on this change, decisions and runs
          will appear here in time order.
        </span>
      </div>
    );
  }

  // Merge runs + decisions into a single timeline. Newest first matches the
  // runs drawer's convention and surfaces the most-recent decision at the top
  // (relevant for in-flight cycles). Each decision is associated with a
  // run_id when one was dispatched — the row links to that run.
  const merged: TimelineEntry[] = [
    ...runs.map(
      (r): TimelineEntry => ({ kind: 'run', ts: r.started_at, key: `r-${r.id}`, run: r }),
    ),
    ...decisions.map(
      (d): TimelineEntry => ({ kind: 'decision', ts: d.ts, key: `d-${d.id}`, decision: d }),
    ),
  ].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600 }}>
        Automation timeline ({runs.length} run{runs.length !== 1 ? 's' : ''} · {decisions.length}{' '}
        decision{decisions.length !== 1 ? 's' : ''})
      </h4>
      <div className="tiny subtle" style={{ marginBottom: 10, fontSize: 11 }}>
        Orchestrator decisions + dispatched runs in time order (newest first). Decisions are the
        state-machine&apos;s narrative (advance / pause / complete); runs are the skill dispatches
        each decision spawned. Click a run row to jump to its drawer entry.
      </div>
      <ol
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          borderLeft: '2px solid var(--border)',
          marginLeft: 4,
          paddingLeft: 14,
        }}
      >
        {merged.map((entry) =>
          entry.kind === 'run' ? (
            <li key={entry.key}>
              <AutomationRunRow
                run={entry.run}
                onOpen={() => navigate(`/processes#${entry.run.id}`)}
              />
            </li>
          ) : (
            <li key={entry.key}>
              <AutomationDecisionRowView decision={entry.decision} />
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

function AutomationRunRow({ run, onOpen }: { run: RunRecord; onOpen: () => void }) {
  const durationLabel = (() => {
    if (run.duration_ms == null) return '';
    const s = Math.round(run.duration_ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  })();
  const stateColor =
    run.state === 'done'
      ? 'var(--success-text, var(--muted))'
      : run.state === 'failed'
        ? 'var(--error-text)'
        : run.state === 'running'
          ? 'var(--accent)'
          : 'var(--muted)';
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
      <span className="tiny subtle" style={{ minWidth: 84 }} title={run.started_at}>
        {formatRelative(run.started_at)}
      </span>
      <Icons.Sparkles size={11} style={{ color: 'var(--muted)' }} />
      <code className="mono" style={{ fontSize: 11 }}>
        {run.skill ?? '—'}
      </code>
      <span className="tiny" style={{ color: stateColor }}>
        {run.state}
        {run.exit_status != null && run.state !== 'running' ? ` (${run.exit_status})` : ''}
      </span>
      <span className="spacer" />
      {durationLabel && (
        <span className="tiny subtle" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {durationLabel}
        </span>
      )}
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        style={{ fontSize: 10.5, padding: '0 6px' }}
        onClick={onOpen}
        title={`Open run ${run.id} in Processes.`}
      >
        logs
      </button>
    </div>
  );
}

// Renders one orchestrator decision row in the Automation timeline. Decisions
// are emitted by automation.ts as `change-automation-<verb>` audit events;
// this component picks an icon + label per verb and surfaces the structured
// args (step, run_id, iteration_count, reason) as inline metadata. Visually
// distinct from runs — leftward icon + muted prefix so the timeline reads
// "what the orchestrator decided" vs "what a skill did".
function AutomationDecisionRowView({ decision }: { decision: AutomationDecisionRow }) {
  // Map the action verb to a human label + visual hint. Unknown actions fall
  // through to the raw verb so newly-added orchestrator actions still render
  // without requiring a UI update.
  const { label, color } = (() => {
    const verb = decision.action.replace(/^change-automation-/, '');
    switch (verb) {
      case 'enable':
        return { label: 'enabled', color: 'var(--accent)' };
      case 'disable':
        return { label: 'disabled', color: 'var(--muted)' };
      case 'pause':
        return { label: 'paused', color: 'var(--warning-text, #e0a02a)' };
      case 'resume':
        return { label: 'resumed', color: 'var(--accent)' };
      case 'reset':
        return { label: 'reset', color: 'var(--muted)' };
      case 'advance':
        return { label: '→ advance', color: 'var(--accent)' };
      case 'complete':
        return { label: '✓ complete', color: 'var(--success-text, var(--accent))' };
      default:
        return { label: verb, color: 'var(--muted)' };
    }
  })();

  return (
    <div
      style={{
        padding: '4px 8px',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        fontSize: 12,
        // Distinct background tint so decisions visually pop from runs
        background: 'var(--bg-2, rgba(255,255,255,0.02))',
        borderRadius: 3,
      }}
      title={`Orchestrator event: ${decision.action}`}
    >
      <span className="tiny subtle" style={{ minWidth: 84 }} title={decision.ts}>
        {formatRelative(decision.ts)}
      </span>
      <span className="tiny" style={{ color, minWidth: 90, fontWeight: 500 }}>
        {label}
      </span>
      {decision.step && (
        <code className="mono" style={{ fontSize: 11 }}>
          {decision.step}
        </code>
      )}
      {decision.iteration_count != null && (
        <span className="tiny subtle">iter {decision.iteration_count}</span>
      )}
      {decision.marked_ready_for_human === true && (
        <span className="tiny" style={{ color: 'var(--success-text, var(--accent))' }}>
          marked PR ready
        </span>
      )}
      {decision.reason && (
        <span className="tiny subtle" style={{ flex: 1 }}>
          — {decision.reason}
        </span>
      )}
      {decision.run_id && (
        <code
          className="mono tiny subtle"
          style={{ marginLeft: 'auto', fontSize: 10.5 }}
          title={`Dispatched run: ${decision.run_id}`}
        >
          {decision.run_id.slice(0, 12)}
        </code>
      )}
    </div>
  );
}

function EmptyTab({ title, hint }: { title: string; hint: string }) {
  // Render `inline-code` segments wrapped in <code className="mono">. Keys
  // are derived from the part text itself (with a salt) so we don't trip
  // biome's noArrayIndexKey rule.
  const parts = hint.split('`').map((part, i) => ({
    text: part,
    isCode: i % 2 === 1,
  }));
  return (
    <div className="card" style={{ padding: 28, textAlign: 'center' }}>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>{title}</div>
      <p className="subtle" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>
        {parts.map((p) =>
          p.isCode ? (
            <code key={`c:${p.text}`} className="mono">
              {p.text}
            </code>
          ) : (
            <span key={`t:${p.text}`}>{p.text}</span>
          ),
        )}
      </p>
    </div>
  );
}

// Map lifecycle field values to badge severities. Each row is one valid
// value → tailwind-ish badge class shape used by the existing .badge CSS.
// `null` / unknown values land on muted.
function badgeClassForStatus(v: string | null): string {
  switch (v) {
    case 'in-progress':
      return 'badge accent';
    case 'in-review':
      return 'badge warning';
    case 'merged':
      return 'badge success';
    case 'abandoned':
      return 'badge danger';
    case 'planning':
    default:
      return 'badge muted';
  }
}
function badgeClassForReview(v: string | null): string {
  switch (v) {
    case 'approved':
      return 'badge success';
    case 'request-changes':
      return 'badge warning';
    case 'rejected':
      return 'badge danger';
    case 'overridden':
      return 'badge accent';
    case 'not-required':
      return 'badge muted';
    case 'pending':
    default:
      return 'badge muted';
  }
}
function badgeClassForCi(v: string | null): string {
  switch (v) {
    case 'pass':
      return 'badge success';
    case 'fail':
      return 'badge danger';
    case 'running':
      return 'badge accent';
    case 'none':
    default:
      return 'badge muted';
  }
}
function badgeClassForPrReview(v: string | null): string {
  switch (v) {
    case 'ready-for-human':
      return 'badge accent';
    case 'approved':
      return 'badge success';
    case 'needs-changes':
      return 'badge warning';
    case 'pending':
    default:
      return 'badge muted';
  }
}

// Status badge that renders the field name + value, with a color hint per
// the value's severity. Renders nothing when value is null AND the field
// isn't required to be visible (`alwaysShow` overrides).
function StatusBadge({
  label,
  value,
  className,
  alwaysShow = false,
}: {
  label: string;
  value: string | null;
  className: string;
  alwaysShow?: boolean;
}) {
  if (!value && !alwaysShow) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="tiny" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <span className={className} style={{ fontSize: 11, alignSelf: 'flex-start' }}>
        <span className="badge-dot" />
        {value ?? '—'}
      </span>
    </div>
  );
}

// Extract a top-level markdown section by heading name. Returns the body of
// `## <heading>` up to the next `## ` (or end of string). Null when missing.
// JS regex doesn't have `\Z`, so the negative-lookahead anchors on either
// the next `## ` or the literal end of the string (`$` with multiline flag).
function extractPlanSection(plan: string, heading: string): string | null {
  // Headings can have trailing punctuation (e.g. `## Tests`) — match the line
  // exactly to avoid accidentally grabbing `## Tests covered` or similar.
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |\\n*$)`, 'm');
  const m = plan.match(re);
  if (!m) return null;
  const body = m[1].trim();
  return body.length > 0 ? body : null;
}

// Plan-summary card — renders the current plan's `## Approach` + `## Tests`
// sections inline on the Overview tab so the reader sees both the user-authored
// body narrative AND the derived plan content side-by-side. The plan file is
// rewritten by dev-revise-plan; this card auto-updates on next fetch.
//
// Companion to the plan-revised banner (which signals "body below is stale")
// — together they tell the reader: "body is the original scope; the card
// above is the current technical plan."
function PlanSummaryCard({
  file,
  planRevision,
  planRevisedAt,
}: {
  file: FileRef;
  planRevision: number | null;
  planRevisedAt: string | null;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEntry(file.path)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [file.path]);

  const approach = useMemo(
    () => (content ? extractPlanSection(content, 'Approach') : null),
    [content],
  );
  const tests = useMemo(() => (content ? extractPlanSection(content, 'Tests') : null), [content]);

  // Hide silently while loading or if both sections are missing — no signal
  // is better than a broken card. The Plan tab is one click away.
  if (loadError) return null;
  if (!content) return null;
  if (!approach && !tests) return null;

  const rev = planRevision ?? 1;
  const sectionHeader: React.CSSProperties = {
    margin: '0 0 8px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--muted)',
  };

  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Current plan summary</h4>
        <span className="tiny" style={{ color: 'var(--muted)' }}>
          revision {rev}
          {rev > 1 && planRevisedAt && ` · revised ${formatRelative(planRevisedAt)}`}
        </span>
      </div>
      <div style={{ padding: '14px 18px 16px' }}>
        {approach && (
          <>
            <h5 style={sectionHeader}>Approach</h5>
            <Rendered content={approach} />
          </>
        )}
        {tests && (
          <div style={{ marginTop: approach ? 14 : 0 }}>
            <h5 style={sectionHeader}>Tests</h5>
            <Rendered content={tests} />
          </div>
        )}
      </div>
    </section>
  );
}

function OverviewTab({
  c,
  detail,
  onOpenEntry,
  onJumpToProjects,
}: {
  c: ChangeSummary;
  detail: ChangeDetail;
  onOpenEntry: (id: string) => void;
  onJumpToProjects: () => void;
}) {
  // Decide which dynamic fields to surface in the hero strip — show all that
  // have a value, plus status always (it's the headline). Each maps to a
  // severity-colored badge so the user can scan lifecycle health in <1s.
  const heroFields: Array<{
    label: string;
    value: string | null;
    className: string;
    alwaysShow?: boolean;
  }> = [
    {
      label: 'Status',
      value: c.status,
      className: badgeClassForStatus(c.status),
      alwaysShow: true,
    },
    { label: 'Review', value: c.review_status, className: badgeClassForReview(c.review_status) },
    { label: 'CI', value: c.ci_state, className: badgeClassForCi(c.ci_state) },
    {
      label: 'Sign-off',
      value: c.pr_review_status,
      className: badgeClassForPrReview(c.pr_review_status),
    },
  ];

  const commentsCount = detail.comments_to_address ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Status at a glance — auto-updates as skills flip frontmatter fields */}
      <div
        className="card"
        style={{
          padding: 14,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          gap: 18,
        }}
      >
        {heroFields.map((f) => (
          <StatusBadge
            key={f.label}
            label={f.label}
            value={f.value}
            className={f.className}
            alwaysShow={f.alwaysShow}
          />
        ))}
        {c.size && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="tiny" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Size
            </span>
            <span className="badge muted" style={{ fontSize: 11, alignSelf: 'flex-start' }}>
              {c.size}
            </span>
          </div>
        )}
        {commentsCount > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="tiny" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
              To address
            </span>
            <span
              className="badge warning"
              style={{ fontSize: 11, alignSelf: 'flex-start' }}
              title="Accepted review comments not yet addressed via dev-write-change ADDRESS-COMMENTS"
            >
              <span className="badge-dot" />
              {commentsCount} comment{commentsCount === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </div>

      <div
        className="card"
        style={{
          padding: 16,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
        }}
      >
        {c.repo && (
          <MetaItem label="Repo">
            <button
              type="button"
              className="link-inline"
              onClick={() => onOpenEntry(c.repo as string)}
              style={linkStyle}
            >
              {c.repo}
            </button>
          </MetaItem>
        )}
        {c.branch && (
          <MetaItem label="Branch">
            <code className="mono" style={{ fontSize: 12 }}>
              {c.branch}
            </code>
          </MetaItem>
        )}
        {c.scope && (
          <MetaItem label="Scope">
            <code className="mono" style={{ fontSize: 12 }}>
              {c.scope}
            </code>
          </MetaItem>
        )}
        {c.pr_url && (
          <MetaItem label="Pull request">
            <a
              href={c.pr_url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: 'var(--accent)' }}
            >
              {c.pr_url.replace(/^https?:\/\//, '')}
            </a>
          </MetaItem>
        )}
        {c.project && (
          <MetaItem label="Project">
            <button
              type="button"
              className="link-inline"
              onClick={onJumpToProjects}
              style={linkStyle}
            >
              {c.project}
            </button>
          </MetaItem>
        )}
        {c.parent_change && (
          <MetaItem label="Parent change">
            <button
              type="button"
              className="link-inline"
              onClick={() => onOpenEntry(c.parent_change as string)}
              style={linkStyle}
            >
              {c.parent_change}
            </button>
          </MetaItem>
        )}
        {c.pr_ready_at && (
          <MetaItem label="Marked ready">
            <span title={c.pr_ready_at} style={{ fontSize: 12.5 }}>
              {formatRelative(c.pr_ready_at)}
            </span>
          </MetaItem>
        )}
        {c.merged_at && (
          <MetaItem label="Merged">
            <span title={c.merged_at} style={{ fontSize: 12.5 }}>
              {formatRelative(c.merged_at)}
            </span>
          </MetaItem>
        )}
        {c.updated && (
          <MetaItem label="Updated">
            <span title={c.updated} style={{ fontSize: 12.5 }}>
              {formatRelative(c.updated)}
            </span>
          </MetaItem>
        )}
      </div>

      {/* Plan-revised banner — fires when dev-revise-plan has rewritten the
          plan artifact but the body's scaffolded prose hasn't been hand-edited
          to match. Plan tab carries the current Approach; this is the heads-up
          so the reader doesn't take the body below as authoritative. */}
      {(c.plan_revision ?? 1) > 1 && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            background: 'var(--warning-soft)',
            borderColor: 'color-mix(in oklab, var(--warning) 30%, var(--border))',
          }}
        >
          <span style={{ color: 'var(--warning-text)', fontWeight: 600, fontSize: 12 }}>ⓘ</span>
          <div className="tiny" style={{ flex: 1, color: 'var(--warning-text)' }}>
            Plan revised to <strong>revision {c.plan_revision}</strong>
            {c.plan_revised_at && (
              <span title={c.plan_revised_at}> · {formatRelative(c.plan_revised_at)}</span>
            )}
            {
              ' — see the current plan summary below for the latest Approach. The body further down reflects the original scope from scaffolding.'
            }
          </div>
        </div>
      )}

      {/* Current plan summary — renders the derived plan's Approach + Tests
          inline so the reader sees the latest technical plan without leaving
          the Overview tab. Auto-updates when dev-revise-plan rewrites the
          plan file. */}
      {detail.plan && (
        <PlanSummaryCard
          file={detail.plan}
          planRevision={c.plan_revision}
          planRevisedAt={c.plan_revised_at}
        />
      )}

      <EditableMarkdown path={c.path} content={detail.content} />
    </div>
  );
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

function ArtifactCard({ kind, file }: { kind: 'plan' | 'review'; file: FileRef }) {
  const navigate = useNavigate();
  const title = kind === 'plan' ? 'Plan' : 'Review';
  const verb = kind === 'plan' ? 'generated' : 'reviewed';
  // The FileRef carries only a 600-char preview; fetch the full content
  // so the user can read the entire plan/review without scrolling to a
  // separate vault entry.
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchEntry(file.path)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [file.path]);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h4>
        <span className="tiny" title={file.mtime}>
          {verb} {formatRelative(file.mtime)}
        </span>
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
            // Deep-link into the Vault app's output tab to this specific
            // file. URL slug is everything after vault/output/ — the Vault
            // FileLister resolves it back to the full path on mount.
            const slug = file.path.replace(/^vault\/(output|raw)\//, '');
            const prefix = file.path.startsWith('vault/output/') ? 'output' : 'raw';
            navigate(`/vault/${prefix}/${slug}`);
          }}
          title="Open the Vault app's output tab at this file"
        >
          <Icons.External size={11} /> Open in Vault
        </button>
      </div>
      <div style={{ padding: '0 16px' }}>
        {error && (
          <p
            className="tiny"
            style={{
              padding: '14px 0',
              color: 'var(--danger-text)',
              margin: 0,
            }}
          >
            Failed to load: {error}. Falling back to the preview snippet below.
          </p>
        )}
        {!content && !error && (
          <p className="subtle" style={{ padding: '14px 0', fontSize: 12.5, margin: 0 }}>
            Loading…
          </p>
        )}
        {(content || file.preview) &&
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
              {content ?? file.preview}
            </pre>
          ) : (
            // Reuse EditableMarkdown for consistent rendering with the rest
            // of the dashboard (wikilink resolution, GFM tables, code blocks
            // with syntax highlight). It defaults to render-mode; clicking
            // into the prose flips to edit mode which is fine — users can
            // tweak the plan in place if they want.
            <div style={{ padding: '4px 0 14px' }}>
              <EditableMarkdown
                path={file.path}
                content={content ?? file.preview}
                onSaved={(c) => setContent(c)}
              />
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
        <code className="mono">{file.path}</code>
      </div>
    </div>
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

// ─── Lifecycle stepper ───────────────────────────────────────────────────────

// Compact rollup strip — total cost / wall-time / run-count for this change.
// Hides when nothing's been spent yet. Tooltip on each chip shows the
// per-skill breakdown so the user can see where time/money went.
function ChangeRollupStrip({
  rollup,
}: {
  rollup: ChangeDetail['rollup'];
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
      <span className="spacer" />
      <span className="tiny subtle">hover for per-skill breakdown</span>
    </section>
  );
}

// Step → event_type mapping moved to vault/wiki/_seed/meta/reference/
// event-catalog.md (the `lifecycle_step` column with values `change:<id>`).
// Single source of truth — fetched + queried via findEventForStep below.

function LifecycleStepper({
  stages,
  changeProject,
  onNotifyStep,
}: {
  stages: LifecycleStage[];
  changeProject: string | null;
  onNotifyStep: (eventType: string, existingRuleId: string | null) => void;
}) {
  const [subscriptionMap, setSubscriptionMap] = useState<Map<string, string>>(() => new Map());
  const [catalog, setCatalog] = useState<EventCatalogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listRules(), getEventCatalog()])
      .then(([rules, cat]) => {
        if (cancelled) return;
        setSubscriptionMap(buildSubscriptionMap(rules.rules, changeProject));
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
  }, [changeProject]);

  if (stages.length === 0) return null;
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Lifecycle</h4>
        <span className="tiny">
          {stages.filter((s) => s.status === 'done').length} of {stages.length} complete
        </span>
      </div>
      <Stepper
        steps={stages.map((s) => {
          const eventType = findEventForStep(catalog, 'change', s.id);
          const subscribedRuleId = eventType ? (subscriptionMap.get(eventType) ?? null) : null;
          return {
            id: s.id,
            label: s.label,
            status: s.status,
            at: s.at,
            hint: s.hint,
            onNotify: eventType ? () => onNotifyStep(eventType, subscribedRuleId) : undefined,
            notifyHint: eventType
              ? subscribedRuleId
                ? `Edit existing rule for ${eventType}${changeProject ? ` (project ${changeProject})` : ''}`
                : `Notify on ${eventType}${changeProject ? ` (filtered to project ${changeProject})` : ''}`
              : null,
            subscribedRuleId,
          };
        })}
      />
      <CurrentStageDetail stages={stages} />
    </section>
  );
}

function CurrentStageDetail({ stages }: { stages: LifecycleStage[] }) {
  // Highlight the current stage, or the most recently completed if everything's done.
  const current = stages.find((s) => s.status === 'current');
  const lastDone = [...stages].reverse().find((s) => s.status === 'done');
  const focus = current ?? lastDone ?? stages[0];
  if (!focus) return null;
  const isCurrent = focus.status === 'current';
  return (
    <div
      style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-2)',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}
    >
      <span className={`badge ${isCurrent ? 'info' : 'success'}`} style={{ flexShrink: 0 }}>
        {isCurrent ? 'Up next' : 'Last completed'}
      </span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 2 }}>{focus.label}</div>
        {focus.hint && (
          <div className="subtle" style={{ fontSize: 12, lineHeight: 1.45 }}>
            {focus.hint}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: 12,
            marginTop: 6,
            fontSize: 11.5,
            color: 'var(--text-3)',
            flexWrap: 'wrap',
          }}
        >
          {focus.via && (
            <span>
              via <code className="mono">{focus.via}</code>
            </span>
          )}
          {focus.at && <span>at {formatRelative(focus.at)}</span>}
          {focus.artifact && (
            <span>
              artifact: <code className="mono">{focus.artifact}</code>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Activity timeline ───────────────────────────────────────────────────────

// Full-width tabular changes list. Replaces the narrow stacked-card picker.
// Columns are intentionally tight today (status, title, repo, branch,
// project, updated) — easy to add more as the change schema grows. Click
// any row to select that change.
function ChangesTable({
  list,
  onOpen,
}: {
  list: ChangeSummary[];
  onOpen: (id: string) => void;
}) {
  // Terminal changes (merged / abandoned) collapse behind a toggle row —
  // active work owns the table. Terminal segment re-sorts newest-first by
  // updated (the server's status-priority order is for the active segment).
  const IN_FLIGHT = new Set(['planning', 'in-progress', 'in-review']);
  const active = list.filter((c) => !c.status || IN_FLIGHT.has(c.status));
  const terminal = list
    .filter((c) => c.status && !IN_FLIGHT.has(c.status))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  const [collapsed, toggle] = useCollapsedFlag('changes:terminal');
  const renderRow = (c: ChangeSummary) => (
    <React.Fragment key={c.path}>
      <tr
        onClick={() => c.id && onOpen(c.id)}
        style={{ cursor: c.id ? 'pointer' : 'default' }}
        title={c.id ?? undefined}
      >
        <td style={{ whiteSpace: 'nowrap' }}>
          {c.status && (
            <span className={statusBadgeClass(c.status)}>
              {STATUS_LABELS[c.status] ?? c.status}
            </span>
          )}
        </td>
        <td style={{ fontWeight: 500 }}>
          {stepPrefix(c) && (
            <span
              className="mono"
              style={{ color: 'var(--accent-text)', fontSize: 11.5, marginRight: 6 }}
              title={
                c.derived_from_report ? `Scaffolded from "${c.derived_from_report}"` : undefined
              }
            >
              {stepPrefix(c).trim()}
            </span>
          )}
          {c.title}
        </td>
        <td className="mono tiny">{c.repo ?? '—'}</td>
        <td className="mono tiny">{c.branch ?? '—'}</td>
        <td className="tiny">{c.project ?? '—'}</td>
        <td className="tiny">
          {c.pr_url ? (
            <a
              href={c.pr_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              #{c.pr_url.split('/').pop()}
            </a>
          ) : (
            '—'
          )}
        </td>
        <td className="tiny subtle" title={c.updated ?? undefined}>
          {c.updated ? formatRelative(c.updated) : '—'}
        </td>
      </tr>
    </React.Fragment>
  );
  return (
    <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th>Status</th>
          <th>Title</th>
          <th>Repo</th>
          <th>Branch</th>
          <th>Project</th>
          <th>PR</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {active.map(renderRow)}
        {terminal.length > 0 && (
          <SectionToggleRow
            colSpan={7}
            label="Terminal"
            count={terminal.length}
            collapsed={collapsed}
            onToggle={toggle}
          />
        )}
        {!collapsed && terminal.map(renderRow)}
      </tbody>
    </table>
  );
}

// ── Replay tab ───────────────────────────────────────────────────────────
// Chronological "autobiography of a change" — events, runs, commits, and
// lifecycle stage transitions merged into one timeline. Fetches lazily from
// GET /api/changes/:id/replay on mount.

interface ReplayResponse {
  ok: true;
  change_id: string;
  rollup: {
    cost_usd: number;
    duration_ms: number;
    skill_count: number;
    by_skill: Array<{ skill: string; count: number; cost_usd: number; duration_ms: number }>;
    ai_prompt_runs: number;
  };
  stage_transitions: Array<{ stage: string; label: string; at: string | null; via: string | null }>;
  runs: Array<{
    id: string;
    started_at: string;
    state: string;
    exit_status: number | null;
    duration_ms: number | null;
    skill: string | null;
    title: string | null;
    cost_usd: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    model: string | null;
  }>;
  commits: Array<{
    sha: string;
    short_sha: string;
    subject: string;
    author: string;
    ts: string;
    body: string;
  }>;
  timeline: Array<
    | {
        ts: string;
        kind: 'stage';
        stage: { id: string; label: string; via: string | null };
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
        };
      }
  >;
}

function ReplayTab({ changeId }: { changeId: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<ReplayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!changeId) return;
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/changes/${encodeURIComponent(changeId)}/replay`)
      .then((r) => r.json())
      .then((j: ReplayResponse | { ok: false; error?: string }) => {
        if (cancelled) return;
        if ('ok' in j && j.ok) setData(j as ReplayResponse);
        else setError(('error' in j && j.error) || 'replay failed');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [changeId]);

  if (error) {
    return <EmptyTab title="Replay unavailable" hint={`Failed to load: ${error}`} />;
  }
  if (!data) {
    return (
      <p className="subtle" style={{ padding: 24, fontSize: 13 }}>
        Loading replay…
      </p>
    );
  }

  const totalMinutes = Math.round(data.rollup.duration_ms / 60000);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section
        className="card"
        style={{ padding: '12px 16px', display: 'flex', gap: 22, flexWrap: 'wrap' }}
      >
        <ReplayStat label="Total cost" value={`$${data.rollup.cost_usd.toFixed(2)}`} />
        <ReplayStat label="Wall-time" value={`${totalMinutes}m`} />
        <ReplayStat label="Billable runs" value={`${data.rollup.ai_prompt_runs}`} />
        <ReplayStat label="Skills" value={`${data.rollup.skill_count}`} />
        <ReplayStat label="Stages done" value={`${data.stage_transitions.length}`} />
        <ReplayStat label="Commits" value={`${data.commits.length}`} />
      </section>

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
        }}
      >
        {[...data.timeline]
          .sort((a, b) => b.ts.localeCompare(a.ts))
          .map((entry, i) => (
            <li key={`${entry.ts}-${i}`}>
              {entry.kind === 'stage' && (
                <ReplayStageRow ts={entry.ts} label={entry.stage.label} via={entry.stage.via} />
              )}
              {entry.kind === 'event' && (
                <ReplayEventRow
                  ts={entry.ts}
                  event={entry.event}
                  onOpenRun={(rid) => navigate(`/processes#${rid}`)}
                />
              )}
              {entry.kind === 'commit' && <ReplayCommitRow ts={entry.ts} commit={entry.commit} />}
            </li>
          ))}
      </ol>
    </div>
  );
}

function ReplayStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div className="tiny subtle" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
    </div>
  );
}

function ReplayStageRow({
  ts,
  label,
  via,
}: {
  ts: string;
  label: string;
  via: string | null;
}) {
  return (
    <div
      style={{
        padding: '6px 10px',
        margin: '6px 0',
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-border)',
        borderRadius: 6,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        fontSize: 12.5,
      }}
    >
      <Icons.Check size={12} style={{ color: 'var(--accent-text)' }} />
      <strong style={{ color: 'var(--accent-text)' }}>Stage: {label}</strong>
      {via && <span className="tiny subtle">via {via}</span>}
      <span className="spacer" />
      <span className="tiny" title={ts}>
        {formatRelative(ts)}
      </span>
    </div>
  );
}

interface ReplayEventPayload {
  id: number;
  action: string | null;
  skill: string | null;
  duration_ms: number | null;
  exit_status: string | null;
  cost_usd: number | null;
  run_id: string | null;
}

function ReplayEventRow({
  ts,
  event,
  onOpenRun,
}: {
  ts: string;
  event: ReplayEventPayload;
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
      <span style={{ flex: 1 }}>{event.action ?? '(event)'}</span>
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

function ReplayCommitRow({
  ts,
  commit,
}: {
  ts: string;
  commit: ReplayResponse['commits'][number];
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
      <span className="tiny subtle">{commit.author}</span>
      <span className="tiny" title={ts}>
        {formatRelative(ts)}
      </span>
    </div>
  );
}

function ActivityTimeline({ events }: { events: ChangeEvent[] }) {
  // events arrive oldest-first from the backend. Reverse for newest-first display.
  const ordered = [...events].reverse();
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Activity</h4>
        <span className="tiny">
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
      </div>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {ordered.map((ev) => (
          <li
            key={ev.id}
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 12.5,
            }}
          >
            <span
              className={`badge ${ev.exit_status === 'success' || ev.exit_status == null ? 'muted' : 'error'}`}
              style={{ minWidth: 64, justifyContent: 'center', fontSize: 10.5 }}
            >
              {ev.kind}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                {ev.skill && (
                  <code className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>
                    {ev.skill}
                  </code>
                )}
                {ev.action && (
                  <span className="tiny" style={{ color: 'var(--text-2)' }}>
                    {ev.action}
                  </span>
                )}
                <span className="spacer" />
                <span className="tiny" title={ev.ts}>
                  {formatRelative(ev.ts)}
                </span>
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  marginTop: 2,
                  fontSize: 11,
                  color: 'var(--text-3)',
                }}
              >
                {ev.duration_ms != null && <span>{Math.round(ev.duration_ms)}ms</span>}
                {ev.cost_usd != null && ev.cost_usd > 0 && <span>${ev.cost_usd.toFixed(4)}</span>}
                {ev.exit_status && ev.exit_status !== 'success' && (
                  <span style={{ color: 'var(--error-text)' }}>{ev.exit_status}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Related entities card ───────────────────────────────────────────────────

function RelatedEntitiesCard({
  related,
  onOpenEntry,
}: {
  related: RelatedEntities;
  onOpenEntry: (id: string) => void;
}) {
  const hasAny =
    related.project ||
    related.repo ||
    related.parent_change ||
    related.skills_used.length > 0 ||
    related.mcps_used.length > 0 ||
    related.artifacts.length > 0;
  if (!hasAny) return null;
  return (
    <section className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Related</h4>
      </div>
      <div
        style={{
          padding: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 14,
        }}
      >
        {related.project && (
          <RelatedItem label="Project">
            <button
              type="button"
              onClick={() => related.project && onOpenEntry(related.project)}
              style={linkStyle}
            >
              {related.project}
            </button>
          </RelatedItem>
        )}
        {related.repo && (
          <RelatedItem label="Repo">
            <button
              type="button"
              onClick={() => related.repo && onOpenEntry(related.repo)}
              style={linkStyle}
            >
              {related.repo}
            </button>
          </RelatedItem>
        )}
        {related.parent_change && (
          <RelatedItem label="Parent change">
            <button
              type="button"
              onClick={() => related.parent_change && onOpenEntry(related.parent_change)}
              style={linkStyle}
            >
              {related.parent_change}
            </button>
          </RelatedItem>
        )}
        {related.skills_used.length > 0 && (
          <RelatedItem label={`Skills (${related.skills_used.length})`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {related.skills_used.map((s) => (
                <code key={s} className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                  {s}
                </code>
              ))}
            </div>
          </RelatedItem>
        )}
        {related.mcps_used.length > 0 && (
          <RelatedItem label={`MCPs (${related.mcps_used.length})`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {related.mcps_used.map((m) => (
                <span key={m} className="badge accent" style={{ fontSize: 10.5 }}>
                  {m}
                </span>
              ))}
            </div>
          </RelatedItem>
        )}
        {related.artifacts.length > 0 && (
          <RelatedItem label={`Artifacts (${related.artifacts.length})`}>
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
              {related.artifacts.map((a) => (
                <li key={a.path} style={{ fontSize: 11.5 }}>
                  <span style={{ color: 'var(--text-3)' }}>{a.kind}:</span>{' '}
                  <code className="mono">{a.path}</code>
                </li>
              ))}
            </ul>
          </RelatedItem>
        )}
      </div>
    </section>
  );
}

function RelatedItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="tiny" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <div>{children}</div>
    </div>
  );
}

// ─── Kanban view ─────────────────────────────────────────────────────────────

const KANBAN_COLUMNS: Array<{ status: string; label: string }> = [
  { status: 'planning', label: 'Planning' },
  { status: 'in-progress', label: 'In progress' },
  { status: 'in-review', label: 'In review' },
  { status: 'merged', label: 'Merged' },
  { status: 'abandoned', label: 'Abandoned' },
];

export function KanbanBoard({
  list,
  onOpen,
}: {
  list: ChangeSummary[];
  onOpen: (id: string | null) => void;
}) {
  const byStatus = new Map<string, ChangeSummary[]>();
  for (const col of KANBAN_COLUMNS) byStatus.set(col.status, []);
  for (const c of list) {
    const k = c.status ?? 'planning';
    if (!byStatus.has(k)) byStatus.set(k, []);
    byStatus.get(k)?.push(c);
  }
  // Terminal columns (merged / abandoned) start collapsed to narrow rails —
  // the board is for in-flight work. Click the rail to expand. Items inside
  // terminal columns sort newest-first by updated.
  const TERMINAL_COLUMNS = new Set(['merged', 'abandoned']);
  for (const status of TERMINAL_COLUMNS) {
    byStatus.get(status)?.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  }
  const [mergedCollapsed, toggleMerged] = useCollapsedFlag('changes:kanban:merged');
  const [abandonedCollapsed, toggleAbandoned] = useCollapsedFlag('changes:kanban:abandoned');
  const collapsedFor = (status: string) =>
    status === 'merged' ? mergedCollapsed : status === 'abandoned' ? abandonedCollapsed : false;
  const toggleFor = (status: string) =>
    status === 'merged' ? toggleMerged : status === 'abandoned' ? toggleAbandoned : undefined;
  const gridCols = KANBAN_COLUMNS.map((col) =>
    collapsedFor(col.status) ? '44px' : 'minmax(220px, 1fr)',
  ).join(' ');
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: gridCols,
        gap: 12,
        padding: 16,
        overflow: 'auto',
        flex: 1,
        minHeight: 0,
      }}
    >
      {KANBAN_COLUMNS.map((col) => {
        const items = byStatus.get(col.status) ?? [];
        const isCollapsed = collapsedFor(col.status);
        const onToggle = toggleFor(col.status);
        if (isCollapsed && onToggle) {
          return (
            <button
              key={col.status}
              type="button"
              className="card"
              onClick={onToggle}
              title={`Expand ${col.label} (${items.length})`}
              style={{
                padding: '10px 4px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                border: '1px solid var(--border)',
                background: 'var(--bg-2)',
              }}
            >
              <span
                style={{
                  writingMode: 'vertical-rl',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                  color: 'var(--text-3)',
                }}
              >
                {col.label}
              </span>
              <span className="tiny">{items.length}</span>
            </button>
          );
        }
        return (
          <div
            key={col.status}
            className="card"
            style={{
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <div className="card-header" style={{ padding: '10px 12px' }}>
              <h4
                style={{
                  margin: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                {col.label}
              </h4>
              <span
                className="tiny"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                {items.length}
                {toggleFor(col.status) && (
                  <button
                    type="button"
                    onClick={toggleFor(col.status)}
                    title={`Collapse ${col.label}`}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-3)',
                      padding: 0,
                      fontSize: 11,
                    }}
                  >
                    ◂
                  </button>
                )}
              </span>
            </div>
            <ul
              style={{
                listStyle: 'none',
                padding: 8,
                margin: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                flex: 1,
                overflow: 'auto',
              }}
            >
              {items.map((c) => (
                <li key={c.path}>
                  <button
                    type="button"
                    onClick={() => onOpen(c.id)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '8px 10px',
                      cursor: 'pointer',
                      color: 'var(--text)',
                    }}
                  >
                    <div style={{ fontWeight: 500, fontSize: 12.5, marginBottom: 4 }}>
                      {stepPrefix(c) && (
                        <span
                          className="mono"
                          style={{ color: 'var(--accent-text)', fontSize: 11, marginRight: 6 }}
                        >
                          {stepPrefix(c).trim()}
                        </span>
                      )}
                      {c.title}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        fontSize: 10.5,
                        color: 'var(--text-3)',
                      }}
                    >
                      {c.repo && <span className="mono">{c.repo}</span>}
                      {c.project && <span>↗ {c.project}</span>}
                    </div>
                  </button>
                </li>
              ))}
              {items.length === 0 && (
                <li className="subtle" style={{ fontSize: 11.5, padding: 8, textAlign: 'center' }}>
                  none
                </li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ─── Pull request tab ────────────────────────────────────────────────────────
// Live fetch of PR + CI state. Two endpoints:
//   GET  /api/changes/:id/pr        — pure read; used on first tab focus.
//   POST /api/changes/:id/pr/sync   — fetch + write back to frontmatter if
//                                     different + log a pr-ci-poll event.
//                                     Used by the Refresh button.
// The Refresh button is the user-initiated re-poll path (the scheduler-driven
// runbook stops polling once ci_state is conclusive — see
// runbook-pr-ci-monitor.md § Auto-stop on conclusive CI).

interface PrCheckRun {
  name: string;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  source: 'check_run' | 'commit_status';
}

interface PrFetchOk {
  ok: true;
  pr: {
    number: number;
    url: string;
    state: string;
    merged: boolean;
    draft: boolean;
    mergeable: boolean | null;
    title: string;
    body: string | null;
    user_login: string | null;
    head_ref: string | null;
    head_sha: string | null;
    base_ref: string | null;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
  };
  ci: {
    state: 'pass' | 'fail' | 'running' | 'none';
    total: number;
    by_state: {
      success: number;
      failure: number;
      in_progress: number;
      queued: number;
      neutral: number;
      other: number;
    };
    runs: PrCheckRun[];
  };
  fetched_at: string;
}

interface PrFetchErr {
  ok: false;
  reason: 'no-pr-url' | 'no-token' | 'parse-failed' | 'github-error' | 'not-found';
  error: string;
  hint?: string;
}

type PrSyncResponse =
  | (PrFetchOk & { synced?: { transitions: string[]; updates_applied: number } })
  | PrFetchErr;
type PrFetchResponse = PrSyncResponse;

function PullRequestTab({
  change,
  commentsToAddress,
  untriagedCount,
  reviewPublished,
  reviewGithubReviewId,
  reviewPublishedAt,
  onReviewPr,
  onMarkPrReady,
  dispatching,
}: {
  change: ChangeSummary;
  // Phase 5 — count from ChangeDetail.comments_to_address. Renders the
  // "N to address" indicator inside the PrReviewSummaryCard.
  commentsToAddress: number;
  // From ChangeDetail.untriaged_comments — latest-pass comments still
  // `status: new`. Blocks Mark ready until each is accepted or dismissed.
  untriagedCount: number;
  // Phase 4 reflection on the linked review's published state.
  reviewPublished: boolean;
  // GitHub review id for the deep link, when set.
  reviewGithubReviewId: number | null;
  // Most recent publish event timestamp, ISO. Renders as "2h ago".
  reviewPublishedAt: string | null;
  onReviewPr: (prUrl: string) => void;
  onMarkPrReady: () => void;
  dispatching: boolean;
}) {
  const [data, setData] = useState<PrFetchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastSynced, setLastSynced] = useState<{ transitions: string[]; ts: string } | null>(null);
  // Push branch state — separate from `loading` since pushing is independent
  // of the sync/fetch loop. Result message bubbles via the inline banner below.
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Auto-load on tab focus uses GET (pure read — no writeback).
  const fetchPr = useCallback(async () => {
    if (!change.id) return;
    setLoading(true);
    try {
      const r = await getJson<PrFetchResponse>(`/api/changes/${encodeURIComponent(change.id)}/pr`);
      setData(r);
    } catch (e) {
      setData({
        ok: false,
        reason: 'github-error',
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [change.id]);

  // Refresh button uses POST sync — writes back to frontmatter when state
  // diverges + logs a pr-ci-poll event with source=dashboard-sync.
  const syncPr = useCallback(async () => {
    if (!change.id) return;
    setLoading(true);
    try {
      const r = await postJson<PrSyncResponse, Record<string, never>>(
        `/api/changes/${encodeURIComponent(change.id)}/pr/sync`,
        {},
      );
      setData(r);
      if (r.ok && r.synced && r.synced.transitions.length > 0) {
        setLastSynced({ transitions: r.synced.transitions, ts: new Date().toISOString() });
      } else if (r.ok) {
        setLastSynced({ transitions: [], ts: new Date().toISOString() });
      }
    } catch (e) {
      setData({
        ok: false,
        reason: 'github-error',
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [change.id]);

  // Defined AFTER syncPr so the useCallback dep doesn't tickle the
  // "used before declared" rule. Pushes the change's branch to origin via
  // POST /:id/push, then re-syncs the PR card so the new commit appears.
  const pushBranch = useCallback(async () => {
    if (!change.id) return;
    setPushing(true);
    setPushResult(null);
    try {
      const r = await fetch(`/api/changes/${encodeURIComponent(change.id)}/push`, {
        method: 'POST',
      });
      const j = (await r.json()) as {
        ok: boolean;
        branch?: string;
        error?: string;
        stderr?: string;
        stdout?: string;
      };
      if (j.ok) {
        const detail = (j.stderr || j.stdout || '').trim() || `pushed to origin/${j.branch}`;
        setPushResult({ ok: true, message: detail });
        syncPr();
      } else {
        const tail = (j.stderr || j.error || 'unknown error').trim().slice(0, 220);
        setPushResult({ ok: false, message: tail });
      }
    } catch (e) {
      setPushResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPushing(false);
    }
  }, [change.id, syncPr]);

  useEffect(() => {
    if (change.pr_url) fetchPr();
  }, [change.pr_url, fetchPr]);

  // No PR opened yet — empty state with hint
  if (!change.pr_url) {
    return (
      <EmptyTab
        title="No pull request yet"
        hint="Run `/os open-pr` once code is committed locally + review_status is approved/overridden/not-required. The branch will be pushed and a PR opened via the github MCP."
      />
    );
  }

  if (!data) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center' }}>
        <p className="subtle" style={{ margin: 0 }}>
          Loading PR data from GitHub…
        </p>
      </div>
    );
  }

  if (!data.ok) {
    return (
      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--error-text)', marginBottom: 6 }}>
          Could not fetch PR ({data.reason})
        </div>
        <div className="subtle" style={{ fontSize: 12.5, marginBottom: 10 }}>
          {data.error}
        </div>
        {data.hint && (
          <div className="tiny" style={{ marginBottom: 10 }}>
            <strong>Hint:</strong> {data.hint}
          </div>
        )}
        <button type="button" className="btn btn-sm" onClick={fetchPr}>
          <Icons.Refresh size={11} /> Retry
        </button>
      </div>
    );
  }

  const pr = data.pr;
  const ci = data.ci;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* PR header card */}
      <div className="card" style={{ padding: 0 }}>
        <div className="card-header">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
              {pr.title} <span className="mono subtle">#{pr.number}</span>
            </h4>
            <PrStateBadge state={pr.state} merged={pr.merged} draft={pr.draft} />
            {pr.draft && <span className="badge muted">draft</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={syncPr} disabled={loading}>
              <Icons.Refresh size={11} className={loading ? 'spin' : ''} />
              {loading ? 'Syncing…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={pushBranch}
              disabled={pushing || pr.merged}
              title={
                pr.merged
                  ? 'PR is merged — nothing to push.'
                  : "Runs `git push origin <branch>` against the change's local clone. Use after manual commits OR if dev-write-change auto-push failed during ADDRESS-COMMENTS. Re-syncs the PR card on success so the new commit shows up."
              }
            >
              <Icons.GitCommit size={11} className={pushing ? 'spin' : ''} />
              {pushing ? 'Pushing…' : 'Push branch'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => onReviewPr(pr.url)}
              disabled={dispatching || loading}
              title={
                dispatching
                  ? 'Another run is in progress — finish that first'
                  : 'Dispatch dev-pr-review against this PR. Writes a pr-review entry linked to this change.'
              }
            >
              <Icons.Sparkles size={11} /> Run review
            </button>
          </div>
        </div>
        {pushResult && (
          <div
            className="tiny"
            style={{
              padding: '8px 16px',
              background: 'var(--bg-2)',
              borderTop: '1px solid var(--border)',
              color: pushResult.ok ? 'var(--success-text)' : 'var(--danger-text)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {pushResult.ok ? '✓ ' : '✗ '}
            {pushResult.message}
          </div>
        )}
        {lastSynced && (
          <div
            className="tiny"
            style={{
              padding: '8px 16px',
              background: 'var(--bg-2)',
              borderTop: '1px solid var(--border)',
              color: lastSynced.transitions.length > 0 ? 'var(--success-text)' : 'var(--text-3)',
            }}
          >
            {lastSynced.transitions.length > 0
              ? `Synced: ${lastSynced.transitions.join(' · ')}`
              : 'Synced — already current (no frontmatter changes).'}
          </div>
        )}
        <div
          style={{
            padding: 16,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 14,
          }}
        >
          <MetaItem label="URL">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: 'var(--accent)' }}
            >
              {pr.url.replace(/^https?:\/\//, '')}
            </a>
          </MetaItem>
          <MetaItem label="Opened by">
            <code className="mono" style={{ fontSize: 12 }}>
              {pr.user_login ?? '—'}
            </code>
          </MetaItem>
          <MetaItem label="Head → base">
            <code className="mono" style={{ fontSize: 12 }}>
              {pr.head_ref} → {pr.base_ref}
            </code>
          </MetaItem>
          <MetaItem label="Mergeable">
            <span
              style={{
                fontSize: 12.5,
                color:
                  pr.mergeable === true
                    ? 'var(--success-text)'
                    : pr.mergeable === false
                      ? 'var(--error-text)'
                      : 'var(--text-3)',
              }}
            >
              {pr.mergeable === null ? 'computing…' : pr.mergeable ? 'yes' : 'no'}
            </span>
          </MetaItem>
          <MetaItem label="Created">
            <span style={{ fontSize: 12.5 }} title={pr.created_at}>
              {formatRelative(pr.created_at)}
            </span>
          </MetaItem>
          {pr.merged_at && (
            <MetaItem label="Merged">
              <span style={{ fontSize: 12.5 }} title={pr.merged_at}>
                {formatRelative(pr.merged_at)}
              </span>
            </MetaItem>
          )}
        </div>
        <div
          className="tiny"
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-2)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Fetched {formatRelative(data.fetched_at)}</span>
          <span>
            head sha: <code className="mono">{pr.head_sha?.slice(0, 7) ?? '—'}</code>
          </span>
        </div>
      </div>

      {/* PR review summary — rendered only when dev-pr-review has run against
          this change. Shows the latest pass count + status + a deep link to
          the full review in the PR Review app. */}
      {change.pr_review_path && (
        <PrReviewSummaryCard
          status={change.pr_review_status}
          changeStatus={change.status ?? null}
          passes={change.pr_review_passes}
          reviewedAt={change.pr_reviewed_at}
          readyAt={change.pr_ready_at}
          mergedAt={change.merged_at ?? null}
          commentsToAddress={commentsToAddress}
          untriagedCount={untriagedCount}
          reviewPublished={reviewPublished}
          reviewGithubReviewId={reviewGithubReviewId}
          reviewPublishedAt={reviewPublishedAt}
          prUrl={change.pr_url}
          path={change.pr_review_path}
          onMarkReady={onMarkPrReady}
          dispatching={dispatching}
        />
      )}

      {/* CI summary */}
      <div className="card" style={{ padding: 0 }}>
        <div className="card-header">
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
            CI — <CiStateBadge state={ci.state} />
          </h4>
          <span className="tiny">
            {ci.total} {ci.total === 1 ? 'check' : 'checks'}
          </span>
        </div>
        {ci.total === 0 ? (
          <div style={{ padding: 16 }}>
            <p className="subtle" style={{ fontSize: 12.5, margin: 0 }}>
              No checks configured for this repo. The PR can be reviewed/merged on its own.
            </p>
          </div>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {ci.runs.map((r) => (
              <li
                key={`${r.source}:${r.name}`}
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <CheckConclusionDot status={r.status} conclusion={r.conclusion} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</div>
                  <div className="tiny" style={{ marginTop: 2, color: 'var(--text-3)' }}>
                    {r.status ?? '—'}
                    {r.conclusion ? ` · ${r.conclusion}` : ''}
                    <span className="subtle" style={{ marginLeft: 8 }}>
                      ({r.source})
                    </span>
                  </div>
                </div>
                {r.url && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm"
                    style={{ fontSize: 11 }}
                  >
                    Open <Icons.External size={11} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* PR body — GFM markdown rendered with the same component the Vault
       * and ArtifactCard surfaces use; toggle to raw for copy/paste. */}
      {pr.body && <PrBodyCard body={pr.body} />}
    </div>
  );
}

// Compact summary of the latest dev-pr-review pass against this change.
// Shown in the Pull request tab below the PR header card when the change
// has a linked pr-review entry (i.e. pr_review_path is set in frontmatter).
function PrReviewSummaryCard({
  status,
  changeStatus,
  passes,
  reviewedAt,
  readyAt,
  mergedAt,
  commentsToAddress,
  untriagedCount,
  reviewPublished,
  reviewGithubReviewId,
  reviewPublishedAt,
  prUrl,
  path,
  onMarkReady,
  dispatching,
}: {
  status: string | null;
  // Linked change's lifecycle status. When 'merged' (terminal), the card
  // shows "merged" in the Status field instead of the now-stale
  // pr_review_status (which close-change doesn't reset). Same override
  // pattern as the Reviews list row.
  changeStatus: string | null;
  passes: number | null;
  reviewedAt: string | null;
  readyAt: string | null;
  mergedAt: string | null;
  // Phase 5 — count of accepted/published-not-acted-on comments on the
  // latest pass. Rendered as a "N to address" indicator so the user can see
  // re-implementation work at a glance.
  commentsToAddress: number;
  // Latest-pass comments still `status: new`. Blocks Mark ready (mirrors the
  // dev-mark-pr-ready skill-side refusal) until each is accepted or dismissed.
  untriagedCount: number;
  // Phase 4 reflection — true when the linked pr-review has been published.
  reviewPublished: boolean;
  // GitHub review id for the deep-link on the published indicator.
  reviewGithubReviewId: number | null;
  // Most recent publish event timestamp (ISO). Renders as "2h ago".
  reviewPublishedAt: string | null;
  // PR URL — used to build the deep link `<pr_url>#pullrequestreview-<id>`.
  prUrl: string | null;
  path: string;
  onMarkReady: () => void;
  dispatching: boolean;
}) {
  const navigate = useNavigate();
  const isMerged = changeStatus === 'merged';
  const statusLabel = isMerged ? 'merged' : (status ?? 'pending');
  // Derive the pr-review entry id from its file path. Filenames mirror ids
  // exactly (id matches the filename minus .md, by the archetype convention).
  // The PR Review app routes a review detail at /pr-review/reviews/<id>.
  const reviewId = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  // Map to the same color tokens the lifecycle stepper / status badges use:
  // pending = muted (neutral, awaiting action), needs-changes = warn (action
  // required), approved / ready-for-human / merged = success.
  const statusColor =
    statusLabel === 'needs-changes'
      ? 'var(--warn-text)'
      : statusLabel === 'approved' || statusLabel === 'ready-for-human' || statusLabel === 'merged'
        ? 'var(--success-text)'
        : 'var(--muted)';

  // Strict-gate the Mark Ready button per the Phase 3 design:
  // - hidden when no review yet (status === null) — nothing to mark ready
  // - hidden when already ready — there's nothing to do
  // - hidden when the change is merged — the lifecycle is terminal
  // - visible+disabled when needs-changes — the latest review blocks shipping
  // - visible+disabled while untriaged comments remain — comment disposition
  //   is a merge invariant (dev-mark-pr-ready refuses while any are `new`)
  // - visible+enabled when pending or approved with zero untriaged
  const canMarkReady =
    !isMerged && (status === 'pending' || status === 'approved') && untriagedCount === 0;
  const showMarkReady =
    !isMerged && (status === 'pending' || status === 'approved' || status === 'needs-changes');
  const markReadyTooltip =
    statusLabel === 'needs-changes'
      ? 'Latest review has blockers — address comments and re-review first.'
      : untriagedCount > 0
        ? `${untriagedCount} comment${untriagedCount !== 1 ? 's' : ''} on the latest pass ${
            untriagedCount !== 1 ? 'are' : 'is'
          } still status: new — Accept or Dismiss each first (dev-mark-pr-ready refuses while untriaged comments remain).`
        : commentsToAddress > 0
          ? `Runs dev-mark-pr-ready: flips pr_review_status to ready-for-human (vault-only — you still merge on GitHub). NOTE: ${commentsToAddress} comment${
              commentsToAddress !== 1 ? 's' : ''
            } in the latest review ${
              commentsToAddress !== 1 ? "haven't" : "hasn't"
            } been re-implemented yet — consider clicking "Re-implement" first so the review is actually addressed in code.`
          : 'Runs dev-mark-pr-ready: flips pr_review_status to ready-for-human and stamps pr_ready_at. Vault-only — no GitHub calls. You review and merge the PR on GitHub yourself.';

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
          Latest PR review
          <span style={{ fontWeight: 500, color: statusColor, marginLeft: 8 }}>
            {passes != null ? `pass ${passes}: ` : ''}
            {statusLabel}
            {untriagedCount > 0 && !isMerged && (
              <span style={{ color: 'var(--warn-text, var(--accent-text))' }}>
                {' '}
                · {untriagedCount} comment{untriagedCount !== 1 ? 's' : ''} untriaged
              </span>
            )}
          </span>
        </h4>
        <div style={{ display: 'flex', gap: 8 }}>
          {showMarkReady && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onMarkReady}
              disabled={!canMarkReady || dispatching}
              title={markReadyTooltip}
            >
              <Icons.Check size={11} /> Mark ready for human
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigate(`/pr-review/reviews/${reviewId}`)}
            disabled={!reviewId}
            title={
              reviewId
                ? `Open ${reviewId} in the PR Review app (Reviews tab → detail view).`
                : 'No review id — the linked path is malformed.'
            }
          >
            View review <Icons.ArrowRight size={11} />
          </button>
        </div>
      </div>
      <div style={{ padding: '14px 16px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <MetaItem label="Status">
          <span style={{ fontSize: 12.5, fontWeight: 500, color: statusColor }}>{statusLabel}</span>
        </MetaItem>
        <MetaItem label="Passes">
          <code className="mono" style={{ fontSize: 12 }}>
            {passes ?? '—'}
          </code>
        </MetaItem>
        <MetaItem label="Last pass">
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {reviewedAt ? formatRelative(reviewedAt) : '—'}
          </span>
        </MetaItem>
        {commentsToAddress > 0 && !isMerged && (
          <MetaItem label="To address">
            <span
              className="mono"
              style={{
                fontSize: 12,
                color: 'var(--warn-text, var(--accent-text))',
                fontWeight: 600,
              }}
              title="Accepted/published comments not yet addressed in code. Re-implement via dev-write-change (the ADDRESS-COMMENTS phase)."
            >
              {commentsToAddress} comment{commentsToAddress !== 1 ? 's' : ''}
            </span>
          </MetaItem>
        )}
        {isMerged && mergedAt && (
          <MetaItem label="Merged">
            <span className="mono" style={{ fontSize: 12, color: 'var(--success-text)' }}>
              {formatRelative(mergedAt)}
            </span>
          </MetaItem>
        )}
        {!isMerged && readyAt && (
          <MetaItem label="Ready since">
            <span className="mono" style={{ fontSize: 12, color: 'var(--success-text)' }}>
              {formatRelative(readyAt)}
            </span>
          </MetaItem>
        )}
        {reviewPublished && (
          <MetaItem label="Published to GitHub">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {reviewGithubReviewId != null && prUrl ? (
                <a
                  href={`${prUrl}#pullrequestreview-${reviewGithubReviewId}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the GitHub-side review event in a new tab"
                  style={{
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--success-text)',
                    fontWeight: 600,
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  review #{reviewGithubReviewId}
                  <Icons.External size={11} />
                </a>
              ) : (
                <span
                  className="mono"
                  style={{ fontSize: 12, color: 'var(--success-text)', fontWeight: 600 }}
                  title="dev-pr-review-publish has fired on this review, but no github_review_id was captured on any comment — likely a partial-publish state."
                >
                  yes
                </span>
              )}
              {reviewPublishedAt && (
                <span
                  className="tiny"
                  style={{ color: 'var(--muted)' }}
                  title={`Last publish event: ${reviewPublishedAt} (UTC)`}
                >
                  · {formatRelative(reviewPublishedAt)}
                </span>
              )}
            </span>
          </MetaItem>
        )}
        <MetaItem label="Entry">
          <code className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {path.replace(/^vault\/wiki\/development\/pr-review\//, '')}
          </code>
        </MetaItem>
      </div>
    </div>
  );
}

function PrStateBadge({
  state,
  merged,
  draft,
}: { state: string; merged: boolean; draft: boolean }) {
  if (merged) return <span className="badge success">merged</span>;
  if (draft) return <span className="badge muted">draft</span>;
  if (state === 'open') return <span className="badge info">open</span>;
  if (state === 'closed') return <span className="badge muted">closed</span>;
  return <span className="badge muted">{state}</span>;
}

function CiStateBadge({ state }: { state: 'pass' | 'fail' | 'running' | 'none' }) {
  if (state === 'pass') return <span className="badge success">pass</span>;
  if (state === 'fail') return <span className="badge error">fail</span>;
  if (state === 'running') return <span className="badge warning">running</span>;
  return <span className="badge muted">no checks</span>;
}

function CheckConclusionDot({
  status,
  conclusion,
}: {
  status: string | null;
  conclusion: string | null;
}) {
  let color = 'var(--text-3)';
  if (status === 'in_progress' || status === 'queued') color = 'var(--warning-text)';
  else if (conclusion === 'success') color = 'var(--success-text)';
  else if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out')
    color = 'var(--error-text)';
  else if (conclusion === 'neutral' || conclusion === 'skipped') color = 'var(--text-3)';
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

// Plan-tab empty-state variant: body has unaccepted DRAFT markers but no
// placeholder text. The auto-drafted content under each marker IS the
// proposed draft — accepting just strips the marker blockquotes via the
// dedicated /accept-drafts endpoint, no manual markdown editing required.
// PR description renderer for the Pull Request tab. Defaults to GFM-rendered
// markdown (same component the Vault Output viewer + ArtifactCard use); the
// Raw toggle drops to a <pre> view for copy/paste of the exact GitHub body.
function PrBodyCard({ body }: { body: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-header">
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Description</h4>
        <span className="tiny">As posted on GitHub</span>
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
      </div>
      <div
        style={{
          borderTop: '1px solid var(--border)',
          maxHeight: 460,
          overflow: 'auto',
        }}
      >
        {showRaw ? (
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: '14px 16px',
              background: 'var(--bg-2)',
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-2)',
            }}
          >
            {body}
          </pre>
        ) : (
          <div style={{ padding: '4px 16px 14px' }}>
            <Rendered content={body} />
          </div>
        )}
      </div>
    </div>
  );
}

// Banner above the Review artifact. Lets the user fold reviewer findings
// back into the plan via dev-revise-plan (one-click; no form because the
// skill takes only `change`, and we know it from context). When a revision
// has already happened (plan_revision > 1), also offers a "Re-review"
// shortcut so the user can get a fresh verdict against the revised plan.
function ReviseFromReviewCard({
  change,
  dispatching,
  onRevisePlan,
  onReviewChange,
}: {
  change: ChangeSummary;
  dispatching: boolean;
  onRevisePlan: () => void;
  onReviewChange: () => void;
}) {
  const rev = change.plan_revision ?? 1;
  const revisedAt = change.plan_revised_at;
  const planMtime = change.plan_generated_at;
  const reviewedAt = change.reviewed_at;
  // True when the plan has been revised since the most recent review — i.e.
  // the review's verdict describes a stale plan and a re-review is the
  // honest next step.
  const reviewIsStale = revisedAt != null && reviewedAt != null && revisedAt > reviewedAt;

  return (
    <div
      className="card"
      style={{
        padding: 14,
        marginBottom: 14,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 240 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span>Plan revision {rev}</span>
          {rev > 1 && revisedAt && (
            <span className="tiny subtle" title={revisedAt}>
              · revised {formatRelative(revisedAt)}
            </span>
          )}
          {reviewIsStale && (
            <span
              className="badge warning"
              style={{ fontSize: 10 }}
              title="The plan was revised after the most recent review. The verdict below describes the prior revision."
            >
              review stale
            </span>
          )}
        </div>
        <p className="tiny subtle" style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5 }}>
          {rev === 1
            ? 'Click Apply findings to fold the reviewer\'s nits/concerns into the plan. The plan is rewritten in place; review_status stays as-is so the lifecycle stays at "execute plan".'
            : `Plan rewritten ${rev - 1} time${rev - 1 !== 1 ? 's' : ''} since the original. Each revise overwrites ${planMtime ? 'plan_path' : 'the plan file'} and bumps plan_revision. The original review verdict is preserved as historical context.`}
        </p>
      </div>
      {/* Button hierarchy flips once a revise has landed: pre-revise the
          natural next move is Apply findings (loud blue); post-revise the
          natural next move is Re-review the new plan, so Re-review becomes
          primary and Apply findings demotes to ghost (still re-clickable if
          the user wants another revise pass, but no longer the loud CTA). */}
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {reviewIsStale ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onRevisePlan}
              disabled={dispatching}
              title="Re-run dev-revise-plan against the current review. Re-folds findings; bumps plan_revision again. Usually not needed once a revise has already landed — Re-review is the natural next step."
            >
              <Icons.Refresh size={11} /> Apply findings again
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onReviewChange}
              disabled={dispatching}
              title="Re-run dev-review-change against the revised plan to get a fresh verdict. The prior review file gets overwritten."
            >
              Re-review
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onRevisePlan}
            disabled={dispatching}
            title="Runs dev-revise-plan: reads plan_path + review_path, folds every concern/nit/suggested-change back into the plan, overwrites plan_path, bumps plan_revision. Preserves review_status — the prior verdict still describes the prior revision. After this, you can execute the revised plan or optionally re-review."
          >
            <Icons.Refresh size={11} /> Apply findings to plan
          </button>
        )}
      </div>
    </div>
  );
}

function PlanBlockedByDraftsCard({ changeId, count }: { changeId: string; count: number }) {
  const [accepting, setAccepting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  async function accept() {
    setAccepting(true);
    try {
      const r = await fetch(`/api/changes/${encodeURIComponent(changeId)}/accept-drafts`, {
        method: 'POST',
      });
      const j = (await r.json()) as { ok: boolean; message?: string; error?: string };
      setResult({ ok: j.ok, message: j.message ?? j.error ?? '(no message)' });
      if (j.ok) {
        // Wait a beat so the toast is visible, then reload so the parent
        // refetches detail and the Plan tab transitions out of this state.
        setTimeout(() => window.location.reload(), 1200);
      }
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setAccepting(false);
    }
  }
  return (
    <div className="card" style={{ padding: 20, textAlign: 'left' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
        Plan blocked — {count} unaccepted DRAFT marker{count !== 1 ? 's' : ''}
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55 }}>
        The change body's <code>Why</code> / <code>Approach</code> / <code>Done when</code> sections
        were auto-drafted by <code>dev-add-change</code>. Each section is prefixed with a{' '}
        <code>&gt; **DRAFT** —</code> blockquote that the user has to accept before{' '}
        <code>dev-write-change</code> will plan against the content.
      </p>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55 }}>
        Review the drafts on the Overview tab. When you're satisfied with the auto-drafted content,
        click <strong>Accept all drafts</strong> to strip the markers in one shot. (If you want to
        rewrite the content first, edit the Overview tab's markdown — the manual path still works.)
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={accept}
          disabled={accepting}
          title={`Strips all ${count} > **DRAFT** — ... blockquotes from the body via POST /api/changes/${changeId}/accept-drafts. The draft content itself is preserved. Idempotent; safe to re-click.`}
        >
          {accepting ? 'Accepting…' : `Accept ${count} draft${count !== 1 ? 's' : ''} and unblock`}
        </button>
        {result && (
          <span
            className="tiny"
            style={{ color: result.ok ? 'var(--success-text)' : 'var(--danger-text)' }}
          >
            {result.ok ? '✓' : '✗'} {result.message}
          </span>
        )}
      </div>
    </div>
  );
}

// Inline toast surfaced when startSkillRun returns blocked or error. Auto-
// dismissable; non-modal. Used in place of the old ActionRunner failure
// surface for the headline cases.
function DispatchToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        bottom: 18,
        right: 18,
        zIndex: 250,
        maxWidth: 380,
        background: 'var(--bg)',
        border: '1px solid var(--danger-text)',
        borderRadius: 6,
        padding: '10px 14px',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, color: 'var(--text)' }}>
        {message}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--muted)',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
