// Idempotent per-repo signing-identity setup for headless automation.
//
// Two live walls block unattended lifecycles at the commit/push step: an
// agent-managed signing key that prompts or locks (`agent returned an error`)
// and GitHub's email-privacy push block (GH007). The fix is a dedicated
// passphrase-less ed25519 SIGNING-ONLY key plus repo-local git config — the
// operator's interactive setup (e.g. 1Password signing for human commits)
// stays untouched because every write here is repo-local scope; this script
// never writes global config. See standard-git-hygiene § 4a "Headless signing
// for automation".
//
// Usage:
//   node scripts/setup-repo-identity.mjs --repo-path <path> [--email <noreply>] [--key <path>] [--signers <path>]
//   node scripts/setup-repo-identity.mjs --all [--email <noreply>] [--key <path>] [--signers <path>]
//
// --all targets the OS repo root (when it is a git clone) plus every ingested
// repo entity (vault/wiki/<domain>/entity/*.md with kind: repo) whose
// local_path exists, deduplicated by real path. The glob is deliberately
// single-level so _seed entities (one directory deeper) are never enumerated.
//
// Email resolution is deliberately NOT derived from the gh CLI — gh may be
// authenticated as a different account than the repo owner (observed live on
// this install), which would silently configure the wrong identity.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_KEY = '~/.ssh/agentic_os_signing';
const DEFAULT_SIGNERS = '~/.ssh/agentic_os_allowed_signers';

