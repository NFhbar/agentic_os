#!/usr/bin/env node
// Walk vault/wiki/ and rebuild the vault indexes:
//
//   vault/.index/manifest.json — frontmatter fields, 200-char snippet,
//     backlinks. The structural index-of-record.
//   vault/.index/search.db — SQLite FTS5 over id + title + tags + BODY.
//     The retrieval index: the manifest's snippet-only search missed
//     body-only knowledge on 3 of 4 realistic queries (Fable review,
//     Finding 5.1). The vault MCP queries this with BM25 and falls back
//     to the substring scorer when the file is missing.
//
// Run by the rebuild-vault-index.sh hook on Write/Edit to vault/wiki/.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WIKI_DIR = join(REPO_ROOT, 'vault', 'wiki');
const INDEX_PATH = join(REPO_ROOT, 'vault', '.index', 'manifest.json');

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Shared real-YAML parser (CORE_SCHEMA: timestamps stay strings, ~ → null,
// duplicate keys → parseError). Replaces this hook's hand-rolled flat parser
// — see scripts/frontmatter.mjs for the consolidation rationale.
import { parseFrontmatter } from '../../scripts/frontmatter.mjs';

function snippetOf(body) {
  return body
    .replace(/^#+ .*\n/m, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 200);
}

function backlinksIn(body) {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
}

const records = walk(WIKI_DIR).map((p) => {
  const content = readFileSync(p, 'utf8');
  const { fm, body, parseError } = parseFrontmatter(content);
  if (parseError) {
    console.error(
      `⚠ ${relative(REPO_ROOT, p)}: frontmatter parse error — ${parseError.split('\n')[0]}`
    );
  }
  return { body, entry: {
    path: relative(REPO_ROOT, p),
    id: fm.id ?? null,
    type: fm.type ?? null,
    // For `type: entity` entries, `kind` further classifies (repo, person,
    // service, etc.). Lifted into the manifest so consumers can filter to
    // e.g. "all repo entities" without parsing each .md file's frontmatter.
    kind: typeof fm.kind === 'string' ? fm.kind : null,
    domain: fm.domain ?? null,
    title: fm.title ?? fm.name ?? null,
    created: fm.created ?? null,
    updated: fm.updated ?? null,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    source: fm.source ?? null,
    private: fm.private === true,
    // Cross-archetype relationships lifted from frontmatter so consumers
    // can do graph queries without re-parsing each entry. `backlinks` still
    // captures body [[wikilinks]] separately — these typed fields are for
    // structural relationships (owning project, owning repo, parent change).
    project: typeof fm.project === 'string' ? fm.project : null,
    repo: typeof fm.repo === 'string' ? fm.repo : null,
    parent_change: typeof fm.parent_change === 'string' ? fm.parent_change : null,
    // The owning change for pr-review entries — lifted here so events.db
    // attribution can resolve review_id → change_id via the manifest without
    // re-parsing the entry. Null for change entries (where the change_id
    // would be itself / redundant) and for external PR reviews.
    change_id: typeof fm.change_id === 'string' ? fm.change_id : null,
    // Change-specific lifecycle fields. Surfaced on the manifest so the
    // brief / status report / change-triage / pr-ci-monitor consumers
    // don't have to load each .md file. Null for non-change entries.
    status: typeof fm.status === 'string' ? fm.status : null,
    review_status: typeof fm.review_status === 'string' ? fm.review_status : null,
    pr_url: typeof fm.pr_url === 'string' ? fm.pr_url : null,
    // CI lifecycle (managed by runbook-pr-ci-monitor)
    ci_state: typeof fm.ci_state === 'string' ? fm.ci_state : null,
    ci_completed_at: typeof fm.ci_completed_at === 'string' ? fm.ci_completed_at : null,
    merged_at: typeof fm.merged_at === 'string' ? fm.merged_at : null,
    // PR review summary (managed by dev-pr-review when invoked with a change input).
    // The flat parser captures values as raw strings — coerce integer + boolean
    // fields where appropriate. pr_review_passes is parsed via parseInt so a
    // `pr_review_passes: 2` line lands as a number.
    pr_review_status: typeof fm.pr_review_status === 'string' ? fm.pr_review_status : null,
    pr_review_path: typeof fm.pr_review_path === 'string' ? fm.pr_review_path : null,
    pr_review_passes:
      typeof fm.pr_review_passes === 'number'
        ? fm.pr_review_passes
        : typeof fm.pr_review_passes === 'string' && /^\d+$/.test(fm.pr_review_passes)
          ? parseInt(fm.pr_review_passes, 10)
          : null,
    pr_reviewed_at: typeof fm.pr_reviewed_at === 'string' ? fm.pr_reviewed_at : null,
    pr_ready_at: typeof fm.pr_ready_at === 'string' ? fm.pr_ready_at : null,
    // Plan-* fields cluster — written by dev-revise-plan (for change entries) and
    // by the four project-orchestration skills (meta-research-project /
    // meta-review-project-plan / meta-revise-project-plan / meta-scaffold-project-plan
    // for project entries). Lifted flat onto every record so the dashboard's
    // lifecycle stepper / Plan tab / projects list can render plan state without
    // a second fetch. Null on entries that don't carry these fields.
    plan_status: typeof fm.plan_status === 'string' ? fm.plan_status : null,
    plan_path: typeof fm.plan_path === 'string' ? fm.plan_path : null,
    plan_reviewed_at: typeof fm.plan_reviewed_at === 'string' ? fm.plan_reviewed_at : null,
    plan_revision:
      typeof fm.plan_revision === 'number'
        ? fm.plan_revision
        : typeof fm.plan_revision === 'string' && /^\d+$/.test(fm.plan_revision)
          ? parseInt(fm.plan_revision, 10)
          : null,
    plan_revised_at: typeof fm.plan_revised_at === 'string' ? fm.plan_revised_at : null,
    plan_revised_from_review:
      typeof fm.plan_revised_from_review === 'string' ? fm.plan_revised_from_review : null,
    // Research-attribution fields on scaffolded changes — written by
    // research-scaffold-recommendations when it creates a change from a
    // research-report's `recommended_changes[]` array. The dashboard reads
    // these to (a) show the `[N+1/M] ` step indicator on the title, (b) link
    // back to the source report, and (c) drive the
    // research-recommended-changes-status-drift audit hook. Null on
    // hand-scaffolded changes.
    derived_from_report:
      typeof fm.derived_from_report === 'string' ? fm.derived_from_report : null,
    recommendation_index:
      typeof fm.recommendation_index === 'number'
        ? fm.recommendation_index
        : typeof fm.recommendation_index === 'string' &&
            /^\d+$/.test(fm.recommendation_index)
          ? parseInt(fm.recommendation_index, 10)
          : null,
    // Research-report-specific lifecycle fields. Mirror the plan_* cluster
    // above — written by research-write / research-review / research-revise
    // (phase B) and read by the dashboard's Research view. Null on entries
    // that don't carry these fields (i.e. everything that isn't a
    // research-report).
    report_generated_at:
      typeof fm.report_generated_at === 'string' ? fm.report_generated_at : null,
    report_revision:
      typeof fm.report_revision === 'number'
        ? fm.report_revision
        : typeof fm.report_revision === 'string' && /^\d+$/.test(fm.report_revision)
          ? parseInt(fm.report_revision, 10)
          : null,
    report_revised_at:
      typeof fm.report_revised_at === 'string' ? fm.report_revised_at : null,
    report_revised_from_review:
      typeof fm.report_revised_from_review === 'string'
        ? fm.report_revised_from_review
        : null,
    materials_path: typeof fm.materials_path === 'string' ? fm.materials_path : null,
    last_data_ingest:
      typeof fm.last_data_ingest === 'string' ? fm.last_data_ingest : null,
    update_count:
      typeof fm.update_count === 'number'
        ? fm.update_count
        : typeof fm.update_count === 'string' && /^\d+$/.test(fm.update_count)
          ? parseInt(fm.update_count, 10)
          : null,
    // Only the count surfaces here (the full array stays in the entry).
    // Degrades to null when the field is absent or the entry's YAML failed
    // to parse. See archetype-research-report § "Frontmatter caveats".
    recommended_changes_count: Array.isArray(fm.recommended_changes)
      ? fm.recommended_changes.length
      : null,
    snippet: snippetOf(body),
    backlinks: backlinksIn(body),
  } };
});
const entries = records.map((r) => r.entry);

mkdirSync(dirname(INDEX_PATH), { recursive: true });
writeFileSync(
  INDEX_PATH,
  JSON.stringify(
    { version: 1, generated: new Date().toISOString(), entries },
    null,
    2
  ) + '\n'
);

// FTS5 retrieval index. Full drop-and-rebuild inside one transaction —
// same cost profile as the manifest rebuild (~300 rows, milliseconds).
// Graceful skip when node:sqlite/FTS5 is unavailable: the vault MCP falls
// back to its substring scorer when search.db is missing or stale-locked.
const SEARCH_DB_PATH = join(REPO_ROOT, 'vault', '.index', 'search.db');

async function rebuildSearchDb() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(SEARCH_DB_PATH);
    try {
      db.exec('BEGIN');
      db.exec('DROP TABLE IF EXISTS wiki_fts');
      db.exec(
        'CREATE VIRTUAL TABLE wiki_fts USING fts5(id, title, tags, body, path UNINDEXED, type UNINDEXED, domain UNINDEXED)'
      );
      const ins = db.prepare(
        'INSERT INTO wiki_fts (id, title, tags, body, path, type, domain) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const { entry, body } of records) {
        ins.run(
          entry.id ?? '',
          entry.title ?? '',
          (entry.tags ?? []).join(' '),
          body ?? '',
          entry.path,
          entry.type ?? '',
          entry.domain ?? ''
        );
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    return true;
  } catch (e) {
    console.error(`⚠ search.db rebuild skipped: ${e.message}`);
    return false;
  }
}

const ftsOk = await rebuildSearchDb();
console.error(`✓ vault index rebuilt — ${entries.length} entries${ftsOk ? ' (+ fts)' : ''}`);
