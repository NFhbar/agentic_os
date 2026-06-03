// Shared utilities for resolving the repo root and validating paths.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// server/index.ts lives at domains/meta/app/server — three up to repo root.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../../../..');

export function safePath(rel: string): string {
  const abs = resolve(REPO_ROOT, rel);
  if (!abs.startsWith(REPO_ROOT)) {
    throw new Error('path escapes repo root');
  }
  return abs;
}
