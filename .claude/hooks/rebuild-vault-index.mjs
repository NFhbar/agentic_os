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

// ---------------------------------------------------------------------------
// Declarative frontmatter lifts (Finding 4.3). Adding a manifest field is ONE
// row here — not a hand-written coercion in this hook plus a types edit plus
// per-consumer plumbing. Identity fields with multi-source fallbacks (title,
// tags, private, …) and computed fields (recommended_changes_count, snippet,
// backlinks) stay hand-written in the entry builder below.
//
// Cluster notes (why each group is lifted):
// - kind further classifies `type: entity` entries (repo, person, service…)
//   so consumers can filter without parsing each .md file.
// - project / repo / parent_change / change_id are structural relationships
//   for graph queries; `backlinks` still captures body [[wikilinks]].
// - status / review_status / pr_* / ci_* / merged_at: change-lifecycle fields
//   for the brief, status reports, change triage, and pr-ci-monitor.
// - plan_* + reviewed_at / review_path: the plan cluster written by
//   dev-revise-plan (changes) and the project-orchestration skills; the
//   review names follow standard-review-state.
// - derived_from_report / recommendation_index: research attribution on
//   scaffolded changes (step indicator, report backlink, drift audit).
// - report_* / materials_path / last_data_ingest / update_count:
//   research-report lifecycle for the Research view.
// - audit_status / validation_result: Overseer-arc fields so scheduler
//   preconditions can gate on them.
const LIFTED_FIELDS = [
  { name: 'kind', type: 'string' },
  { name: 'project', type: 'string' },
  { name: 'repo', type: 'string' },
  { name: 'parent_change', type: 'string' },
  { name: 'change_id', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'review_status', type: 'string' },
  { name: 'pr_url', type: 'string' },
  { name: 'ci_state', type: 'string' },
  { name: 'ci_completed_at', type: 'string' },
  { name: 'merged_at', type: 'string' },
  { name: 'pr_review_status', type: 'string' },
  { name: 'pr_review_path', type: 'string' },
  { name: 'pr_review_passes', type: 'int' },
  { name: 'pr_reviewed_at', type: 'string' },
  { name: 'pr_ready_at', type: 'string' },
  { name: 'plan_status', type: 'string' },
  { name: 'plan_path', type: 'string' },
  { name: 'reviewed_at', type: 'string' },
  { name: 'review_path', type: 'string' },
  { name: 'plan_revision', type: 'int' },
  { name: 'plan_revised_at', type: 'string' },
  { name: 'plan_revised_from_review', type: 'string' },
  { name: 'derived_from_report', type: 'string' },
  { name: 'recommendation_index', type: 'int' },
  { name: 'report_generated_at', type: 'string' },
  { name: 'report_revision', type: 'int' },
  { name: 'report_revised_at', type: 'string' },
  { name: 'report_revised_from_review', type: 'string' },
  { name: 'materials_path', type: 'string' },
  { name: 'last_data_ingest', type: 'string' },
  { name: 'update_count', type: 'int' },
  { name: 'audit_status', type: 'string' },
  { name: 'validation_result', type: 'string' },
];

// `int` tolerates digit-strings for entries written before the shared
// js-yaml parser (quoted numbers) — same coercion the hand-written lifts had.
function liftValue(raw, type) {
  if (type === 'string') return typeof raw === 'string' ? raw : null;
  if (type === 'int') {
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
    return null;
  }
  return null;
}

function liftFields(fm) {
  const out = {};
  for (const { name, type } of LIFTED_FIELDS) out[name] = liftValue(fm[name], type);
  return out;
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
    domain: fm.domain ?? null,
    title: fm.title ?? fm.name ?? null,
    created: fm.created ?? null,
    updated: fm.updated ?? null,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    source: fm.source ?? null,
    private: fm.private === true,
    // Declarative scalar lifts — see LIFTED_FIELDS above.
    ...liftFields(fm),
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
