#!/usr/bin/env node
// OS compliance audit. Read-only diagnostic that walks the repo and checks
// every primitive against its documented standard (vault/wiki/_seed/meta/reference/standard-*.md).
//
// Usage:
//   node scripts/audit.mjs                 (run all checks, plain text)
//   node scripts/audit.mjs --json          (emit machine-readable JSON)
//   node scripts/audit.mjs --skills        (skills only)
//   node scripts/audit.mjs --wiki          (wiki entries only)
//   node scripts/audit.mjs --domains       (domains/playbooks only)
//   node scripts/audit.mjs --templates     (archetypes/templates only)
//   node scripts/audit.mjs --router        (OS.md vocab only)
//   node scripts/audit.mjs --logs          (vault/raw/*.jsonl validity only)
//   node scripts/audit.mjs --dispatch      (claude spawn-site discipline only)
//
// Exit code: 0 if no ERRORs, 1 if any ERROR-severity findings.
// Pure node — no npm deps, runnable from a fresh clone.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { EXPECTED_COLUMNS as EVENTS_DB_EXPECTED_COLUMNS } from './events-db-init.mjs';
import {
  CHANGE_SCOPED_SKILLS,
  PROJECT_SCOPED_SKILLS,
  REPORT_SCOPED_SKILLS,
} from './extract-event-attribution.mjs';
import { parseFrontmatter as sharedParseFrontmatter } from './frontmatter.mjs';
import {
  SKILL_IDS_MODULE_REL,
  buildSkillIdsSource,
  extractSkillLikeLiterals,
  listSkillIds,
} from './generate-skill-ids.mjs';
import { missingTargetPaths } from './tuning-targets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

// ---------------------------------------------------------------------------
// Frontmatter parser (flat, sufficient for what we audit).
// ---------------------------------------------------------------------------

// Adapter over the shared real-YAML parser (scripts/frontmatter.mjs).
// Audit semantics preserved: fm === null means "no frontmatter fence at
// all" (drives skill-frontmatter-missing); fm === {} with parseError set
// means "fence present, YAML broken". Note the skill-frontmatter-parse-error
// check was wired for parseError all along, but the old flat parser never
// reported one — it's live for the first time.
function parseFrontmatter(content) {
  const r = sharedParseFrontmatter(content);
  return {
    fm: r.hasFrontmatter ? r.fm : null,
    body: r.body,
    raw: r.raw,
    parseError: r.parseError,
  };
}

function walkMd(dir) {
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
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Domain registry — derived from filesystem
// ---------------------------------------------------------------------------

function discoverDomains() {
  const out = new Set();
  const root = join(REPO_ROOT, 'domains');
  for (const top of listDirs(root)) {
    out.add(top);
    for (const sub of listDirs(join(root, top))) {
      // Sub-domain only counts if it has its own playbook.md
      if (existsSync(join(root, top, sub, 'playbook.md'))) {
        out.add(`${top}/${sub}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archetype registry — derived from _templates/wiki-entry/ AND reference entries
// ---------------------------------------------------------------------------

function discoverArchetypes() {
  // From templates: every *.md.tmpl in _templates/wiki-entry/
  const templates = new Set();
  const tmplDir = join(REPO_ROOT, '_templates', 'wiki-entry');
  for (const f of listFiles(tmplDir)) {
    if (f.endsWith('.md.tmpl')) templates.add(f.replace(/\.md\.tmpl$/, ''));
  }
  // From references: every archetype-*.md in vault/wiki/_seed/meta/reference/
  const refs = new Set();
  const refDir = join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'reference');
  for (const f of listFiles(refDir)) {
    const m = f.match(/^archetype-(.+)\.md$/);
    if (m) refs.add(m[1]);
  }
  return { templates, refs, union: new Set([...templates, ...refs]) };
}

// ---------------------------------------------------------------------------
// Cron validator (mirrors scheduler-tick.mjs, simplified to "does it parse").
// ---------------------------------------------------------------------------

function isValidCron(expr) {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    const [min, max] = ranges[i];
    for (const part of fields[i].split(',')) {
      const [range, stepStr] = part.split('/');
      if (stepStr && Number.isNaN(parseInt(stepStr, 10))) return false;
      if (range === '*') continue;
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        if (Number.isNaN(a) || Number.isNaN(b) || a < min || b > max || a > b) return false;
      } else {
        const n = parseInt(range, 10);
        if (Number.isNaN(n) || n < min || n > max) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// CHECKS — each returns Array<Finding>
// Finding shape: { id, severity, message, path?, hint? }
// ---------------------------------------------------------------------------

const REQUIRED_SKILL_FIELDS = ['name', 'description', 'user-invocable', 'version', 'domain'];
const REQUIRED_WIKI_FIELDS = ['id', 'type', 'domain', 'created', 'updated', 'tags', 'source', 'private'];
const REQUIRED_PLAYBOOK_FIELDS = ['domain', 'version', 'created', 'updated'];

// Wikilink targets that are intentionally placeholders inside documentation
// examples (typically appear in code fences but might leak into prose).
const PLACEHOLDER_WIKILINK_IDS = new Set([
  'entity-id',
  'other-entity-id',
  'other-entry-id',
  'entry-id',
  'wikilink',
  'wikilinks',
]);

// Scan a markdown body for [[wikilinks]] and report any whose target is not
// in `knownTargets`. Strips code fences and inline code first so example
// wikilinks inside ``` blocks don't get flagged.
function findDanglingWikilinks(body, relPath, knownTargets) {
  const findings = [];
  const stripped = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '');
  for (const match of stripped.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1].trim();
    if (target.includes('<') || target.includes('>')) continue; // placeholder
    if (PLACEHOLDER_WIKILINK_IDS.has(target)) continue;
    if (!knownTargets.has(target)) {
      findings.push({
        id: 'wiki-link-dangling',
        severity: 'warn',
        path: relPath,
        message: `Dangling wikilink: [[${target}]] — no wiki entry or skill has that id`,
      });
    }
  }
  return findings;
}

// Names of all installed skills (each is a directory under .claude/skills/
// with a SKILL.md inside). Used to validate wikilink targets that point at
// skills, and to register skill names as valid link targets.
function discoverSkillNames() {
  const out = new Set();
  const skillsDir = join(REPO_ROOT, '.claude', 'skills');
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md'))) {
      out.add(e.name);
    }
  }
  return out;
}

function checkSkills(domains, knownTargets) {
  const findings = [];
  const skillsDir = join(REPO_ROOT, '.claude', 'skills');
  const entries = readdirSync(skillsDir, { withFileTypes: true });

  // Flat skill files (.md directly under .claude/skills/) are forbidden per
  // decision-subdir-skills.
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      findings.push({
        id: 'skill-no-flat-files',
        severity: 'error',
        path: relative(REPO_ROOT, join(skillsDir, e.name)),
        message: `Flat skill file found — skills must be at .claude/skills/<name>/SKILL.md (decision-subdir-skills)`,
        hint: `Move to .claude/skills/${e.name.replace(/\.md$/, '')}/SKILL.md`,
      });
    }
  }

  // Per-skill checks
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillName = e.name;
    const skillPath = join(skillsDir, skillName, 'SKILL.md');
    const relPath = relative(REPO_ROOT, skillPath);

    if (!existsSync(skillPath)) {
      findings.push({
        id: 'skill-subdir-layout',
        severity: 'error',
        path: relative(REPO_ROOT, join(skillsDir, skillName)),
        message: `Skill directory missing SKILL.md`,
        hint: `Expected ${relPath}`,
      });
      continue;
    }

    const content = readFileSync(skillPath, 'utf8');
    const { fm, parseError } = parseFrontmatter(content);
    if (!fm) {
      findings.push({
        id: 'skill-frontmatter-missing',
        severity: 'error',
        path: relPath,
        message: 'No frontmatter block (--- ... ---) found',
      });
      continue;
    }

    // Required fields
    for (const f of REQUIRED_SKILL_FIELDS) {
      if (fm[f] === undefined || fm[f] === '') {
        findings.push({
          id: 'skill-frontmatter-required',
          severity: 'error',
          path: relPath,
          message: `Missing required frontmatter field: ${f}`,
          hint: `See standard-skill-format`,
        });
      }
    }

    // name == directory name
    if (fm.name !== undefined && fm.name !== skillName) {
      findings.push({
        id: 'skill-name-matches-dir',
        severity: 'error',
        path: relPath,
        message: `Frontmatter name "${fm.name}" does not match directory "${skillName}"`,
      });
    }

    // user-invocable must be boolean true (not the string "true")
    if (fm['user-invocable'] !== undefined && fm['user-invocable'] !== true) {
      findings.push({
        id: 'skill-user-invocable-bool',
        severity: 'warn',
        path: relPath,
        message: `user-invocable should be boolean true (got: ${JSON.stringify(fm['user-invocable'])})`,
      });
    }

    // domain must match an existing domain folder (top-level domain segment)
    if (fm.domain && !domains.has(fm.domain) && !domains.has(fm.domain.split('/')[0])) {
      findings.push({
        id: 'skill-domain-exists',
        severity: 'error',
        path: relPath,
        message: `Skill claims domain "${fm.domain}" but no matching folder under domains/`,
      });
    }

    // YAML hygiene: an UNquoted value that contains `: ` (colon-space) will
    // confuse js-yaml — it tries to parse a nested mapping. Common offenders
    // are `description:` lines with inline-code like `type: project`. This
    // check fires on the raw frontmatter text (regex-only) since the audit's
    // own flat parser silently tolerates the issue. js-yaml (used by the
    // dashboard backend) does not — and the broken skill stops appearing in
    // the dashboard's scaffolders.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fmText = fmMatch[1];
      const lines = fmText.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        // YAML key: <value> where <value> starts unquoted AND contains ": "
        // somewhere within. Catches BOTH top-level keys (no leading whitespace)
        // AND indented keys — both forms can confuse js-yaml into trying to
        // parse a nested mapping. Skips: empty/comment lines, lines whose
        // value starts with a quote, lines whose value is empty (block scalar
        // / nested mapping start).
        const m = line.match(/^(\s*)([a-zA-Z_][\w-]*):\s+([^'"\n][^\n]*)$/);
        if (!m) continue;
        const value = m[3];
        if (value.includes(': ')) {
          findings.push({
            id: 'skill-frontmatter-unquoted-colon',
            severity: 'warn',
            path: `${relPath}:${li + 2}`, // +2: 1 for the opening --- line, 1 for 1-based
            message: `Unquoted YAML value contains ": " — js-yaml will try to parse a nested mapping and fail. Wrap the value in single or double quotes.`,
            hint: `Example: description: "Project id (slug). Must match an existing \`type: project\` entry."`,
          });
        }
      }
    }

    // Also fire on any skill whose frontmatter fails to parse at all — covers
    // edge cases the per-line scan misses (multi-line YAML, anchor refs, etc.).
    // The dashboard's API ignores domain/description/etc. when parseError is
    // set, so an unparseable skill silently loses metadata — worth catching.
    if (parseError) {
      findings.push({
        id: 'skill-frontmatter-parse-error',
        severity: 'error',
        path: relPath,
        message: `Skill frontmatter failed to parse: ${parseError}`,
        hint: `The dashboard treats this skill as having no domain/description/etc. — fix the YAML to restore visibility.`,
      });
    }

    // Wikilinks in SKILL.md body — target must be either a wiki entry id
    // or a known skill name (resolved polymorphically by EditableMarkdown).
    if (knownTargets) {
      const m = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      const body = m ? m[1] : content;
      findings.push(...findDanglingWikilinks(body, relPath, knownTargets));
    }
  }

  return findings;
}

