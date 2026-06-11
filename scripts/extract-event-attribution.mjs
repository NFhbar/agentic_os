// Shared event attribution helpers — the single place that knows how to lift
// { change_id, project, domain } out of dashboard prompts, CLI intents, or
// edited file paths. Used by every recordEvent() caller so the attribution
// format only has to evolve in one place.
//
// Why centralize: the original ad-hoc regexes in action.ts and
// record-router-event.mjs got out of sync with the actual log format and
// silently dropped change_id for months. One helper + one audit check =
// no more silent regressions.
//
// See standard-event-store.md for the contract: events whose skill is one of
// CHANGE_SCOPED_SKILLS MUST carry change_id; the audit warns when they don't.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '..', 'vault', '.index', 'manifest.json');

// Skills that operate on an EXISTING change. Events tagged with these skills
// MUST have change_id set — the audit check enforces this.
//
// `dev-add-change` is deliberately NOT in this set: it CREATES the change,
// so the change_id is the *output* of the skill, not an input. Events that
// fire before / during the create (router intent, skill dispatcher) can't
// know the id yet. If `dev-add-change` later emits a "created change X"
// event with the id known, that event should still be tagged via the
// normal extractor — the audit just doesn't *require* it.
export const CHANGE_SCOPED_SKILLS = new Set([
  'dev-write-change',
  'dev-review-change',
  'dev-open-pr',
  'dev-close-change',
  'dev-pr-review',
  'dev-address-comments',
]);

// Skills that operate on an EXISTING project. Events tagged with these skills
// MUST have project set — the audit check enforces this.
//
// `meta-add-project` is deliberately NOT in this set: it CREATES the project,
// so the project id is the *output* of the skill, not an input — same shape
// as `dev-add-change`'s exclusion above.
export const PROJECT_SCOPED_SKILLS = new Set([
  'meta-review-project-plan',
  'meta-revise-project-plan',
  'meta-scaffold-project-plan',
]);

// Skills that operate on an EXISTING research-report. Events tagged with
// these skills MUST have report_id set — the audit check enforces this.
//
// Every research-domain skill operates on an existing report (there is no
// `research-add-report` analogue to `dev-add-change` / `meta-add-project`),
// so the full set is in scope here — no exclusion line needed.
export const REPORT_SCOPED_SKILLS = new Set([
  'research-write',
  'research-review',
  'research-revise',
  'research-update',
  'research-scaffold-recommendations',
]);

// Pull a kebab-case id from `<field>: "..."` / `<field>: ...` lines in
// prompt-like text. Used by dashboard action prompts.
function extractField(text, field) {
  if (!text) return null;
  const quoted = new RegExp(`\\b${field}:\\s*["']([a-z0-9][a-z0-9-]*)["']`, 'i');
  const m1 = text.match(quoted);
  if (m1) return m1[1];
  const bare = new RegExp(`\\b${field}:\\s+([a-z0-9][a-z0-9-]*)\\b`, 'i');
  const m2 = text.match(bare);
  return m2 ? m2[1] : null;
}

/**
 * Extract { change_id, project, domain, report_id } from a dashboard-style
 * prompt body (the kind that includes `Inputs:\n- change: "<id>"` blocks).
 */
export function extractFromPrompt(prompt) {
  return {
    change_id: extractField(prompt, 'change'),
    project: extractField(prompt, 'project'),
    domain: extractField(prompt, 'domain'),
    // Research-app dispatches use `report_id:` (not bare `report:`) in the
    // prompt body. extractField tries the exact field name first; the second
    // call catches the canonical `report:` form used by record-dashboard-action
    // and the audit skills. Either form lands in the same extracted value.
    report_id: extractField(prompt, 'report_id') ?? extractField(prompt, 'report'),
  };
}

/**
 * Extract the skill name from a dashboard-action prompt body. Dashboard
 * scaffolders embed the SKILL.md path; if absent (raw `/os ...` text, plain
 * prompts), returns null and the caller may fall back to other signals.
 */
export function extractSkill(prompt) {
  if (!prompt) return null;
  const m = prompt.match(/\.claude\/skills\/([a-z0-9-]+)\/SKILL\.md/);
  return m ? m[1] : null;
}

/**
 * Extract { change_id, project } from a router-log intent string (the raw
 * phrase a user typed after `/os`, e.g. "write change add-license" or
 * "status report ship-v1"). Handles both hyphenated and space-separated
 * verb forms since the router stores the original phrasing.
 */
