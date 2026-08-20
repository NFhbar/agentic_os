// Pure decision table for the git-sync audit (scripts/audit.mjs's
// checkGitSyncGap). Separated from the `git rev-parse` / `git ls-remote` reads
// so the branch → finding contract is unit-testable: audit.mjs imports
// node:sqlite at module top, which vitest's resolver can't load, so the impure
// half can't be imported by a test. checkGitSyncGap shells out for the shas and
// feeds the facts in here; it maps each returned decision `kind` to a finding
// `id` (keeping the id literals in audit.mjs so the audit-check-id scanners
// still see them).
//
// Two sync policies:
//
// - **default** (no `sync_policy`, or anything other than `fork`) — the local
//   clone is expected to track origin. Any divergence between local
//   `<branch>` and `origin/<branch>` is a sync gap; the hint is a ff-pull.
// - **fork** (`sync_policy: fork` + `upstream_reviewed_sha: <sha12>`) — the
//   repo permanently diverges from origin: never pushed, never merged. Local
//   being ahead of origin IS the point, so it never fires. What DOES fire is
//   origin moving past the `upstream_reviewed_sha` stamp — upstream commits
//   nobody has looked at yet. The hint is review-and-stamp: fetch, read the
//   log range, re-implement what fits locally, then re-stamp. It must NEVER
//   suggest merge / rebase / pull — those would destroy the divergence the
//   fork exists for.

export const FORK_SYNC_POLICY = 'fork';

// The stamp is a short sha (`<sha12>`); the shas we read are full 40-char
// hashes. Compare on the shorter of the two so either width matches.
function shaMatches(a, b) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/**
 * @param {object} facts
 * @param {string}      facts.repoId        entity `id`
 * @param {string}      facts.branch        `default_branch` (or the `main` fallback)
 * @param {string}      facts.localPath     entity `local_path` (used in hints)
 * @param {string}      facts.localSha      local `<branch>` HEAD
 * @param {string}      facts.remoteSha     `origin/<branch>` HEAD (via ls-remote)
 * @param {string|null} [facts.syncPolicy]  entity `sync_policy`
 * @param {string|null} [facts.reviewedSha] entity `upstream_reviewed_sha`
 * @returns {Array<{kind: string, severity: string, message: string, hint: string}>}
 */
export function classifyGitSync({
  repoId,
  branch,
  localPath,
  localSha,
  remoteSha,
  syncPolicy = null,
  reviewedSha = null,
}) {
  const decisions = [];
  if (!localSha || !remoteSha) return decisions;

  if (syncPolicy === FORK_SYNC_POLICY) {
    // Never compare local to origin — the divergence is intentional.
    if (reviewedSha && shaMatches(remoteSha, reviewedSha)) return decisions;
    const range = reviewedSha ? `${reviewedSha}..origin/${branch}` : `origin/${branch}`;
    decisions.push({
      kind: 'upstream-unreviewed',
      severity: 'info',
      message: reviewedSha
        ? `origin/${branch} (${remoteSha.slice(0, 7)}) has commits not yet reviewed for fork repo "${repoId}" (last reviewed ${reviewedSha}).`
        : `origin/${branch} (${remoteSha.slice(0, 7)}) has never been reviewed for fork repo "${repoId}" (no upstream_reviewed_sha stamp).`,
      hint: `Fork — never merge/rebase/pull. Run: git -C ${localPath} fetch origin ${branch} && git log ${range} — re-implement upstream work that fits locally, then stamp \`upstream_reviewed_sha: ${remoteSha.slice(0, 12)}\` on the entity.`,
    });
    return decisions;
  }

  if (localSha === remoteSha) return decisions;
  decisions.push({
    kind: 'sync-gap',
    severity: 'info',
    message: `Local ${branch} (${localSha.slice(0, 7)}) diverges from origin/${branch} (${remoteSha.slice(0, 7)}) for repo "${repoId}".`,
    hint: `Run: git -C ${localPath} checkout ${branch} && git pull --ff-only origin ${branch}`,
  });
  return decisions;
}
