import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations
import { migrateProjectText } from '../../scripts/migrate-review-state.mjs';

function entry(fmLines: string[], body = '# Title\n\nBody.') {
  return `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
}

const BASE = ['id: p', 'type: project', 'updated: 2026-01-01T00:00:00Z'];

describe('migrateProjectText', () => {
  it.each([
    ['reviewed-pending', 'pending'],
    ['request-changes', 'request-changes'],
    ['approved', 'approved'],
  ])('maps legacy plan_status %s to drafted + review_status %s', (legacy, verdict) => {
    const { text, actions } = migrateProjectText(entry([...BASE, `plan_status: ${legacy}`]));
    expect(text).toMatch(/^plan_status: drafted$/m);
    expect(text).toMatch(new RegExp(`^review_status: ${verdict}$`, 'm'));
    expect(actions).toHaveLength(1);
  });

  it('renames plan_review_path and plan_reviewed_at', () => {
    const { text, actions } = migrateProjectText(
      entry([...BASE, 'plan_review_path: vault/output/x.md', 'plan_reviewed_at: 2026-01-02T00:00:00Z']),
    );
    expect(text).toMatch(/^review_path: vault\/output\/x\.md$/m);
    expect(text).toMatch(/^reviewed_at: 2026-01-02T00:00:00Z$/m);
    expect(text).not.toMatch(/plan_review_path|plan_reviewed_at/);
    expect(actions).toHaveLength(2);
  });

  it('is idempotent — second run is a no-op', () => {
    const first = migrateProjectText(
      entry([...BASE, 'plan_status: reviewed-pending', 'plan_review_path: x.md']),
    );
    const second = migrateProjectText(first.text);
    expect(second.actions).toEqual([]);
    expect(second.text).toBe(first.text);
  });

  it('leaves new-vocabulary entries untouched', () => {
    const t = entry([...BASE, 'plan_status: scaffolded', 'review_status: approved']);
    const { text, actions } = migrateProjectText(t);
    expect(actions).toEqual([]);
    expect(text).toBe(t);
  });

  it('does not clobber an existing review_status', () => {
    const { text, actions } = migrateProjectText(
      entry([...BASE, 'plan_status: approved', 'review_status: overridden']),
    );
    expect(text).toMatch(/^plan_status: drafted$/m);
    expect(text).toMatch(/^review_status: overridden$/m);
    expect(text).not.toMatch(/^review_status: approved$/m);
    expect(actions[0]).toContain('review_status already present');
  });

  it('flags rename conflicts instead of overwriting', () => {
    const { text, actions } = migrateProjectText(
      entry([...BASE, 'plan_review_path: old.md', 'review_path: new.md']),
    );
    expect(text).toMatch(/^plan_review_path: old\.md$/m);
    expect(text).toMatch(/^review_path: new\.md$/m);
    expect(actions[0]).toContain('NOT renamed');
  });

  it('touches frontmatter only — body text with legacy phrases survives', () => {
    const body = 'The plan moved through plan_status: approved last week.';
    const { text } = migrateProjectText(entry([...BASE, 'plan_status: approved'], body));
    expect(text).toContain(body);
  });

  it('bumps updated only when something actually migrated', () => {
    const migratedText = migrateProjectText(entry([...BASE, 'plan_status: approved'])).text;
    expect(migratedText).not.toMatch(/^updated: 2026-01-01T00:00:00Z$/m);
    const untouched = migrateProjectText(entry([...BASE, 'plan_status: drafted'])).text;
    expect(untouched).toMatch(/^updated: 2026-01-01T00:00:00Z$/m);
  });
});