function checkWiki(domains, archetypes, knownTargets) {
  const findings = [];
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = walkMd(wikiDir);

  const parsed = files.map((p) => {
    const content = readFileSync(p, 'utf8');
    const result = parseFrontmatter(content);
    return { path: p, ...result };
  });

  // Indexes used by cross-entry checks below.
  const repoEntities = new Set();
  const projectIds = new Set();
  // project-id → newest `updated` timestamp (ms) across the project entry
  // itself + every entry owning it via `project:` frontmatter. Used by the
  // stale-project check.
  const projectActivityMs = new Map();
  for (const { fm } of parsed) {
    if (!fm || !fm.id) continue;
    if (fm.type === 'entity' && fm.kind === 'repo') repoEntities.add(fm.id);
    if (fm.type === 'project') projectIds.add(fm.id);
    const updatedMs = typeof fm.updated === 'string' ? Date.parse(fm.updated) : NaN;
    if (Number.isNaN(updatedMs)) continue;
    // Project's own activity
    if (fm.type === 'project') {
      const prev = projectActivityMs.get(fm.id) ?? 0;
      projectActivityMs.set(fm.id, Math.max(prev, updatedMs));
    }
    // Owned entry contributes to its owning project's activity
    if (typeof fm.project === 'string') {
      const prev = projectActivityMs.get(fm.project) ?? 0;
      projectActivityMs.set(fm.project, Math.max(prev, updatedMs));
    }
  }

  const PROJECT_STATUS_VALUES = new Set(['active', 'paused', 'completed', 'cancelled']);
  const PROJECT_LIFECYCLE_VALUES = new Set([
    'planning',
    'active',
    'review',
    'shipped',
    'archived',
  ]);
  const PROJECT_REPORTING_TARGETS = new Set([
    'clipboard',
    'notion',
    'linear',
    'slack',
    'none',
  ]);
  const CHANGE_STATUS_VALUES = new Set([
    'planning',
    'in-progress',
    'in-review',
    'merged',
    'abandoned',
  ]);
  const CHANGE_SIZE_VALUES = new Set(['xs', 'small', 'medium', 'large']);
  const CHANGE_REVIEW_STATUS_VALUES = new Set([
    'pending',
    'approved',
    'request-changes',
    'rejected',
    'overridden',
    'not-required',
  ]);

  for (const { path: p, fm, body, raw } of parsed) {
    const relPath = relative(REPO_ROOT, p);

    if (!fm) {
      findings.push({
        id: 'wiki-frontmatter-missing',
        severity: 'error',
        path: relPath,
        message: 'Wiki entry has no frontmatter block',
      });
      continue;
    }

    // Required shared fields
    for (const f of REQUIRED_WIKI_FIELDS) {
      if (fm[f] === undefined) {
        findings.push({
          id: 'wiki-frontmatter-required',
          severity: 'error',
          path: relPath,
          message: `Missing required shared frontmatter field: ${f}`,
          hint: `See standard-wiki-format`,
        });
      }
    }

    // Telemetry promoted to wiki (Finding 5.2). A note sourced from a .jsonl
    // telemetry log AND carrying a date-bucketed id is an event restatement,
    // not knowledge — events.db / vault/raw already hold the data. Both
    // conditions required: analysis notes legitimately cite a .jsonl source
    // (pr-ci-monitor-skip-pattern), and dated ids are fine when the content
    // is a journal, not telemetry (os-iteration-*).
    if (
      fm.type === 'note' &&
      typeof fm.source === 'string' &&
      fm.source.endsWith('.jsonl') &&
      typeof fm.id === 'string' &&
      /\d{4}-\d{2}-\d{2}/.test(fm.id)
    ) {
      findings.push({
        id: 'note-run-telemetry',
        severity: 'warn',
        path: relPath,
        message: `Date-bucketed run-log note sourced from telemetry (${fm.source}) — telemetry stays out of the wiki (OS.md layer contract)`,
        hint: `Fold durable observations into a pattern/retrospective note (no date-bucketed id) and delete this entry — the data of record lives in events.db + ${fm.source}. See meta-curate § telemetry rule.`,
      });
    }

    // id must match filename slug
    const filenameSlug = p.split('/').pop().replace(/\.md$/, '');
    if (fm.id && fm.id !== filenameSlug) {
      findings.push({
        id: 'wiki-id-matches-filename',
        severity: 'error',
        path: relPath,
        message: `Frontmatter id "${fm.id}" does not match filename slug "${filenameSlug}"`,
      });
    }

    // type must be in archetype registry
    if (fm.type && !archetypes.union.has(fm.type)) {
      findings.push({
        id: 'wiki-type-registered',
        severity: 'error',
        path: relPath,
        message: `Unknown archetype type: "${fm.type}"`,
        hint: `Known: ${[...archetypes.union].join(', ')}`,
      });
    }

    // domain must match a known domain (top segment OK for sub-domains)
    if (fm.domain && !domains.has(fm.domain) && !domains.has(fm.domain.split('/')[0])) {
      findings.push({
        id: 'wiki-domain-exists',
        severity: 'error',
        path: relPath,
        message: `Wiki entry claims domain "${fm.domain}" but no matching folder under domains/`,
      });
    }

    // Schedule cron validity (runbook with schedule field)
    if (fm.type === 'runbook' && fm.schedule) {
      if (!isValidCron(fm.schedule)) {
        findings.push({
          id: 'schedule-valid-cron',
          severity: 'error',
          path: relPath,
          message: `Invalid 5-field cron expression: "${fm.schedule}"`,
        });
      }
      // If schedule is set, prompt must also be set
      if (!fm.prompt) {
        findings.push({
          id: 'schedule-prompt-required',
          severity: 'error',
          path: relPath,
          message: `Runbook has schedule but no prompt — scheduler would have nothing to fire`,
        });
      }
    }

    // Any entry can carry `project: <id>` as a shared optional field
    // (ownership claim). Verify the project exists. This subsumes the
    // older schedule-project-exists check — for runbooks, this catches the
    // same case (project field present on a scheduled runbook).
    if (fm.project && fm.type !== 'project' && !projectIds.has(fm.project)) {
      findings.push({
        id: 'entry-project-exists',
        severity: 'error',
        path: relPath,
        message: `Entry references project "${fm.project}" but no project entity has that id`,
        hint: `Create the project via /os add-project, or remove the project: field`,
      });
    }

    // Project archetype checks
    if (fm.type === 'project') {
      if (fm.status && !PROJECT_STATUS_VALUES.has(fm.status)) {
        findings.push({
          id: 'project-status-enum',
          severity: 'error',
          path: relPath,
          message: `Invalid status "${fm.status}" — must be one of: ${[...PROJECT_STATUS_VALUES].join(', ')}`,
        });
      }
      if (fm.lifecycle_stage && !PROJECT_LIFECYCLE_VALUES.has(fm.lifecycle_stage)) {
        findings.push({
          id: 'project-lifecycle-stage-enum',
          severity: 'warn',
          path: relPath,
          message: `Invalid lifecycle_stage "${fm.lifecycle_stage}" — must be one of: ${[...PROJECT_LIFECYCLE_VALUES].join(', ')}`,
        });
      }
      if (Array.isArray(fm.repos)) {
        for (const repoId of fm.repos) {
          if (typeof repoId !== 'string') continue;
          if (!repoEntities.has(repoId)) {
            findings.push({
              id: 'project-repos-exist',
              severity: 'error',
              path: relPath,
              message: `Project references repo "${repoId}" but no entity with kind: repo has that id`,
              hint: `Ingest the repo via /os ingest repo, or remove the id from repos:`,
            });
          }
        }
      }
      if (fm.deadline && fm.status === 'active') {
        const deadlineMs = Date.parse(fm.deadline);
        if (!Number.isNaN(deadlineMs) && deadlineMs < Date.now()) {
          findings.push({
            id: 'project-deadline-overdue',
            severity: 'info',
            path: relPath,
            message: `Project deadline ${fm.deadline} is in the past but status is "active"`,
            hint: `Update status, push the deadline, or close out the milestones`,
          });
        }
      }
      // Stale check: status=active but nothing under this project has been
      // updated in >30 days. Could mean the project is forgotten or finished
      // without being closed out.
      if (fm.status === 'active' && fm.id) {
        const lastActivityMs = projectActivityMs.get(fm.id) ?? 0;
        const ageDays = (Date.now() - lastActivityMs) / 86400000;
        if (lastActivityMs > 0 && ageDays > 30) {
          findings.push({
            id: 'project-stale',
            severity: 'info',
            path: relPath,
            message: `Active project hasn't been updated in ${Math.floor(ageDays)} days (counting both the project entry and any owned entries)`,
            // `dedupe_key: ''` — path is unique per project; day-count in
            // message drifts daily and would break dismissal match (#424).
            dedupe_key: '',
            hint: `If still active, capture progress as an owned note. If stalled, set status: paused. If done, set status: completed.`,
          });
        }
      }
      // Reporting target_ref consistency
      if (fm.reporting && typeof fm.reporting === 'object') {
        const target = fm.reporting.target;
        const targetRef = fm.reporting.target_ref;
        if (target && !PROJECT_REPORTING_TARGETS.has(target)) {
          findings.push({
            id: 'project-reporting-target-enum',
            severity: 'error',
            path: relPath,
            message: `Invalid reporting.target "${target}" — must be one of: ${[...PROJECT_REPORTING_TARGETS].join(', ')}`,
          });
        }
        if (target && target !== 'clipboard' && target !== 'none' && !targetRef) {
          findings.push({
            id: 'project-reporting-target-ref',
            severity: 'error',
            path: relPath,
            message: `reporting.target is "${target}" but target_ref is empty — platform integrations need a destination id`,
          });
        }
      }
    }

    // Change archetype checks
    if (fm.type === 'change') {
      if (fm.status && !CHANGE_STATUS_VALUES.has(fm.status)) {
        findings.push({
          id: 'change-status-enum',
          severity: 'error',
          path: relPath,
          message: `Invalid status "${fm.status}" — must be one of: ${[...CHANGE_STATUS_VALUES].join(', ')}`,
        });
      }
      // repo is REQUIRED on change (unlike project where it's optional)
      if (!fm.repo) {
        findings.push({
          id: 'change-repo-required',
          severity: 'error',
          path: relPath,
          message: `Change is missing required field: repo`,
          hint: `Every change must target an ingested repo (kind: repo entity)`,
        });
      } else if (!repoEntities.has(fm.repo)) {
        findings.push({
          id: 'change-repo-exists',
          severity: 'error',
          path: relPath,
          message: `Change references repo "${fm.repo}" but no entity with kind: repo has that id`,
          hint: `Ingest the repo via /os ingest repo, or fix the repo: field`,
        });
      }
      if (fm.size && !CHANGE_SIZE_VALUES.has(fm.size)) {
        findings.push({
          id: 'change-size-enum',
          severity: 'warn',
          path: relPath,
          message: `Invalid size "${fm.size}" — must be one of: ${[...CHANGE_SIZE_VALUES].join(', ')}`,
        });
      }
      if (fm.pr_url && typeof fm.pr_url === 'string') {
        // Loose URL check: must start with http(s):// and contain a path
        if (!/^https?:\/\/[^\s]+/.test(fm.pr_url)) {
          findings.push({
            id: 'change-pr-url-format',
            severity: 'warn',
            path: relPath,
            message: `pr_url "${fm.pr_url}" doesn't look like an HTTP(S) URL`,
          });
        }
      }
      if (fm.review_status && !CHANGE_REVIEW_STATUS_VALUES.has(fm.review_status)) {
        findings.push({
          id: 'change-review-status-enum',
          severity: 'error',
          path: relPath,
          message: `Invalid review_status "${fm.review_status}" — must be one of: ${[...CHANGE_REVIEW_STATUS_VALUES].join(', ')}`,
        });
      }
      // Detect stale-template content: when a model writes a change file from
      // memory instead of reading the current template, lines like
      //   size: small                               # small | medium | large
      // sneak through (the parser's inline-comment strip clears the value for
      // enum validation, but the on-disk file is still polluted). The current
      // template carries no inline comments on active values, so any such
      // hint is provably stale.
      if (raw) {
        const STALE_HINT_FIELDS = ['size', 'review_required', 'review_status'];
        const polluted = [];
        for (const line of raw.split('\n')) {
          const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*[^#\s]\S*\s+#/);
          if (m && STALE_HINT_FIELDS.includes(m[1])) polluted.push(m[1]);
        }
        if (polluted.length > 0) {
          findings.push({
            id: 'change-frontmatter-stale-comments',
            severity: 'warn',
            path: relPath,
            message: `Frontmatter has inline comments on active value(s) (${polluted.join(', ')}) — the current template carries no such hints, so the writer likely composed from memory instead of reading _templates/wiki-entry/change.md.tmpl.`,
            hint: `Edit the affected line(s) to strip the trailing \` # …\`. The parser tolerates this for enum validation, but the artifact stays polluted until cleaned.`,
          });
        }
      }
      // Body completeness — flag planning-state changes that still contain
      // unreviewed body content from the scaffolder. Two failure modes:
      //   1. Template placeholder text (skill never drafted, human never filled)
      //   2. DRAFT markers (skill auto-drafted but human hasn't accepted)
      // The dev-write-change PLAN phase rejects both too; catching here
      // surfaces them at audit time as well.
      if (fm.status === 'planning' && body) {
        const lower = body.toLowerCase();
        const placeholders = [
          "what's broken / what's missing / what we're improving",
          'how you plan to do it. touched files, key functions, test strategy',
        ];
        const placeholdersPresent = placeholders.filter((p) => lower.includes(p));
        const draftMarkerCount = (body.match(/\*\*DRAFT\*\*/g) || []).length;
        if (placeholdersPresent.length > 0 || draftMarkerCount > 0) {
          const parts = [];
          if (placeholdersPresent.length > 0) {
            parts.push(`${placeholdersPresent.length} template placeholder line(s)`);
          }
          if (draftMarkerCount > 0) {
            parts.push(`${draftMarkerCount} unreviewed DRAFT marker(s)`);
          }
          findings.push({
            id: 'change-body-template-placeholder',
            severity: 'warn',
            path: relPath,
            message: `Change body has unreviewed content — found ${parts.join(' + ')}. Fill in / accept before invoking dev-write-change.`,
            hint: `Edit the change file: remove DRAFT blockquote lines (\`> **DRAFT** — …\`) and/or replace template placeholders. See standard-change-workflow's "Where the description lives" section.`,
          });
        }
      }
    }

    // last_verified staleness for reference entries
    if (fm.type === 'reference' && fm.last_verified) {
      const verifiedDate = Date.parse(fm.last_verified);
      if (!Number.isNaN(verifiedDate)) {
        const ageDays = (Date.now() - verifiedDate) / 86400000;
        if (ageDays > 90) {
          findings.push({
            id: 'reference-stale-verified',
            severity: 'info',
            path: relPath,
            message: `last_verified is ${Math.floor(ageDays)} days old (>90)`,
            // Path is unique per entry; day-count drifts daily (#424).
            dedupe_key: '',
            hint: `Re-verify and bump last_verified, or accept as historical`,
          });
        }
      }
    }

    // Dangling wikilinks — target must resolve to a wiki entry id OR a
    // skill name. Code fences/inline code stripped before scanning so
    // example wikilinks in documentation don't get flagged.
    findings.push(...findDanglingWikilinks(body, relPath, knownTargets));
  }

  return findings;
}

function checkDomains() {
  const findings = [];
  const root = join(REPO_ROOT, 'domains');
  for (const top of listDirs(root)) {
    const dirs = [top, ...listDirs(join(root, top)).map((s) => `${top}/${s}`)];
    for (const d of dirs) {
      const playbookPath = join(root, d, 'playbook.md');
      const subDir = join(root, d);
      // Only require playbook if the dir contains other files (not just sub-domains)
      const looksLikeDomain =
        listFiles(subDir).length > 0 ||
        existsSync(playbookPath) ||
        d.includes('/');
      if (!looksLikeDomain) continue;

      const relPath = relative(REPO_ROOT, playbookPath);
      if (!existsSync(playbookPath)) {
        // Top-level dir without playbook AND without sub-domains with playbooks is suspicious
        if (!d.includes('/')) {
          findings.push({
            id: 'domain-playbook-required',
            severity: 'error',
            path: relative(REPO_ROOT, subDir),
            message: `Domain folder has no playbook.md`,
          });
        }
        continue;
      }
      const content = readFileSync(playbookPath, 'utf8');
      const { fm } = parseFrontmatter(content);
      if (!fm) {
        findings.push({
          id: 'domain-playbook-frontmatter-missing',
          severity: 'error',
          path: relPath,
          message: `Playbook has no frontmatter`,
        });
        continue;
      }
      for (const f of REQUIRED_PLAYBOOK_FIELDS) {
        if (fm[f] === undefined) {
          findings.push({
            id: 'domain-playbook-frontmatter-required',
            severity: 'error',
            path: relPath,
            message: `Playbook missing required field: ${f}`,
          });
        }
      }
    }
  }
  return findings;
}

function checkTemplates(archetypes) {
  const findings = [];
  // Every archetype should have BOTH a template and a reference entry
  for (const a of archetypes.union) {
    if (!archetypes.templates.has(a)) {
      findings.push({
        id: 'archetype-template-required',
        severity: 'error',
        message: `Archetype "${a}" has a reference entry but no _templates/wiki-entry/${a}.md.tmpl`,
      });
    }
    if (!archetypes.refs.has(a)) {
      findings.push({
        id: 'archetype-reference-required',
        severity: 'error',
        message: `Template for archetype "${a}" exists but no vault/wiki/_seed/meta/reference/archetype-${a}.md`,
      });
    }
  }
  return findings;
}

function checkRouter() {
  const findings = [];
  const osMdPath = join(REPO_ROOT, 'OS.md');
  if (!existsSync(osMdPath)) {
    findings.push({
      id: 'router-os-md-missing',
      severity: 'error',
      message: `OS.md missing at repo root`,
    });
    return findings;
  }
  const content = readFileSync(osMdPath, 'utf8');
  // Find Intent vocabulary heading, then parse the next markdown table
  const lines = content.split('\n');
  let i = lines.findIndex((l) => /^#{2,4}\s+Intent vocabulary/i.test(l));
  if (i < 0) {
    findings.push({
      id: 'router-vocab-missing',
      severity: 'warn',
      message: `OS.md has no "Intent vocabulary" section`,
    });
    return findings;
  }
  while (i < lines.length && !lines[i].trim().startsWith('|')) i++;
  i += 2; // skip header + separator
  const skillsDir = join(REPO_ROOT, '.claude', 'skills');

  // Collect skills referenced from the vocab table — used both for the
  // forward check below AND for the reverse check (vocab coverage).
  const skillsInVocab = new Set();
  // phrase → set of skills it routes to. A phrase on two rows makes
  // `/os <phrase>` ambiguous — the router's "prefer the most specific" rule
  // has no answer for an exact tie, and the miss-rate metric can't see it
  // (ambiguous hits aren't misses).
  const phraseToSkills = new Map();

  while (i < lines.length && lines[i].trim().startsWith('|')) {
    const cells = lines[i].trim().split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length >= 2) {
      const skillMatch = cells[1].match(/`([^`]+)`/);
      if (skillMatch) {
        const skill = skillMatch[1];
        skillsInVocab.add(skill);
        for (const m of cells[0].matchAll(/`([^`]+)`/g)) {
          const phrase = m[1];
          if (!phraseToSkills.has(phrase)) phraseToSkills.set(phrase, new Set());
          phraseToSkills.get(phrase).add(skill);
        }
        if (!existsSync(join(skillsDir, skill, 'SKILL.md'))) {
          findings.push({
            id: 'router-vocab-skill-exists',
            severity: 'error',
            path: 'OS.md',
            message: `Intent vocabulary maps to non-existent skill: ${skill}`,
            hint: `Add the skill or remove the row`,
          });
        }
      }
    }
    i++;
  }

  for (const [phrase, skills] of phraseToSkills) {
    if (skills.size > 1) {
      findings.push({
        id: 'router-vocab-duplicate-phrase',
        severity: 'error',
        path: 'OS.md',
        message: `Intent phrase "${phrase}" maps to ${skills.size} skills (${[...skills].join(', ')}) — /os dispatch is ambiguous`,
        hint: 'Keep the phrase on exactly one row; make the other rows more specific',
      });
    }
  }

  // Reverse check: every user-invocable skill should appear in the vocab
  // table. Skills missing from vocab still work via direct invocation
  // (/<skill-name>), but `/os <intent>` won't route to them — a common
  // drift after adding a skill but forgetting to update OS.md.
  let skillDirEntries;
  try {
    skillDirEntries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return findings;
  }
  // The `os` skill IS the router — it's invoked as the `/os` slash command
  // and dispatches FROM the vocab table, not TO an entry in it. Exempting
  // it prevents an infinite-recursion-flavored false positive.
  const VOCAB_EXEMPT = new Set(['os']);

  for (const e of skillDirEntries) {
    if (!e.isDirectory()) continue;
    const skillName = e.name;
    if (VOCAB_EXEMPT.has(skillName)) continue;
    const skillPath = join(skillsDir, skillName, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    try {
      const { fm } = parseFrontmatter(readFileSync(skillPath, 'utf8'));
      if (!fm || fm['user-invocable'] !== true) continue;
      if (!skillsInVocab.has(skillName)) {
        findings.push({
          id: 'router-vocab-skill-uncovered',
          severity: 'warn',
          path: 'OS.md',
          message: `User-invocable skill "${skillName}" is not in OS.md's intent vocabulary — /os intent can't route to it`,
          hint: `Add a row to OS.md's Intent vocabulary table mapping common phrasings to ${skillName}`,
        });
      }
    } catch {
      /* skill frontmatter unreadable — covered by skill-frontmatter checks */
    }
  }
  return findings;
}

