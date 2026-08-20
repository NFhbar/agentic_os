// Unit coverage for the git-sync audit decision table
// (scripts/audit-git-sync.mjs). The impure half — checkGitSyncGap in
// scripts/audit.mjs — shells out for the local + remote shas and maps each
// decision `kind` to a finding id; it can't be imported here because audit.mjs
// pulls node:sqlite at module top (vitest's resolver can't load it). These
// tests pin the fork-mode contract: a fork is measured against its
// `upstream_reviewed_sha` stamp, never against the local clone, and its hint
// never says merge / rebase / pull.

import { describe, expect, it } from 'vitest';
import { classifyGitSync } from '../../../scripts/audit-git-sync.mjs';

const LOCAL = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function classify(over: Partial<Parameters<typeof classifyGitSync>[0]> = {}) {
  return classifyGitSync({
    repoId: 'some-repo',
    branch: 'main',
    localPath: '/repos/some-repo',
    localSha: LOCAL,
    remoteSha: REMOTE,
    ...over,
  });
}

describe('classifyGitSync — default (tracking) repos', () => {
  it('local == origin → no finding', () => {
    expect(classify({ remoteSha: LOCAL })).toEqual([]);
  });

  it('missing either sha → no finding (git read failed)', () => {
    expect(classify({ localSha: '' })).toEqual([]);
    expect(classify({ remoteSha: '' })).toEqual([]);
  });

  it('divergence → info sync-gap with the ff-pull hint', () => {
    const out = classify();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'sync-gap', severity: 'info' });
    expect(out[0].message).toBe(
      `Local main (${LOCAL.slice(0, 7)}) diverges from origin/main (${REMOTE.slice(0, 7)}) for repo "some-repo".`,
    );
    expect(out[0].hint).toBe(
      'Run: git -C /repos/some-repo checkout main && git pull --ff-only origin main',
    );
  });

  it('an unrelated sync_policy value is treated as tracking', () => {
    const out = classify({ syncPolicy: 'mirror' });
    expect(out.map((d) => d.kind)).toEqual(['sync-gap']);
  });
});

describe('classifyGitSync — fork repos', () => {
  it('origin still at the reviewed stamp → no finding', () => {
    expect(
      classify({ syncPolicy: 'fork', reviewedSha: REMOTE.slice(0, 12) }),
    ).toEqual([]);
  });

  it('local strictly ahead of origin is the intentional divergence → no finding', () => {
    // local != remote (would fire for a tracking repo), but origin has not
    // moved past the stamp.
    const out = classify({
      syncPolicy: 'fork',
      localSha: LOCAL,
      remoteSha: REMOTE,
      reviewedSha: REMOTE.slice(0, 12),
    });
    expect(out).toEqual([]);
  });

  it('origin beyond the stamp → info upstream-unreviewed naming the reviewed sha', () => {
    const out = classify({ syncPolicy: 'fork', reviewedSha: '0123456789ab' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'upstream-unreviewed', severity: 'info' });
    expect(out[0].message).toContain('has commits not yet reviewed for fork repo "some-repo"');
    expect(out[0].message).toContain('last reviewed 0123456789ab');
  });

  it('the review-and-stamp hint carries the log range and the next stamp', () => {
    const out = classify({ syncPolicy: 'fork', reviewedSha: '0123456789ab' });
    expect(out[0].hint).toContain('git -C /repos/some-repo fetch origin main');
    expect(out[0].hint).toContain('git log 0123456789ab..origin/main');
    expect(out[0].hint).toContain(`upstream_reviewed_sha: ${REMOTE.slice(0, 12)}`);
  });

  it('never suggests merge / rebase / pull', () => {
    for (const reviewedSha of ['0123456789ab', null]) {
      const out = classify({ syncPolicy: 'fork', reviewedSha });
      expect(out).toHaveLength(1);
      expect(out[0].hint).not.toMatch(/\bgit (merge|rebase|pull)\b/);
      expect(out[0].hint).toContain('never merge/rebase/pull');
    }
  });

  it('no stamp at all → unreviewed finding with an unbounded log', () => {
    const out = classify({ syncPolicy: 'fork', reviewedSha: null });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'upstream-unreviewed', severity: 'info' });
    expect(out[0].message).toContain('no upstream_reviewed_sha stamp');
    expect(out[0].hint).toContain('git log origin/main');
  });

  it('the sha12 stamp matches the full 40-char origin sha it was cut from', () => {
    // The stamp is stored short; the ls-remote read is full-length.
    expect(classify({ syncPolicy: 'fork', reviewedSha: REMOTE.slice(0, 12) })).toEqual([]);
    expect(classify({ syncPolicy: 'fork', reviewedSha: REMOTE })).toEqual([]);
  });
});
