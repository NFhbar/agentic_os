// The single server-side derivation point for lifecycle state across the
// three reviewed archetypes (Fable review, Finding 4.3 / Bet 5).
//
// Before this module, lifecycle state had no single computation point: two
// UI surfaces independently shipped the same stale-frontmatter bug on
// projects (each patched with a `plan_status_derived` shim), the change
// stepper lived inline in routes/changes.ts, and the research-report stepper
// was derived CLIENT-side in the research Detail page — three dialects of
// "what stage is this thing in", drifting independently.
//
// Everything here is pure (manifest-record / summary in, derived stages
// out) so unit tests can exercise it without the I/O-heavy route modules —
// same separation pattern as automation-state-machine.ts. Views consume the
// server-computed results; clients never re-derive.
//
// Bugs here surface as silently-blank lifecycle widgets — Task #417 is the
// canonical case (research-update added a `status: updated` value the
// project deriver didn't cover). tests/unit/projects/deriveProjectPlanStatus
// .test.ts pins every project branch; tests/unit/lifecycle/report-steps
// .test.ts pins the report stepper.

import type {
  ChangeSummary,
  FileRef,
  LifecycleStage,
  StageStatus,
} from '../routes/changes.types.js';
import type { OwnedChangeRef } from '../routes/projects.types.js';
import type {
  ReportStepStatus,
  ReportStepStatuses,
  ResearchReportSummary,
} from '../routes/research.types.js';

// ---------------------------------------------------------------------------
// Project — plan lifecycle × shared review verdict
// ---------------------------------------------------------------------------
//
// Since the shared review-state contract (Finding 4.2) the deriver returns a
// PAIR instead of one mixed string:
//   plan_status   — lifecycle only: pending | in-research | drafted |
//                   scaffolded | active
//   review_status — the shared 6-value verdict enum used by change plans and
//                   research-reports: pending | approved | request-changes |
//                   rejected | overridden | not-required
// The old single-string vocabulary ('reviewed-pending' et al.) mixed the two
// axes and gave projects a third review dialect. planStageId() collapses the
// pair back into one linear id for stepper/timeline RENDERING only — display
// granularity is not contract vocabulary.

export type PlanLifecycleStatus = 'pending' | 'in-research' | 'drafted' | 'scaffolded' | 'active';
export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'request-changes'
  | 'rejected'
  | 'overridden'
  | 'not-required';

export interface DerivedPlanState {
  plan_status: PlanLifecycleStatus | null;
  review_status: ReviewStatus | null;
}

export function deriveProjectPlanState(
  researchReports: ResearchReportSummary[],
  ownedChanges: OwnedChangeRef[],
): DerivedPlanState {
  if (researchReports.length === 0) return { plan_status: null, review_status: null };
  // Pick the latest report by report_revision desc, falling back to `updated`.
  const latest = [...researchReports].sort((a, b) => {
    const aR = a.report_revision ?? 0;
    const bR = b.report_revision ?? 0;
    if (bR !== aR) return bR - aR;
    return (b.updated ?? '').localeCompare(a.updated ?? '');
  })[0];
  const rs = latest.status;
  const rv = latest.review_status;
  if (rs === 'draft') return { plan_status: 'in-research', review_status: 'pending' };
  if (rs === 'reviewed' || rs === 'updated') {
    if (rv === 'request-changes')
      return { plan_status: 'drafted', review_status: 'request-changes' };
    if (rv === 'approved' || rv === 'overridden') {
      // The scaffolder consumed the report even though status may still be
      // 'reviewed' (the reviewed → approved flip is a separate human step,
      // but the scaffolder doesn't require it). Treat as post-approval.
      return {
        plan_status: derivePostApprovalStage(latest, ownedChanges),
        review_status: rv,
      };
    }
    return { plan_status: 'drafted', review_status: 'pending' };
  }
  if (rs === 'approved') {
    return {
      plan_status: derivePostApprovalStage(latest, ownedChanges),
      review_status: rv === 'overridden' ? 'overridden' : 'approved',
    };
  }
  return { plan_status: null, review_status: null };
}

export function derivePostApprovalStage(
  latest: ResearchReportSummary,
  ownedChanges: OwnedChangeRef[],
): PlanLifecycleStatus {
  const scaffoldedRecs = latest.recommended_changes_scaffolded ?? 0;
  if (scaffoldedRecs === 0) return 'drafted';
  // Any owned change past planning → automation/lifecycle is active.
  const anyInFlight = ownedChanges.some(
    (c) => c.status === 'in-progress' || c.status === 'in-review' || c.status === 'merged',
  );
  return anyInFlight ? 'active' : 'scaffolded';
}

