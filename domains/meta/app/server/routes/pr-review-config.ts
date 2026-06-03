// /api/pr-review/config — read + write the PR Review singleton config doc.
//
// GET returns the parsed config as JSON. PUT accepts a partial config update,
// validates each field, recomputes the custom_instructions hash when the
// instructions change, and writes back via a full-frontmatter rewrite (the
// frontmatter has no comments to preserve so dumping the whole block is
// safe; the document body stays untouched).
//
// The frontend's contract is the JSON shape below — kept as a TS interface so
// the frontend can share it. Field names match the YAML frontmatter directly.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { rewriteFrontmatter, serializeYamlValue } from '../frontmatter-rewrite.js';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type { PrReviewConfig, PrReviewConfigUpdateBody } from './pr-review-config.types.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./pr-review-config.types.js per standard-shared-types.
export type {
  CommentStyle,
  ContextStrategy,
  PrReviewConfig,
  PrReviewConfigUpdateBody,
} from './pr-review-config.types.js';

// Look in both user-override location and the seeded default. User edits to
// the live config could either go in the _seed file (and live with upstream
// merge conflicts) or in a sibling override path — we honor either, user
// wins.
const CONFIG_CANDIDATES = [
  join(REPO_ROOT, 'vault', 'wiki', 'development', 'reference', 'reference-pr-review-config.md'),
  join(
    REPO_ROOT,
    'vault',
    'wiki',
    '_seed',
    'development',
    'reference',
    'reference-pr-review-config.md',
  ),
];

function resolveConfigPath(): string | null {
  for (const p of CONFIG_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// Editable field allowlist. Anything not in this set is rejected by PUT —
// keeps the API surface narrow and prevents callers from injecting arbitrary
// frontmatter fields. context_strategy is editable but only accepts
// 'full-diff' for now (other values are documented future work).
const EDITABLE_FIELDS = new Set([
  'primary_model',
  'analyzer_model',
  'comment_style',
  'focus_areas',
  'context_strategy',
  'custom_instructions',
]);

const COMMENT_STYLES = new Set(['terse', 'concise', 'detailed']);
const CONTEXT_STRATEGIES = new Set(['full-diff']);

// Local alias for the request-body type (kept short for use inside validator).
type UpdateBody = PrReviewConfigUpdateBody;

// Validate the incoming partial update. Returns either { ok: true, updates }
// with normalized values, or { ok: false, error } with a human-readable
// reason. Unknown fields fail loud (not silent) so the frontend can't drift.
function validateUpdate(
  body: unknown,
): { ok: true; updates: UpdateBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const updates: UpdateBody = {};
  const b = body as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!EDITABLE_FIELDS.has(key))
      return { ok: false, error: `unknown or read-only field: ${key}` };
  }

  if ('primary_model' in b) {
    if (typeof b.primary_model !== 'string' || !b.primary_model.trim()) {
      return { ok: false, error: 'primary_model must be a non-empty string' };
    }
    updates.primary_model = b.primary_model.trim();
  }
  if ('analyzer_model' in b) {
    if (typeof b.analyzer_model !== 'string' || !b.analyzer_model.trim()) {
      return { ok: false, error: 'analyzer_model must be a non-empty string' };
    }
    updates.analyzer_model = b.analyzer_model.trim();
  }
  if ('comment_style' in b) {
    if (typeof b.comment_style !== 'string' || !COMMENT_STYLES.has(b.comment_style)) {
      return { ok: false, error: `comment_style must be one of ${[...COMMENT_STYLES].join(', ')}` };
    }
    updates.comment_style = b.comment_style as UpdateBody['comment_style'];
  }
  if ('focus_areas' in b) {
    if (!Array.isArray(b.focus_areas) || !b.focus_areas.every((x) => typeof x === 'string')) {
      return { ok: false, error: 'focus_areas must be an array of strings' };
    }
    if (b.focus_areas.length === 0) {
      return { ok: false, error: 'focus_areas must have at least one entry' };
    }
    updates.focus_areas = b.focus_areas as string[];
  }
  if ('context_strategy' in b) {
    if (typeof b.context_strategy !== 'string' || !CONTEXT_STRATEGIES.has(b.context_strategy)) {
      return {
        ok: false,
        error: `context_strategy must be one of ${[...CONTEXT_STRATEGIES].join(', ')}`,
      };
    }
    updates.context_strategy = b.context_strategy as UpdateBody['context_strategy'];
  }
  if ('custom_instructions' in b) {
    if (typeof b.custom_instructions !== 'string') {
      return { ok: false, error: 'custom_instructions must be a string' };
    }
    updates.custom_instructions = b.custom_instructions;
  }

  return { ok: true, updates };
}

