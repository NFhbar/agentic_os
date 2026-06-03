import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';

export interface VocabRow {
  intents: string[];
  skill: string;
}

// Parse the "Intent vocabulary" markdown table from OS.md.
// Looks for a heading matching /Intent vocabulary/i, then reads the first
// markdown table that follows.
export function parseIntentVocabulary(osMdContent: string): VocabRow[] {
  const lines = osMdContent.split('\n');

  let i = lines.findIndex((l) => /^#{2,4}\s+Intent vocabulary/i.test(l));
  if (i < 0) return [];

  // Advance to the first table row (starts with |)
  while (i < lines.length && !lines[i].trim().startsWith('|')) i++;
  if (i >= lines.length) return [];

  // Skip the header row + separator row
  i += 2;

  const rows: VocabRow[] = [];
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    const cells = lines[i]
      .trim()
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length >= 2) {
      const intents = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const skillMatch = cells[1].match(/`([^`]+)`/);
      if (skillMatch && intents.length > 0) {
        rows.push({ intents, skill: skillMatch[1] });
      }
    }
    i++;
  }
  return rows;
}

export const commandsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    try {
      const content = await readFile(join(REPO_ROOT, 'OS.md'), 'utf8');
      return { vocabulary: parseIntentVocabulary(content) };
    } catch {
      return { vocabulary: [] };
    }
  });
};
