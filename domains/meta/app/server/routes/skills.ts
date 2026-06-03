import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const dir = join(REPO_ROOT, '.claude', 'skills');
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const skillDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

      const results = await Promise.all(
        skillDirs.map(async (e) => {
          const skillPath = join(dir, e.name, 'SKILL.md');
          try {
            const [content, st] = await Promise.all([readFile(skillPath, 'utf8'), stat(skillPath)]);
            const { fm, parseError } = parseFrontmatter(content);
            return {
              name: e.name,
              description: (fm.description as string) ?? null,
              domain: (fm.domain as string) ?? null,
              version: typeof fm.version === 'number' ? fm.version : null,
              tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
              inputs:
                fm.inputs && typeof fm.inputs === 'object' && !Array.isArray(fm.inputs)
                  ? (fm.inputs as Record<string, unknown>)
                  : {},
              userInvocable: fm['user-invocable'] === true,
              modified: st.mtime.toISOString(),
              parseError,
            };
          } catch {
            return null;
          }
        }),
      );

      return { skills: results.filter((s) => s !== null) };
    } catch {
      return { skills: [] };
    }
  });
};
