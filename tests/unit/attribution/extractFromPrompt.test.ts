// Tier 1 unit tests for the event-attribution parsers.
//
// `scripts/extract-event-attribution.mjs` is the shared helper that pulls
// {change_id, project, domain, report_id} out of dispatcher prompts, router
// intents, file paths, and arg payloads. Used by record-dashboard-action.mjs,
// record-router-event.mjs, and runs.ts close handlers — basically every
// path that writes an event row.
//
// Real bugs caught in this code historically (filed + fixed in
// [[event-report-id-attribution-fix]]):
//   - extractFromPrompt didn't handle the `report:` legacy key (only `report_id:`)
//   - extractFromIntent didn't capture report_id from research intents at all
//   - record-dashboard-action.mjs read parsedArgs.report but not parsedArgs.report_id
//
// Tests pin the documented behavior so the next divergence between writer
// and reader is caught at commit time, not after a Slack notification fails
// to attribute properly.

import { describe, expect, it } from 'vitest';
import {
  extractFromIntent,
  extractFromPath,
  extractFromPrompt,
  extractSkill,
  mergeAttributions,
} from '../../../scripts/extract-event-attribution.mjs';

describe('extractFromPrompt', () => {
  it('extracts all four fields from a canonical dispatcher prompt', () => {
    const prompt = [
      'Run the dev-write-change skill for change "fix-y".',
      '',
      'Inputs:',
      '- change: fix-y',
      '- project: my-project',
      '- domain: development',
      '- report_id: my-project-report-x',
    ].join('\n');
    const r = extractFromPrompt(prompt);
    expect(r).toEqual({
      change_id: 'fix-y',
      project: 'my-project',
      domain: 'development',
      report_id: 'my-project-report-x',
    });
  });

  it('accepts legacy `report:` key in addition to `report_id:`', () => {
    // The bug from [[event-report-id-attribution-fix]] — extractFromPrompt
    // tries `report_id` first, then falls back to bare `report`. Both should
    // resolve to the same field.
    const prompt = 'Inputs:\n- change: x\n- report: legacy-report-id';
    const r = extractFromPrompt(prompt);
    expect(r.report_id).toBe('legacy-report-id');
  });

  it('prefers `report_id:` over `report:` when both are present', () => {
    // Defensive: if both keys appear (unusual but possible during migration),
    // the canonical key wins.
    const prompt = 'Inputs:\n- report_id: canonical\n- report: legacy';
    const r = extractFromPrompt(prompt);
    expect(r.report_id).toBe('canonical');
  });

  it('returns nulls for fields not present in the prompt', () => {
    const r = extractFromPrompt('Just a free-form prompt with no Inputs block.');
    expect(r.change_id).toBeNull();
    expect(r.project).toBeNull();
    expect(r.domain).toBeNull();
    expect(r.report_id).toBeNull();
  });

  it('handles quoted JSON-style values', () => {
    // Some skill dispatchers use JSON.stringify for the inputs (e.g.
    // - change: "fix-y" with quotes). Parser should strip surrounding quotes.
    const prompt = 'Inputs:\n- change: "fix-y"\n- project: "my-project"';
    const r = extractFromPrompt(prompt);
    expect(r.change_id).toBe('fix-y');
    expect(r.project).toBe('my-project');
  });

  it('returns nulls for empty/null/undefined input', () => {
    expect(extractFromPrompt('')).toMatchObject({
      change_id: null,
      project: null,
      domain: null,
      report_id: null,
    });
    expect(extractFromPrompt(null)).toMatchObject({
      change_id: null,
      project: null,
      domain: null,
      report_id: null,
    });
  });
});

describe('extractSkill', () => {
  it('extracts skill from a SKILL.md path reference', () => {
    const prompt =
      'Run the dev-write-change skill. Read .claude/skills/dev-write-change/SKILL.md and follow its Procedure.';
    expect(extractSkill(prompt)).toBe('dev-write-change');
  });

  it('returns null when no SKILL.md path is present', () => {
    expect(extractSkill('Plain prompt with no path.')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractSkill('')).toBeNull();
    expect(extractSkill(null)).toBeNull();
  });

  it('matches the first occurrence when multiple SKILL.md paths exist', () => {
    const prompt = '.claude/skills/dev-write-change/SKILL.md and .claude/skills/dev-pr-review/SKILL.md';
    expect(extractSkill(prompt)).toBe('dev-write-change');
  });
});

