// Structural integrity test for cross-entity references in wiki frontmatter.
//
// Many entries carry id references to other entries:
//   change.project → project entry id
//   change.repo → entity id
//   change.parent_change → another change id
//   change.derived_from_report → research-report id
//   change.plan_path / review_path / pr_review_path → file path that exists
//   project.research_paths[] → research-report file paths
//
// When these dangle, downstream views (lifecycle steppers, project tabs,
// PR-review linkage) silently misrender or crash. The audit doesn't yet
// check most of these; this test does.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readManifest, relPath } from '../helpers/vault.js';

// True only for actual id-like strings. Manifest serializes YAML `null` as
// the literal string `"null"` (manifest-writer bug worth filing separately);
// treat that + empty string as "not a real reference."
function isPresent(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v !== 'null' && v !== 'undefined';
}

const manifest = readManifest();
const idByType = new Map<string, Set<string>>();
for (const e of manifest.entries) {
  if (!e.type || !e.id) continue;
  if (!idByType.has(e.type)) idByType.set(e.type, new Set());
  idByType.get(e.type)?.add(e.id);
}

function idsOfType(type: string): Set<string> {
  return idByType.get(type) ?? new Set();
}

const projectIds = idsOfType('project');
const entityIds = idsOfType('entity');
const reportIds = idsOfType('research-report');
const changeIds = idsOfType('change');

describe('change.project references', () => {
  it('every change.project points at an existing project entry', () => {
    const orphans: string[] = [];
    for (const e of manifest.entries) {
      if (e.type !== 'change') continue;
      const p = (e as Record<string, unknown>).project;
      if (!isPresent(p)) continue;
      if (!projectIds.has(p)) {
        orphans.push(`${e.id ?? '(no-id)'} → project: ${p}`);
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} change(s) reference a project that doesn't exist:\n` +
        orphans.map((o) => `  ${o}`).join('\n'),
    );
  });
});

describe('change.parent_change references', () => {
  it('every change.parent_change points at an existing change entry', () => {
    const orphans: string[] = [];
    for (const e of manifest.entries) {
      if (e.type !== 'change') continue;
      const pc = (e as Record<string, unknown>).parent_change;
      if (!isPresent(pc)) continue;
      if (!changeIds.has(pc)) {
        orphans.push(`${e.id ?? '(no-id)'} → parent_change: ${pc}`);
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} change(s) reference a parent_change that doesn't exist:\n` +
        orphans.map((o) => `  ${o}`).join('\n'),
    );
  });
});

describe('change.repo references', () => {
  it('every change.repo points at an existing entity', () => {
    const orphans: string[] = [];
    for (const e of manifest.entries) {
      if (e.type !== 'change') continue;
      const r = (e as Record<string, unknown>).repo;
      if (!isPresent(r)) continue;
      // Some seed/example changes reference fake repos (e.g. example-repo)
      // that aren't ingested. Allow those by checking the change is under
      // _seed/ — they're documentation examples, not load-bearing.
      const isSeed = typeof e.path === 'string' && e.path.includes('/_seed/');
      if (isSeed && !entityIds.has(r)) continue;
      if (!entityIds.has(r)) {
        orphans.push(`${e.id ?? '(no-id)'} → repo: ${r}`);
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} non-seed change(s) reference a repo entity that doesn't exist:\n` +
        orphans.map((o) => `  ${o}`).join('\n') +
        '\n\nIngest the repo via /os ingest repo OR fix the change.repo value.',
    );
  });
});

describe('change.derived_from_report references', () => {
  it('every change.derived_from_report points at an existing research-report', () => {
    const orphans: string[] = [];
    for (const e of manifest.entries) {
      if (e.type !== 'change') continue;
      const r = (e as Record<string, unknown>).derived_from_report;
      if (!isPresent(r)) continue;
      if (!reportIds.has(r)) {
        orphans.push(`${e.id ?? '(no-id)'} → derived_from_report: ${r}`);
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} change(s) reference a research-report that doesn't exist:\n` +
        orphans.map((o) => `  ${o}`).join('\n'),
    );
  });
});

describe('frontmatter file-path references', () => {
  // Fields whose values are repo-relative paths to files that should exist.
  // Scope: NON-terminal entries only. Once a change is `merged` / `abandoned`,
  // its plan/review artifacts may have been cleaned up — that's intentional.
  // Same for research-reports past `approved`. The test catches drift on
  // in-flight entries where the paths are still load-bearing.
  const PATH_FIELDS = [
    'plan_path',
    'review_path',
    'pr_review_path',
    'report_path',
  ];

  it('every plan_path / review_path / pr_review_path resolves for in-flight entries', () => {
    const orphans: string[] = [];
    for (const e of manifest.entries) {
      const status = (e as Record<string, unknown>).status;
      // Skip terminal states — artifacts may legitimately be cleaned up.
      if (status === 'merged' || status === 'abandoned' || status === 'archived') continue;
      // Skip seed/example entries — their paths are illustrative.
      if (typeof e.path === 'string' && e.path.includes('/_seed/')) continue;
      for (const field of PATH_FIELDS) {
        const v = (e as Record<string, unknown>)[field];
        if (!isPresent(v)) continue;
        // Skip entries pre-skill: a `planning` change's `plan_path` is
        // forward-declared until `dev-write-change` PLAN populates it.
        if (field === 'plan_path' && status === 'planning') continue;
        const abs = join(REPO_ROOT, v as string);
        if (!existsSync(abs)) {
          orphans.push(`${e.id ?? '(no-id)'} (status: ${status ?? 'null'}).${field} → ${v}`);
        }
      }
    }
    if (orphans.length === 0) return;
    expect.fail(
      `${orphans.length} in-flight entr${orphans.length === 1 ? 'y' : 'ies'} reference file paths that don't exist on disk:\n` +
        orphans.map((o) => `  ${o}`).join('\n') +
        '\n\nFix the path OR clear the field if the artifact was deleted.',
    );
  });
});
