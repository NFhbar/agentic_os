// Fail-closed OS-root resolution — the one answer to "which tree am I?".
//
// Every telemetry write, vault read, and skill lookup is relative to the OS
// root. Guessing it wrong is not a crash, it is a SILENT crash: events land in
// a stranger's `.claude/state/`, a run report is written into whatever
// directory the shell happened to be in, and nothing errors. So this module
// never guesses. Resolution order:
//
//   1. `AGENTIC_OS_ROOT` — an explicit declaration. Set-but-invalid THROWS;
//      it is never silently overridden by a different tree, because a typo
//      that resolves to "some other valid OS" is the exact incident this
//      exists to prevent.
//   2. Optional hint vars (`hintEnvVars`) — harness-provided directories that
//      may or may not be an OS tree (the vault MCP passes `CLAUDE_PROJECT_DIR`
//      this way). Set-but-invalid is skipped, not fatal: these are hints, not
//      declarations.
//   3. A walk upward from `startDir` for the sentinel — a directory holding
//      BOTH `OS.md` and `.claude/skills`. Either alone is ambiguous; a repo
//      can carry an `OS.md` doc without being an OS.
//   4. Throw, with a message naming what was tried.
//
// There is deliberately NO cwd fallback. `process.cwd()` is whatever directory
// the operator, launchd, or an IDE task runner happened to start the process
// in — it carries no information about which tree owns the code.
//
// Deliberately NOT `${CLAUDE_PROJECT_DIR}` in skill text: that is a harness
// substitution, and skill instructions read raw by a headless child arrive
// with the literal `${...}` unexpanded. An env var read by node works in every
// execution mode.
//
// Pure node built-ins — importable from launchd-context scripts and MCP
// servers alike.

import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const OS_ROOT_ENV_VAR = 'AGENTIC_OS_ROOT';

// Both must be present. `OS.md` alone appears in forks, docs mirrors, and
// archives; `.claude/skills` alone appears in any Claude Code project.
export const SENTINEL_PATHS = ['OS.md', join('.claude', 'skills')];

/** True when `dir` holds every sentinel path — i.e. it is an OS tree root. */
export function isOsRoot(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  return SENTINEL_PATHS.every((rel) => existsSync(join(dir, rel)));
}

/** Sentinel paths missing from `dir` — used to explain a rejection. */
function missingSentinels(dir) {
  return SENTINEL_PATHS.filter((rel) => !existsSync(join(dir, rel)));
}

/**
 * Walk from `startDir` toward the filesystem root looking for the sentinel.
 * Returns the first matching directory, or null when the walk reaches the top.
 */
export function findOsRootUpward(startDir) {
  let dir = resolve(startDir);
  const { root } = parse(dir);
  for (;;) {
    if (isOsRoot(dir)) return dir;
    if (dir === root) return null;
    const next = dirname(dir);
    if (next === dir) return null; // defensive: dirname is a fixpoint at the root
    dir = next;
  }
}

/**
 * Resolve the OS root or throw.
 *
 * @param {object}   [opts]
 * @param {Record<string, string | undefined>} [opts.env]  env to read (default `process.env`)
 * @param {string}   [opts.startDir]      where the upward walk begins (default: this file's dir)
 * @param {string[]} [opts.hintEnvVars]   extra env vars tried after `AGENTIC_OS_ROOT`;
 *                                        set-but-invalid values are skipped, not fatal
 * @returns {string} absolute path to the OS root
 */
export function resolveOsRoot({
  env = process.env,
  startDir = __dirname,
  hintEnvVars = [],
} = {}) {
  const declared = env?.[OS_ROOT_ENV_VAR];
  if (typeof declared === 'string' && declared.trim().length > 0) {
    const dir = resolve(declared.trim());
    if (isOsRoot(dir)) return dir;
    throw new Error(
      `${OS_ROOT_ENV_VAR} is set to ${dir}, which is not an OS root — missing ${missingSentinels(dir).join(' and ')}. ` +
        `Point it at the directory holding OS.md and .claude/skills, or unset it to resolve by walking up from the running script.`,
    );
  }

  const skippedHints = [];
  for (const name of hintEnvVars) {
    const raw = env?.[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const dir = resolve(raw.trim());
    if (isOsRoot(dir)) return dir;
    skippedHints.push(`${name}=${dir}`);
  }

  const walked = findOsRootUpward(startDir);
  if (walked) return walked;

  const tried = [
    `${OS_ROOT_ENV_VAR} (unset)`,
    ...skippedHints.map((h) => `${h} (not an OS root)`),
    `upward walk from ${resolve(startDir)}`,
  ];
  throw new Error(
    `Cannot resolve the OS root — refusing to guess a tree. Tried: ${tried.join('; ')}. ` +
      `An OS root is a directory holding both OS.md and .claude/skills. ` +
      `Run from inside the OS clone, or set ${OS_ROOT_ENV_VAR} to its path.`,
  );
}

/**
 * Env fragment to merge into a spawned child's environment so the child
 * inherits the resolved tree instead of re-deriving one from its own cwd.
 * Spawn sites use `env: { ...process.env, ...osRootEnv(root) }`.
 */
export function osRootEnv(root) {
  return { [OS_ROOT_ENV_VAR]: root };
}