function checkPlaybookSkillCoverage(domains) {
  const findings = [];
  const skillsDir = join(REPO_ROOT, '.claude', 'skills');
  // Build skill → domain map
  const skillDomain = new Map();
  for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(skillsDir, e.name, 'SKILL.md');
    if (!existsSync(p)) continue;
    const { fm } = parseFrontmatter(readFileSync(p, 'utf8'));
    if (fm?.domain) skillDomain.set(e.name, fm.domain);
  }

  // For each domain playbook, extract Skills section and compare
  for (const d of domains) {
    const pb = join(REPO_ROOT, 'domains', d, 'playbook.md');
    if (!existsSync(pb)) continue;
    const content = readFileSync(pb, 'utf8');
    // Find "## Skills" section — stop at the next H2/H3 OR a "Planned"
    // sub-heading/paragraph so aspirational entries don't get flagged.
    const skillsSection = content.match(/^##\s+Skills\s*\n([\s\S]*?)(?=^##\s|^###\s|^Planned\b|\Z)/m);
    if (!skillsSection) continue;
    const listed = new Set(
      [...skillsSection[1].matchAll(/^[-*]\s+`([^`]+)`/gm)].map((m) => m[1]),
    );
    const expected = new Set(
      [...skillDomain.entries()].filter(([_, dom]) => dom === d).map(([s]) => s),
    );
    for (const skill of expected) {
      if (!listed.has(skill)) {
        findings.push({
          id: 'playbook-skill-coverage',
          severity: 'warn',
          path: relative(REPO_ROOT, pb),
          message: `Skill "${skill}" claims domain "${d}" but isn't listed in playbook's Skills section`,
        });
      }
    }
    for (const skill of listed) {
      if (!existsSync(join(skillsDir, skill, 'SKILL.md'))) {
        findings.push({
          id: 'playbook-skill-exists',
          severity: 'warn',
          path: relative(REPO_ROOT, pb),
          message: `Playbook lists skill "${skill}" but .claude/skills/${skill}/SKILL.md does not exist`,
        });
      }
    }
  }
  return findings;
}

function checkLogs() {
  const findings = [];
  const rawDir = join(REPO_ROOT, 'vault', 'raw');
  let entries;
  try {
    entries = readdirSync(rawDir);
  } catch {
    return findings;
  }

  // Load the log-formats standard for the documentation check below. If the
  // standard is missing we skip the docs check (an audit on a partial OS
  // shouldn't complain about its own missing standards).
  const standardPath = join(
    REPO_ROOT,
    'vault',
    'wiki',
    '_seed',
    'meta',
    'reference',
    'standard-log-formats.md',
  );
  let standardContent = '';
  try {
    standardContent = readFileSync(standardPath, 'utf8');
  } catch {
    /* missing — skip docs check */
  }

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(rawDir, name);
    const relPath = relative(REPO_ROOT, p);

    // 1. Validate JSONL parses
    const content = readFileSync(p, 'utf8');
    const lines = content.split('\n');
    let lineNo = 0;
    for (const line of lines) {
      lineNo++;
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch {
        findings.push({
          id: 'log-jsonl-valid',
          severity: 'warn',
          path: `${relPath}:${lineNo}`,
          message: `Invalid JSON on line ${lineNo}`,
        });
        break; // one finding per file is enough
      }
    }

    // 2. Documented in the log-formats standard
    if (standardContent && !standardContent.includes(name)) {
      findings.push({
        id: 'log-documented-in-standard',
        severity: 'warn',
        path: relPath,
        message: `JSONL log file "${name}" is not mentioned in standard-log-formats.md`,
        hint: `Add a section to vault/wiki/_seed/meta/reference/standard-log-formats.md documenting its shape, OR remove the file if obsolete`,
      });
    }
  }
  return findings;
}

// Audit-of-the-audit: check that every audit check `id` in this file is
// documented in standard-os-audit.md, and that no documented id is orphaned
// (referenced in docs but not implemented). Catches registry drift.
function checkAuditRegistry() {
  const findings = [];
  const auditMjsPath = join(REPO_ROOT, 'scripts', 'audit.mjs');
  const standardPath = join(
    REPO_ROOT,
    'vault',
    'wiki',
    '_seed',
    'meta',
    'reference',
    'standard-os-audit.md',
  );
  let auditSrc;
  let standardSrc;
  try {
    auditSrc = readFileSync(auditMjsPath, 'utf8');
    standardSrc = readFileSync(standardPath, 'utf8');
  } catch {
    return findings; // missing files surface elsewhere
  }

  // Extract every `id: '<check-id>'` (or `"..."`) literal from audit.mjs.
  // Filter to kebab-case identifiers — avoids matching unrelated strings.
  const implementedIds = new Set();
  for (const m of auditSrc.matchAll(/\bid:\s*['"]([a-z][a-z0-9-]+)['"]/g)) {
    implementedIds.add(m[1]);
  }
  // Also skip our own id, which would otherwise self-report.
  implementedIds.add('audit-check-id-documented');

  // Extract documented ids from markdown tables: backticked identifiers in
  // the first column. Require at least one hyphen — all real check ids are
  // multi-word kebab-case (e.g. `wiki-link-dangling`). This filters out
  // severity labels (`error`, `warn`, `info`) that appear in other tables
  // in the same document.
  const documentedIds = new Set();
  for (const m of standardSrc.matchAll(/^\|\s*`([a-z][a-z0-9]*-[a-z0-9-]+)`/gm)) {
    documentedIds.add(m[1]);
  }

  const standardRel = relative(REPO_ROOT, standardPath);
  for (const id of implementedIds) {
    if (!documentedIds.has(id)) {
      findings.push({
        id: 'audit-check-id-documented',
        severity: 'warn',
        path: standardRel,
        message: `Audit check "${id}" is implemented but not documented in standard-os-audit`,
        hint: `Add a row to the appropriate section of ${standardRel} with severity + source standard`,
      });
    }
  }
  for (const id of documentedIds) {
    if (!implementedIds.has(id)) {
      findings.push({
        id: 'audit-check-id-documented',
        severity: 'warn',
        path: standardRel,
        message: `Audit check "${id}" is documented in standard-os-audit but not implemented in scripts/audit.mjs`,
        hint: `Either implement the check in audit.mjs or remove the row from ${standardRel}`,
      });
    }
  }
  return findings;
}

function checkManifestFreshness() {
  const findings = [];
  const indexPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(indexPath)) {
    findings.push({
      id: 'manifest-exists',
      severity: 'info',
      message: `vault/.index/manifest.json missing — run rebuild-vault-index hook`,
    });
    return findings;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    findings.push({
      id: 'manifest-valid',
      severity: 'error',
      message: `manifest.json is not valid JSON: ${e.message}`,
    });
    return findings;
  }
  const generatedMs = manifest.generated ? Date.parse(manifest.generated) : 0;
  let newestMs = 0;
  for (const p of walkMd(join(REPO_ROOT, 'vault', 'wiki'))) {
    try {
      const s = statSync(p);
      if (s.mtimeMs > newestMs) newestMs = s.mtimeMs;
    } catch {
      /* skip */
    }
  }
  if (generatedMs > 0 && newestMs > generatedMs) {
    findings.push({
      id: 'manifest-stale',
      severity: 'info',
      message: `Manifest is stale — newest wiki entry was modified after the last rebuild`,
      hint: `Run: node .claude/hooks/rebuild-vault-index.mjs`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Event store (.claude/state/events.db) — schema drift check.
// ---------------------------------------------------------------------------

// Verify install.sh seeds the event store. Cheap drift check: the standard
// declares that a fresh clone gets a ready DB; this fires if a future edit
// silently breaks that contract.
function checkInstallerCoverage() {
  const findings = [];
  const installerPath = join(REPO_ROOT, 'install.sh');
  if (!existsSync(installerPath)) {
    findings.push({
      id: 'installer-exists',
      severity: 'warn',
      message: 'install.sh not found at repo root',
    });
    return findings;
  }
  const content = readFileSync(installerPath, 'utf8');
  if (!content.includes('events-db-init.mjs')) {
    findings.push({
      id: 'installer-seeds-event-store',
      severity: 'warn',
      message: 'install.sh does not run scripts/events-db-init.mjs',
      hint: 'Add the init call near the other state-file initializers so a fresh clone has a ready events.db.',
    });
  }
  return findings;
}

// Compare JSONL line counts against events.db row counts per kind. The OS
// dual-writes both layers for safety during the events.db rollout — this
// check enforces the invariant. If JSONL has materially more lines than the
// DB has matching rows, some write site is appending JSONL without calling
// recordEvent (or the helper is failing silently). Small drift (≤2) is
// tolerated to absorb in-flight writes / clock skew during the audit.
const DUAL_WRITE_PAIRS = [
  { jsonl: 'vault/raw/router-log.jsonl', kind: 'router' },
  { jsonl: 'vault/raw/dashboard-actions.jsonl', kind: 'dashboard' },
  { jsonl: 'vault/raw/scheduled-runs.jsonl', kind: 'schedule' },
];
const DUAL_WRITE_TOLERANCE = 2;

function checkDualWriteParity() {
  const findings = [];
  if (!existsSync(EVENTS_DB_PATH)) return findings; // covered by events-db-exists
  let db;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH);
  } catch {
    return findings; // covered by events-db-readable
  }
  try {
    for (const { jsonl, kind } of DUAL_WRITE_PAIRS) {
      const absPath = join(REPO_ROOT, jsonl);
      let jsonlCount = 0;
      if (existsSync(absPath)) {
        const content = readFileSync(absPath, 'utf8');
        jsonlCount = content.split('\n').filter((l) => l.length > 0).length;
      }
      const row = db.prepare('SELECT count(*) AS n FROM events WHERE kind = ?').get(kind);
      const dbCount = row?.n ?? 0;
      const drift = jsonlCount - dbCount;
      if (drift > DUAL_WRITE_TOLERANCE) {
        findings.push({
          id: 'dual-write-parity',
          severity: 'warn',
          path: jsonl,
          message: `${jsonl} has ${jsonlCount} lines but events.db has only ${dbCount} kind="${kind}" rows (drift=${drift})`,
          hint: 'Some write site appends JSONL without calling recordEvent. Either fix that site or run `node scripts/events-db-backfill.mjs` to seed missed lines.',
        });
      }
    }
  } finally {
    db.close();
  }
  return findings;
}

function checkEventsDb() {
  const findings = [];
  if (!existsSync(EVENTS_DB_PATH)) {
    findings.push({
      id: 'events-db-exists',
      severity: 'info',
      message:
        'events.db missing — run `node scripts/events-db-init.mjs` (and `node scripts/events-db-backfill.mjs` to seed from JSONL).',
    });
    return findings;
  }
  // node:sqlite is built-in since Node 22.5 (already required by the helper
  // import above). Open read-only here — no init side-effect.
  let columns;
  try {
    const db = new DatabaseSync(EVENTS_DB_PATH);
    columns = db.prepare('PRAGMA table_info(events)').all().map((r) => r.name);
    db.close();
  } catch (e) {
    findings.push({
      id: 'events-db-readable',
      severity: 'error',
      message: `events.db present but unreadable: ${e.message}`,
    });
    return findings;
  }
  const expected = new Set(EVENTS_DB_EXPECTED_COLUMNS);
  const actual = new Set(columns);
  const missing = [...expected].filter((c) => !actual.has(c));
  const extra = [...actual].filter((c) => !expected.has(c));
  if (missing.length > 0) {
    findings.push({
      id: 'events-db-schema-current',
      severity: 'error',
      message: `events.db missing columns: ${missing.join(', ')}`,
      hint: 'Re-run `node scripts/events-db-init.mjs` (idempotent CREATE; for added columns, drop the table or migrate).',
    });
  }
  if (extra.length > 0) {
    findings.push({
      id: 'events-db-schema-current',
      severity: 'info',
      message: `events.db has extra columns not in standard: ${extra.join(', ')}`,
      hint: 'Update EXPECTED_COLUMNS in scripts/events-db-init.mjs and standard-event-store.md if these are intended.',
    });
  }
  return findings;
}

// Surfaces changes that are sitting at the merge boundary — PR opened, CI
// passed, but nothing's happened in >7 days. Usually means the human forgot
// to merge (or merged but the CI-monitor hasn't caught up — rare since it
// polls every 15 min). Info severity: the OS can't auto-merge; the human
// decides. Reads from the wiki manifest (rebuild-vault-index.mjs surfaces
// the relevant frontmatter fields), no extra disk walks.
function checkChangesPrFrozen() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const FROZEN_THRESHOLD_MS = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  const frozen = [];
  for (const e of manifest.entries ?? []) {
    if (e.type !== 'change') continue;
    if (e.status !== 'in-review') continue;
    if (!e.pr_url) continue;
    if (e.ci_state !== 'pass') continue;
    if (!e.updated) continue;
    const updatedMs = Date.parse(e.updated);
    if (Number.isNaN(updatedMs)) continue;
    const ageMs = now - updatedMs;
    if (ageMs < FROZEN_THRESHOLD_MS) continue;
    const days = Math.floor(ageMs / (24 * 3600 * 1000));
    frozen.push({ id: e.id, days, path: e.path });
  }
  for (const f of frozen) {
    findings.push({
      id: 'change-pr-frozen-but-not-merged',
      severity: 'info',
      path: f.path,
      message: `Change "${f.id}" has CI passing but PR not merged for ${f.days} days`,
      // Path is unique per change; day-count drifts daily (#424).
      dedupe_key: '',
      hint: `Either merge the PR (then runbook-pr-ci-monitor will transition status→merged on next poll), abandon (status: abandoned), or push new commits if more work is needed.`,
    });
  }
  return findings;
}

// Phase 3.5 indexing health: surface repo-knowledge entries whose analysis is
// stale enough that reviews against this repo may be making generic-best-
// practice judgments instead of repo-specific ones. Two drift signals:
//   1. CALENDAR drift — analyzed_at > 30 days ago (analyzer model improved,
//      or conventions may have evolved even without code changes).
//   2. STRUCTURAL drift — pr-review-repo-cache.head_sha != based_on_commit
//      (the codebase has moved since the analysis ran).
// Info severity: the OS can re-analyze cheaply, but the human picks when.
// Reads frontmatter directly since the relevant fields (analyzed_at,
// based_on_commit, head_sha, owner, repo) aren't in the flat manifest.
function checkRepoKnowledgeStale() {
  const findings = [];
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  if (!existsSync(wikiDir)) return findings;
  const STALE_THRESHOLD_MS = 30 * 24 * 3600 * 1000;
  const now = Date.now();

  // First pass: build owner/repo → cache.head_sha map.
  const cacheHeadShas = new Map();
  for (const file of walkMd(wikiDir)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { fm } = parseFrontmatter(content);
    if (fm.type !== 'pr-review-repo-cache') continue;
    if (!fm.owner || !fm.repo) continue;
    cacheHeadShas.set(`${fm.owner}/${fm.repo}`, fm.head_sha ?? null);
  }

  // Second pass: walk repo-knowledge entries, compute drift.
  for (const file of walkMd(wikiDir)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { fm } = parseFrontmatter(content);
    if (fm.type !== 'repo-knowledge') continue;
    const relPath = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
    const key = `${fm.owner}/${fm.repo}`;
    const cacheHead = cacheHeadShas.get(key);
    const reasons = [];

    // Calendar drift
    if (fm.analyzed_at) {
      const ageMs = now - Date.parse(fm.analyzed_at);
      if (!Number.isNaN(ageMs) && ageMs > STALE_THRESHOLD_MS) {
        const days = Math.floor(ageMs / (24 * 3600 * 1000));
        reasons.push(`analyzed_at is ${days} days old (>30)`);
      }
    }

    // Structural drift
    if (cacheHead && fm.based_on_commit && cacheHead !== fm.based_on_commit) {
      reasons.push(
        `cache HEAD (${String(cacheHead).slice(0, 7)}) has moved since analysis (based_on_commit ${String(fm.based_on_commit).slice(0, 7)})`,
      );
    }

    if (reasons.length === 0) continue;

    findings.push({
      id: 'repo-knowledge-stale',
      severity: 'info',
      path: relPath,
      message: `Repo knowledge "${fm.id}" is stale — ${reasons.join('; ')}`,
      hint: `Re-analyze via the Repos tab's analyze button, or run: /os analyze repo ${fm.owner}/${fm.repo}`,
    });
  }

  return findings;
}

// Detect orphan owner-shell directories under .claude/state/pr-review-cache/.
// The DELETE endpoint prunes empty <owner>/ dirs cleanly, but ad-hoc rm of a
// cache dir from a script or skill might leave the empty <owner>/ behind. Not
// dangerous, just visual noise — surface it so the user knows to rmdir.
function checkPrReviewCacheOrphans() {
  const findings = [];
  const cacheRoot = join(REPO_ROOT, '.claude', 'state', 'pr-review-cache');
  if (!existsSync(cacheRoot)) return findings;
  let entries;
  try {
    entries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return findings;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const ownerDir = join(cacheRoot, e.name);
    let contents;
    try {
      contents = readdirSync(ownerDir).filter((x) => !x.startsWith('.'));
    } catch {
      continue;
    }
    if (contents.length === 0) {
      const rel = `.claude/state/pr-review-cache/${e.name}`;
      findings.push({
        id: 'pr-review-cache-orphan-owner-dir',
        severity: 'info',
        path: rel,
        message: `Empty owner dir "${e.name}" — leftover shell after a repo eviction`,
        hint: `Safe to remove: rmdir ${rel}`,
      });
    }
  }
  return findings;
}

