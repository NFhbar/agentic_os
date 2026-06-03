import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { recordEvent } from '../../../../../scripts/events-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractFromPath } from '../../../../../scripts/extract-event-attribution.mjs';
import { REPO_ROOT, safePath } from '../repo.js';

// Paths the dashboard is allowed to write to directly (non-AI edits).
// Other paths must go through /api/action (which uses Claude's tools, with
// their own permission system).
const ALLOWED_PREFIXES = ['vault/wiki/', 'vault/raw/', 'vault/output/', 'domains/', 'OS.md'];

const AUDIT_LOG = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');

function isAllowed(rel: string): boolean {
  return ALLOWED_PREFIXES.some((p) => rel === p || rel.startsWith(p));
}

export const editRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { path: string; content: string } }>('/', async (req, reply) => {
    const { path, content } = req.body;
    const abs = safePath(path);
    const rel = relative(REPO_ROOT, abs);

    if (!isAllowed(rel)) {
      reply.code(403);
      return { ok: false, error: `path not editable from dashboard: ${rel}` };
    }

    const startedMs = Date.now();
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    const ts = new Date().toISOString();

    await mkdir(dirname(AUDIT_LOG), { recursive: true });
    await appendFile(
      AUDIT_LOG,
      JSON.stringify({
        ts,
        action: 'edit',
        files_touched: [rel],
        exit_status: 0,
      }) + '\n',
    );

    // Mirror to events.db for cross-action analytics. The vault file itself
    // remains the source of knowledge truth; this row is just "an edit happened."
    // Attribution lifts change_id + domain from the edited path when it matches
    // the canonical change layout (vault/wiki/<domain>/change/<id>.md).
    const attr = extractFromPath(rel);
    recordEvent({
      ts,
      kind: 'dashboard',
      action: 'edit',
      source: 'dashboard',
      change_id: attr.change_id,
      domain: attr.domain,
      duration_ms: Date.now() - startedMs,
      exit_status: 0,
      status: 'success',
      files_touched: [rel],
      description: `edited ${rel}`,
    });

    return { ok: true };
  });
};
