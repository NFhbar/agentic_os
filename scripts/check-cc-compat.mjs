#!/usr/bin/env node
// Claude Code version-compatibility contract.
//
// The OS is not portable across arbitrary CLI versions: dispatched runs lean
// on harness behavior that arrived in a specific release, and every release
// past the one the suite was last run against is untested territory. Both
// facts are invisible at runtime — an old CLI does not error, it just behaves
// differently, and a brand-new one looks fine right up until something the OS
// depends on has moved. This module turns both into a stated contract.
//
// Three classes:
//   fail — below MIN_SUPPORTED. The gated behavior is named so the operator
//          knows what silently degrades, not just that a number is small.
//   ok   — inside [MIN_SUPPORTED, HIGHEST_TESTED].
//   info — above HIGHEST_TESTED. Not a problem; an invitation to run the
//          suite and move the ceiling, so the tested range keeps up.
//
// Version comparison is per-segment NUMERIC. String compare is the bug this
// exists to avoid: `'2.1.9' > '2.1.196'` lexicographically, which would pass
// a CLI three months too old.
//
// Usage:
//   node scripts/check-cc-compat.mjs           # read `claude --version`, report
//   node scripts/check-cc-compat.mjs --json    # machine-readable
//   node scripts/check-cc-compat.mjs 2.1.200   # evaluate an explicit version
//
// Exit 1 only on `fail`. An unreadable CLI is reported and exits 0 — the
// caller (install.sh, the audit) decides what a missing binary means; the
// version contract itself has nothing to say about it.
//
// Complements scripts/check-cc-contract.mjs, which probes the CLI's actual
// surfaces (flags, stream-json fields, transcript format) rather than its
// version number. Behavioral drift inside the supported range shows up there;
// being outside the range shows up here.

import { spawnSync } from 'node:child_process';

export const MIN_SUPPORTED = '2.1.196';
export const HIGHEST_TESTED = '2.1.220';

// What breaks below the minimum. Named in operator terms — the point is that
// these degrade QUIETLY, so the message has to say what to look for.
export const GATED_FEATURES = [
  'headless gate policies (default / park / refuse) — dispatched runs need the minimum release to honor the non-interactive contract; below it an interactive gate can stall a run until its wall-time cap instead of taking the declared branch',
];

/**
 * Parse a version string into numeric segments. Tolerates a leading `v`, a
 * trailing build/pre-release suffix, and trailing prose (the CLI prints
 * `2.1.220 (Claude Code)`). Returns null when no numeric segments are found.
 *
 * @param {string} v
 * @returns {number[] | null}
 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/(\d+(?:\.\d+)*)/);
  if (!m) return null;
  const segments = m[1].split('.').map((s) => Number.parseInt(s, 10));
  return segments.every((n) => Number.isFinite(n)) ? segments : null;
}

/**
 * Per-segment numeric comparison. Missing trailing segments count as 0, so
 * `2.1` and `2.1.0` are equal.
 *
 * @returns {number} -1 when a < b, 0 when equal, 1 when a > b
 */
export function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (av === null || bv === null) {
    throw new Error(`Cannot compare versions: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Classify a Claude Code version against the contract.
 *
 * @param {string} current  version string (`2.1.220`, `v2.1.220`, `2.1.220 (Claude Code)`)
 * @param {object} [range]
 * @param {string} [range.min]     override MIN_SUPPORTED (tests)
 * @param {string} [range.tested]  override HIGHEST_TESTED (tests)
 * @returns {{status: 'fail'|'ok'|'info'|'unknown', current: string, min: string,
 *            tested: string, message: string, hint: string|null}}
 */
export function evaluateCompat(current, { min = MIN_SUPPORTED, tested = HIGHEST_TESTED } = {}) {
  const base = { current: typeof current === 'string' ? current.trim() : '', min, tested };
  if (parseVersion(current) === null) {
    return {
      ...base,
      status: 'unknown',
      message: `Unrecognizable Claude Code version ${JSON.stringify(current)} — cannot evaluate the compatibility contract`,
      hint: `Run \`claude --version\` and check the output still starts with a dotted version number.`,
    };
  }
  if (compareVersions(current, min) < 0) {
    return {
      ...base,
      status: 'fail',
      message: `Claude Code ${base.current} is below the minimum supported ${min}. Degrades quietly: ${GATED_FEATURES.join('; ')}`,
      hint: `Upgrade the CLI to ${min} or newer, then re-run.`,
    };
  }
  if (compareVersions(current, tested) > 0) {
    return {
      ...base,
      status: 'info',
      message: `Claude Code ${base.current} is newer than the highest tested ${tested} — untested territory, not a known problem`,
      hint: `Run the suite (\`npm test\` + \`node scripts/check-cc-contract.mjs\`); if it is green, extend the tested ceiling by raising HIGHEST_TESTED in scripts/check-cc-compat.mjs.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    message: `Claude Code ${base.current} is within the supported range ${min}–${tested}`,
    hint: null,
  };
}

/**
 * Read the installed CLI's version. Returns null when the binary is absent or
 * prints nothing usable — "no CLI" is a different question from "wrong CLI",
 * and this module deliberately only answers the second.
 */
export function detectInstalledVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  // The CLI prints `2.1.220 (Claude Code)`; keep only the dotted number so
  // messages don't echo the product name back at the reader.
  const segments = parseVersion(`${r.stdout ?? ''}`);
  return segments === null ? null : segments.join('.');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isDirectRun() {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('check-cc-compat.mjs');
}

if (isDirectRun()) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const explicit = args.find((a) => !a.startsWith('-')) ?? null;
  const current = explicit ?? detectInstalledVersion();

  if (current === null) {
    const payload = {
      status: 'unavailable',
      min: MIN_SUPPORTED,
      tested: HIGHEST_TESTED,
      message: 'claude CLI not found on PATH (or it printed no version) — compatibility not evaluated',
    };
    if (json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`⊘ ${payload.message}`);
    process.exit(0);
  }

  const result = evaluateCompat(current);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const glyph = { fail: '✗', ok: '✓', info: 'ℹ', unknown: '⊘' }[result.status];
    console.log(`${glyph} ${result.message}`);
    if (result.hint) console.log(`  → ${result.hint}`);
  }
  process.exit(result.status === 'fail' ? 1 : 0);
}