export function extractFromIntent(intent) {
  if (!intent) return { change_id: null, project: null, report_id: null };
  const changeMatch = intent.match(
    /\b(?:write|review|open|close|address)[ -]change\s+([a-z0-9][a-z0-9-]*)\b/i,
  );
  const projectMatch = intent.match(
    /\b(?:status\s+report|add[- ]project)\s+([a-z0-9][a-z0-9-]*)\b/i,
  );
  // Research router intents support BOTH orderings (per OS.md § Intent
  // vocabulary — `research write`, `write research`, etc.):
  //
  //   Pattern A — `research <verb> <id>` (canonical kebab form)
  //   Pattern B — `<verb> research <id>` (natural English form, used by
  //               dashboard action-item hints like `/os update research X`)
  //
  // Without both, router-logged research dispatches lose report attribution
  // when the user types the English-ordering form — surfaced by audit check
  // `events-report-attribution-missing`.
  const reportMatchA = intent.match(
    /\bresearch[ -](?:write|review|revise|update|scaffold(?:[ -]recommendations)?)\s+([a-z0-9][a-z0-9-]*)\b/i,
  );
  const reportMatchB = intent.match(
    /\b(?:write|review|revise|update|refresh|author)[ -]research(?:\s+report)?\s+([a-z0-9][a-z0-9-]*)\b/i,
  );
  return {
    change_id: changeMatch ? changeMatch[1] : null,
    project: projectMatch ? projectMatch[1] : null,
    report_id: reportMatchA ? reportMatchA[1] : reportMatchB ? reportMatchB[1] : null,
  };
}

/**
 * Extract { change_id, domain } from a repo-relative file path. Handles the
 * canonical change layout: `vault/wiki/<domain>/change/<id>.md`. Returns
 * nulls for paths that don't match.
 */
export function extractFromPath(path) {
  if (!path) return { change_id: null, domain: null };
  const m = path.match(/vault\/wiki\/([a-z0-9-]+)\/change\/([a-z0-9-]+)\.md$/);
  if (!m) return { change_id: null, domain: null };
  return { domain: m[1], change_id: m[2] };
}

/**
 * Resolve a pr-review entry id to its owning change_id by reading the vault
 * manifest. Returns { change_id: null } when the review doesn't exist, has
 * no change_id (external PR), or the manifest can't be read.
 *
 * Used by record-dashboard-action.mjs so review-side events (pr-review-publish,
 * pr-comment-mutate) inherit the change_id even though their args carry only
 * a `review:` field. Without this lookup, those events land with change_id:null
 * and the Changes app's activity timeline misses them.
 */
export function extractFromReviewId(reviewId) {
  if (!reviewId || typeof reviewId !== 'string') return { change_id: null };
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const entry = manifest.entries?.find(
      (e) => e?.id === reviewId && e?.type === 'pr-review',
    );
    return { change_id: entry?.change_id ?? null };
  } catch {
    return { change_id: null };
  }
}

/**
 * Resolve a research-report entry id to its owning project by reading the
 * vault manifest. Returns { project: null } when the report doesn't exist or
 * the manifest can't be read.
 *
 * Used by record-dashboard-action.mjs so research-side events
 * (research-write, research-update, …) inherit the `project` even when their
 * args carry only a `report:` field. Without this lookup, those events land
 * with project=null and the owning project's rollup misses them.
 */
export function extractFromReportId(reportId) {
  if (!reportId || typeof reportId !== 'string') return { project: null };
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const entry = manifest.entries?.find(
      (e) => e?.id === reportId && e?.type === 'research-report',
    );
    return { project: entry?.project ?? null };
  } catch {
    return { project: null };
  }
}

/**
 * Convenience: merge { change_id, project, domain, report_id } from any
 * source into a single non-null object. Use when an event may have multiple
 * signals (e.g. dashboard edit with both a path AND a prompt). First-non-null
 * wins.
 */
export function mergeAttributions(...sources) {
  const out = { change_id: null, project: null, domain: null, report_id: null };
  for (const src of sources) {
    if (!src) continue;
    if (src.change_id && !out.change_id) out.change_id = src.change_id;
    if (src.project && !out.project) out.project = src.project;
    if (src.domain && !out.domain) out.domain = src.domain;
    if (src.report_id && !out.report_id) out.report_id = src.report_id;
  }
  return out;
}