// Collapse the pair into one linear stage id for the Plan-lifecycle stepper
// + Phase Timeline. Rendering vocabulary only — never persisted.
export type PlanStageId =
  | 'planning'
  | 'in-research'
  | 'awaiting-review'
  | 'request-changes'
  | 'approved'
  | 'scaffolded'
  | 'active';

export function planStageId(state: DerivedPlanState): PlanStageId | null {
  const { plan_status, review_status } = state;
  if (plan_status === null) return null;
  if (plan_status === 'pending') return 'planning';
  if (plan_status === 'in-research') return 'in-research';
  if (plan_status === 'drafted') {
    if (review_status === 'request-changes') return 'request-changes';
    if (review_status === 'approved' || review_status === 'overridden') return 'approved';
    return 'awaiting-review';
  }
  return plan_status; // 'scaffolded' | 'active'
}

// ---------------------------------------------------------------------------
// Change — eight-stage lifecycle stepper
// ---------------------------------------------------------------------------

// Server-side rollup shape for events.db rows, not on the wire.
export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  action: string | null;
  skill: string | null;
  duration_ms: number | null;
  exit_status: string | null;
  cost_usd: number | null;
}

// Lifecycle stages, in canonical order. Each stage's "done" condition is
// derived from the change frontmatter + artifact presence.
const STAGE_DEFS: Array<{
  id: string;
  label: string;
  hint: string;
  done: (s: ChangeSummary, plan: FileRef | null, review: FileRef | null) => boolean;
  atFrom: (s: ChangeSummary, plan: FileRef | null, review: FileRef | null) => string | null;
  viaSkills: string[];
  artifactFrom?: (s: ChangeSummary, plan: FileRef | null, review: FileRef | null) => string | null;
}> = [
  {
    id: 'scaffolded',
    label: 'Scaffolded',
    hint: 'Change entry created via dev-add-change.',
    done: () => true, // entry exists if we're rendering it
    atFrom: (s) => s.updated,
    viaSkills: ['dev-add-change'],
  },
  {
    id: 'plan-written',
    label: 'Plan written',
    hint: 'dev-write-change PLAN phase composed the structured plan.',
    done: (_s, plan) => plan != null,
    atFrom: (s, plan) => plan?.mtime ?? s.plan_generated_at,
    viaSkills: ['dev-write-change'],
    artifactFrom: (s) => s.plan_path,
  },
  {
    id: 'plan-reviewed',
    label: 'Plan reviewed',
    hint: 'dev-review-change produced a verdict (approve / changes / reject / overridden / not-required).',
    done: (s, _plan, review) => {
      if (!s.review_status) return false;
      return (
        ['approved', 'overridden', 'not-required', 'request-changes', 'rejected'].includes(
          s.review_status,
        ) || review != null
      );
    },
    atFrom: (s, _plan, review) => review?.mtime ?? s.reviewed_at,
    viaSkills: ['dev-review-change'],
    artifactFrom: (s) => s.review_path,
  },
  {
    id: 'code-executed',
    label: 'Code executed',
    hint: 'dev-write-change EXECUTE phase: branch created, files edited, tests run, commits made locally.',
    done: (s) => s.status === 'in-progress' || s.status === 'in-review' || s.status === 'merged',
    atFrom: () => null, // best-effort from events
    viaSkills: ['dev-write-change'],
  },
  {
    id: 'pr-opened',
    label: 'PR opened',
    hint: 'dev-open-pr pushed the branch and opened a PR via the github MCP.',
    done: (s) => s.pr_url != null,
    atFrom: () => null,
    viaSkills: ['dev-open-pr'],
    artifactFrom: (s) => s.pr_url,
  },
  {
    id: 'pr-reviewed',
    label: 'PR reviewed',
    hint: 'dev-pr-review analyzed the open PR and produced a review report. Done when at least one pass has run AND the latest pass found no blockers (status !== needs-changes). A needs-changes status holds this stage as "current" until the next pass clears.',
    done: (s) => s.pr_reviewed_at != null && s.pr_review_status !== 'needs-changes',
    atFrom: (s) => s.pr_reviewed_at,
    viaSkills: ['dev-pr-review'],
    artifactFrom: (s) => s.pr_review_path,
  },
  {
    id: 'ready-for-human',
    label: 'Ready for human',
    hint: 'User clicked Mark ready, signing off on the OS-authored PR. dev-mark-pr-ready set pr_review_status: ready-for-human (vault-only — the human reviews + merges on GitHub).',
    done: (s) => s.pr_review_status === 'ready-for-human',
    atFrom: (s) => s.pr_ready_at,
    viaSkills: ['dev-mark-pr-ready'],
  },
  {
    id: 'merged',
    label: 'Merged',
    hint: 'PR merged on GitHub. dev-close-change marks the change terminal and syncs the vault.',
    done: (s) => s.status === 'merged',
    // Use merged_at, NOT updated — the file's `updated` is touched on every
    // edit, so falling back to it would show "Merged X ago" even on an
    // unmerged change (just because the file was recently edited).
    atFrom: (s) => s.merged_at,
    viaSkills: ['dev-close-change'],
  },
];

