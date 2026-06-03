import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';

// Stub. Layer 9 adds tailing, aggregation, miss-rate computation.
export const routerLogRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const path = join(REPO_ROOT, 'vault', 'raw', 'router-log.jsonl');
    try {
      const content = await readFile(path, 'utf8');
      const lines = content
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((x) => x !== null);
      return { entries: lines };
    } catch {
      return { entries: [] };
    }
  });
};
