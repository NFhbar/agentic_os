// Skill dependency gate decision core (scripts/skill-dependency-gate.mjs).
//
// The gate answers "may this skill be refactored right now?" from live state.
// These tests pin each blocking axis independently — a non-terminal entry on
// the lifecycle the skill serves, a scheduled runbook that fires it, run
// traffic inside the window — plus the clear case, since a gate that never
// says yes is as useless as one that never says no.
//
// The CLI half (wiki walk + events.db read) is not exercised here: it pulls
// node:sqlite, which vitest's resolver can't load. It's imported lazily inside
// readRuns for exactly that reason, which is what keeps this import working.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRAFFIC_WINDOW_DAYS,
  evaluateSkillDependencies,
  lifecycleForSkill,
  osIntentSegments,
  runbookReferencesSkill,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../scripts/skill-dependency-gate.mjs';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function evaluate(over: Record<string, unknown> = {}) {
  return evaluateSkillDependencies({
    skill: 'dev-write-change',
    nowMs: NOW,
    entries: [],
    runbooks: [],
    runs: [],
    routingPhrases: [],
    ...over,
  });
}

const kinds = (r: { reasons: Array<{ kind: string }> }) => r.reasons.map((x) => x.kind);

describe('lifecycleForSkill', () => {
  it('maps change / project / report skills onto their lifecycle', () => {
    expect(lifecycleForSkill('dev-write-change')).toBe('change');
    expect(lifecycleForSkill('dev-add-change')).toBe('change');
    expect(lifecycleForSkill('meta-scaffold-project-plan')).toBe('project');
    expect(lifecycleForSkill('meta-close-project')).toBe('project');
    expect(lifecycleForSkill('research-revise')).toBe('research-report');
  });

  it('returns null for skills that serve no entity lifecycle', () => {
    expect(lifecycleForSkill('meta-audit')).toBeNull();
    expect(lifecycleForSkill('meta-brief')).toBeNull();
  });
});

describe('evaluateSkillDependencies — clear', () => {
  it('no live entries, no runbooks, no traffic → not blocked', () => {
    const out = evaluate({
      entries: [
        { id: 'shipped-thing', status: 'merged' },
        { id: 'dropped-thing', status: 'abandoned' },
      ],
      runs: [{ id: 'run-old', startedAt: daysAgo(30) }],
    });
    expect(out.blocked).toBe(false);
    expect(out.reasons).toEqual([]);
    expect(out.days).toBe(DEFAULT_TRAFFIC_WINDOW_DAYS);
    expect(out.lifecycle).toBe('change');
  });
});

describe('evaluateSkillDependencies — live lifecycle entries', () => {
  it('a non-terminal change blocks a change-lifecycle skill', () => {
    const out = evaluate({
      entries: [
        { id: 'mid-flight', status: 'in-progress' },
        { id: 'shipped-thing', status: 'merged' },
      ],
    });
    expect(out.blocked).toBe(true);
    expect(kinds(out)).toEqual(['live-lifecycle-entry']);
    expect(out.reasons[0].detail).toContain('1 non-terminal change entry');
    expect(out.reasons[0].refs).toEqual(['mid-flight (in-progress)']);
  });

  it('an entry with no status at all counts as non-terminal', () => {
    expect(evaluate({ entries: [{ id: 'statusless' }] }).blocked).toBe(true);
  });

  it('caps the ref list and says how many were elided', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ id: `c-${i}`, status: 'planning' }));
    const refs = evaluate({ entries }).reasons[0].refs;
    expect(refs).toHaveLength(6);
    expect(refs[5]).toBe('…and 3 more');
  });

  it('project + research-report lifecycles use their own terminal sets', () => {
    expect(
      evaluateSkillDependencies({
        skill: 'meta-close-project',
        nowMs: NOW,
        entries: [{ id: 'done', status: 'completed' }, { id: 'gone', status: 'cancelled' }],
      }).blocked,
    ).toBe(false);
    expect(
      evaluateSkillDependencies({
        skill: 'meta-close-project',
        nowMs: NOW,
        entries: [{ id: 'live', status: 'active' }],
      }).blocked,
    ).toBe(true);
    expect(
      evaluateSkillDependencies({
        skill: 'research-revise',
        nowMs: NOW,
        entries: [{ id: 'draft-report', status: 'draft' }],
      }).blocked,
    ).toBe(true);
  });

  it('a skill serving no lifecycle ignores the entries entirely', () => {
    const out = evaluateSkillDependencies({
      skill: 'meta-audit',
      nowMs: NOW,
      entries: [{ id: 'mid-flight', status: 'in-progress' }],
    });
    expect(out.lifecycle).toBeNull();
    expect(out.blocked).toBe(false);
  });
});

