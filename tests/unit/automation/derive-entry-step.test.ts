// Entry-step derivation for the change-automation orchestrator's /start
// boundary. `deriveCompletedStepFromArtifacts` classifies the completed step
// from artifacts (branch commits + pr_url + pr-review pass state); the reused
// `decideNextChangeStep` table then produces the dispatch. These pin the
// COMPOSITION — the actual next-dispatch a Start produces — because that is
// what the 2026-07-06 double-cancel regression is about: a change with
// completed execute/open-pr artifacts must advance to the right step, never
// re-dispatch a redundant execute.

import { describe, expect, it } from 'vitest';
import {
  type ArtifactObservation,
  decideNextChangeStep,
  deriveCompletedStepFromArtifacts,
} from '../../../domains/meta/app/server/routes/automation-state-machine.js';
import type { ChangeAutomationDecision } from '../../../domains/meta/app/server/routes/automation.types.js';

// Mirror the /start null-branch composition exactly: derive the completed
// step, then either dispatch execute (fresh) or re-use the transition table
// with artifact_moved: true (the classifier just proved the postcondition).
function entryDispatch(args: {
  observed: ArtifactObservation;
  change_status: string | null;
  latest_pass_acted?: boolean;
  pr_review_status?: string | null;
  comments_to_address?: number | null;
  iteration_count?: number;
  iteration_cap?: number;
}): ChangeAutomationDecision {
  const completed = deriveCompletedStepFromArtifacts({
    change_status: args.change_status,
    observed: args.observed,
    latest_pass_acted: args.latest_pass_acted ?? false,
  });
  if (completed === null) return { action: 'dispatch', step: 'execute' };
  return decideNextChangeStep({
    current_step: completed,
    iteration_count: args.iteration_count ?? 0,
    iteration_cap: args.iteration_cap ?? 4,
    last_exit: 0,
    pr_review_status: args.pr_review_status ?? null,
    comments_to_address: args.comments_to_address ?? null,
    artifact_moved: true,
  });
}

const FRESH: ArtifactObservation = {
  head: null,
  head_error: 'ref-not-found',
  pr_url: null,
  pass_count: null,
  pr_review_path_set: false,
};

