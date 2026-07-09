// Pins scripts/headless-guard.mjs — the dispatch-layer envelope that appends a
// non-interactive declaration to scheduled runbook prompts (the one dispatch
// surface that doesn't already carry one; see scheduler-tick.mjs's fireJob).
// The guard lives in a pure, dependency-free module precisely so vitest can
// import it — scheduler-tick.mjs transitively pulls in node:sqlite and can't be
// loaded here.

import { describe, expect, it } from 'vitest';
import { HEADLESS_GUARD, appendHeadlessGuard } from '../../../scripts/headless-guard.mjs';

describe('appendHeadlessGuard', () => {
  it('appends the guard to a bare runbook prompt', () => {
    const out = appendHeadlessGuard('/os brief');
    expect(out.startsWith('/os brief')).toBe(true);
    expect(out).toContain(HEADLESS_GUARD);
  });

  it('no-ops (idempotent) when a non-interactive declaration is already present', () => {
    // A prompt that already declares itself non-interactive is returned verbatim…
    const already =
      'Curate the queue.\n\nIMPORTANT: Do NOT use AskUserQuestion or any interactive prompt.';
    expect(appendHeadlessGuard(already)).toBe(already);
    // …and the guard's own output already contains the phrase, so a second
    // append is a no-op — appending twice equals appending once.
    const once = appendHeadlessGuard('/os brief');
    expect(appendHeadlessGuard(once)).toBe(once);
  });

  it('HEADLESS_GUARD carries the canonical marker phrase', () => {
    expect(HEADLESS_GUARD.toLowerCase()).toContain('do not use askuserquestion');
  });
});
