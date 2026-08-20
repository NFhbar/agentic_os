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

// The repo-entity fields the dispatch gates need. Both come from the same
// entry, so callers that want both pay for one wiki walk.
export interface RepoEntityFacts {
  local_path: string | null;
  default_branch: string | null;
}

// Resolve the change's repo entity. Mirrors the inline walk in changes.ts's
// replay endpoint (that version lives inside a route handler and isn't
// exported; duplicating locally beats coupling route modules). Null when the
// entity doesn't exist — callers treat that as "unknown", never as a fact.
export async function resolveRepoEntity(repoId: string | null): Promise<RepoEntityFacts | null> {
  if (!repoId) return null;
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'entity' || fm.kind !== 'repo' || fm.id !== repoId) continue;
      return {
        local_path: typeof fm.local_path === 'string' ? fm.local_path : null,
        default_branch: typeof fm.default_branch === 'string' ? fm.default_branch : null,
      };
    } catch {
      /* skip */
    }
  }
  return null;
}

// Local-path-only convenience over resolveRepoEntity — the shape most callers
// want, kept so they don't all have to destructure.
export async function resolveRepoLocalPath(repoId: string | null): Promise<string | null> {
  return (await resolveRepoEntity(repoId))?.local_path ?? null;
}

// The branch currently checked out in the clone.
//   - branch set   — a named branch is checked out
//   - 'degraded'   — no path / dir missing / git or spawn failure / detached
//                    HEAD (`rev-parse --abbrev-ref` prints "HEAD" there, which
//                    names no branch and must not be compared against one)
// Same fail-open posture as readWorkingTreeStatus: an unknown branch is not
// evidence of a wrong branch.
export function readCurrentBranch(localPath: string | null): {
  branch: string | null;
  degraded: boolean;
} {
  if (!localPath) return { branch: null, degraded: true };
  try {
    if (!existsSync(localPath)) return { branch: null, degraded: true };
    const res = spawnSync('git', ['-C', localPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    });
    if (res.error || res.status !== 0) return { branch: null, degraded: true };
    const branch = (res.stdout ?? '').trim();
    if (branch === '' || branch === 'HEAD') return { branch: null, degraded: true };
    return { branch, degraded: false };
  } catch {
    return { branch: null, degraded: true };
  }
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
export function readWorkingTreeStatus(localPath: string | null): {
  dirty_files: string[];
  degraded: boolean;
} {
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