// Guardrail against the bug we just fixed: when a writer forgets to tag
// change_id on events whose skill clearly identifies a change-scoped action,
// the Activity tab shows empty state even though work happened. Surface
// untagged rows so we know to patch the writer (or extend
// scripts/extract-event-attribution.mjs).
function checkEventAttribution() {
  const findings = [];
  if (!existsSync(EVENTS_DB_PATH)) return findings;
  let untagged;
  try {
    const db = new DatabaseSync(EVENTS_DB_PATH);
    const placeholders = [...CHANGE_SCOPED_SKILLS].map(() => '?').join(', ');
    untagged = db
      .prepare(`
        SELECT skill, COUNT(*) AS n
        FROM events
        WHERE skill IN (${placeholders})
          AND change_id IS NULL
        GROUP BY skill
        ORDER BY n DESC
      `)
      .all(...CHANGE_SCOPED_SKILLS);
    db.close();
  } catch {
    // checkEventsDb surfaces readability problems; don't double-report here.
    return findings;
  }
  if (untagged.length === 0) return findings;
  const total = untagged.reduce((s, r) => s + r.n, 0);
  const breakdown = untagged.map((r) => `${r.skill}=${r.n}`).join(', ');
  findings.push({
    id: 'events-skill-attribution-missing',
    severity: 'warn',
    message: `${total} event${total === 1 ? '' : 's'} with change-scoped skill but null change_id (${breakdown})`,
    hint: 'Run `node scripts/events-db-tag-changes.mjs` to backfill from JSONL audit logs, then audit which writer dropped the tag. See standard-event-store.md § Event attribution.',
  });
  return findings;
}