describe('extractFromIntent', () => {
  it('captures change_id from `write-change` intent', () => {
    const r = extractFromIntent('write change fix-the-thing');
    expect(r.change_id).toBe('fix-the-thing');
    expect(r.project).toBeNull();
    expect(r.report_id).toBeNull();
  });

  it('captures change_id from `review-change`, `open-change`, etc.', () => {
    expect(extractFromIntent('review change foo').change_id).toBe('foo');
    expect(extractFromIntent('open change bar').change_id).toBe('bar');
    expect(extractFromIntent('close change baz').change_id).toBe('baz');
    expect(extractFromIntent('address change qux').change_id).toBe('qux');
  });

  it('captures project from `status report` intent', () => {
    const r = extractFromIntent('status report mull-version-2');
    expect(r.project).toBe('mull-version-2');
    expect(r.change_id).toBeNull();
  });

  it('captures project from `add-project` intent', () => {
    expect(extractFromIntent('add project ship-it').project).toBe('ship-it');
    expect(extractFromIntent('add-project ship-it').project).toBe('ship-it');
  });

  it('captures report_id from research intents (regression test for Task #398-era bug)', () => {
    // [[event-report-id-attribution-fix]] added this — research router
    // dispatches used to lose the report_id because extractFromIntent only
    // returned change_id + project.
    expect(extractFromIntent('research write my-project-topic').report_id).toBe('my-project-topic');
    expect(extractFromIntent('research review my-project-topic').report_id).toBe(
      'my-project-topic',
    );
    expect(extractFromIntent('research revise my-project-topic').report_id).toBe(
      'my-project-topic',
    );
    expect(extractFromIntent('research update my-project-topic').report_id).toBe(
      'my-project-topic',
    );
    expect(extractFromIntent('research scaffold-recommendations my-project-topic').report_id).toBe(
      'my-project-topic',
    );
    expect(extractFromIntent('research scaffold recommendations my-project-topic').report_id).toBe(
      'my-project-topic',
    );
  });

  it('captures report_id from the English-ordering form (Task #435)', () => {
    // `<verb> research <id>` — the form OS.md's intent vocabulary accepts
    // alongside the canonical `research <verb> <id>`. Dashboard action-item
    // hints use this form (e.g. `/os update research X`); without parsing
    // both, router-logged events lose the report attribution and the audit
    // check `events-report-attribution-missing` fires.
    expect(extractFromIntent('update research mull-version-2-mull-new-features').report_id).toBe(
      'mull-version-2-mull-new-features',
    );
    expect(extractFromIntent('review research my-report').report_id).toBe('my-report');
    expect(extractFromIntent('revise research my-report').report_id).toBe('my-report');
    expect(extractFromIntent('write research my-report').report_id).toBe('my-report');
    expect(extractFromIntent('refresh research my-report').report_id).toBe('my-report');
    expect(extractFromIntent('author research report my-report').report_id).toBe('my-report');
  });

  it('captures report_id when the intent has trailing context (long natural sentence)', () => {
    // The actual bug case from mull dogfooding — the intent carried a long
    // tail explaining what the user wanted, not just the slug.
    const r = extractFromIntent(
      'update research mull-version-2-mull-new-features so recommended_changes[] reflects current change states',
    );
    expect(r.report_id).toBe('mull-version-2-mull-new-features');
  });

  it('returns all nulls for an unrecognized intent', () => {
    const r = extractFromIntent('something totally random');
    expect(r).toEqual({ change_id: null, project: null, report_id: null });
  });

  it('handles empty/null input', () => {
    expect(extractFromIntent('')).toEqual({ change_id: null, project: null, report_id: null });
    expect(extractFromIntent(null)).toEqual({ change_id: null, project: null, report_id: null });
  });
});

describe('extractFromPath', () => {
  it('extracts change_id + domain from canonical change path', () => {
    const r = extractFromPath('vault/wiki/development/change/fix-y.md');
    expect(r).toEqual({ change_id: 'fix-y', domain: 'development' });
  });

  it('handles different domains', () => {
    const r = extractFromPath('vault/wiki/research/change/x.md');
    expect(r.domain).toBe('research');
  });

  it('returns nulls for non-change paths', () => {
    expect(extractFromPath('vault/wiki/development/project/foo.md')).toEqual({
      change_id: null,
      domain: null,
    });
    expect(extractFromPath('some/random/file.md')).toEqual({ change_id: null, domain: null });
  });

  it('handles empty/null input', () => {
    expect(extractFromPath('')).toEqual({ change_id: null, domain: null });
    expect(extractFromPath(null)).toEqual({ change_id: null, domain: null });
  });
});

describe('mergeAttributions', () => {
  it('first non-null wins per field', () => {
    const r = mergeAttributions(
      { change_id: 'a', project: null, domain: null, report_id: null },
      { change_id: 'b', project: 'p', domain: null, report_id: null },
      { change_id: null, project: null, domain: 'd', report_id: null },
    );
    expect(r).toEqual({ change_id: 'a', project: 'p', domain: 'd', report_id: null });
  });

  it('returns all nulls when every source is empty', () => {
    const r = mergeAttributions(null, undefined, {});
    expect(r).toEqual({ change_id: null, project: null, domain: null, report_id: null });
  });

  it('handles a single source', () => {
    const r = mergeAttributions({ change_id: 'a', project: 'p' });
    expect(r.change_id).toBe('a');
    expect(r.project).toBe('p');
  });

  it('handles zero sources', () => {
    const r = mergeAttributions();
    expect(r).toEqual({ change_id: null, project: null, domain: null, report_id: null });
  });
});
