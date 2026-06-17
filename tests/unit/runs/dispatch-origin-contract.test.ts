// Per-dispatch-path origin contract. runs-wiring.test.ts pins the generic
// startRun mechanism (default `human`, explicit override honored); this pins
// that each real caller passes the RIGHT value, so a regression where someone
// drops `origin:` from a dispatch site is caught — not just the primitive.
//
// The dispatch helpers (automation.ts dispatchStep/dispatchChangeStep,
// schedules.ts run-now) are unexported and deeply wired, so we assert the
// literal in each caller (the reviewer's suggested alternative) by extracting
// each startRun({...}) call's argument object from source and checking its
// origin. Brace-balanced extraction keeps it robust to formatting.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../helpers/vault.js';

const ROUTES = join(REPO_ROOT, 'domains', 'meta', 'app', 'server', 'routes');

// Return the inner text of every `startRun({ ... })` call's argument object.
function startRunArgObjects(src: string): string[] {
  const objs: string[] = [];
  const needle = 'startRun(';
  let from = 0;
  for (;;) {
    const call = src.indexOf(needle, from);
    if (call === -1) break;
    const argStart = call + needle.length;
    const open = src.indexOf('{', argStart);
    // Only treat this as an object-argument call when the first non-space
    // char after `startRun(` is `{` — skips prose mentions like `startRun()`.
    if (open === -1 || src.slice(argStart, open).trim() !== '') {
      from = argStart;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    objs.push(src.slice(open, end + 1));
    from = end + 1;
  }
  return objs;
}

describe('dispatch origin contract', () => {
  it('every startRun in automation.ts stamps origin: automation', () => {
    const src = readFileSync(join(ROUTES, 'automation.ts'), 'utf8');
    const calls = startRunArgObjects(src);
    expect(calls.length).toBeGreaterThanOrEqual(2); // dispatchStep + dispatchChangeStep
    for (const arg of calls) {
      expect(arg).toContain("origin: 'automation'");
    }
  });

  it('schedules.ts run-now stamps origin: scheduler', () => {
    const src = readFileSync(join(ROUTES, 'schedules.ts'), 'utf8');
    const calls = startRunArgObjects(src);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const arg of calls) {
      expect(arg).toContain("origin: 'scheduler'");
    }
  });
});