describe('deriveCompletedStepFromArtifacts → entry dispatch', () => {
  it('fresh change (no branch ref, no PR, no passes) derives null → execute', () => {
    expect(
      deriveCompletedStepFromArtifacts({
        change_status: 'planning',
        observed: FRESH,
        latest_pass_acted: false,
      }),
    ).toBeNull();
    expect(entryDispatch({ observed: FRESH, change_status: 'planning' })).toEqual({
      action: 'dispatch',
      step: 'execute',
    });
  });

  it('in-progress with branch commits and no PR derives open-pr (2026-07-06 double-cancel regression)', () => {
    const observed: ArtifactObservation = {
      head: 'abc1234',
      head_error: null,
      pr_url: null,
      pass_count: null,
      pr_review_path_set: false,
    };
    // classifier says execute completed; the table advances to open-pr —
    // NOT a redundant execute (the live 2026-07-06 first cancelled dispatch).
    expect(
      deriveCompletedStepFromArtifacts({
        change_status: 'in-progress',
        observed,
        latest_pass_acted: false,
      }),
    ).toBe('execute');
    expect(entryDispatch({ observed, change_status: 'in-progress' })).toEqual({
      action: 'dispatch',
      step: 'open-pr',
    });
  });

  it('in-review with pr_url and no passes derives pr-review', () => {
    const observed: ArtifactObservation = {
      head: 'abc1234',
      head_error: null,
      pr_url: 'https://github.com/o/r/pull/1',
      pass_count: null,
      pr_review_path_set: false,
    };
    // The second cancelled 2026-07-06 dispatch: a PR exists → open-pr done → pr-review.
    expect(entryDispatch({ observed, change_status: 'in-review' })).toEqual({
      action: 'dispatch',
      step: 'pr-review',
    });
  });

  it('pr_url + pass + needs-changes + curated comments derives address-comments dispatch', () => {
    const observed: ArtifactObservation = {
      head: 'abc',
      head_error: null,
      pr_url: 'https://github.com/o/r/pull/1',
      pass_count: 1,
      pr_review_path_set: true,
    };
    expect(
      entryDispatch({
        observed,
        change_status: 'in-review',
        pr_review_status: 'needs-changes',
        comments_to_address: 2,
      }),
    ).toEqual({ action: 'dispatch', step: 'address-comments' });
  });

  it('needs-changes with zero curated and zero acted comments parks needs-triage', () => {
    const observed: ArtifactObservation = {
      head: 'abc',
      head_error: null,
      pr_url: 'https://github.com/o/r/pull/1',
      pass_count: 1,
      pr_review_path_set: true,
    };
    const d = entryDispatch({
      observed,
      change_status: 'in-review',
      pr_review_status: 'needs-changes',
      comments_to_address: 0,
      latest_pass_acted: false,
    });
    expect(d.action).toBe('park');
    if (d.action === 'park') expect(d.reason).toMatch(/^needs-triage:/);
  });

  it('needs-changes with all comments acted-on derives pr-review re-review', () => {
    const observed: ArtifactObservation = {
      head: 'abc',
      head_error: null,
      pr_url: 'https://github.com/o/r/pull/1',
      pass_count: 1,
      pr_review_path_set: true,
    };
    // actedCount>0 && commentsToAddress===0 → latest_pass_acted → classifier
    // says address-comments completed → dispatch a re-review (not a park).
    expect(
      deriveCompletedStepFromArtifacts({
        change_status: 'in-review',
        observed,
        latest_pass_acted: true,
      }),
    ).toBe('address-comments');
    expect(
      entryDispatch({
        observed,
        change_status: 'in-review',
        pr_review_status: 'needs-changes',
        comments_to_address: 0,
        latest_pass_acted: true,
      }),
    ).toEqual({ action: 'dispatch', step: 'pr-review' });
  });

  it('branch commits but status still planning derives null (wall-cap partial-completion → re-dispatch execute)', () => {
    const observed: ArtifactObservation = {
      head: 'abc',
      head_error: null,
      pr_url: null,
      pass_count: null,
      pr_review_path_set: false,
    };
    // EXECUTE committed but never ran its status writeback — did NOT complete.
    expect(
      deriveCompletedStepFromArtifacts({
        change_status: 'planning',
        observed,
        latest_pass_acted: false,
      }),
    ).toBeNull();
    expect(entryDispatch({ observed, change_status: 'planning' })).toEqual({
      action: 'dispatch',
      step: 'execute',
    });
  });

  it('clean verdict completes; degraded git falls back to status mapping', () => {
    const reviewed: ArtifactObservation = {
      head: 'abc',
      head_error: null,
      pr_url: 'https://github.com/o/r/pull/1',
      pass_count: 1,
      pr_review_path_set: true,
    };
    expect(
      entryDispatch({
        observed: reviewed,
        change_status: 'in-review',
        pr_review_status: 'approved',
      }).action,
    ).toBe('complete');

    // Degraded head read → trust frontmatter status. in-progress → execute
    // completed → dispatch open-pr.
    const degraded: ArtifactObservation = {
      head: null,
      head_error: 'degraded',
      pr_url: null,
      pass_count: null,
      pr_review_path_set: false,
    };
    expect(entryDispatch({ observed: degraded, change_status: 'in-progress' })).toEqual({
      action: 'dispatch',
      step: 'open-pr',
    });
    // Degraded + planning → null → execute (identical to today's behavior).
    expect(entryDispatch({ observed: degraded, change_status: 'planning' })).toEqual({
      action: 'dispatch',
      step: 'execute',
    });
  });
});