function checkMcps() {
  const findings = [];
  const mcpsDir = join(REPO_ROOT, 'mcps');
  if (!existsSync(mcpsDir)) return findings;

  const required = ['id', 'domain', 'description', 'transport', 'command', 'args'];
  const discovered = [];
  const domainDirs = new Set(listDirs(join(REPO_ROOT, 'domains')));

  for (const name of listDirs(mcpsDir)) {
    if (name.startsWith('_')) continue;
    const dir = join(mcpsDir, name);
    const manifestPath = join(dir, 'manifest.json');
    const relManifest = relative(REPO_ROOT, manifestPath);
    if (!existsSync(manifestPath)) {
      findings.push({
        id: 'mcp-manifest-required-fields',
        severity: 'error',
        path: relative(REPO_ROOT, dir),
        message: `MCP folder has no manifest.json`,
        hint: 'Run /os add-mcp or model on mcps/github/manifest.json.',
      });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      findings.push({
        id: 'mcp-manifest-required-fields',
        severity: 'error',
        path: relManifest,
        message: `manifest.json is not valid JSON: ${e.message}`,
      });
      continue;
    }
    const missing = required.filter((k) => manifest[k] == null);
    if (missing.length > 0) {
      findings.push({
        id: 'mcp-manifest-required-fields',
        severity: 'error',
        path: relManifest,
        message: `MCP manifest missing required fields: ${missing.join(', ')}`,
      });
    }
    if (manifest.id && manifest.id !== name) {
      findings.push({
        id: 'mcp-id-folder-match',
        severity: 'error',
        path: relManifest,
        message: `manifest.id (${manifest.id}) must equal folder name (${name})`,
      });
    }
    if (manifest.domain && !domainDirs.has(manifest.domain)) {
      // Also allow short-form domain aliases used elsewhere in the OS — match
      // against any subdir nested one level deep (e.g. development/<sub>).
      // Keep this minimal; the standard says manifest.domain must exist as
      // a top-level domain dir.
      findings.push({
        id: 'mcp-domain-exists',
        severity: 'error',
        path: relManifest,
        message: `manifest.domain "${manifest.domain}" is not a directory under domains/`,
      });
    }
    if (Array.isArray(manifest.env) && manifest.env.length > 0) {
      const envExamplePath = join(dir, '.env.example');
      if (!existsSync(envExamplePath)) {
        findings.push({
          id: 'mcp-env-example-present',
          severity: 'warn',
          path: relative(REPO_ROOT, dir),
          message: `manifest declares env vars but .env.example is missing`,
          hint: `Create mcps/${name}/.env.example documenting required env vars.`,
        });
      } else {
        const envExample = readFileSync(envExamplePath, 'utf8');
        const undocumented = manifest.env.filter((v) => !envExample.includes(v));
        if (undocumented.length > 0) {
          findings.push({
            id: 'mcp-env-example-present',
            severity: 'warn',
            path: relative(REPO_ROOT, envExamplePath),
            message: `.env.example does not document: ${undocumented.join(', ')}`,
          });
        }
        // Catch leaked secrets: .env.example is committed; any line of the
        // form KEY=<non-empty-value> probably means someone pasted a real
        // credential into the template instead of into the gitignored .env.
        // Comments + blank lines are fine.
        const leaked = [];
        for (const line of envExample.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq === -1) continue;
          const key = trimmed.slice(0, eq).trim();
          const value = trimmed.slice(eq + 1).trim();
          if (value.length > 0) leaked.push(key);
        }
        if (leaked.length > 0) {
          findings.push({
            id: 'mcp-env-example-no-secrets',
            severity: 'error',
            path: relative(REPO_ROOT, envExamplePath),
            message: `.env.example has non-empty value(s) for: ${leaked.join(', ')}. The template is committed to git — a value here is a leaked secret.`,
            hint: `Move the value to mcps/${name}/.env (gitignored). Set ${leaked.join(', ')} back to empty in .env.example. Treat the previous value as compromised — rotate it.`,
          });
        }
      }
    }
    if (manifest.id) discovered.push(manifest);
  }

  // Staleness: .mcp.json should reflect what's discovered. Third-party
  // hosted entries (with `url` and `type`) are passed through unchanged by
  // sync-mcp-config.mjs and aren't expected to have an mcps/<id>/ folder —
  // so we only audit entries that look like OS-built stdio servers.
  const mcpConfigPath = join(REPO_ROOT, '.mcp.json');
  if (existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      const servers = config.mcpServers ?? {};
      const osBuiltConfigIds = new Set(
        Object.entries(servers)
          // Heuristic: stdio-shape entries (have command, no url/type) are
          // assumed to be OS-built MCPs. http/sse hosted MCPs are third-party.
          .filter(([, s]) => s && typeof s === 'object' && s.command && !s.url && !s.type)
          .map(([id]) => id),
      );
      const discoveredIds = new Set(discovered.map((m) => m.id));
      const missing = [...discoveredIds].filter((id) => !osBuiltConfigIds.has(id));
      const extra = [...osBuiltConfigIds].filter((id) => !discoveredIds.has(id));
      if (missing.length > 0 || extra.length > 0) {
        const parts = [];
        if (missing.length > 0) parts.push(`missing from .mcp.json: ${missing.join(', ')}`);
        if (extra.length > 0) parts.push(`stdio entries with no mcps/ folder: ${extra.join(', ')}`);
        findings.push({
          id: 'mcp-config-stale',
          severity: 'info',
          path: '.mcp.json',
          message: `.mcp.json is out of sync with mcps/ — ${parts.join('; ')}`,
          hint: 'Run `node scripts/sync-mcp-config.mjs` to regenerate.',
        });
      }
    } catch (e) {
      findings.push({
        id: 'mcp-config-stale',
        severity: 'info',
        path: '.mcp.json',
        message: `.mcp.json present but unparseable: ${e.message}`,
        hint: 'Run `node scripts/sync-mcp-config.mjs` to regenerate.',
      });
    }
  } else if (discovered.length > 0) {
    findings.push({
      id: 'mcp-config-stale',
      severity: 'info',
      message: `.mcp.json missing but mcps/ has ${discovered.length} server${discovered.length === 1 ? '' : 's'}`,
      hint: 'Run `node scripts/sync-mcp-config.mjs` to generate.',
    });
  }

  // mcp-tool-orphan: every tool declared in a manifest should be referenced
  // by at least one skill (via the `mcp__<server>__<tool>` namespace). An
  // orphan tool isn't broken — but it's either dead infrastructure or a
  // planned-but-unbuilt consumer skill. Either way, surface it as info so
  // future-you remembers to either wire it up or remove it.
  const skillsDir = join(REPO_ROOT, '.claude', 'skills');
  let combinedSkillText = '';
  if (existsSync(skillsDir)) {
    for (const name of listDirs(skillsDir)) {
      const skillPath = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      try {
        combinedSkillText += readFileSync(skillPath, 'utf8') + '\n';
      } catch {
        /* skip */
      }
    }
  }
  for (const manifest of discovered) {
    const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
    const relManifest = `mcps/${manifest.id}/manifest.json`;
    for (const t of tools) {
      const toolName = typeof t === 'string' ? t : t?.name;
      if (!toolName) continue;
      const namespaced = `mcp__${manifest.id}__${toolName}`;
      // Match either the fully-qualified `mcp__server__tool` form or the
      // bare tool name. Two-stage match because skill docs sometimes use
      // shorthand like `the get_pull_request tool` without the prefix.
      if (!combinedSkillText.includes(namespaced) && !combinedSkillText.includes(toolName)) {
        findings.push({
          id: 'mcp-tool-orphan',
          severity: 'info',
          path: relManifest,
          message: `MCP tool "${manifest.id}.${toolName}" is declared but not referenced by any skill`,
          hint: `Either build a consumer skill that calls ${namespaced}, or remove the tool from the manifest + server.`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Event store freshness — distinguishes "nobody's using the OS" from
// "OS is being used but recording pipeline is broken". Info-severity since
// quiet weeks (vacation, no work) shouldn't fire as warnings.
// ---------------------------------------------------------------------------

function checkEventsDbFreshness() {
  const findings = [];
  const dbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(dbPath)) return findings; // checkEventsDb covers absence
  let mtimeMs;
  try {
    mtimeMs = statSync(dbPath).mtimeMs;
  } catch {
    return findings;
  }
  const ageMs = Date.now() - mtimeMs;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // 14-day threshold: two missed weekly cycles is the point where "quiet
  // period" becomes "something is wrong". Tunable; revisit if this fires
  // during legitimate vacations.
  if (ageDays > 14) {
    findings.push({
      id: 'events-db-stale',
      severity: 'info',
      path: '.claude/state/events.db',
      message: `events.db hasn't been written to in ${Math.floor(ageDays)} days`,
      // Single finding (events.db is global); day-count drifts daily (#424).
      dedupe_key: '',
      hint: 'Either the OS isn\'t being used (quiet period — fine to ignore) OR the event-recording pipeline is broken. Check that scripts/record-dashboard-action.mjs is reachable from skills and that the scheduler is firing.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// New checks (rich-observability surfacing pass)
// ---------------------------------------------------------------------------

// Detect git-sync gaps on every kind=repo entity. Compares the local
// working clone's `default_branch` HEAD to `origin/<default_branch>`. When
// they diverge, the local clone is stale (or ahead) — flag it so the user
// can pull. Skips entities without `remote_url` (e.g. the self-pointing
// agentic-os entity).
function checkGitSyncGap() {
  const findings = [];
  const entityDir = join(REPO_ROOT, 'vault', 'wiki', 'development', 'entity');
  if (!existsSync(entityDir)) return findings;
  for (const file of walkMd(entityDir)) {
    let fm;
    try {
      ({ fm } = parseFrontmatter(readFileSync(file, 'utf8')));
    } catch {
      continue;
    }
    if (fm.kind !== 'repo') continue;
    if (!fm.local_path || !fm.remote_url) continue; // self-pointing or unconfigured
    const branch = fm.default_branch ?? 'main';
    // Local rev — cheap.
    const local = spawnSync(
      'git',
      ['-C', fm.local_path, 'rev-parse', branch],
      { encoding: 'utf8' },
    );
    if (local.status !== 0) continue;
    // Remote rev — uses ls-remote so no `git fetch` side-effect.
    const remote = spawnSync(
      'git',
      ['-C', fm.local_path, 'ls-remote', 'origin', branch],
      { encoding: 'utf8' },
    );
    if (remote.status !== 0) continue;
    const localSha = local.stdout.trim();
    const remoteSha = (remote.stdout.split(/\s+/)[0] || '').trim();
    if (!localSha || !remoteSha || localSha === remoteSha) continue;
    findings.push({
      id: 'git-sync-gap',
      severity: 'info',
      path: relative(REPO_ROOT, file),
      message: `Local ${branch} (${localSha.slice(0, 7)}) diverges from origin/${branch} (${remoteSha.slice(0, 7)}) for repo "${fm.id}".`,
      hint: `Run: git -C ${fm.local_path} checkout ${branch} && git pull --ff-only origin ${branch}`,
    });
  }
  return findings;
}

// Orphan JSONL files under .claude/state/runs/ with no corresponding row
// in the `runs` table. Surfaces when the cap-evictor failed to clean up
// or when a row was deleted manually.
function checkOrphanRunJsonl() {
  const findings = [];
  const runsDir = join(REPO_ROOT, '.claude', 'state', 'runs');
  if (!existsSync(runsDir)) return findings;
  const dbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(dbPath)) return findings;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return findings;
  }
  let knownIds;
  try {
    knownIds = new Set(
      db.prepare('SELECT id FROM runs').all().map((r) => r.id),
    );
  } catch {
    db.close();
    return findings;
  } finally {
    db.close();
  }
  let orphans = 0;
  let entries;
  try {
    entries = readdirSync(runsDir);
  } catch {
    return findings;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!knownIds.has(id)) orphans += 1;
  }
  if (orphans > 0) {
    findings.push({
      id: 'orphan-run-jsonl',
      severity: 'info',
      path: '.claude/state/runs/',
      message: `${orphans} JSONL file(s) under .claude/state/runs/ have no matching row in the runs table.`,
      hint: 'Each .claude/state/runs/<id>.jsonl should have a row in events.db.runs. Stale files accumulate from manual deletes or crashed cap-evictors. Safe to delete the orphan jsonl files: ls .claude/state/runs/*.jsonl and remove ones whose id isn\'t in `SELECT id FROM runs`.',
    });
  }
  return findings;
}

// Detect changes whose `pr_review_status` is `pending` (or absent) on a
// merged change. The roll-up should have transitioned to `ready-for-human`
// (or higher) before the merge — `pending` after merge means the user
// merged via GitHub directly without flipping the OS-side state. Surfaces
// the gap so the audit trail is honest.
function checkStalePrReviewStatus() {
  const findings = [];
  const changeDir = join(REPO_ROOT, 'vault', 'wiki', 'development', 'change');
  if (!existsSync(changeDir)) return findings;
  for (const file of walkMd(changeDir)) {
    let fm;
    try {
      ({ fm } = parseFrontmatter(readFileSync(file, 'utf8')));
    } catch {
      continue;
    }
    if (fm.type !== 'change') continue;
    if (fm.status !== 'merged') continue;
    // Skip if review wasn't required (small/trivial changes).
    if (fm.review_required === false) continue;
    if (fm.pr_review_status === 'ready-for-human') continue; // canonical happy
    if (!fm.pr_review_path) continue; // never had a pr-review entry — different story
    const sev = fm.pr_review_status === 'needs-changes' ? 'warn' : 'info';
    findings.push({
      id: 'stale-pr-review-status-on-merged',
      severity: sev,
      path: relative(REPO_ROOT, file),
      message: `Change "${fm.id}" is merged but pr_review_status is "${fm.pr_review_status ?? 'unset'}" — never transitioned to ready-for-human.`,
      hint: 'Indicates the merge happened outside the OS-driven flow (or the user skipped the Mark Ready step). For historical audit honesty, edit the change frontmatter and set pr_review_status: ready-for-human + pr_ready_at to the merge timestamp.',
    });
  }
  return findings;
}

// Untriaged comments (status: new) sitting on a merged change for more
// than 7 days. Either commit to addressing them in a follow-up change or
// explicitly dismiss them — letting them dangle muddies the audit trail.
function checkDeferredCommentsAge() {
  const findings = [];
  const prReviewDir = join(REPO_ROOT, 'vault', 'wiki', 'development', 'pr-review');
  if (!existsSync(prReviewDir)) return findings;
  const changeDir = join(REPO_ROOT, 'vault', 'wiki', 'development', 'change');
  if (!existsSync(changeDir)) return findings;

  // Build change_id -> status map.
  const mergedChanges = new Set();
  for (const file of walkMd(changeDir)) {
    let fm;
    try {
      ({ fm } = parseFrontmatter(readFileSync(file, 'utf8')));
    } catch {
      continue;
    }
    if (fm.type !== 'change') continue;
    if (fm.status === 'merged' && typeof fm.id === 'string') mergedChanges.add(fm.id);
  }

  const STALE_THRESHOLD_MS = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  for (const file of walkMd(prReviewDir)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { fm } = parseFrontmatter(content);
    if (fm.type !== 'pr-review') continue;
    if (!fm.change_id || !mergedChanges.has(fm.change_id)) continue;
    // Count `- status: new` lines in the body — these are untriaged
    // comments left over after merge.
    const newCount = (content.match(/^- status: new$/gm) || []).length;
    if (newCount === 0) continue;
    const completedAt = fm.completed ?? fm.updated;
    let ageDays = null;
    if (completedAt) {
      const ageMs = now - Date.parse(completedAt);
      if (!Number.isNaN(ageMs) && ageMs > 0) ageDays = Math.floor(ageMs / (24 * 3600 * 1000));
    }
    if (ageDays !== null && ageDays * 24 * 3600 * 1000 < STALE_THRESHOLD_MS) continue;
    findings.push({
      id: 'deferred-comments-age',
      severity: 'info',
      path: relative(REPO_ROOT, file),
      message: `${newCount} untriaged comment(s) on a merged change "${fm.change_id}"${ageDays !== null ? ` (${ageDays}d old)` : ''}.`,
      hint: 'Either scaffold a follow-up change to address them, or open the review in the PR Review app and dismiss them with a one-line rationale. Letting them sit as `status: new` after merge defeats the audit trail.',
    });
  }
  return findings;
}

// Mirror of checkEventAttribution for project-scoped skills. The
// orchestration skills (meta-review-project-plan, meta-revise-project-plan,
// meta-scaffold-project-plan) all carry a project
// id; events tagged with these skills that have project=null indicate a
// dropped tag somewhere on the write path.
function checkProjectAttribution() {
  const findings = [];
  if (!existsSync(EVENTS_DB_PATH)) return findings;
  let untagged;
  try {
    const db = new DatabaseSync(EVENTS_DB_PATH);
    const placeholders = [...PROJECT_SCOPED_SKILLS].map(() => '?').join(', ');
    untagged = db
      .prepare(`
        SELECT skill, COUNT(*) AS n
        FROM events
        WHERE skill IN (${placeholders})
          AND project IS NULL
        GROUP BY skill
        ORDER BY n DESC
      `)
      .all(...PROJECT_SCOPED_SKILLS);
    db.close();
  } catch {
    return findings;
  }
  if (untagged.length === 0) return findings;
  const total = untagged.reduce((s, r) => s + r.n, 0);
  const breakdown = untagged.map((r) => `${r.skill}=${r.n}`).join(', ');
  findings.push({
    id: 'events-project-attribution-missing',
    severity: 'warn',
    message: `${total} event${total === 1 ? '' : 's'} with project-scoped skill but null project (${breakdown})`,
    hint: 'Audit which writer dropped the project tag — extract-event-attribution.mjs.extractFromPrompt should pull it from the `- project:` line. See standard-event-store.md § Event attribution.',
  });
  return findings;
}

// Project-plan files under vault/output/<domain>/project-plans/ should each be
// referenced by some project entry's plan_path. Orphans accumulate when a
// wiki-id-unique — flag any two entries sharing the same {id, type} pair.
// Discovered 2026-05-31 when an automation-and-notifications project entry
// existed in two domains simultaneously (meta + development), causing the
// API to pick one arbitrarily and lifecycle state on the un-picked twin to
// silently drift. Scoping by `type` is important: a `change` and a `project`
// with the same id are different archetypes and not a collision.
function checkDuplicateWikiIds() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  // Group entries by `${type}::${id}`. Skip rows missing either field — the
  // dedicated `wiki-frontmatter-required` check covers that gap.
  const byKey = new Map();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || typeof e.type !== 'string') continue;
    const key = `${e.type}::${e.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const [type, id] = key.split('::');
    const paths = group.map((g) => g.path).filter(Boolean);
    findings.push({
      id: 'wiki-id-unique',
      severity: 'warn',
      path: paths[0],
      message: `Duplicate ${type} entries share id "${id}" (${group.length} files)`,
      hint: `Remove all but one: ${paths.join(', ')}. The dashboard API picks one arbitrarily, causing lifecycle drift on the un-picked twin.`,
    });
  }
  return findings;
}

// automation-stuck-running — flag projects whose automation.state.phase has
// been `running` for >60 minutes. Usually means the dispatched skill hung or
// the auto-tick path failed silently; either way the user wants a poke.
function checkAutomationStuckRunning() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const STUCK_MS = 60 * 60 * 1000; // 60 min
  const nowMs = Date.now();
  for (const e of entries) {
    if (!e || e.type !== 'project' || !e.path) continue;
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, e.path), 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('automation:')) continue;
    const { fm } = parseFrontmatter(content);
    if (!fm) continue;
    const auto = fm.automation;
    if (!auto || typeof auto !== 'object') continue;
    if (auto.state?.phase !== 'running') continue;
    const lastTrans = auto.state.last_transition;
    if (typeof lastTrans !== 'string') continue;
    const transMs = Date.parse(lastTrans);
    if (Number.isNaN(transMs)) continue;
    const ageMs = nowMs - transMs;
    if (ageMs < STUCK_MS) continue;
    const mins = Math.round(ageMs / 60000);
    findings.push({
      id: 'automation-stuck-running',
      severity: 'warn',
      path: e.path,
      message: `Project "${e.id}" automation has been running for ${mins} minutes (>60) on step "${auto.state.current_step ?? '?'}" of change "${auto.state.current_change ?? '?'}"`,
      // Path unique per project; minutes-count drifts every minute (#424).
      dedupe_key: '',
      hint: 'Either the dispatched skill hung or the auto-tick path failed. Pause + investigate the current run in the Processes view, then Resume or Stop.',
    });
  }
  return findings;
}

// automation-stale-paused — flag projects whose automation has been paused
// for >7 days. Long pauses usually mean the user forgot or the project
// abandoned — surface so dismissed-or-acted-on is the explicit decision.
function checkAutomationStalePaused() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const nowMs = Date.now();
  for (const e of entries) {
    if (!e || e.type !== 'project' || !e.path) continue;
    let content;
    try {
      content = readFileSync(join(REPO_ROOT, e.path), 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('automation:')) continue;
    const { fm } = parseFrontmatter(content);
    if (!fm) continue;
    const auto = fm.automation;
    if (!auto || typeof auto !== 'object') continue;
    if (auto.state?.phase !== 'paused') continue;
    const lastTrans = auto.state.last_transition;
    if (typeof lastTrans !== 'string') continue;
    const transMs = Date.parse(lastTrans);
    if (Number.isNaN(transMs)) continue;
    const ageMs = nowMs - transMs;
    if (ageMs < STALE_MS) continue;
    const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
    findings.push({
      id: 'automation-stale-paused',
      severity: 'info',
      path: e.path,
      message: `Project "${e.id}" automation has been paused for ${days} days — reason: ${auto.state.paused_reason ?? 'unknown'}`,
      // Path unique per project; day-count drifts daily (#424).
      dedupe_key: '',
      hint: 'Resolve the pause condition and Resume, or Stop the automation if the project no longer needs auto-execution.',
    });
  }
  return findings;
}

// project is deleted but the plan file wasn't cleaned up — cheap drift that
// pollutes the dashboard's recent-output panel.
function checkPlanFileOrphan() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const referenced = new Set();
  for (const e of manifest.entries ?? []) {
    if (e.type !== 'project') continue;
    if (typeof e.plan_path === 'string' && e.plan_path) referenced.add(e.plan_path);
  }
  const outputRoot = join(REPO_ROOT, 'vault', 'output');
  if (!existsSync(outputRoot)) return findings;
  for (const domain of listDirs(outputRoot)) {
    const planDir = join(outputRoot, domain, 'project-plans');
    if (!existsSync(planDir)) continue;
    for (const name of listFiles(planDir)) {
      if (!name.endsWith('.md')) continue;
      // Reviewer artifacts (`*-plan-review.md`) are referenced via
      // plan_review_path, which isn't lifted to the manifest yet — skip them
      // so we don't false-positive. They get their own check when that field
      // is lifted.
      if (name.endsWith('-plan-review.md')) continue;
      const rel = relative(REPO_ROOT, join(planDir, name));
      if (referenced.has(rel)) continue;
      findings.push({
        id: 'plan-file-orphan',
        severity: 'info',
        path: rel,
        message: `Project plan file has no project entry pointing at it via plan_path`,
        hint: 'Either `rm` the orphan plan, or restore/repoint the project entry whose plan_path should match.',
      });
    }
  }
  return findings;
}

// Project stuck `plan_status: in-research` for >1h: the research-write
// dispatch almost certainly crashed before flipping plan_status to `pending` (the
// terminal value). Without this check, dead research runs sit invisibly and
// the human has no signal to retry or salvage.
function checkPlanStatusStuckInResearch() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const STALE_THRESHOLD_MS = 3600 * 1000; // 1 hour
  const now = Date.now();
  for (const e of manifest.entries ?? []) {
    if (e.type !== 'project') continue;
    if (e.plan_status !== 'in-research') continue;
    if (!e.updated) continue;
    const updatedMs = Date.parse(e.updated);
    if (Number.isNaN(updatedMs)) continue;
    const ageMs = now - updatedMs;
    if (ageMs < STALE_THRESHOLD_MS) continue;
    const mins = Math.floor(ageMs / 60000);
    findings.push({
      id: 'plan-status-stuck-in-research',
      severity: 'warn',
      path: e.path,
      message: `Project "${e.id}" has plan_status: in-research with no update for ${mins} minute${mins === 1 ? '' : 's'} (research likely crashed)`,
      hint: 'Check events.db for the matching project-research / project-research-start event. If the run is truly dead, flip plan_status back to `pending` and re-run /os research project <id>.',
    });
  }
  return findings;
}

// Project plan approved but never scaffolded — cost was spent on planning
// that didn't convert to work. After 7 days it's worth surfacing so the human
// either dispatches /os scaffold project <id> or revises/abandons.
function checkPlanApprovedButUnscaffolded() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  const STALE_THRESHOLD_MS = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  for (const e of manifest.entries ?? []) {
    if (e.type !== 'project') continue;
    // Shared review-state contract: the verdict lives in review_status;
    // plan_status 'drafted' means the plan exists but nothing scaffolded.
    if (e.review_status !== 'approved' && e.review_status !== 'overridden') continue;
    if (e.plan_status !== 'drafted') continue;
    if (!e.updated) continue;
    const updatedMs = Date.parse(e.updated);
    if (Number.isNaN(updatedMs)) continue;
    const ageMs = now - updatedMs;
    if (ageMs < STALE_THRESHOLD_MS) continue;
    const days = Math.floor(ageMs / (24 * 3600 * 1000));
    findings.push({
      id: 'plan-approved-but-unscaffolded',
      severity: 'info',
      path: e.path,
      message: `Project "${e.id}" plan was approved ${days} days ago but never scaffolded`,
      // Path unique per project; day-count drifts daily (#424).
      dedupe_key: '',
      hint: 'Run /os scaffold project <id> to materialize the plan, or revise/abandon if scope shifted.',
    });
  }
  return findings;
}

// Materials directories under vault/raw/project-research/<id>/ should map to
// an active project. Orphans (no project) or stale leftovers (project
// completed/cancelled >30d ago) waste disk and confuse curation.
function checkMaterialsOrphan() {
  const findings = [];
  const materialsRoot = join(REPO_ROOT, 'vault', 'raw', 'project-research');
  if (!existsSync(materialsRoot)) return findings;
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  const projectsById = new Map();
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const e of manifest.entries ?? []) {
        if (e.type !== 'project') continue;
        if (typeof e.id === 'string') projectsById.set(e.id, e);
      }
    } catch {
      // Treat as no manifest — every dir becomes a potential orphan.
    }
  }
  const STALE_THRESHOLD_MS = 30 * 24 * 3600 * 1000;
  const now = Date.now();
  for (const id of listDirs(materialsRoot)) {
    const rel = relative(REPO_ROOT, join(materialsRoot, id));
    const project = projectsById.get(id);
    if (!project) {
      findings.push({
        id: 'materials-orphan',
        severity: 'info',
        path: rel,
        message: `Materials directory has no matching project entry`,
        hint: 'Either `rm -rf` the orphan dir, or restore the project entry it belongs to.',
      });
      continue;
    }
    if (project.status !== 'completed' && project.status !== 'cancelled') continue;
    if (!project.updated) continue;
    const updatedMs = Date.parse(project.updated);
    if (Number.isNaN(updatedMs)) continue;
    const ageMs = now - updatedMs;
    if (ageMs < STALE_THRESHOLD_MS) continue;
    const days = Math.floor(ageMs / (24 * 3600 * 1000));
    findings.push({
      id: 'materials-orphan',
      severity: 'info',
      path: rel,
      message: `Materials directory belongs to a ${project.status} project (${days} days since last update)`,
      // Path unique per materials dir; day-count drifts daily (#424).
      dedupe_key: '',
      hint: 'Archive elsewhere or `rm -rf` the materials dir; the project is done with them.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Research-lifecycle checks (research-report archetype + materials drift)
// ---------------------------------------------------------------------------

// Helper: read every research-report entry from disk (with frontmatter +
// recommended_changes parsed). Cheap: one investigation per report, bounded
// to <100 per OS in practice.
function loadResearchReports() {
  const out = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return out;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return out;
  }
  for (const e of manifest.entries ?? []) {
    if (e?.type !== 'research-report') continue;
    if (typeof e.path !== 'string') continue;
    const full = join(REPO_ROOT, e.path);
    if (!existsSync(full)) continue;
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    out.push({ entry: e, fm: parsed.fm ?? {} });
  }
  return out;
}

// Walk every file under `root` and yield its absolute path. Used by the
// materials-stale check to discover newer-than-ingest files on disk.
function walkAllFiles(root) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...walkAllFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function checkResearchMaterialsStale() {
  const findings = [];
  const STALE_THRESHOLD_MS = 7 * 24 * 3600 * 1000;
  const now = Date.now();
  for (const { entry, fm } of loadResearchReports()) {
    const materialsPath = fm.materials_path ?? entry.materials_path;
    const lastIngest = fm.last_data_ingest ?? entry.last_data_ingest;
    if (!materialsPath || !lastIngest) continue;
    const lastIngestMs = Date.parse(lastIngest);
    if (Number.isNaN(lastIngestMs)) continue;
    const ageMs = now - lastIngestMs;
    if (ageMs < STALE_THRESHOLD_MS) continue;
    const matsAbs = join(REPO_ROOT, materialsPath);
    if (!existsSync(matsAbs)) continue;
    let newer = false;
    for (const f of walkAllFiles(matsAbs)) {
      try {
        if (statSync(f).mtimeMs > lastIngestMs) { newer = true; break; }
      } catch { /* skip */ }
    }
    if (!newer) continue;
    const days = Math.floor(ageMs / (24 * 3600 * 1000));
    findings.push({
      id: 'research-materials-stale',
      severity: 'warn',
      path: entry.path,
      message: `Research report "${entry.id}" has new materials since last_data_ingest (${days}d ago) — drift may have accumulated`,
      // Path unique per report; day-count drifts daily (#424).
      dedupe_key: '',
      hint: `Run /os update research ${entry.id} to re-walk materials.`,
    });
  }
  return findings;
}

function checkResearchOrphanMaterialsDir() {
  const findings = [];
  const root = join(REPO_ROOT, 'vault', 'raw', 'project-research');
  if (!existsSync(root)) return findings;
  // Build the set of {project}/{report} pairs known to the manifest by parsing
  // each research-report's materials_path field.
  const known = new Set();
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const e of manifest.entries ?? []) {
        if (e?.type !== 'research-report') continue;
        if (typeof e.materials_path !== 'string') continue;
        const m = e.materials_path.match(/vault\/raw\/project-research\/([^/]+)\/([^/]+)\/?$/);
        if (m) known.add(`${m[1]}/${m[2]}`);
      }
    } catch { /* treat as no manifest */ }
  }
  // Files that mark a dir as "intentionally empty for future use" — don't
  // count as real materials. The .gitkeep convention is the common one;
  // .DS_Store sneaks in on macOS; README.md is a convention for documenting
  // the slot before research-write fires.
  const META_FILES = new Set(['.gitkeep', '.DS_Store', 'README.md']);
  for (const project of listDirs(root)) {
    const inner = join(root, project);
    for (const report of listDirs(inner)) {
      const key = `${project}/${report}`;
      if (known.has(key)) continue;
      // Skip pre-creation slots — a report directory with only metadata
      // files (.gitkeep, README.md, .DS_Store) is a legitimate "drop your
      // materials here before running research-write" placeholder, not an
      // orphan. Only fire when actual material files are present.
      const reportPath = join(inner, report);
      let hasRealMaterials = false;
      try {
        const entries = readdirSync(reportPath, { withFileTypes: true });
        for (const e of entries) {
          if (META_FILES.has(e.name)) continue;
          if (e.name.startsWith('.')) continue;
          hasRealMaterials = true;
          break;
        }
      } catch { /* unreadable — treat as orphan */ hasRealMaterials = true; }
      if (!hasRealMaterials) continue;
      const rel = relative(REPO_ROOT, reportPath);
      findings.push({
        id: 'research-orphan-materials-dir',
        severity: 'info',
        path: rel,
        message: `Materials directory has no matching research-report entry`,
        hint: `Remove the dir (rm -rf ${rel}) or create the matching research-report entry.`,
      });
    }
  }
  return findings;
}

// Build a changes-by-id map once per audit run for the two recommended_changes
// drift checks below.
function buildChangesById() {
  const out = new Map();
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return out;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const e of manifest.entries ?? []) {
      if (e?.type === 'change' && typeof e.id === 'string') out.set(e.id, e);
    }
  } catch { /* empty map */ }
  return out;
}

const IN_FLIGHT_CHANGE_STATUSES = new Set(['planning', 'in-progress', 'in-review']);

function checkResearchRecommendedChangesScaffoldedNotMerged() {
  const findings = [];
  const STALE_THRESHOLD_MS = 14 * 24 * 3600 * 1000;
  const now = Date.now();
  const changesById = buildChangesById();
  for (const { entry, fm } of loadResearchReports()) {
    const recs = Array.isArray(fm.recommended_changes) ? fm.recommended_changes : [];
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.status !== 'scaffolded') continue;
      if (typeof rec.id !== 'string' || !rec.id) continue;
      const ch = changesById.get(rec.id);
      if (!ch) continue;
      if (!IN_FLIGHT_CHANGE_STATUSES.has(ch.status)) continue;
      if (typeof ch.updated !== 'string') continue;
      const updatedMs = Date.parse(ch.updated);
      if (Number.isNaN(updatedMs)) continue;
      if (now - updatedMs < STALE_THRESHOLD_MS) continue;
      const days = Math.floor((now - updatedMs) / (24 * 3600 * 1000));
      findings.push({
        id: 'research-recommended-changes-scaffolded-not-merged',
        severity: 'info',
        path: entry.path,
        message: `Report "${entry.id}" recommends change "${rec.id}" (scaffolded ${days}d ago) but the change is still ${ch.status}`,
        // Multiple recs per report can each produce a finding — disambiguate
        // by rec.id (stable). Day-count drifts daily (#424).
        dedupe_key: rec.id,
        hint: `Check change ${rec.id}'s blockers, or revise the report if the recommendation is stale.`,
      });
    }
  }
  return findings;
}

