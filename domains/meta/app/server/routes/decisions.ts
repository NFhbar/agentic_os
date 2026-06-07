// /api/decisions — Phase 4.1 surface for decisions that gate Phase 4 apply
// runs. Lists every `decision`-archetype entry under vault/wiki/meta/decision/
// that has `implements_tuning_suggestions` populated (the Phase 4 marker).
//
// Used by the Overseer Overview's <DecisionsPanel> to render decisions as
// first-class citizens with status + validation count + inline action buttons.
// Generic decisions (those without implements_tuning_suggestions — e.g. older
// architectural decisions) are excluded; they're documentation, not action
// surfaces.

import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';

const DECISIONS_DIR = join(REPO_ROOT, 'vault', 'wiki', 'meta', 'decision');

interface ImplementsRef {
  audit_id: string;
  suggestion_index: number;
}

interface TargetMetric {
  type: 'tag_frequency_decrease' | 'skill_score_increase' | 'pattern_absence' | string;
  name: string;
  baseline: number;
  target: number;
  scope: string;
  window_audits: number;
}

interface ValidationObservation {
  audit_id: string;
  observed_at: string;
  qualifies: boolean;
  metric_value: number;
  notes: string;
}

export interface DecisionSummary {
  id: string;
  path: string;
  title: string;
  status:
    | 'proposed'
    | 'accepted'
    | 'deprecated'
    | 'superseded'
    | 'validated'
    | 'regressed'
    | string;
  validation_result: 'pending' | 'validated' | 'regressed' | 'inconclusive' | null;
  implements_tuning_suggestions: ImplementsRef[];
  target_metric: TargetMetric | null;
  validation_observations_count: number;
  validation_window: number | null; // target_metric.window_audits when present
  // Set by meta-apply-tuning-suggestion after a successful apply run. Powers
  // the dashboard's "✓ applied" state — without it, the panel can't tell
  // "accepted, ready to apply" from "accepted, apply already done."
  applied_at: string | null;
  created: string | null;
  updated: string | null;
}

// Project a decision entry's frontmatter to the summary shape. Only entries
// with implements_tuning_suggestions populated are surfaced — they're the
// Phase 4 decisions the panel is designed for. Generic decisions (purely
// documentary) are filtered out.
// biome-ignore lint/suspicious/noExplicitAny: frontmatter is arbitrary YAML
function toSummary(fm: any, filePath: string): DecisionSummary | null {
  const implementsRaw = Array.isArray(fm.implements_tuning_suggestions)
    ? fm.implements_tuning_suggestions
    : null;
  if (!implementsRaw || implementsRaw.length === 0) return null;

  // Filter to well-formed refs only — malformed entries silently drop rather
  // than corrupting the surface.
  const implementsList: ImplementsRef[] = implementsRaw.filter((x: unknown): x is ImplementsRef => {
    if (!x || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    return typeof o.audit_id === 'string' && typeof o.suggestion_index === 'number';
  });
  if (implementsList.length === 0) return null;

  let targetMetric: TargetMetric | null = null;
  if (fm.target_metric && typeof fm.target_metric === 'object') {
    const tm = fm.target_metric as Record<string, unknown>;
    if (
      typeof tm.type === 'string' &&
      typeof tm.name === 'string' &&
      typeof tm.baseline === 'number' &&
      typeof tm.target === 'number' &&
      typeof tm.scope === 'string' &&
      typeof tm.window_audits === 'number'
    ) {
      targetMetric = tm as unknown as TargetMetric;
    }
  }

  const observationsRaw = Array.isArray(fm.validation_observations)
    ? fm.validation_observations
    : [];

  const validationResultRaw = fm.validation_result;
  const validation_result =
    validationResultRaw === 'pending' ||
    validationResultRaw === 'validated' ||
    validationResultRaw === 'regressed' ||
    validationResultRaw === 'inconclusive'
      ? validationResultRaw
      : null;

  return {
    id: String(fm.id ?? ''),
    path: relative(REPO_ROOT, filePath),
    title: String(fm.title ?? '(untitled decision)'),
    status: String(fm.status ?? 'proposed'),
    validation_result,
    implements_tuning_suggestions: implementsList,
    target_metric: targetMetric,
    validation_observations_count: observationsRaw.length,
    validation_window: targetMetric?.window_audits ?? null,
    // js-yaml auto-parses ISO timestamps into Date objects under the default
    // schema. Coerce to ISO string for the wire shape — accept strings
    // (manual frontmatter) AND Dates (auto-parsed by js-yaml) AND drop
    // anything else as null. Same coercion for created/updated.
    applied_at: asIsoString(fm.applied_at),
    created: asIsoString(fm.created),
    updated: asIsoString(fm.updated),
  };
}

function asIsoString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return null;
}

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    out.push(join(dir, e.name));
  }
  return out;
}

export const decisionsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/decisions — list all Phase 4 decisions (those with
  // implements_tuning_suggestions). Sorted by status priority (proposed
  // first — these need user action — then accepted, then everything else)
  // and within priority by updated descending.
  fastify.get('/', async () => {
    const files = await walkMd(DECISIONS_DIR);
    const out: DecisionSummary[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'decision') continue;
      const summary = toSummary(fm, file);
      if (summary) out.push(summary);
    }
    // Status priority — proposed surfaces highest because they need action.
    const statusPriority = (s: string): number => {
      if (s === 'proposed') return 0;
      if (s === 'accepted') return 1;
      if (s === 'validated') return 2;
      if (s === 'regressed') return 3;
      return 4;
    };
    out.sort((a, b) => {
      const pa = statusPriority(a.status);
      const pb = statusPriority(b.status);
      if (pa !== pb) return pa - pb;
      const at = a.updated ?? a.created ?? '';
      const bt = b.updated ?? b.created ?? '';
      return bt.localeCompare(at);
    });
    return { decisions: out };
  });
};
