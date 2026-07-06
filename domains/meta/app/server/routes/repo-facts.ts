// Leaf helpers for repo/git/entity fact-gathering shared by the orchestrator
// (automation.ts) and the run dispatcher (runs.ts). Lives in its own file so
// neither route module has to import the other — the same route-coupling
// tension pr-review-lookup.ts's header documents. Pure I/O: each function
// gathers facts; the decisions over them are the pure functions in
// automation-state-machine.ts.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';

// Recursively collect every .md file under `dir`, skipping dotfiles/dotdirs.
// Returns absolute paths. Missing/unreadable dirs yield an empty list.
export async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Resolve the change's repo entity → local_path. Mirrors the inline walk in
// changes.ts's replay endpoint (that version lives inside a route handler and
// isn't exported; duplicating locally beats coupling route modules).
export async function resolveRepoLocalPath(repoId: string | null): Promise<string | null> {
  if (!repoId) return null;
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'entity' || fm.kind !== 'repo' || fm.id !== repoId) continue;
      return typeof fm.local_path === 'string' ? fm.local_path : null;
    } catch {
      /* skip */
    }
  }
  return null;
}

// Read the change branch's head SHA, classifying the outcome for
// evaluateArtifactMovement:
//   - head set            — ref resolved
//   - 'ref-not-found'     — repo dir present, git ran, ref doesn't exist
//                           (determinate: the branch has no commits)
//   - 'degraded'          — no branch configured / dir missing / git or
//                           spawn failure (unknown — gate must stay inert)
export function readBranchHead(
  localPath: string | null,
  branch: string | null,
): { head: string | null; head_error: 'ref-not-found' | 'degraded' | null } {
  if (!localPath || !branch) return { head: null, head_error: 'degraded' };
  try {
    if (!existsSync(localPath)) return { head: null, head_error: 'degraded' };
    const res = spawnSync(
      'git',
      ['-C', localPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { encoding: 'utf8' },
    );
    if (res.error) return { head: null, head_error: 'degraded' };
    if (res.status === 0) {
      const sha = (res.stdout ?? '').trim();
      return sha ? { head: sha, head_error: null } : { head: null, head_error: 'degraded' };
    }
    // `--verify --quiet` exits 1 (silently) for a missing ref; other codes
    // (128 = not a repo, etc.) are infrastructure failures.
    if (res.status === 1) return { head: null, head_error: 'ref-not-found' };
    return { head: null, head_error: 'degraded' };
  } catch {
    return { head: null, head_error: 'degraded' };
  }
}

// Probe the working tree for uncommitted changes via `git status --porcelain`.
// Feeds the clean-tree dispatch gate: an EXECUTE-bound dispatch against a dirty
// clone burns a full run to learn what porcelain says in 10ms. Returns the
// (trimmed) porcelain lines when clean-read, `degraded: true` on any git/spawn
// failure so the caller fails OPEN (the skill's own pre-branch abort stays the
// precise backstop).
export function readWorkingTreeStatus(
  localPath: string | null,
): { dirty_files: string[]; degraded: boolean } {
  if (!localPath) return { dirty_files: [], degraded: true };
  try {
    if (!existsSync(localPath)) return { dirty_files: [], degraded: true };
    const res = spawnSync('git', ['-C', localPath, 'status', '--porcelain'], { encoding: 'utf8' });
    if (res.error || res.status !== 0) return { dirty_files: [], degraded: true };
    const dirty_files = (res.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    return { dirty_files, degraded: false };
  } catch {
    return { dirty_files: [], degraded: true };
  }
}