function checkResearchRecommendedChangesStatusDrift() {
  const findings = [];
  const changesById = buildChangesById();
  for (const { entry, fm } of loadResearchReports()) {
    const recs = Array.isArray(fm.recommended_changes) ? fm.recommended_changes : [];
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object') continue;
      const status = rec.status;
      if (!['scaffolded', 'merged', 'abandoned'].includes(status)) continue;
      if (typeof rec.id !== 'string' || !rec.id) continue;
      const ch = changesById.get(rec.id);
      if (!ch) {
        findings.push({
          id: 'research-recommended-changes-status-drift',
          severity: 'warn',
          path: entry.path,
          message: `Report "${entry.id}" recommends change "${rec.id}" (status: ${status}) but no such change exists`,
          hint: `Re-run /os update research ${entry.id} so recommended_changes[] reflects current change states.`,
        });
        continue;
      }
      const chStatus = ch.status;
      let drifted = false;
      if (status === 'scaffolded' && !IN_FLIGHT_CHANGE_STATUSES.has(chStatus)) drifted = true;
      else if (status === 'merged' && chStatus !== 'merged') drifted = true;
      else if (status === 'abandoned' && chStatus !== 'abandoned') drifted = true;
      if (!drifted) continue;
      findings.push({
        id: 'research-recommended-changes-status-drift',
        severity: 'warn',
        path: entry.path,
        message: `Report "${entry.id}" says change "${rec.id}" is ${status}, but the change's actual status is ${chStatus}`,
        hint: `Re-run /os update research ${entry.id} so recommended_changes[] reflects current change states.`,
      });
    }
  }
  return findings;
}

// Mirror of checkProjectAttribution for report-scoped skills (the five
// research-domain skills). Skip gracefully when the events.db is missing the
// `report_id` column — existing DBs that haven't been re-init'd yet.
function checkReportAttribution() {
  const findings = [];
  if (!existsSync(EVENTS_DB_PATH)) return findings;
  let untagged;
  try {
    const db = new DatabaseSync(EVENTS_DB_PATH);
    const liveCols = db.prepare('PRAGMA table_info(events)').all().map((r) => r.name);
    if (!liveCols.includes('report_id')) {
      db.close();
      return findings;
    }
    const placeholders = [...REPORT_SCOPED_SKILLS].map(() => '?').join(', ');
    untagged = db
      .prepare(`
        SELECT skill, COUNT(*) AS n
        FROM events
        WHERE skill IN (${placeholders})
          AND report_id IS NULL
        GROUP BY skill
        ORDER BY n DESC
      `)
      .all(...REPORT_SCOPED_SKILLS);
    db.close();
  } catch {
    return findings;
  }
  if (untagged.length === 0) return findings;
  const total = untagged.reduce((s, r) => s + r.n, 0);
  const breakdown = untagged.map((r) => `${r.skill}=${r.n}`).join(', ');
  findings.push({
    id: 'events-report-attribution-missing',
    severity: 'warn',
    message: `${total} event${total === 1 ? '' : 's'} with report-scoped skill but null report_id (${breakdown})`,
    hint: 'Audit which writer dropped the report tag — extract-event-attribution.mjs.extractFromPrompt should pull it from the `- report:` line. See standard-event-store.md § Event attribution.',
  });
  return findings;
}

// ---------------------------------------------------------------------------
// App-design checks (regex-based heuristics on apps/<id>/ .tsx files)
// ---------------------------------------------------------------------------

// Walk every .tsx file under domains/<*>/app/src/apps/ AND
// domains/<*>/app/src/shared/. Returns absolute paths.
function walkAppTsx() {
  const out = [];
  const domains = join(REPO_ROOT, 'domains');
  for (const dom of listDirs(domains)) {
    for (const sub of ['apps', 'shared']) {
      const root = join(domains, dom, 'app', 'src', sub);
      if (!existsSync(root)) continue;
      for (const p of walkAllFiles(root)) {
        if (p.endsWith('.tsx')) out.push(p);
      }
    }
  }
  return out;
}

function isUnderApps(absPath) {
  return absPath.includes(`${'/app/src/apps/'}`);
}

function checkAppDesignBannerReducer() {
  const findings = [];
  for (const abs of walkAppTsx()) {
    if (!isUnderApps(abs)) continue;
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    if (!src.includes('<ActionBanner')) continue;
    // Pass predicate: any one of (1) local stateFor definition,
    // (2) imported stateFor, (3) stateFor( call site.
    const hasLocalDef = /\b(?:function|const|let)\s+stateFor\b/.test(src);
    const hasImport = /import\s*\{[^}]*\bstateFor\b[^}]*\}/.test(src);
    const hasCallSite = /\bstateFor\s*\(/.test(src);
    if (hasLocalDef || hasImport || hasCallSite) continue;
    // Count inline if/else branches that set a banner-related prop.
    const ifLines = src.split('\n').filter((l) => /\bif\s*\(/.test(l) && /(tone|title|desc|actions|primary)\b/.test(l));
    if (ifLines.length < 3) continue;
    findings.push({
      id: 'app-design-banner-reducer',
      severity: 'warn',
      path: relative(REPO_ROOT, abs),
      message: `Multi-state <ActionBanner> usage without a stateFor() reducer (${ifLines.length} inline if-branches)`,
      hint: 'Extract a stateFor(entity): EntityState reducer per standard-app-design.md §11.1.',
    });
  }
  return findings;
}

// app-design-dispatch-cap check removed — see decision-remove-dispatch-cost-cap.
// The cost-cap slider was UI-only with no server-side enforcement; rather than
// wire it through, we removed the slider entirely. Cumulative cost is already
// visible via stream-json's `result` events.

function checkAppDesignFilterChips() {
  const findings = [];
  for (const abs of walkAppTsx()) {
    if (!isUnderApps(abs)) continue;
    const isList = /\/apps\/[^/]+\/pages\/List\.tsx$/.test(abs)
      || /\/apps\/[^/]+\/View\.tsx$/.test(abs) && abs.split('/').pop().startsWith('List');
    if (!isList) continue;
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = src.split('\n');
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('<select')) continue;
      const window = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
      if (/statusFilter|setStatusFilter|\bfilter\b|\bstatus\b/.test(window)) { hit = true; break; }
    }
    if (!hit) continue;
    findings.push({
      id: 'app-design-filter-chips',
      severity: 'info',
      path: relative(REPO_ROOT, abs),
      message: `List page uses <select> for status-style filtering instead of filter chips`,
      hint: 'Port to a chip-row using filter chips per standard-app-design.md §11.3.',
    });
  }
  return findings;
}

