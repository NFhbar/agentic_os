import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';

// Normalized event shape — every line in every JSONL stream gets mapped here
// so the frontend can render them in a single chronological feed.
export interface NormalizedEvent {
  ts: string;
  source: string; // basename of the source .jsonl (e.g. "router-log.jsonl")
  kind: 'router' | 'dashboard' | 'schedule' | 'unknown';
  summary: string;
  // biome-ignore lint/suspicious/noExplicitAny: raw event payload varies per source
  raw: any;
}

// Map filename → high-level event kind. Unknown filenames fall back to 'unknown'.
const KIND_BY_FILE: Record<string, NormalizedEvent['kind']> = {
  'router-log.jsonl': 'router',
  'dashboard-actions.jsonl': 'dashboard',
  'scheduled-runs.jsonl': 'schedule',
};

function truncate(s: string, n: number): string {
  if (!s) return '';
  // Collapse whitespace (including newlines) before truncating — long AI
  // prompts contain newlines that wreck the single-line summary layout.
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

// biome-ignore lint/suspicious/noExplicitAny: raw event shape varies
function summarize(file: string, raw: any): string {
  switch (file) {
    case 'router-log.jsonl': {
      const intent = raw.intent ?? '(no intent)';
      const skill = raw.matched_skill ?? '(no match)';
      const confidence = raw.confidence ?? '?';
      return `"${truncate(intent, 60)}" → ${skill} (${confidence})`;
    }
    case 'dashboard-actions.jsonl': {
      const action = raw.action ?? 'unknown';
      const exit = raw.exit_status;
      const exitTag = exit === 0 ? '✓' : exit !== undefined ? `✗ exit ${exit}` : '';
      if (action === 'ai-prompt') {
        return `AI: ${truncate(raw.prompt ?? '(empty prompt)', 80)} ${exitTag}`.trim();
      }
      const args = raw.args ? ` ${truncate(JSON.stringify(raw.args), 60)}` : '';
      const filesTouched =
        Array.isArray(raw.files_touched) && raw.files_touched.length > 0
          ? ` · ${raw.files_touched.length} file${raw.files_touched.length === 1 ? '' : 's'}`
          : '';
      return `${action}${args}${filesTouched} ${exitTag}`.trim();
    }
    case 'scheduled-runs.jsonl': {
      const id = raw.id ?? '(unknown)';
      const manual = raw.manual ? ' (manual)' : '';
      // Branch on `outcome` first so skip + spawn-error get clean rendering
      // (skipped runs are HEALTHY precondition-gates — they shouldn't surface
      // as `✗ exit undefined`). Legacy entries without `outcome` fall through
      // to the exit-code logic for back-compat.
      if (raw.outcome === 'skipped') {
        const reason = raw.skip_reason ? `: ${raw.skip_reason}` : '';
        return `${id}${manual} ↷ skipped${reason}`;
      }
      if (raw.outcome === 'spawn-error') {
        return `${id}${manual} ✗ spawn-error`;
      }
      const exit = raw.exit;
      const duration = raw.duration_ms;
      const exitTag =
        exit === 0
          ? '✓'
          : exit === null || exit === undefined
            ? '✗ failed'
            : `✗ exit ${exit}`;
      const durTag = typeof duration === 'number' ? ` · ${duration}ms` : '';
      return `${id}${manual} ${exitTag}${durTag}`;
    }
    default: {
      // Unknown source — best-effort one-liner.
      const keys = Object.keys(raw)
        .filter((k) => k !== 'ts')
        .slice(0, 3);
      return keys.map((k) => `${k}=${truncate(String(raw[k]), 30)}`).join(' · ');
    }
  }
}

async function readEvents(file: string): Promise<NormalizedEvent[]> {
  const path = join(REPO_ROOT, 'vault', 'raw', file);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: NormalizedEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const ts = typeof raw.ts === 'string' ? raw.ts : null;
      if (!ts) continue; // skip records without timestamps — they can't be ordered
      out.push({
        ts,
        source: file,
        kind: KIND_BY_FILE[file] ?? 'unknown',
        summary: summarize(file, raw),
        raw,
      });
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

async function listJsonlFiles(): Promise<string[]> {
  const dir = join(REPO_ROOT, 'vault', 'raw');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
  } catch {
    return [];
  }
}

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/events?limit=200&kinds=router,schedule&since=<iso>
  fastify.get<{ Querystring: { limit?: string; kinds?: string; since?: string } }>(
    '/',
    async (req) => {
      const limit = req.query.limit
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 2000)
        : 200;
      const kindFilter = req.query.kinds
        ? new Set(req.query.kinds.split(',').map((s) => s.trim()))
        : null;
      const sinceMs = req.query.since ? Date.parse(req.query.since) : 0;

      const files = await listJsonlFiles();
      const all: NormalizedEvent[] = [];
      for (const f of files) {
        const events = await readEvents(f);
        all.push(...events);
      }

      // Filter
      const filtered = all.filter((e) => {
        if (kindFilter && !kindFilter.has(e.kind)) return false;
        if (sinceMs > 0 && Date.parse(e.ts) < sinceMs) return false;
        return true;
      });

      // Sort newest first, then slice
      filtered.sort((a, b) => b.ts.localeCompare(a.ts));

      // Aggregate source counts BEFORE slicing so the UI can show
      // "showing 200 of 1453 (router: 800, dashboard: 400, schedule: 253)".
      const counts: Record<string, number> = {};
      for (const e of all) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

      return {
        events: filtered.slice(0, limit),
        total: filtered.length,
        all_total: all.length,
        counts,
        sources: files,
      };
    },
  );
};