describe('runbookReferencesSkill', () => {
  it('matches the skill name on a word boundary', () => {
    expect(runbookReferencesSkill({ text: 'Run the dev-pr-review skill.' }, 'dev-pr-review')).toBe(true);
    // The longer id must not be claimed by the shorter one.
    expect(
      runbookReferencesSkill({ text: 'Run the dev-pr-review-publish skill.' }, 'dev-pr-review'),
    ).toBe(false);
  });

  it('resolves routed `/os <intent>` prompts through OS.md phrases', () => {
    const runbook = { text: 'prompt: "/os audit followups"' };
    expect(runbookReferencesSkill(runbook, 'meta-audit-followups')).toBe(false);
    expect(runbookReferencesSkill(runbook, 'meta-audit-followups', ['audit followups'])).toBe(true);
  });

  it('osIntentSegments lifts every /os invocation out of a prompt', () => {
    expect(osIntentSegments('nothing here')).toEqual([]);
    expect(osIntentSegments('/os brief\nthen /os audit now')).toEqual(['brief', 'audit now']);
  });
});

describe('evaluateSkillDependencies — scheduled runbooks', () => {
  it('a runbook referencing the skill blocks it', () => {
    const out = evaluate({
      runbooks: [
        { id: 'runbook-nightly-writes', text: 'prompt: "Run dev-write-change for the queue"' },
        { id: 'runbook-unrelated', text: 'prompt: "/os brief"' },
      ],
    });
    expect(out.blocked).toBe(true);
    expect(kinds(out)).toEqual(['scheduled-runbook']);
    expect(out.reasons[0].refs).toEqual(['runbook-nightly-writes']);
  });
});

describe('evaluateSkillDependencies — recent run traffic', () => {
  it('runs inside the default window block', () => {
    const out = evaluate({
      runs: [
        { id: 'run-a', startedAt: daysAgo(1) },
        { id: 'run-b', startedAt: daysAgo(20) },
      ],
    });
    expect(kinds(out)).toEqual(['recent-run-traffic']);
    expect(out.reasons[0].detail).toContain('1 run(s) in the last 14 days');
    expect(out.reasons[0].detail).toContain(daysAgo(1));
  });

  it('--days widens the window', () => {
    const runs = [{ id: 'run-b', startedAt: daysAgo(20) }];
    expect(evaluate({ runs }).blocked).toBe(false);
    expect(evaluate({ runs, days: 30 }).blocked).toBe(true);
    expect(evaluate({ runs, days: 30 }).days).toBe(30);
  });

  it('unparseable started_at values are ignored rather than counted', () => {
    expect(evaluate({ runs: [{ id: 'run-x', startedAt: 'not-a-date' }] }).blocked).toBe(false);
  });
});

describe('evaluateSkillDependencies — multiple axes', () => {
  it('reports every blocking axis, in decision order', () => {
    const out = evaluate({
      entries: [{ id: 'mid-flight', status: 'planning' }],
      runbooks: [{ id: 'runbook-x', text: 'dev-write-change' }],
      runs: [{ id: 'run-a', startedAt: daysAgo(2) }],
    });
    expect(out.blocked).toBe(true);
    expect(kinds(out)).toEqual(['live-lifecycle-entry', 'scheduled-runbook', 'recent-run-traffic']);
  });
});