function checkAppDesignStepper() {
  const findings = [];
  for (const abs of walkAppTsx()) {
    if (!isUnderApps(abs)) continue;
    const isDetail = /\/apps\/[^/]+\/pages\/Detail\.tsx$/.test(abs)
      || /\/apps\/[^/]+\/View\.tsx$/.test(abs);
    if (!isDetail) continue;
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    const hasTabs = src.includes('<DetailTabs') || src.includes('<Tabs') || src.includes('role="tablist"');
    if (!hasTabs) continue;
    if (src.includes('shared/stepper') || src.includes('@/shared/stepper')) continue;
    // Also accept the canonical import-from-barrel: `Stepper` from `'../../../shared'`.
    if (/\bStepper\b/.test(src) && /from\s+['"][^'"]*shared['"]/.test(src)) continue;
    // Per-file opt-out for apps where a stepper is intentionally absent
    // (analytics views, settings panes, anything where the tabs aren't a
    // lifecycle). The marker must appear in source with the literal check
    // id so future readers can see what was opted out and why.
    if (/audit-ignore:\s*app-design-stepper/.test(src)) continue;
    findings.push({
      id: 'app-design-stepper',
      severity: 'info',
      path: relative(REPO_ROOT, abs),
      message: `Detail page renders a tabbar without a <Stepper>`,
      hint: 'Add <Stepper> from shared/stepper.tsx if this page represents a multi-stage workflow; otherwise add a `// audit-ignore: app-design-stepper — <reason>` comment to suppress.',
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Notification hooks — surface dispatcher failure modes that the pipeline
// records but nothing currently watches. Read events.db read-only, join
// against on-disk rule ids.
// ---------------------------------------------------------------------------

function listNotificationRuleIds() {
  // Discover on-disk rule ids by walking each domain's notification-config
  // directory. Mirrors the rules-loader contract without importing server TS.
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const ids = new Set();
  if (!existsSync(wikiDir)) return ids;
  let domains;
  try {
    domains = readdirSync(wikiDir, { withFileTypes: true });
  } catch {
    return ids;
  }
  const SKIP = new Set(['_seed', '_templates']);
  for (const d of domains) {
    if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue;
    const ruleDir = join(wikiDir, d.name, 'notification-config');
    if (!existsSync(ruleDir)) continue;
    let entries;
    try { entries = readdirSync(ruleDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue;
      let raw;
      try { raw = readFileSync(join(ruleDir, e.name), 'utf8'); } catch { continue; }
      const { fm, parseError } = parseFrontmatter(raw);
      if (parseError) continue;
      if (typeof fm.id === 'string') ids.add(fm.id);
    }
  }
  return ids;
}

// Extract `<id>` from `rule:<id>` or `rule:<id>:test` source strings.
function parseRuleSource(source) {
  if (typeof source !== 'string' || !source.startsWith('rule:')) return null;
  const rest = source.slice('rule:'.length);
  const colonIdx = rest.indexOf(':');
  return colonIdx === -1 ? rest : rest.slice(0, colonIdx);
}

function checkNotificationRuleOrphan() {
  const findings = [];
  const eventsDbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(eventsDbPath)) return findings;
  const knownIds = listNotificationRuleIds();
  let db;
  try {
    db = new DatabaseSync(eventsDbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT DISTINCT source, COUNT(*) AS n FROM events WHERE kind = 'notification' AND source LIKE 'rule:%' GROUP BY source"
    ).all();
    const counts = new Map();
    for (const r of rows) {
      const id = parseRuleSource(r.source);
      if (!id) continue;
      if (knownIds.has(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + Number(r.n ?? 0));
    }
    for (const [id, count] of counts) {
      findings.push({
        id: 'notification-rule-orphan',
        severity: 'warn',
        path: `events.db:rule:${id}`,
        message: `Notification events attribute to rule "${id}" but no rule file exists on disk`,
        hint: `Either restore the rule under vault/wiki/<domain>/notification-config/${id}.md OR accept the orphan (${count} historical event row${count !== 1 ? 's' : ''} preserved).`,
      });
    }
  } catch { /* skip */ } finally {
    if (db) { try { db.close(); } catch { /* */ } }
  }
  return findings;
}

function checkNotificationRateLimitExceeded() {
  const findings = [];
  const eventsDbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(eventsDbPath)) return findings;
  let db;
  try {
    db = new DatabaseSync(eventsDbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT source, COUNT(*) AS n FROM events WHERE kind = 'notification' AND action = 'suppressed-rate-limit' AND ts > datetime('now','-1 day') GROUP BY source"
    ).all();
    for (const r of rows) {
      const id = parseRuleSource(r.source) ?? r.source;
      const count = Number(r.n ?? 0);
      findings.push({
        id: 'notification-rate-limit-exceeded',
        severity: 'info',
        path: `events.db:rule:${id}`,
        message: `Rule "${id}" hit its rate-limit cap ${count} time${count !== 1 ? 's' : ''} in the last 24h`,
        // Path unique per rule; count drifts as hits accumulate (#424).
        dedupe_key: '',
        hint: 'Tune cap_per_day on the rule OR ignore — caps biting is by design but worth knowing.',
      });
    }
  } catch { /* skip */ } finally {
    if (db) { try { db.close(); } catch { /* */ } }
  }
  return findings;
}

function checkNotificationDeliveryFailed() {
  const findings = [];
  const eventsDbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(eventsDbPath)) return findings;
  let db;
  try {
    db = new DatabaseSync(eventsDbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT source, COUNT(*) AS n, MAX(description) AS latest_desc FROM events WHERE kind = 'notification' AND action = 'failed' AND ts > datetime('now','-1 day') GROUP BY source"
    ).all();
    for (const r of rows) {
      const id = parseRuleSource(r.source) ?? r.source;
      const count = Number(r.n ?? 0);
      const desc = typeof r.latest_desc === 'string' ? r.latest_desc : '';
      findings.push({
        id: 'notification-delivery-failed',
        severity: 'warn',
        path: `events.db:rule:${id}`,
        message: `Rule "${id}" had ${count} delivery failure${count !== 1 ? 's' : ''} in the last 24h`,
        // Path unique per rule; count + latest-desc drift (#424).
        dedupe_key: '',
        hint: desc ? `Latest: ${desc.slice(0, 200)}` : 'Check the adapter config + channel availability.',
      });
    }
  } catch { /* skip */ } finally {
    if (db) { try { db.close(); } catch { /* */ } }
  }
  return findings;
}

// runbook-orphan — flag runbook entries with a `project:` frontmatter field
// pointing at a project that no longer exists. The schedule-report endpoint
// scaffolds project-scoped runbooks; if the project is later deleted/renamed,
// the runbook keeps firing but its prompt references a non-existent project.
// Severity: warn (it'll generate failing skill runs, not just visual drift).
function checkRunbookOrphan() {
  const findings = [];
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  if (!existsSync(wikiDir)) return findings;
  // First collect every project id on disk.
  const projectIds = new Set();
  for (const p of walkMd(wikiDir)) {
    try {
      const { fm, parseError } = parseFrontmatter(readFileSync(p, 'utf8'));
      if (parseError) continue;
      if (fm?.type === 'project' && typeof fm.id === 'string') projectIds.add(fm.id);
    } catch { /* skip */ }
  }
  // Then walk runbooks and flag any project ref that doesn't resolve.
  for (const p of walkMd(wikiDir)) {
    try {
      const { fm, parseError } = parseFrontmatter(readFileSync(p, 'utf8'));
      if (parseError) continue;
      if (fm?.type !== 'runbook') continue;
      const proj = typeof fm.project === 'string' ? fm.project : null;
      if (!proj) continue;
      if (projectIds.has(proj)) continue;
      const rel = p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
      findings.push({
        id: 'runbook-orphan',
        severity: 'warn',
        path: rel,
        message: `Runbook references project "${proj}" but no project entity has that id`,
        hint: `Either restore the project at vault/wiki/<domain>/project/${proj}.md, edit the runbook to point at a real project, or delete the runbook.`,
      });
    } catch { /* skip */ }
  }
  return findings;
}

// notes-unconsidered-stale — flag research-report notes_log entries with an
// empty considered_by chain AND a ts older than the staleness window. The
// hybrid-persistence model in archetype-research-report expects unconsidered
// notes to be folded into the NEXT research-review/-revise/-update run; if
// they sit untouched for too long, the user added guidance that's silently
// being ignored. Severity: info (advisory; nothing's broken, just stale).
function checkNotesUnconsideredStale() {
  const findings = [];
  const STALE_DAYS = 14;
  const cutoffMs = Date.now() - STALE_DAYS * 24 * 3600 * 1000;
  const reportDir = join(REPO_ROOT, 'vault', 'wiki', 'research', 'research-report');
  if (!existsSync(reportDir)) return findings;
  let entries;
  try { entries = readdirSync(reportDir, { withFileTypes: true }); } catch { return findings; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue;
    const p = join(reportDir, e.name);
    let fm;
    try {
      const parsed = parseFrontmatter(readFileSync(p, 'utf8'));
      if (parsed.parseError) continue;
      fm = parsed.fm;
    } catch { continue; }
    if (!Array.isArray(fm.notes_log)) continue;
    let staleCount = 0;
    let oldestStaleTs = null;
    for (const note of fm.notes_log) {
      if (!note || typeof note !== 'object') continue;
      const considered = Array.isArray(note.considered_by) ? note.considered_by : [];
      if (considered.length > 0) continue;
      const ts = typeof note.ts === 'string' ? Date.parse(note.ts) : NaN;
      if (Number.isNaN(ts) || ts >= cutoffMs) continue;
      staleCount += 1;
      if (oldestStaleTs === null || ts < oldestStaleTs) oldestStaleTs = ts;
    }
    if (staleCount === 0) continue;
    const rel = p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
    const oldestIso = oldestStaleTs ? new Date(oldestStaleTs).toISOString().slice(0, 10) : '(unknown)';
    findings.push({
      id: 'notes-unconsidered-stale',
      severity: 'info',
      path: rel,
      message: `${staleCount} unconsidered note${staleCount !== 1 ? 's' : ''} on research-report "${fm.id}" older than ${STALE_DAYS} days (oldest: ${oldestIso})`,
      // Path unique per report; count + oldestIso drift (#424).
      dedupe_key: '',
      hint: `Re-run /research-review or /research-revise on the report — unconsidered notes are read at the start of each run and get a considered_by entry appended when folded in.`,
    });
  }
  return findings;
}

// dismissed-action-items-stale — flag dismissals in
// .claude/state/dismissed-action-items.jsonl whose audit-check-id is no
// longer in the live check registry. Common cause: a check was renamed or
// removed, but the user's old dismissal still references the old id and
// will never re-fire (so the dismissal is effectively dead). Severity: info
// (housekeeping only — won't break anything, just clutter in the dismissal file).
function checkDismissedActionItemsStale() {
  const findings = [];
  const dismissedPath = join(REPO_ROOT, '.claude', 'state', 'dismissed-action-items.jsonl');
  if (!existsSync(dismissedPath)) return findings;
  let raw;
  try { raw = readFileSync(dismissedPath, 'utf8'); } catch { return findings; }
  // Live audit check ids — extracted from the audit registry markdown so
  // the source of truth stays the wiki standard, not a duplicated list.
  const liveCheckIds = liveAuditCheckIds();
  if (liveCheckIds.size === 0) return findings; // registry unreadable; skip
  const staleByCheck = new Map(); // check_id -> count
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (typeof entry.id !== 'string') continue;
    // Dismissal id format: `audit:<check-id>:<path>:<hash>` (per health.ts).
    if (!entry.id.startsWith('audit:')) continue;
    const parts = entry.id.slice('audit:'.length).split(':');
    if (parts.length === 0) continue;
    const checkId = parts[0];
    if (liveCheckIds.has(checkId)) continue;
    staleByCheck.set(checkId, (staleByCheck.get(checkId) ?? 0) + 1);
  }
  for (const [checkId, count] of staleByCheck) {
    findings.push({
      id: 'dismissed-action-items-stale',
      severity: 'info',
      path: '.claude/state/dismissed-action-items.jsonl',
      message: `${count} dismissal${count !== 1 ? 's' : ''} reference unknown audit check "${checkId}"`,
      hint: `The check was renamed or removed. Edit the file (one JSONL entry per dismissal) to drop the stale rows, or restore the check id under scripts/audit.mjs.`,
    });
  }
  return findings;
}

// env-var-undocumented — flag `process.env.X` reads where `X` isn't
// documented in any `.env.example` file. Per standard-env-config, every
// secret + config var the OS reads must appear in a per-surface .env.example
// so new contributors see the full needed set. Drift catches: "I added a
// new env var to my code but forgot to update .env.example."
//
// Walks server + MCP source code only (not scripts/, not test fixtures).
// Whitelist exempts runtime-injected vars (CLAUDE_PROJECT_DIR) and Node
// conventions (NODE_ENV) that aren't OS-managed secrets.
function checkEnvConfigDrift() {
  const findings = [];
  // Vars exempt from documentation requirement — runtime-injected or Node
  // conventions that aren't OS-managed secrets / config.
  const WHITELIST = new Set([
    'CLAUDE_PROJECT_DIR', // Claude Code injects this; OS doesn't manage it
    'NODE_ENV',           // Node convention; never a secret
    'HOME', 'USER', 'PATH', 'TZ', 'LANG', 'PWD', // shell-inherited
  ]);
  // Source roots to scan. Skips scripts/ + tests + node_modules — those
  // can read whatever; the contract is for server + MCP surfaces.
  const SOURCE_ROOTS = [
    join(REPO_ROOT, 'domains', 'meta', 'app', 'server'),
    join(REPO_ROOT, 'mcps'),
  ];
  // .env.example files to read for documented-var coverage.
  const EXAMPLE_PATTERNS = [
    join(REPO_ROOT, 'domains', '*', 'app', '.env.example'),
    join(REPO_ROOT, 'mcps', '*', '.env.example'),
  ];
  // Collect documented vars from every .env.example file.
  const documented = new Set();
  for (const pattern of EXAMPLE_PATTERNS) {
    // Manual glob walk (no glob dep) — pattern always has one wildcard.
    const [parent, after] = pattern.split('*');
    const tail = after.startsWith('/') ? after.slice(1) : after;
    let entries;
    try { entries = readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = join(parent, e.name, tail);
      if (!existsSync(file)) continue;
      let raw;
      try { raw = readFileSync(file, 'utf8'); } catch { continue; }
      // Match KEY=value lines, including commented-out examples.
      for (const line of raw.split('\n')) {
        const stripped = line.replace(/^#\s*/, '').trim();
        const m = stripped.match(/^([A-Z][A-Z0-9_]*)=/);
        if (m) documented.add(m[1]);
      }
    }
  }
  // Walk source code looking for process.env.X references.
  // referencedBy: Map<varName, Set<relativePath>>
  const referencedBy = new Map();
  function walkCode(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walkCode(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
      let raw;
      try { raw = readFileSync(p, 'utf8'); } catch { continue; }
      const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
      let match;
      while ((match = re.exec(raw)) !== null) {
        const name = match[1];
        const rel = p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
        if (!referencedBy.has(name)) referencedBy.set(name, new Set());
        referencedBy.get(name).add(rel);
      }
    }
  }
  for (const root of SOURCE_ROOTS) walkCode(root);
  // Diff: every referenced var that isn't documented + isn't whitelisted.
  for (const [name, paths] of referencedBy) {
    if (WHITELIST.has(name)) continue;
    if (documented.has(name)) continue;
    const pathsList = Array.from(paths).sort();
    findings.push({
      id: 'env-var-undocumented',
      severity: 'warn',
      path: pathsList[0], // primary file (alphabetically first); message has the rest
      message: `process.env.${name} is read but not documented in any .env.example (${pathsList.length} reference${pathsList.length !== 1 ? 's' : ''})`,
      hint: `Add a commented or uncommented "${name}=" line to the relevant .env.example (domains/<domain>/app/.env.example or mcps/<id>/.env.example) per standard-env-config. Other refs: ${pathsList.slice(1, 3).join(', ') || '(none)'}${pathsList.length > 3 ? ` + ${pathsList.length - 3} more` : ''}.`,
    });
  }
  return findings;
}

// runbook-schedule-invalid — flag runbook entries whose `schedule:` field
// isn't a valid 5-field cron expression. Catches hand-edits that break syntax
// (extra/missing field, garbage chars). The scheduler tick silently skips
// invalid crons today; this surfaces the gap proactively. Severity: warn
// (broken cron = scheduled job never fires).
function checkRunbookScheduleInvalid() {
  const findings = [];
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  if (!existsSync(wikiDir)) return findings;
  for (const p of walkMd(wikiDir)) {
    let fm;
    try {
      const parsed = parseFrontmatter(readFileSync(p, 'utf8'));
      if (parsed.parseError) continue;
      fm = parsed.fm;
    } catch { continue; }
    if (fm?.type !== 'runbook') continue;
    const schedule = typeof fm.schedule === 'string' ? fm.schedule.trim() : null;
    if (!schedule) continue;
    // Basic validation: 5 fields separated by whitespace. Each field
    // non-empty + matches the cron character set (digits, *, /, -, ,).
    const parts = schedule.split(/\s+/);
    let reason = null;
    if (parts.length !== 5) {
      reason = `expected 5 fields, got ${parts.length}`;
    } else {
      const CRON_FIELD = /^[\d*\/,\-]+$/;
      for (let i = 0; i < parts.length; i++) {
        if (!CRON_FIELD.test(parts[i])) {
          reason = `field ${i + 1} ("${parts[i]}") has invalid characters`;
          break;
        }
      }
    }
    if (!reason) continue;
    const rel = p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
    findings.push({
      id: 'runbook-schedule-invalid',
      severity: 'warn',
      path: rel,
      message: `Runbook "${fm.id ?? '(no id)'}" has invalid schedule "${schedule}" — ${reason}`,
      hint: `Fix the cron expression. Example: "0 9 * * *" = every day at 09:00. Five fields: minute hour day-of-month month day-of-week.`,
    });
  }
  return findings;
}

// notification-template-missing-override — info-level hint for catalog events
// that have fired at least once but don't have a per-event template override
// (per standard-template-syntax). Falling through to notification-default.md
// is by-design; this hook is a gentle suggestion that high-fire events would
// benefit from richer messages. Severity: info (not a drift; nudge for polish).
function checkNotificationTemplateMissingOverride() {
  const findings = [];
  const eventsDbPath = join(REPO_ROOT, '.claude', 'state', 'events.db');
  if (!existsSync(eventsDbPath)) return findings;
  // Load catalog event_types (we only suggest templates for catalog events,
  // not random firings of out-of-scope events).
  const catalogEventTypes = new Set();
  const catalogPaths = [
    join(REPO_ROOT, 'vault', 'wiki', 'meta', 'reference', 'event-catalog.md'),
    join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'reference', 'event-catalog.md'),
  ];
  for (const cp of catalogPaths) {
    if (!existsSync(cp)) continue;
    let raw;
    try { raw = readFileSync(cp, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 6) continue;
      const et = cells[1];
      if (/^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(et)) catalogEventTypes.add(et);
    }
    break; // first match wins (active vault > seed)
  }
  if (catalogEventTypes.size === 0) return findings;
  // Existing templates on disk (active + seed).
  const templateDirs = [
    join(REPO_ROOT, 'vault', 'wiki', 'meta', 'template'),
    join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'template'),
  ];
  const haveOverride = new Set();
  for (const dir of templateDirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith('notification-')) continue;
      if (!e.name.endsWith('.md')) continue;
      if (e.name === 'notification-default.md') continue;
      // Reverse the `.` → `-` sanitization template.ts does.
      const base = e.name.slice('notification-'.length, -'.md'.length);
      const lastHyphen = base.lastIndexOf('-');
      // Heuristic: kind is everything up to the last `-` before action; the
      // file convention from notification-per-event-templates is
      // `notification-<kind-as-typed>-<action>.md` (dots replaced with hyphens).
      // To round-trip, try the first hyphen for kind boundary AND match any
      // catalog event_type whose sanitized form matches the filename.
      for (const et of catalogEventTypes) {
        if (et.replace(/\./g, '-') === base) {
          haveOverride.add(et);
          break;
        }
      }
    }
  }
  // Query events.db for fire counts per catalog event.
  let firingCounts = new Map();
  let db;
  try {
    db = new DatabaseSync(eventsDbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT kind || '.' || action AS et, COUNT(*) AS n FROM events WHERE kind != 'notification' GROUP BY et"
    ).all();
    for (const r of rows) firingCounts.set(r.et, Number(r.n ?? 0));
  } catch { /* skip */ } finally {
    if (db) { try { db.close(); } catch { /* */ } }
  }
  // Threshold tuned to flag actively-firing events. Low-fire one-offs
  // (1-4 fires lifetime) are noise; 5+ fires means it's a recurring
  // event where richer prose would be worthwhile.
  const FIRE_THRESHOLD = 5;
  for (const et of catalogEventTypes) {
    if (haveOverride.has(et)) continue;
    const fires = firingCounts.get(et) ?? 0;
    if (fires < FIRE_THRESHOLD) continue;
    findings.push({
      id: 'notification-template-missing-override',
      severity: 'info',
      path: `event-catalog:${et}`,
      message: `Event "${et}" has fired ${fires} time${fires !== 1 ? 's' : ''} but has no per-event template (falls through to notification-default.md)`,
      hint: `Optional: create vault/wiki/_seed/meta/template/notification-${et.replace(/\./g, '-')}.md for richer message rendering. See standard-template-syntax + the 9 example templates already shipped.`,
    });
  }
  return findings;
}

// catalog-lifecycle-step-invalid — flag rows in event-catalog.md whose
// `lifecycle_step` cell references an unknown context. The catalog uses
// `<context>:<step-id>` format; valid contexts are `change`, `research-report`,
// `project`. Typos (e.g. `chnage:scaffolded`) would silently break bell
// rendering — the stepper queries by context prefix and finds nothing.
// Severity: warn (catalog typo = silent bell-disappearance bug).
function checkCatalogLifecycleStepInvalid() {
  const findings = [];
  const VALID_CONTEXTS = new Set(['change', 'research-report', 'project']);
  const catalogPaths = [
    join(REPO_ROOT, 'vault', 'wiki', 'meta', 'reference', 'event-catalog.md'),
    join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'reference', 'event-catalog.md'),
  ];
  for (const cp of catalogPaths) {
    if (!existsSync(cp)) continue;
    let raw;
    try { raw = readFileSync(cp, 'utf8'); } catch { continue; }
    const rel = cp.startsWith(REPO_ROOT) ? cp.slice(REPO_ROOT.length + 1) : cp;
    for (const line of raw.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 6) continue;
      const event_type = cells[1];
      if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(event_type)) continue;
      const stepsRaw = cells[5] ?? '';
      if (!stepsRaw || stepsRaw === '—' || stepsRaw === '-' || stepsRaw === '(none)') continue;
      const steps = stepsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      for (const step of steps) {
        if (!step.includes(':')) {
          findings.push({
            id: 'catalog-lifecycle-step-invalid',
            severity: 'warn',
            path: `${rel}:${event_type}`,
            message: `Catalog row "${event_type}" has malformed lifecycle_step value "${step}" — missing colon (expected <context>:<step-id>)`,
            hint: `Edit ${rel} and fix the lifecycle_step cell. Valid contexts: ${[...VALID_CONTEXTS].join(', ')}.`,
          });
          continue;
        }
        const [context] = step.split(':');
        if (!VALID_CONTEXTS.has(context)) {
          findings.push({
            id: 'catalog-lifecycle-step-invalid',
            severity: 'warn',
            path: `${rel}:${event_type}`,
            message: `Catalog row "${event_type}" references unknown lifecycle context "${context}" in "${step}"`,
            hint: `Valid contexts: ${[...VALID_CONTEXTS].join(', ')}. Edit ${rel} and fix the lifecycle_step cell (typo or invalid context).`,
          });
        }
      }
    }
    break; // first existing wins (active > seed)
  }
  return findings;
}

// dynamic-process-env-indexing — flag `process.env[<expr>]` dynamic accesses
// in server/MCP source. The env-var-undocumented check (E) only catches
// static `process.env.X` accesses; this complements it for cases where
// the env-var name is computed at runtime. Whitelist by file for legit
// loader/bootstrap code (e.g., load-env.ts itself walks all env keys).
// Severity: info (dynamic accesses are rare; usually intentional in loaders).
function checkDynamicProcessEnvIndexing() {
  const findings = [];
  // Files where dynamic process.env indexing is by-design (loader code).
  const WHITELIST_FILES = new Set([
    'domains/meta/app/server/load-env.ts',
    'mcps/github/server.mjs',
    'mcps/vault/server.mjs',
  ]);
  const SOURCE_ROOTS = [
    join(REPO_ROOT, 'domains', 'meta', 'app', 'server'),
    join(REPO_ROOT, 'mcps'),
  ];
  function walkCode(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walkCode(p); continue; }
      if (!e.isFile() || !/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
      const rel = p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
      if (WHITELIST_FILES.has(rel)) continue;
      let raw;
      try { raw = readFileSync(p, 'utf8'); } catch { continue; }
      const re = /process\.env\[/g;
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          findings.push({
            id: 'dynamic-process-env-indexing',
            severity: 'info',
            path: `${rel}:${i + 1}`,
            message: `Dynamic process.env[...] access on line ${i + 1}`,
            hint: `Static access (process.env.X) is preferred so env-var-undocumented can catch missing docs. If this is loader/bootstrap code, add the file to checkDynamicProcessEnvIndexing's WHITELIST_FILES in scripts/audit.mjs.`,
          });
        }
        re.lastIndex = 0; // reset regex for next iteration
      }
    }
  }
  for (const root of SOURCE_ROOTS) walkCode(root);
  return findings;
}