export function computeLifecycle(
  summary: ChangeSummary,
  plan: FileRef | null,
  review: FileRef | null,
  events: EventRow[],
): LifecycleStage[] {
  // Index events by skill for quick lookup (oldest first for "first run" times).
  const eventsBySkill = new Map<string, EventRow[]>();
  for (const ev of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (!ev.skill) continue;
    if (!eventsBySkill.has(ev.skill)) eventsBySkill.set(ev.skill, []);
    eventsBySkill.get(ev.skill)?.push(ev);
  }

  const abandoned = summary.status === 'abandoned';
  // Closed via close-local — change merged without ever opening a PR (typically
  // OS-internal work against agentic-os). The PR-side stages don't apply, so
  // render them as `skipped` instead of leaving them dangling as empty pending
  // rows on a terminal change.
  const closedLocal = summary.status === 'merged' && summary.pr_url == null;
  const PR_STAGES = new Set(['pr-opened', 'pr-reviewed', 'ready-for-human']);
  let firstNotDoneSeen = false;

  return STAGE_DEFS.map((def) => {
    const isDone = def.done(summary, plan, review);
    let status: StageStatus;
    if (isDone) {
      status = 'done';
    } else if (abandoned) {
      status = 'skipped';
    } else if (closedLocal && PR_STAGES.has(def.id)) {
      status = 'skipped';
    } else if (!firstNotDoneSeen) {
      status = 'current';
      firstNotDoneSeen = true;
    } else {
      status = 'pending';
    }

    // Find a timestamp: frontmatter > artifact mtime > first event for this stage's skill.
    //
    // Only resolve `at` for stages that have actually completed. The
    // timestamp semantically means "when the stage finished", so for
    // pending/current/skipped stages it should stay null. Without this
    // gate two bugs leak through:
    //   1. `viaSkills` can overlap across stages (dev-write-change drives
    //      both plan-written and code-executed). A first-event fallback on
    //      a pending stage would surface the *previous* stage's event.
    //   2. Frontmatter fields like `updated` always have a value, so an
    //      atFrom that falls back to them would stamp every stage with the
    //      file's last-edit time — making pending stages look done.
    let at: string | null = null;
    if (status === 'done') {
      at = def.atFrom(summary, plan, review);
      if (!at) {
        for (const skill of def.viaSkills) {
          const evs = eventsBySkill.get(skill);
          if (evs && evs.length > 0) {
            at = evs[0].ts;
            break;
          }
        }
      }
    }

    // The skill that's most likely to have driven this stage: prefer the one
    // that has actually run.
    let via: string | null = null;
    for (const skill of def.viaSkills) {
      if (eventsBySkill.has(skill)) {
        via = skill;
        break;
      }
    }
    if (!via && def.viaSkills.length > 0) via = def.viaSkills[0];

    const artifact = def.artifactFrom?.(summary, plan, review) ?? null;

    return {
      id: def.id,
      label: def.label,
      status,
      at,
      via,
      artifact,
      hint: def.hint,
    };
  });
}

// ---------------------------------------------------------------------------
// Research-report — four-step stepper
// ---------------------------------------------------------------------------
//
// Extracted from the research Detail page, which derived these statuses
// client-side from raw frontmatter — the exact dialect-drift pattern that
// produced the project stale-frontmatter bug. The server computes once;
// the client decorates (click/notify handlers stay UI-side).
//
// Faithful port note: the `reviewed` step counts ANY non-pending verdict
// (including request-changes/rejected/overridden) as done — "a review
// happened" — while `approved` recognizes only an approved verdict or a
// report-level `status: approved`. `overridden` deliberately does NOT light
// the approved step here even though planStageId treats it as approved at
// the project tier; changing that is a product decision, not a refactor.

export function deriveReportSteps(r: {
  status: string | null;
  review_status: string | null;
  update_count: number | null;
}): ReportStepStatuses {
  const reviewed: ReportStepStatus = r.review_status
    ? r.review_status === 'pending'
      ? 'current'
      : 'done'
    : 'pending';
  const approved: ReportStepStatus =
    r.review_status === 'approved' || r.status === 'approved'
      ? 'done'
      : reviewed === 'done'
        ? 'current'
        : 'pending';
  const updated: ReportStepStatus = (r.update_count ?? 0) > 0 ? 'done' : 'pending';
  return { drafted: 'done', reviewed, approved, updated };
}