// Both the id+login form (23327624+NFhbar@...) and the legacy login-only form.
const NOREPLY_RE = /^(\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$/;

export function isNoreplyEmail(email) {
  return typeof email === 'string' && NOREPLY_RE.test(email.trim());
}

// Decide the exact repo-local `git config` writes for one repo. Pure — the
// caller passes the effective (inherited) config; every returned {key, value}
// is applied with plain `git -C <repo> config <key> <value>` (local scope).
export function planConfigWrites(effective, { pubPath, signersPath, email }) {
  const writes = [
    { key: 'user.signingkey', value: pubPath },
    { key: 'gpg.ssh.program', value: 'ssh-keygen' },
    { key: 'gpg.ssh.allowedSignersFile', value: signersPath },
  ];
  if (email) writes.push({ key: 'user.email', value: email });
  // Fresh machines without the operator's globals can't sign silently on the
  // four reference values alone (a signingkey with gpg.format unset attempts
  // OpenPGP signing and fails). Written repo-locally, and only when the
  // inherited value is wrong, so machines with correct globals keep the
  // proven four-value shape.
  if (effective['gpg.format'] !== 'ssh') {
    writes.push({ key: 'gpg.format', value: 'ssh' });
  }
  if (effective['commit.gpgsign'] !== 'true') {
    writes.push({ key: 'commit.gpgsign', value: 'true' });
  }
  return writes;
}

export function keyBlobOf(pubkeyLine) {
  const parts = (pubkeyLine ?? '').trim().split(/\s+/);
  return parts.length >= 2 ? parts[1] : null;
}

export function composeSignersLine(email, pubkeyLine) {
  return `${email} ${pubkeyLine.trim()}`;
}

// Dedupe by key blob, not whole-line match, so comment drift across
// regenerated .pub files doesn't duplicate entries.
export function signersHasKey(content, pubkeyLine) {
  const blob = keyBlobOf(pubkeyLine);
  if (!blob) return false;
  return (content ?? '')
    .split('\n')
    .some((line) => line.trim().split(/\s+/).includes(blob));
}

function git(repoPath, args) {
  const res = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
  return {
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function gitGet(repoPath, key, extraFlags = []) {
  const res = git(repoPath, ['config', ...extraFlags, '--get', key]);
  return res.status === 0 ? res.stdout : null;
}

function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function ensureKey(keyPath) {
  const pubPath = `${keyPath}.pub`;
  if (existsSync(keyPath)) {
    if (!existsSync(pubPath)) {
      throw new Error(
        `private key ${keyPath} exists but ${pubPath} is missing — restore it with: ssh-keygen -y -f ${keyPath} > ${pubPath}`,
      );
    }
    return { pubPath, created: false };
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 10);
  const res = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-N', '', '-C', `agentic-os automation signing key (signing-only, ${stamp})`, '-f', keyPath],
    { encoding: 'utf8' },
  );
  if (res.error && res.error.code === 'ENOENT') {
    throw new Error('ssh-keygen not found — install the OpenSSH client tools and re-run');
  }
  if (res.status !== 0) {
    throw new Error(`ssh-keygen failed: ${(res.stderr ?? '').trim()}`);
  }
  return { pubPath, created: true };
}

function setupRepo(repoPath, { emailFlag, keyPath, signersPath }) {
  if (git(repoPath, ['rev-parse', '--git-dir']).status !== 0) {
    return { repoPath, skipped: 'not a git repository' };
  }
  const { pubPath, created } = ensureKey(keyPath);
  const pubkeyLine = readFileSync(pubPath, 'utf8').trim();

  const effectiveEmail = gitGet(repoPath, 'user.email');
  let email = null;
  let emailSource = null;
  if (emailFlag) {
    email = emailFlag.trim();
    emailSource = 'flag';
  } else if (isNoreplyEmail(effectiveEmail)) {
    email = effectiveEmail.trim();
    emailSource = 'existing user.email';
  }

  let signers = 'skipped (email unresolved)';
  if (email) {
    if (!existsSync(signersPath)) {
      mkdirSync(dirname(signersPath), { recursive: true, mode: 0o700 });
      writeFileSync(signersPath, '');
    }
    const content = readFileSync(signersPath, 'utf8');
    if (signersHasKey(content, pubkeyLine)) {
      signers = 'already present';
    } else {
      const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      appendFileSync(signersPath, `${sep}${composeSignersLine(email, pubkeyLine)}\n`);
      signers = 'appended';
    }
  }

  const effective = {
    'gpg.format': gitGet(repoPath, 'gpg.format'),
    'commit.gpgsign': gitGet(repoPath, 'commit.gpgsign', ['--type=bool']),
  };
  const configReport = [];
  for (const { key, value } of planConfigWrites(effective, { pubPath, signersPath, email })) {
    const current = gitGet(repoPath, key, ['--local']);
    if (current === value) {
      configReport.push(`${key} — already set`);
      continue;
    }
    const prior =
      key === 'user.email' && effectiveEmail && effectiveEmail !== value
        ? ` (was: ${effectiveEmail})`
        : '';
    const res = git(repoPath, ['config', key, value]);
    if (res.status !== 0) {
      throw new Error(`git config ${key} failed in ${repoPath}: ${res.stderr}`);
    }
    configReport.push(`${key} = ${value}${prior}`);
  }
  if (!email) {
    configReport.push('user.email — skipped (unresolved; see lookup instructions below)');
  }

  return { repoPath, keyCreated: created, pubPath, pubkeyLine, email, emailSource, signers, configReport };
}

// --all target enumeration. The wiki glob is deliberately single-level
// (vault/wiki/<domain>/entity/*.md) so _seed entities — which sit one
// directory deeper — are excluded structurally; the source: seed skip is
// belt-and-braces on top.
function enumerateTargets() {
  const targets = [];
  if (existsSync(join(ROOT, '.git'))) {
    targets.push(ROOT);
  }
  const wikiDir = join(ROOT, 'vault', 'wiki');
  if (existsSync(wikiDir)) {
    for (const domain of readdirSync(wikiDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!domain.isDirectory()) continue;
      const entityDir = join(wikiDir, domain.name, 'entity');
      if (!existsSync(entityDir)) continue;
      for (const file of readdirSync(entityDir).sort()) {
        if (!file.endsWith('.md')) continue;
        const { fm } = parseFrontmatter(readFileSync(join(entityDir, file), 'utf8'));
        if (fm.kind !== 'repo' || fm.source === 'seed') continue;
        if (typeof fm.local_path !== 'string' || !existsSync(fm.local_path)) continue;
        targets.push(fm.local_path);
      }
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const t of targets) {
    let real;
    try {
      real = realpathSync(t);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    deduped.push(real);
  }
  return deduped;
}

function printRepoReport(r) {
  if (r.skipped) {
    console.log(`⊘ ${r.repoPath} — ${r.skipped}`);
    return;
  }
  console.log(`✓ ${r.repoPath}`);
  console.log(`  key:     ${r.keyCreated ? 'created' : 'reused'} (${r.pubPath.replace(/\.pub$/, '')})`);
  console.log(`  email:   ${r.email ? `${r.email} (${r.emailSource})` : 'unresolved — user.email not written'}`);
  console.log(`  signers: ${r.signers}`);
  for (const line of r.configReport) {
    console.log(`  config:  ${line}`);
  }
}

function printHandoff({ pubkeyLine, anyUnresolved }) {
  console.log('');
  console.log('Public signing key (register on GitHub):');
  console.log(`  ${pubkeyLine}`);
  console.log('');
  console.log('GitHub registration (once per account):');
  console.log('  Settings → SSH and GPG keys → New SSH key → key type: Signing Key — NOT');
  console.log('  Authentication Key. Paste the line above. A signing-only registration');
  console.log('  cannot authenticate or push, and is revocable in one click.');
  if (anyUnresolved) {
    console.log('');
    console.log('Noreply email lookup (needed to finish user.email):');
    console.log('  GitHub → Settings → Emails shows your <id>+<login>@users.noreply.github.com');
    console.log('  address. Re-run with --email <that address> to complete setup; until then');
    console.log('  signing works but pushes may hit GH007 (email-privacy block).');
  }
  console.log('');
  console.log('SSH authentication posture (signing is headless; auth is a separate choice):');
  console.log('  (a) prompt-per-session (recommended default): keep your agent-managed auth key');
  console.log('      and enable its "remember approval" setting — one human checkpoint per');
  console.log('      sitting. Automated lifecycles push/pull many times per session; per-use');
  console.log('      prompting is untenable, per-session approval keeps a human in the loop.');
  console.log('  (b) fully headless dedicated auth key: zero prompts, wider blast radius —');
  console.log('      auth keys can push. Reserve for routine unattended driving.');
}

function usage() {
  console.error(
    'usage: node scripts/setup-repo-identity.mjs (--repo-path <path> | --all) [--email <noreply>] [--key <path>] [--signers <path>]',
  );
}

function parseArgs(argv) {
  const opts = { all: false, repoPath: null, email: null, key: null, signers: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') {
      opts.all = true;
    } else if (a === '--repo-path' || a === '--email' || a === '--key' || a === '--signers') {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`missing value for ${a}`);
        usage();
        process.exit(2);
      }
      opts[a === '--repo-path' ? 'repoPath' : a.slice(2)] = value;
    } else {
      console.error(`unknown argument: ${a}`);
      usage();
      process.exit(2);
    }
  }
  if (opts.all === Boolean(opts.repoPath)) {
    console.error('exactly one of --repo-path or --all is required');
    usage();
    process.exit(2);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const shared = {
    emailFlag: opts.email,
    keyPath: resolve(expandHome(opts.key ?? DEFAULT_KEY)),
    signersPath: resolve(expandHome(opts.signers ?? DEFAULT_SIGNERS)),
  };

  const targets = opts.all ? enumerateTargets() : [resolve(expandHome(opts.repoPath))];
  if (targets.length === 0) {
    console.log('⊘ no targets — no git clone at the OS root and no ingested repo entities with an existing local_path');
    return;
  }

  const reports = [];
  for (const target of targets) {
    try {
      const report = setupRepo(target, shared);
      if (report.skipped && !opts.all) {
        console.error(`✗ ${report.repoPath} — ${report.skipped}`);
        process.exit(1);
      }
      printRepoReport(report);
      reports.push(report);
    } catch (e) {
      // Hard errors (ssh-keygen missing, config write failure) abort the whole
      // run — they would repeat identically for every remaining target.
      console.error(`✗ ${target} — ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }

  const done = reports.filter((r) => !r.skipped);
  if (done.length > 0) {
    printHandoff({ pubkeyLine: done[0].pubkeyLine, anyUnresolved: done.some((r) => !r.email) });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