// Read the audit-registry markdown to discover the list of live check ids.
// Single source of truth for what checks exist — mirrors what checkAuditRegistry
// already does for documentation coverage. Returns a Set; empty set means
// the registry file is missing or unparseable (caller should skip drift check).
function liveAuditCheckIds() {
  const registryPath = join(
    REPO_ROOT,
    'vault', 'wiki', '_seed', 'meta', 'reference', 'standard-os-audit.md',
  );
  const ids = new Set();
  if (!existsSync(registryPath)) return ids;
  let raw;
  try { raw = readFileSync(registryPath, 'utf8'); } catch { return ids; }
  // Each registry row starts with `| <check-id> |`. Match cells that look
  // like check-ids (lowercase + hyphens) and aren't header words.
  const HEADER_WORDS = new Set(['check id', 'id', '---']);
  for (const line of raw.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 2) continue;
    const first = cells[1];
    if (!first || HEADER_WORDS.has(first.toLowerCase())) continue;
    // Strip backticks/asterisks that markdown rows use for emphasis.
    const cleaned = first.replace(/[`*]/g, '').trim();
    if (!/^[a-z][a-z0-9-]*$/.test(cleaned)) continue;
    if (cleaned.length < 3) continue; // skip stray short tokens
    ids.add(cleaned);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dispatch — claude spawn-site discipline.
// ---------------------------------------------------------------------------

// Every `claude` subprocess must be spawned via scripts/dispatch-claude.mjs —
// the single source for effort/model resolution. A spawn('claude', …)
// anywhere else silently ignores Settings → Effort/Model; that drift class
// left cron-fired runs unconfigured across two releases (Fable review
// Finding 1.1) because nobody could reliably enumerate the spawn sites.
const DISPATCH_HELPER_REL = 'scripts/dispatch-claude.mjs';

function checkDispatchSpawnSites() {
  const findings = [];
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'repos']);
  const CODE_EXT = /\.(mjs|cjs|js|ts|tsx)$/;
  const spawnRe = /spawn\(\s*['"]claude['"]/;
  const walkCodeFiles = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walkCodeFiles(p));
      else if (e.isFile() && CODE_EXT.test(e.name)) out.push(p);
    }
    return out;
  };
  // The helper itself spawns; this file's own message/hint strings name the
  // pattern, so it would self-match without the exemption.
  const ALLOWED = new Set([DISPATCH_HELPER_REL, 'scripts/audit.mjs']);
  for (const root of ['scripts', 'domains', 'mcps', '.claude/hooks']) {
    for (const p of walkCodeFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, p);
      if (ALLOWED.has(rel)) continue;
      let content;
      try {
        content = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (spawnRe.test(content)) {
        findings.push({
          id: 'dispatch-spawn-outside-helper',
          severity: 'error',
          message: `spawn('claude', …) outside ${DISPATCH_HELPER_REL} — effort/model resolution will not apply to this subprocess`,
          path: rel,
          hint: `import { spawnClaude } (or buildClaudeArgs) from ${DISPATCH_HELPER_REL} so per-skill settings reach the subprocess`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Review-state enum pins — the shared contract (standard-review-state).
// One verdict vocabulary across change plans, research-reports, and project
// plans; plan_status on projects is LIFECYCLE-only. Without these pins the
// three pipelines drift back into private dialects (the pre-contract state:
// projects spelled "awaiting review" as `reviewed-pending` while the other
// two used `pending` — Fable review, Finding 4.2).
// ---------------------------------------------------------------------------

const REVIEW_STATUS_ENUM = new Set([
  'pending',
  'approved',
  'request-changes',
  'rejected',
  'overridden',
  'not-required',
]);
const PLAN_LIFECYCLE_ENUM = new Set([
  'pending',
  'in-research',
  'drafted',
  'scaffolded',
  'active',
]);

function checkReviewStateEnums() {
  const findings = [];
  const manifestPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
  if (!existsSync(manifestPath)) return findings;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return findings;
  }
  for (const e of manifest.entries ?? []) {
    const reviewed = e.type === 'change' || e.type === 'research-report' || e.type === 'project';
    if (!reviewed) continue;
    if (e.review_status != null && !REVIEW_STATUS_ENUM.has(e.review_status)) {
      findings.push({
        id: 'review-status-enum',
        severity: 'error',
        path: e.path,
        message: `review_status '${e.review_status}' is not in the shared enum (${[...REVIEW_STATUS_ENUM].join(' | ')})`,
        hint: 'See standard-review-state — one verdict vocabulary across change / research-report / project. Pre-contract entries: run `node scripts/migrate-review-state.mjs` once (idempotent).',
      });
    }
    if (e.type === 'project' && e.plan_status != null && !PLAN_LIFECYCLE_ENUM.has(e.plan_status)) {
      findings.push({
        id: 'plan-status-enum',
        severity: 'error',
        path: e.path,
        message: `plan_status '${e.plan_status}' is not lifecycle-only (${[...PLAN_LIFECYCLE_ENUM].join(' | ')})`,
        hint: 'Review verdicts moved to review_status (standard-review-state). Run `node scripts/migrate-review-state.mjs` once (idempotent) — it maps legacy reviewed-pending/request-changes/approved to the pair form and renames plan_review_path/plan_reviewed_at.',
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Skill-id constants module — app TS names skills via the generated
// server/lib/skill-ids.ts instead of raw string literals, so a rename or
// deletion is a compile error rather than a silently-stale string (the
// deprecated meta-research-project alias was undeletable for a project phase
// because routes/projects.ts named it by string).
// ---------------------------------------------------------------------------

// The tuning-targets path map (scripts/tuning-targets.mjs) routes non-skill
// Overseer suggestions to real files. A mapped path that no longer exists
// silently reverts those suggestions to rationale-only dead ends — the exact
// failure Finding 3.2 documented — so map rot is an error, not a warning.
function checkTuningTargetPaths() {
  const findings = [];
  for (const { id, path } of missingTargetPaths()) {
    findings.push({
      id: 'tuning-target-path-missing',
      severity: 'error',
      path: 'scripts/tuning-targets.mjs',
      message: `Tuning target "${id}" maps to ${path}, which does not exist`,
      hint: `Update TUNING_TARGETS in scripts/tuning-targets.mjs to the file's new location (or remove the entry if the surface is gone)`,
    });
  }
  return findings;
}

function checkSkillIdsModule() {
  const findings = [];
  const expected = buildSkillIdsSource(listSkillIds(REPO_ROOT));
  const p = join(REPO_ROOT, SKILL_IDS_MODULE_REL);
  if (!existsSync(p)) {
    findings.push({
      id: 'skill-ids-module-stale',
      severity: 'error',
      path: SKILL_IDS_MODULE_REL,
      message: 'Generated skill-ids module is missing',
      hint: 'run: node scripts/generate-skill-ids.mjs',
    });
    return findings;
  }
  if (readFileSync(p, 'utf8') !== expected) {
    findings.push({
      id: 'skill-ids-module-stale',
      severity: 'error',
      path: SKILL_IDS_MODULE_REL,
      message: 'Generated skill-ids module is out of sync with .claude/skills/',
      hint: 'run: node scripts/generate-skill-ids.mjs (meta-add-skill / meta-rename / meta-delete regenerate it as part of their procedures)',
    });
  }
  return findings;
}

// Whole-string literals in app code that LOOK like skill ids but name no
// existing skill — the residue a rename/deletion leaves behind. Three
// legitimate vocabularies share the (dev|meta|research)- prefix space and
// pass: wiki entry ids + skill names (knownTargets), archetype names, and
// events.db ACTION names — sourced from the event-catalog reference, which
// doubles as a nudge to catalogue new actions. Anything else goes in
// STALE_LITERAL_ALLOW with a written reason.
const STALE_LITERAL_ALLOW = new Set([]);

// Action names from event-catalog.md rows (`| dashboard.<action> …`).
function catalogedActionNames() {
  const out = new Set();
  try {
    const text = readFileSync(
      join(REPO_ROOT, 'vault', 'wiki', '_seed', 'meta', 'reference', 'event-catalog.md'),
      'utf8',
    );
    for (const m of text.matchAll(/\|\s*[a-z]+\.([a-z][a-z0-9-]*)/g)) out.add(m[1]);
  } catch {
    /* catalog missing — fall through to the other allowlists */
  }
  return out;
}

function checkStaleSkillLiterals(knownTargets) {
  const findings = [];
  const skillIds = new Set(listSkillIds(REPO_ROOT));
  const catalogActions = catalogedActionNames();
  const archetypes = new Set();
  for (const f of listFiles(join(REPO_ROOT, '_templates', 'wiki-entry'))) {
    if (f.endsWith('.md.tmpl')) archetypes.add(f.replace(/\.md\.tmpl$/, ''));
  }
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
  const CODE_EXT = /\.(ts|tsx|mjs|js)$/;
  const walkCodeFiles = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walkCodeFiles(p));
      else if (e.isFile() && CODE_EXT.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const root of ['domains/meta/app/server', 'domains/meta/app/src']) {
    for (const p of walkCodeFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, p);
      if (rel === SKILL_IDS_MODULE_REL) continue;
      const seen = new Set();
      for (const lit of extractSkillLikeLiterals(readFileSync(p, 'utf8'))) {
        if (seen.has(lit)) continue;
        seen.add(lit);
        if (skillIds.has(lit)) continue;
        if (knownTargets.has(lit)) continue;
        if (archetypes.has(lit)) continue;
        if (catalogActions.has(lit)) continue;
        if (STALE_LITERAL_ALLOW.has(lit)) continue;
        findings.push({
          id: 'app-stale-skill-literal',
          severity: 'error',
          path: rel,
          message: `String literal '${lit}' looks like a skill id but no such skill exists`,
          hint: 'Renamed or deleted skill? Reference skills via SKILL.<NAME> from server/lib/skill-ids.ts; if the literal is a legitimate non-skill term, add it to STALE_LITERAL_ALLOW with a reason.',
        });
      }
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const sections = {
    skills: args.length === 0 || args.includes('--all') || args.includes('--skills'),
    wiki: args.length === 0 || args.includes('--all') || args.includes('--wiki'),
    domains: args.length === 0 || args.includes('--all') || args.includes('--domains'),
    templates: args.length === 0 || args.includes('--all') || args.includes('--templates'),
    router: args.length === 0 || args.includes('--all') || args.includes('--router'),
    logs: args.length === 0 || args.includes('--all') || args.includes('--logs'),
    dispatch: args.length === 0 || args.includes('--all') || args.includes('--dispatch'),
  };
  // If only --json was passed, run all
  if (args.length === 1 && args[0] === '--json') {
    for (const k of Object.keys(sections)) sections[k] = true;
  }

  const domains = discoverDomains();
  const archetypes = discoverArchetypes();
  const skillNames = discoverSkillNames();
  // Build the unified set of valid wikilink targets: every wiki entry id
  // plus every installed skill name. EditableMarkdown's link renderer
  // resolves polymorphically (skill → Skills view, else → Vault view).
  const entryIds = new Set();
  for (const p of walkMd(join(REPO_ROOT, 'vault', 'wiki'))) {
    try {
      const { fm } = parseFrontmatter(readFileSync(p, 'utf8'));
      if (fm?.id) entryIds.add(fm.id);
    } catch {
      /* skip unreadable */
    }
  }
  const knownTargets = new Set([...entryIds, ...skillNames]);

  const findings = [];

  if (sections.skills) findings.push(...checkSkills(domains, knownTargets));
  if (sections.skills) {
    findings.push(...checkSkillIdsModule());
    findings.push(...checkStaleSkillLiterals(knownTargets));
    findings.push(...checkTuningTargetPaths());
  }
  if (sections.wiki) findings.push(...checkWiki(domains, archetypes, knownTargets));
  if (sections.domains) {
    findings.push(...checkDomains());
    findings.push(...checkPlaybookSkillCoverage(domains));
  }
  if (sections.templates) findings.push(...checkTemplates(archetypes));
  if (sections.router) findings.push(...checkRouter());
  if (sections.logs) findings.push(...checkLogs());
  if (sections.dispatch) findings.push(...checkDispatchSpawnSites());
  if (sections.wiki) findings.push(...checkManifestFreshness());
  if (sections.wiki) findings.push(...checkReviewStateEnums());
  // Event store schema drift — cheap, runs unconditionally.
  findings.push(...checkEventsDb());
  findings.push(...checkEventAttribution());
  findings.push(...checkProjectAttribution());
  findings.push(...checkPlanFileOrphan());
  findings.push(...checkPlanStatusStuckInResearch());
  findings.push(...checkPlanApprovedButUnscaffolded());
  findings.push(...checkMaterialsOrphan());
  // Research-lifecycle drift (mirrors the project-orchestration block above).
  findings.push(...checkResearchMaterialsStale());
  findings.push(...checkResearchOrphanMaterialsDir());
  findings.push(...checkResearchRecommendedChangesScaffoldedNotMerged());
  findings.push(...checkResearchRecommendedChangesStatusDrift());
  findings.push(...checkReportAttribution());
  // App-design heuristics (regex-based; warn-severity ones tightened to avoid
  // canonical-app false positives — see standard-app-design.md §11).
  findings.push(...checkAppDesignBannerReducer());
  // app-design-dispatch-cap retired — see decision-remove-dispatch-cost-cap.
  findings.push(...checkAppDesignFilterChips());
  findings.push(...checkAppDesignStepper());
  findings.push(...checkChangesPrFrozen());
  findings.push(...checkRepoKnowledgeStale());
  findings.push(...checkPrReviewCacheOrphans());
  findings.push(...checkDualWriteParity());
  findings.push(...checkInstallerCoverage());
  // MCP manifests + .mcp.json freshness — cheap, runs unconditionally.
  findings.push(...checkMcps());
  findings.push(...checkEventsDbFreshness());
  findings.push(...checkGitSyncGap());
  findings.push(...checkOrphanRunJsonl());
  findings.push(...checkStalePrReviewStatus());
  findings.push(...checkDeferredCommentsAge());
  // Notification pipeline hooks — read events.db + join against on-disk rules.
  findings.push(...checkNotificationRuleOrphan());
  findings.push(...checkNotificationRateLimitExceeded());
  findings.push(...checkNotificationDeliveryFailed());
  // New-state coverage hooks (session 2026-05-30): runbook references,
  // research-report notes_log staleness, dismissed-action-items drift.
  findings.push(...checkRunbookOrphan());
  findings.push(...checkNotesUnconsideredStale());
  findings.push(...checkDismissedActionItemsStale());
  // env-config drift: process.env.X reads without matching .env.example doc.
  findings.push(...checkEnvConfigDrift());
  // Self-healing fills (standard-self-healing known gaps): cron syntax,
  // template overrides, catalog typos, dynamic env indexing.
  findings.push(...checkRunbookScheduleInvalid());
  findings.push(...checkNotificationTemplateMissingOverride());
  findings.push(...checkCatalogLifecycleStepInvalid());
  findings.push(...checkDynamicProcessEnvIndexing());
  // Duplicate id detection across the wiki tree.
  findings.push(...checkDuplicateWikiIds());
  // Project automation health hooks (Phase 1.5+): stuck-running > 60min,
  // stale-paused > 7d. Both read the project frontmatter's automation block
  // and the last_transition timestamp.
  findings.push(...checkAutomationStuckRunning());
  findings.push(...checkAutomationStalePaused());
  // Audit-of-audit always runs (no section flag) — it's cheap (two file reads)
  // and the drift it catches is global to the audit registry, not scoped.
  findings.push(...checkAuditRegistry());

  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const infos = findings.filter((f) => f.severity === 'info');

  if (json) {
    console.log(JSON.stringify({ findings, summary: { error: errors.length, warn: warns.length, info: infos.length } }, null, 2));
  } else {
    const print = (group, label) => {
      if (group.length === 0) return;
      console.log(`\n${label} (${group.length})`);
      console.log('─'.repeat(60));
      for (const f of group) {
        const where = f.path ? ` ${f.path}` : '';
        console.log(`  [${f.id}]${where}`);
        console.log(`    ${f.message}`);
        if (f.hint) console.log(`    → ${f.hint}`);
      }
    };
    print(errors, '✗ ERRORS');
    print(warns, '⚠ WARNINGS');
    print(infos, 'ℹ INFO');

    console.log();
    if (findings.length === 0) {
      console.log('✓ OS audit clean — no findings.');
    } else {
      console.log(
        `Summary: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}, ${infos.length} info`,
      );
    }
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main();
