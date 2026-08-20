// Arg interpolation in rendered notifications.
//
// A notification template and the site that records the event are coupled by
// nothing but the variable NAME: the renderer substitutes a missing `{{var}}`
// with the empty string (Mustache default), so a mismatch is silent — the
// notification just ships with a hole where the number should be. The
// accept-all title regressed exactly that way, so these tests pin the seed
// template's arg names against the shape the recording site emits.

import { describe, expect, it } from 'vitest';
import { renderViaTemplate } from '../../domains/meta/app/server/notifications/template.js';
import type { Rule } from '../../domains/meta/app/server/notifications/rules.js';
import type { EventRow } from '../../domains/meta/app/server/notifications/types.js';

// The dispatcher hands the renderer a row whose `raw` has already been parsed
// from JSON, hence the cast — `EventRow.raw` types the on-disk column.
function eventWith(action: string, args: Record<string, unknown>): EventRow {
  return {
    ts: '2026-08-20T12:00:00Z',
    dedupe_key: null,
    kind: 'dashboard',
    action,
    project: 'some-project',
    change_id: 'some-change',
    raw: { args },
  } as unknown as EventRow;
}

const RULE: Rule = {
  id: 'some-rule',
  event_type: 'dashboard.pr-comment-accept-all',
  channel: 'desktop',
  filter: {},
  delivery: {},
  rate_limit: null,
};

describe('renderViaTemplate — event args', () => {
  it('interpolates the accept-all tally into the title and body', async () => {
    const rendered = await renderViaTemplate(
      eventWith('pr-comment-accept-all', { review: 'some-review', pass: 2, accepted_count: 7 }),
      RULE,
    );
    expect(rendered).not.toBeNull();
    expect(rendered?.title).toContain('Accepted 7 review comment(s)');
    expect(rendered?.title).toContain('some-change');
    expect(rendered?.body).toContain('7 inline comment(s)');
  });

  it('leaves a hole when the arg name does not match the placeholder', async () => {
    // The pre-fix recording site spelled the tally `accepted`. Nothing errors
    // — the count simply vanishes, which is why the mismatch went unnoticed.
    const rendered = await renderViaTemplate(
      eventWith('pr-comment-accept-all', { review: 'some-review', pass: 2, accepted: 7 }),
      RULE,
    );
    expect(rendered?.title).toContain('Accepted  review comment(s)');
  });

  it('reserved event fields win over same-named args', async () => {
    const rendered = await renderViaTemplate(
      eventWith('pr-comment-accept-all', { accepted_count: 1, change_id: 'spoofed' }),
      RULE,
    );
    expect(rendered?.title).toContain('some-change');
    expect(rendered?.title).not.toContain('spoofed');
  });
});
