import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';
import type { CurationItem } from './curation.types.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./curation.types.js per standard-shared-types.
export type { CurationItem, CurationListResponse } from './curation.types.js';

// System files that live inside vault/raw/ but are NOT curation candidates.
const SYSTEM_FILES = new Set(['router-log.jsonl', 'dashboard-actions.jsonl', '.gitkeep']);

// Walk vault/raw/ for files that look like curation candidates (skipping
// system logs, hidden files, and the .archived/ subtree).
async function listRawCandidates(): Promise<string[]> {
  const out: string[] = [];
  const root = join(REPO_ROOT, 'vault', 'raw');

  async function walk(dir: string) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const name = String(e.name);
        if (name.startsWith('.')) continue; // skips .archived/, .gitkeep, etc.
        const p = join(dir, name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.isFile() && !SYSTEM_FILES.has(name)) {
          out.push(relative(REPO_ROOT, p));
        }
      }
    } catch {
      /* unreadable dir */
    }
  }

  await walk(root);
  return out;
}

export const curationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const queuePath = join(REPO_ROOT, '.claude', 'state', 'pending-curation.txt');

    let queueLines: string[] = [];
    try {
      const content = await readFile(queuePath, 'utf8');
      queueLines = content.split('\n').filter((l) => l.trim().length > 0);
    } catch {
      /* no queue yet */
    }

    const queueSet = new Set(queueLines);

    // Union queue paths with disk scan — discovered items are on disk but
    // not in the queue (external drops that bypassed the PostToolUse hook).
    const rawCandidates = await listRawCandidates();
    const allPaths = new Set<string>([...queueLines, ...rawCandidates]);

    const items: CurationItem[] = await Promise.all(
      [...allPaths].map(async (rel) => {
        const abs = join(REPO_ROOT, rel);
        let preview = '(could not read)';
        let mtime: string | null = null;
        try {
          const [c, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
          preview = c.slice(0, 400);
          mtime = st.mtime.toISOString();
        } catch {
          /* file missing or unreadable — keep placeholder */
        }
        return {
          path: rel,
          preview,
          mtime,
          discovered: !queueSet.has(rel),
        };
      }),
    );

    // Sort: queue items first (oldest first within), then discovered items by newest mtime.
    items.sort((a, b) => {
      if (a.discovered !== b.discovered) return a.discovered ? 1 : -1;
      return (b.mtime ?? '').localeCompare(a.mtime ?? '');
    });

    return { items };
  });

  fastify.post<{ Body: { path: string } }>('/ignore', async (req) => {
    const queuePath = join(REPO_ROOT, '.claude', 'state', 'pending-curation.txt');
    try {
      const content = await readFile(queuePath, 'utf8');
      const remaining = content
        .split('\n')
        .filter((l) => l.trim().length > 0 && l !== req.body.path)
        .join('\n');
      await writeFile(queuePath, remaining.length ? remaining + '\n' : '');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // File upload: drag-and-drop / browse files from the dashboard go here.
  // Multipart form-data; each file is saved into vault/raw/ and added to the queue.
  fastify.post('/upload', async (req) => {
    const rawDir = join(REPO_ROOT, 'vault', 'raw');
    await mkdir(rawDir, { recursive: true });

    const queuePath = join(REPO_ROOT, '.claude', 'state', 'pending-curation.txt');
    const queueLines = new Set<string>();
    try {
      const content = await readFile(queuePath, 'utf8');
      for (const l of content.split('\n')) {
        if (l.trim().length > 0) queueLines.add(l);
      }
    } catch {
      /* no queue yet */
    }

    const saved: string[] = [];
    const skipped: string[] = [];

    const parts = req.files();
    for await (const part of parts) {
      // Sanitize filename: strip path separators and leading dots, fallback if empty.
      const submitted = (part.filename ?? '').replace(/[/\\]/g, '_').replace(/^\.+/, '');
      const baseName = submitted || `dropped-${Date.now()}.bin`;

      let finalName = baseName;
      let abs = join(rawDir, finalName);
      try {
        await access(abs);
        // Collision — append ISO timestamp before the extension.
        const ext = extname(baseName);
        const stem = basename(baseName, ext);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        finalName = `${stem}-${stamp}${ext}`;
        abs = join(rawDir, finalName);
      } catch {
        /* no collision */
      }

      // Final safety: ensure the resolved path is still inside vault/raw/.
      if (!abs.startsWith(`${rawDir}/`)) {
        skipped.push(submitted);
        continue;
      }

      try {
        await pipeline(part.file, createWriteStream(abs));
        const rel = `vault/raw/${finalName}`;
        saved.push(rel);
        queueLines.add(rel);
      } catch (e) {
        skipped.push(`${submitted}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Persist queue updates if anything was saved.
    if (saved.length > 0) {
      const newContent = [...queueLines].join('\n') + '\n';
      await writeFile(queuePath, newContent);
    }

    return { ok: true, saved, skipped };
  });
};
