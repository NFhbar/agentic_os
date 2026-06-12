// Re-parenting trampoline for dispatched subprocesses.
//
// Usage: node dispatch-holder.mjs --out <path> --err <path> -- <cmd> [args…]
//
// Spawns <cmd> detached with stdout/stderr redirected to the given files,
// reports the child's PID as a single JSON line on stdout, and exits
// immediately — the child re-parents to PID 1, so parent-pid tree-walks
// (`concurrently -k`, IDE task runners) can no longer find and kill it.
// Process-group detachment alone does not survive a ps-walk; breaking the
// PPID link does.
//
// Wire contract (the parent must handle all three):
//   pid line + exit 0       → spawn succeeded
//   no pid line + exit != 0 → spawn failed (stderr has the reason)
//   pid line + exit != 0    → rare post-fork failure after the pid was
//                             reported; the child may be alive — the parent
//                             is responsible for killing the reported pid.
//
// The pid line is flushed synchronously the moment spawn() returns, before
// yielding to the event loop — shrinks the spawned-but-unreported window
// (holder killed between fork and report → live unsupervised child) to the
// syscall-to-flush gap.
//
// Command-agnostic by design: argv is built by the caller
// (dispatch-claude.mjs stays the single source of claude invocations), and
// no cwd is set — both the holder and the grandchild inherit the cwd the
// caller chose. Keep this file free of heavyweight imports (no node:sqlite)
// so it loads in milliseconds and stays vitest-loadable.

import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';

function parseArgv(argv) {
  let out = null;
  let err = null;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--err') err = argv[++i];
    else if (a === '--') {
      i++;
      break;
    } else return null;
  }
  const cmd = argv[i];
  if (!out || !err || !cmd) return null;
  return { out, err, cmd, args: argv.slice(i + 1) };
}

const parsed = parseArgv(process.argv.slice(2));
if (!parsed) {
  process.stderr.write('usage: dispatch-holder.mjs --out <path> --err <path> -- <cmd> [args…]\n');
  process.exit(2);
}

const outFd = openSync(parsed.out, 'a');
const errFd = openSync(parsed.err, 'a');
let child;
try {
  child = spawn(parsed.cmd, parsed.args, {
    stdio: ['ignore', outFd, errFd],
    detached: true,
  });
} finally {
  closeSync(outFd);
  closeSync(errFd);
}

if (typeof child.pid === 'number') {
  writeSync(1, `${JSON.stringify({ pid: child.pid })}\n`);
  child.unref();
  child.on('error', (e) => {
    process.stderr.write(`spawn error after pid report: ${e.message}\n`);
    process.exitCode = 1;
  });
  // Exit on the next loop turn — late enough for a synchronously-detected
  // post-fork 'error' (delivered via nextTick) to flip the exit code first.
  setImmediate(() => process.exit(process.exitCode ?? 0));
} else {
  child.on('error', (e) => {
    process.stderr.write(`spawn error: ${e.message}\n`);
    process.exit(1);
  });
  // Backstop: spawn failures with no pid always emit 'error', but never
  // hang the caller if one doesn't arrive.
  setTimeout(() => process.exit(1), 1000);
}
