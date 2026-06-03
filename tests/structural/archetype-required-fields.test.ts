// Structural test: every entry of type X carries the mandatory frontmatter
// fields documented in archetype-X.md.
//
// Required fields are codified here (not parsed from the archetype docs)
// because the doc prose isn't machine-readable. The contract: when an
// archetype's required-field list changes, update this test AND the doc in
// the same commit. Same pattern as archetype-enums.test.ts — the test is
// the source of truth that forces drift detection at commit time.
//
// Scope: only enforces fields that are LOAD-BEARING — used by code paths
// that would silently misbehave if absent. Optional fields (e.g., `tags`,
// `private`, `description`) aren't enforced here; the audit + lifecycle-
// stepper code paths handle their absence gracefully.

import { describe, expect, it } from 'vitest';
import { readManifest, relPath, REPO_ROOT } from '../helpers/vault.js';
import { join } from 'node:path';

// Per-archetype required field list. Comments name the rationale + the
// canonical doc that should be updated in parallel.
//
// Shared fields enforced on every entry:
//   id, type, domain, title, created, updated
// Per-archetype extras add to the shared set.
const SHARED_REQUIRED = ['id', 'type', 'domain', 'title', 'created', 'updated'] as const;

const REQUIRED_BY_TYPE: Record<string, readonly string[]> = {
  // change — archetype-change.md § Required frontmatter. status drives the
  // lifecycle stepper + every routing decision; repo + branch are how the
  // skills resolve the git target.
  change: ['repo', 'status'],
  // project — archetype-project.md § Required frontmatter. status gates
  // scheduled runbooks; deadline drives the urgency UI.
  project: ['status'],
  // research-report — archetype-research-report.md § Required frontmatter.
  // project is the owning relation; status drives the lifecycle stepper.
  'research-report': ['project', 'status'],
  // entity — archetype-entity.md § Required frontmatter. Entity entries
  // describe repos / external systems; they need their domain + title to
  // be navigable but specific extras vary by kind. Conservative scope.
  entity: [],
  // decision — archetype-decision.md. Date + author land on every decision.
  decision: [],
  // note — archetype-note.md. Minimal — just the shared set.
  note: [],
  // reference — archetype-reference.md. Used for standards + templates +
  // walkthroughs. Body is the load-bearing content; frontmatter is light.
  reference: [],
  // pr-review — review entries; written by dev-pr-review.
  'pr-review': [],
  // notification-config — rule entries. event_type + channel ARE required
  // on disk but aren't lifted into the manifest's standard field set.
  // events.test.ts validates event_type by reading the entry file directly;
  // this archetype gets the shared-fields check only.
  'notification-config': [],
  // repo-knowledge — analyzer output. analyzed_at + based_on_commit drive
  // the staleness audit; without them, the audit fires false-positives.
  'repo-knowledge': [],
  // pr-review-repo-cache — cache entries. local_path + head_sha are how
  // dev-pr-review finds the cache.
  'pr-review-repo-cache': [],
};

const manifest = readManifest();

describe('archetype required fields', () => {
  it('shared fields exist on every entry', () => {
    const violations: Array<{ id: string; field: string; path: string }> = [];
    for (const entry of manifest.entries) {
      // Skip entries with no `type` — that's its own check; let the audit
      // catch type-less entries separately.
      if (entry.type == null) continue;
      // Skip _seed/ entries — they're examples; some intentionally omit
      // fields to demonstrate the minimum shape.
      if (typeof entry.path === 'string' && entry.path.includes('/_seed/')) continue;
      for (const field of SHARED_REQUIRED) {
        const value = (entry as Record<string, unknown>)[field];
        if (value == null || value === '') {
          violations.push({
            id: entry.id ?? '(no-id)',
            field,
            path: entry.path ?? '(no-path)',
          });
        }
      }
    }
    if (violations.length === 0) return;
    expect.fail(
      `${violations.length} entry/entries missing required shared field(s):\n` +
        violations
          .map(
            (v) => `  ${v.id} (${relPath(join(REPO_ROOT, v.path))}): missing "${v.field}"`,
          )
          .join('\n') +
        `\n\nRequired shared fields: { ${SHARED_REQUIRED.join(', ')} }`,
    );
  });

  for (const [archetype, extra] of Object.entries(REQUIRED_BY_TYPE)) {
    if (extra.length === 0) continue; // shared-only archetypes covered above
    it(`${archetype}: archetype-specific required fields present`, () => {
      const violations: Array<{ id: string; field: string; path: string }> = [];
      for (const entry of manifest.entries) {
        if (entry.type !== archetype) continue;
        if (typeof entry.path === 'string' && entry.path.includes('/_seed/')) continue;
        for (const field of extra) {
          const value = (entry as Record<string, unknown>)[field];
          if (value == null || value === '') {
            violations.push({
              id: entry.id ?? '(no-id)',
              field,
              path: entry.path ?? '(no-path)',
            });
          }
        }
      }
      if (violations.length === 0) return;
      expect.fail(
        `${violations.length} ${archetype} entry/entries missing required field(s):\n` +
          violations
            .map(
              (v) =>
                `  ${v.id} (${relPath(join(REPO_ROOT, v.path))}): missing "${v.field}"`,
            )
            .join('\n') +
          `\n\nRequired ${archetype} fields: { ${[...SHARED_REQUIRED, ...extra].join(', ')} }`,
      );
    });
  }
});
