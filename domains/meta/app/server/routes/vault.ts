import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT, safePath } from '../repo.js';

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...(await walkFiles(p)));
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  } catch {
    /* dir missing */
  }
  return out;
}

export const vaultRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/index', async () => {
    const path = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
    try {
      const content = await readFile(path, 'utf8');
      return JSON.parse(content);
    } catch {
      return { version: 1, generated: null, entries: [] };
    }
  });

  fastify.get<{ Querystring: { path: string } }>('/entry', async (req, reply) => {
    const { path } = req.query;
    const abs = safePath(path);
    try {
      const [content, s] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
      return { path, content, mtime: new Date(s.mtimeMs).toISOString() };
    } catch (e) {
      // Distinguish "not found" (so callers like Overview can show an empty
      // state without logging a console error) from other read failures.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reply.code(404);
        return { path, content: null, mtime: null, error: 'not_found' };
      }
      throw e;
    }
  });

  fastify.get('/raw', async () => {
    const dir = join(REPO_ROOT, 'vault', 'raw');
    const files = await walkFiles(dir);
    return {
      files: files
        .map((p) => relative(REPO_ROOT, p))
        .filter((p) => !p.endsWith('.gitkeep'))
        .sort(),
    };
  });

  fastify.get('/output', async () => {
    const dir = join(REPO_ROOT, 'vault', 'output');
    const files = await walkFiles(dir);
    return {
      files: files
        .map((p) => relative(REPO_ROOT, p))
        .filter((p) => !p.endsWith('.gitkeep'))
        .sort(),
    };
  });

  // Freshness check: compare manifest.generated against the newest wiki file mtime.
  // Returns `stale: true` if any wiki entry has been modified since the last rebuild.
  fastify.get('/freshness', async () => {
    const indexPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
    let generated: string | null = null;
    try {
      const m = JSON.parse(await readFile(indexPath, 'utf8'));
      generated = m.generated;
    } catch {
      /* no index yet */
    }

    const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
    const files = await walkFiles(wikiDir);
    const mdFiles = files.filter((p) => p.endsWith('.md'));

    let newestMs = 0;
    const generatedMs = generated ? Date.parse(generated) : 0;
    let newerCount = 0;

    for (const p of mdFiles) {
      try {
        const s = await stat(p);
        if (s.mtimeMs > newestMs) newestMs = s.mtimeMs;
        if (generatedMs > 0 && s.mtimeMs > generatedMs) newerCount += 1;
      } catch {
        /* skip */
      }
    }

    return {
      generated,
      newest_mtime: newestMs > 0 ? new Date(newestMs).toISOString() : null,
      stale: generated === null || newerCount > 0,
      newer_count: newerCount,
      total_files: mdFiles.length,
    };
  });

  // Trigger a fresh index rebuild. Shells out to the same Node script the
  // PostToolUse hook uses (.claude/hooks/rebuild-vault-index.mjs), so behavior
  // is identical to auto-rebuild — just user-triggered.
  fastify.post('/reindex', async () => {
    const scriptPath = join(REPO_ROOT, '.claude', 'hooks', 'rebuild-vault-index.mjs');
    return new Promise((resolve) => {
      const child = spawn('node', [scriptPath], { cwd: REPO_ROOT });
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      child.on('close', async (code) => {
        if (code === 0) {
          try {
            const indexPath = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
            const content = await readFile(indexPath, 'utf8');
            const manifest = JSON.parse(content);
            resolve({
              ok: true,
              entries: manifest.entries?.length ?? 0,
              generated: manifest.generated,
            });
          } catch (e) {
            resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        } else {
          resolve({ ok: false, error: stderr || `exit ${code}` });
        }
      });
      child.on('error', (e) => {
        resolve({ ok: false, error: e.message });
      });
    });
  });
};
