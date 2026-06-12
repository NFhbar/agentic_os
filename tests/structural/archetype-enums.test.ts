// Structural test: every entry's enum-shaped frontmatter field carries a
// value from the documented canonical set for that archetype.
//
// This is the test that catches the class of bug from Task #417 ("research-
// report status enum not type-enforced — derivers silently miss values").
// When a skill or operator writes a new value the deriver code doesn't
// handle, downstream views silently break. Without this test, the drift
// only surfaces in production when a screen renders empty.
//
// **The contract:** the canonical sets below are the source of truth. When
// a skill writes a new value, the same change that lands the skill MUST
// update the canonical set here. The test enforces "every value seen on
// disk is documented" — silent drift is impossible.
//
// **What this is NOT:** these are NOT the only allowed values forever.
// New values are expected as the OS evolves. The test just ensures they
// land here at the same time they land in skills.

import { describe, expect, it } from 'vitest';
import { readManifest, relPath, REPO_ROOT } from '../helpers/vault.js';
import { join } from 'node:path';

// Canonical enum value sets per archetype + field. When a skill writes a
// new value, add it here in the same change. Comments name the canonical
// docs that should also be updated.
//
// Format: archetype → field → set of valid values (`null` allowed everywhere
// — fields are optional unless required by another check).
type EnumMap = Map<string, Map<string, Set<string>>>;

const ENUMS: EnumMap = new Map([
  [
    'change',
    new Map([
      // Lifecycle stages. archetype-change § Lifecycle.
      ['status', new Set(['planning', 'in-progress', 'in-review', 'merged', 'abandoned'])],
      // Plan-review verdicts. dev-write-change / dev-review-change skill set.
      [
        'review_status',
        new Set([
          'pending',
          'approved',
          'request-changes',
          'rejected',
          'not-required',
          'overridden',
          'needs-changes',
        ]),
      ],
      // PR review status (post dev-pr-review or dev-mark-pr-ready).
      // archetype-change § PR review fields.
      ['pr_review_status', new Set(['pending', 'approved', 'needs-changes', 'ready-for-human'])],
      // CI rollup state (managed by runbook-pr-ci-monitor).
      ['ci_state', new Set(['running', 'pass', 'fail', 'none'])],
    ]),
  ],
  [
    'project',
    new Map([
      // Project status. archetype-project + standard-project-workflow.
      ['status', new Set(['active', 'paused', 'completed', 'cancelled'])],
      // Lifecycle stage (informational; gates the scheduler).
      ['lifecycle_stage', new Set(['planning', 'active', 'review', 'shipped', 'archived'])],
    ]),
  ],
  [
    'research-report',
    new Map([
      // Report lifecycle. research-write / research-review / research-update
      // skills. `updated` lands when research-update refreshes an approved
      // report (Task #417 was about this value not being in the deriver set).
      ['status', new Set(['draft', 'reviewed', 'approved', 'updated'])],
      // Reviewer verdict.
      ['review_status', new Set(['pending', 'approved', 'request-changes', 'rejected'])],
    ]),
  ],
  [
    'pr-review',
    new Map([
      // Per-pass result. dev-pr-review skill outputs.
      ['result', new Set(['approved', 'request-changes', 'rejected'])],
    ]),
  ],
]);

const manifest = readManifest();

describe('archetype enum value coverage', () => {
  for (const [archetype, fields] of ENUMS) {
    const entries = manifest.entries.filter((e) => e.type === archetype);

    describe(`type: ${archetype} (${entries.length} entries)`, () => {
      for (const [fieldName, validSet] of fields) {
        it(`every ${archetype}.${fieldName} is in the canonical set`, () => {
          const violations: Array<{ id: string; value: string; path: string }> = [];
          for (const entry of entries) {
            // Skip _seed/ entries — they're examples and may carry placeholder
            // values that don't reflect real lifecycle state.
            if (typeof entry.path === 'string' && entry.path.includes('/_seed/')) continue;
            const value = (entry as Record<string, unknown>)[fieldName];
            // null / undefined / missing → not a violation (fields are optional)
            if (value === null || value === undefined) continue;
            // Must be string + in the canonical set
            if (typeof value !== 'string') {
              violations.push({
                id: entry.id ?? '(no-id)',
                value: `(non-string: ${typeof value})`,
                path: entry.path ?? '(no-path)',
              });
              continue;
            }
            if (!validSet.has(value)) {
              violations.push({
                id: entry.id ?? '(no-id)',
                value,
                path: entry.path ?? '(no-path)',
              });
            }
          }
          if (violations.length === 0) return;
          const lines = violations.map(
            (v) => `  ${v.id} (${relPath(join(REPO_ROOT, v.path))}): ${fieldName} = ${v.value}`,
          );
          const allowed = [...validSet].sort().join(', ');
          expect.fail(
            `${violations.length} entry/entries have ${archetype}.${fieldName} values outside the canonical set:\n` +
              lines.join('\n') +
              `\n\nCanonical set: { ${allowed} }\n\n` +
              `Resolve by ONE of:\n` +
              `  (a) The value is a typo / mistake — fix the entry's frontmatter.\n` +
              `  (b) The value is a NEW canonical state — add it to ENUMS in this test AND update the relevant archetype/standard doc + every deriver that switches on this field.\n` +
              `Whichever you choose, the test is correctly forcing the question instead of letting drift go silent.`,
          );
        });
      }
    });
  }
});
