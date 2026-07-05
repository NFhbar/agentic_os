import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs module without type declarations
import { composeSignersLine, isNoreplyEmail, planConfigWrites, signersHasKey } from '../../scripts/setup-repo-identity.mjs';

const OPTS = {
  pubPath: '/home/u/.ssh/agentic_os_signing.pub',
  signersPath: '/home/u/.ssh/agentic_os_allowed_signers',
  email: '23327624+NFhbar@users.noreply.github.com',
};

// Machines like the live reference already inherit both values from scope.
const REFERENCE_EFFECTIVE = { 'gpg.format': 'ssh', 'commit.gpgsign': 'true' };
const FRESH_EFFECTIVE = { 'gpg.format': null, 'commit.gpgsign': null };

const keys = (writes: Array<{ key: string; value: string }>) => writes.map((w) => w.key);

describe('isNoreplyEmail', () => {
  it('accepts id+login and legacy noreply forms, rejects real emails', () => {
    expect(isNoreplyEmail('23327624+NFhbar@users.noreply.github.com')).toBe(true);
    expect(isNoreplyEmail('NFhbar@users.noreply.github.com')).toBe(true);
    expect(isNoreplyEmail('  23327624+NFhbar@users.noreply.github.com ')).toBe(true);
    expect(isNoreplyEmail('jane@personal.example')).toBe(false);
    expect(isNoreplyEmail('jane@users.noreply.github.com.evil.example')).toBe(false);
    expect(isNoreplyEmail('')).toBe(false);
    expect(isNoreplyEmail(null)).toBe(false);
  });
});

describe('planConfigWrites', () => {
  it('always plans the four repo-local reference values', () => {
    const writes = planConfigWrites(REFERENCE_EFFECTIVE, OPTS);
    expect(writes).toEqual([
      { key: 'user.signingkey', value: OPTS.pubPath },
      { key: 'gpg.ssh.program', value: 'ssh-keygen' },
      { key: 'gpg.ssh.allowedSignersFile', value: OPTS.signersPath },
      { key: 'user.email', value: OPTS.email },
    ]);
  });

  it('omits user.email when unresolved', () => {
    const writes = planConfigWrites(REFERENCE_EFFECTIVE, { ...OPTS, email: null });
    expect(keys(writes)).not.toContain('user.email');
    expect(keys(writes)).toEqual(['user.signingkey', 'gpg.ssh.program', 'gpg.ssh.allowedSignersFile']);
  });

  it('adds gpg.format/commit.gpgsign only when effective values are missing or wrong', () => {
    const fresh = planConfigWrites(FRESH_EFFECTIVE, OPTS);
    expect(fresh).toContainEqual({ key: 'gpg.format', value: 'ssh' });
    expect(fresh).toContainEqual({ key: 'commit.gpgsign', value: 'true' });

    const wrong = planConfigWrites({ 'gpg.format': 'openpgp', 'commit.gpgsign': 'false' }, OPTS);
    expect(wrong).toContainEqual({ key: 'gpg.format', value: 'ssh' });
    expect(wrong).toContainEqual({ key: 'commit.gpgsign', value: 'true' });

    const halfSet = planConfigWrites({ 'gpg.format': 'ssh', 'commit.gpgsign': null }, OPTS);
    expect(keys(halfSet)).not.toContain('gpg.format');
    expect(keys(halfSet)).toContain('commit.gpgsign');

    const reference = planConfigWrites(REFERENCE_EFFECTIVE, OPTS);
    expect(keys(reference)).not.toContain('gpg.format');
    expect(keys(reference)).not.toContain('commit.gpgsign');
  });

  it('never emits a global-scope write', () => {
    const everyShape = [
      planConfigWrites(REFERENCE_EFFECTIVE, OPTS),
      planConfigWrites(FRESH_EFFECTIVE, OPTS),
      planConfigWrites(FRESH_EFFECTIVE, { ...OPTS, email: null }),
    ].flat();
    expect(everyShape.length).toBeGreaterThan(0);
    for (const w of everyShape) {
      expect(`${w.key} ${w.value}`).not.toContain('--global');
      expect(w.key.startsWith('--')).toBe(false);
      expect(String(w.value).startsWith('--')).toBe(false);
    }
  });
});

describe('signers helpers', () => {
  it('append is deduped by key blob, not by full line', () => {
    const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBlobBlobBlob agentic-os automation signing key (signing-only, 2026-06-12)';
    const line = composeSignersLine('23327624+NFhbar@users.noreply.github.com', pub);
    expect(line).toBe(`23327624+NFhbar@users.noreply.github.com ${pub}`);

    // Same key blob under a drifted comment must NOT re-append…
    const drifted = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBlobBlobBlob regenerated comment';
    expect(signersHasKey(`${line}\n`, drifted)).toBe(true);

    // …while a genuinely different key must.
    const other = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyBlob other';
    expect(signersHasKey(`${line}\n`, other)).toBe(false);
    expect(signersHasKey('', pub)).toBe(false);
  });
});
