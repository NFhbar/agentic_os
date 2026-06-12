// Re-parenting trampoline (scripts/dispatch-holder.mjs). These spawn the
// real holder and pin its wire contract: pid line + exit 0 on success, the
// grandchild re-parented to PID 1 with the holder's cwd, and the no-pid
// non-zero-exit shape on spawn failure.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const HOLDER = join(process.cwd(), 'scripts', 'dispatch-holder.mjs');

interface HolderResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runHolder(args: string[], cwd: string): Promise<HolderResult> {
  return new Promise((resolve) => {
    const holder = spawn(process.execPath, [HOLDER, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    holder.stdout.on('data', (d) => {
      stdout += d;
    });
    holder.stderr.on('data', (d) => {
      stderr += d;
    });
    holder.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const dirs: string[] = [];
const pids: number[] = [];

afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('dispatch-holder', () => {
  it('re-parents the grandchild to PID 1, inherits cwd, and hands back its pid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holder-test-'));
    dirs.push(dir);
    const outPath = join(dir, 'out.log');
    const errPath = join(dir, 'err.log');

    const res = await runHolder(
      ['--out', outPath, '--err', errPath, '--', 'sh', '-c', 'pwd; sleep 300'],
      dir,
    );

    expect(res.exitCode).toBe(0);
    const pidLine = res.stdout.split('\n').find((l) => l.length > 0);
    expect(pidLine).toBeTruthy();
    const { pid } = JSON.parse(pidLine as string) as { pid: number };
    expect(typeof pid).toBe('number');
    pids.push(pid);

    expect(isAlive(pid)).toBe(true);
    // The holder has exited (close event fired) — the grandchild must have
    // re-parented to PID 1 (launchd/init).
    const ppid = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    expect(ppid).toBe('1');

    // The grandchild's `pwd` went to the redirected journal and reflects the
    // cwd the holder was spawned with (the holder sets no cwd of its own).
    await new Promise((r) => setTimeout(r, 200));
    const journal = readFileSync(outPath, 'utf8');
    // macOS tmpdir is symlinked under /private — compare via realpath shape.
    expect(journal.trim().endsWith(dir.replace(/^\/private/, '')) || journal.trim() === dir).toBe(
      true,
    );
  });

  it('exits non-zero with no pid line when the command cannot spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holder-test-'));
    dirs.push(dir);
    const res = await runHolder(
      [
        '--out',
        join(dir, 'out.log'),
        '--err',
        join(dir, 'err.log'),
        '--',
        '/nonexistent-command-for-holder-test',
      ],
      dir,
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout.trim()).toBe('');
    expect(res.stderr).toContain('spawn error');
  });

  it('exits 2 with usage on malformed argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holder-test-'));
    dirs.push(dir);
    const res = await runHolder(['--out', join(dir, 'out.log')], dir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('usage:');
  });
});