function hashInstructions(text: string): string | null {
  if (!text) return null;
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

// Note: `serializeYamlValue` and `rewriteFrontmatter` were lifted to
// `server/frontmatter-rewrite.ts` to share with notification rule CRUD.

export const prReviewConfigRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (_req, reply) => {
    const path = resolveConfigPath();
    if (!path) {
      reply.code(404);
      return {
        ok: false,
        error: 'reference-pr-review-config.md not found',
        hint: 'Shipped by default in _seed/development/reference/ — restore from upstream or run install.sh',
      };
    }
    const content = await readFile(path, 'utf8');
    const { fm, parseError } = parseFrontmatter(content);
    if (parseError) {
      reply.code(500);
      return { ok: false, error: 'config YAML parse error', detail: parseError };
    }

    const config: PrReviewConfig = {
      primary_model: asString(fm.primary_model, 'claude-opus-4-7'),
      analyzer_model: asString(fm.analyzer_model, asString(fm.primary_model, 'claude-opus-4-7')),
      comment_style:
        (asString(fm.comment_style, 'concise') as PrReviewConfig['comment_style']) ?? 'concise',
      focus_areas: asStringArray(fm.focus_areas),
      context_strategy:
        (asString(fm.context_strategy, 'full-diff') as PrReviewConfig['context_strategy']) ??
        'full-diff',
      custom_instructions: asString(fm.custom_instructions),
      custom_instructions_hash:
        typeof fm.custom_instructions_hash === 'string' ? fm.custom_instructions_hash : null,
      source_path: relative(REPO_ROOT, path),
      updated: asString(fm.updated) || null,
    };
    return { config };
  });

  // PUT /api/pr-review/config — apply a partial update to the singleton.
  // Only fields in EDITABLE_FIELDS are accepted; unknown fields fail loud.
  // custom_instructions_hash is recomputed automatically when the text
  // changes. Writes the full frontmatter back via js-yaml dump (which loses
  // any in-frontmatter comments, but the doc only has body comments so this
  // is safe). Records a `pr-review-config-update` event on success.
  fastify.put<{ Body: unknown }>('/', async (req, reply) => {
    const path = resolveConfigPath();
    if (!path) {
      reply.code(404);
      return {
        ok: false,
        error: 'reference-pr-review-config.md not found',
      };
    }

    const validation = validateUpdate(req.body);
    if (!validation.ok) {
      reply.code(400);
      return { ok: false, error: validation.error };
    }
    const updates = validation.updates;

    // Read existing config, validate, write back ONLY the changed lines.
    const content = await readFile(path, 'utf8');
    const { parseError } = parseFrontmatter(content);
    if (parseError) {
      reply.code(500);
      return { ok: false, error: 'config YAML parse error', detail: parseError };
    }

    const nowIso = new Date().toISOString();
    // Surgical write: only the fields the user actually changed + bookkeeping.
    // Everything else in the frontmatter (id, created, tags, last_verified,
    // …) stays bit-for-bit as authored.
    const lineUpdates: Record<string, unknown> = { ...updates, updated: nowIso };
    if ('custom_instructions' in updates) {
      lineUpdates.custom_instructions_hash = hashInstructions(updates.custom_instructions ?? '');
    }

    let newContent: string;
    try {
      newContent = rewriteFrontmatter(content, lineUpdates);
    } catch (e) {
      reply.code(500);
      return { ok: false, error: `frontmatter rewrite failed: ${(e as Error).message}` };
    }

    await writeFile(path, newContent, 'utf8');

    // Best-effort event log. The wrapper script handles JSONL + events.db
    // dual-write AND the manifest rebuild (since files_touched includes a
    // vault/wiki/ path).
    try {
      const { spawnSync } = await import('node:child_process');
      spawnSync(
        'node',
        [
          join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
          '--action',
          'pr-review-config-update',
          '--args',
          JSON.stringify({ fields: Object.keys(updates) }),
          '--files-touched',
          JSON.stringify([relative(REPO_ROOT, path)]),
          '--exit-status',
          '0',
        ],
        { cwd: REPO_ROOT, stdio: 'ignore' },
      );
    } catch {
      /* event logging is best-effort; the write itself succeeded */
    }

    // Return the updated config so the frontend doesn't need a follow-up GET.
    const updatedFm = parseFrontmatter(newContent).fm;
    const config: PrReviewConfig = {
      primary_model: asString(updatedFm.primary_model, 'claude-opus-4-7'),
      analyzer_model: asString(
        updatedFm.analyzer_model,
        asString(updatedFm.primary_model, 'claude-opus-4-7'),
      ),
      comment_style:
        (asString(updatedFm.comment_style, 'concise') as PrReviewConfig['comment_style']) ??
        'concise',
      focus_areas: asStringArray(updatedFm.focus_areas),
      context_strategy:
        (asString(updatedFm.context_strategy, 'full-diff') as PrReviewConfig['context_strategy']) ??
        'full-diff',
      custom_instructions: asString(updatedFm.custom_instructions),
      custom_instructions_hash:
        typeof updatedFm.custom_instructions_hash === 'string'
          ? updatedFm.custom_instructions_hash
          : null,
      source_path: relative(REPO_ROOT, path),
      updated: asString(updatedFm.updated) || null,
    };
    return { ok: true, config };
  });
};
