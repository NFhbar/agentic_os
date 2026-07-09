// Structural invariant: every interactive gate on a potentially-dispatched
// path declares a headless fallback policy.
//
// Per standard-skill-format § "Headless behavior", any interactive gate
// (AskUserQuestion / ExitPlanMode / a prose "ask the user") that can be reached
// on a headless dispatch MUST declare exactly one policy — default(...) / park /
// refuse — via a literal `Headless:` clause at the gate. This test is the
// enforcement the standard points at.
//
// What it CAN see: literal `AskUserQuestion` / `ExitPlanMode` tokens. What it
// CANNOT: prose-worded gates ("ask the user to confirm …"). meta-add-skill's
// collision ask and meta-dashboard's port-conflict ask are that class — they
// carry declarations anyway; the test simply can't assert them.
//
// The `/do not use/i` negative filter is how a skill *documents* the
// non-interactive contract without tripping the check (the canonical
// "Do NOT use AskUserQuestion" dispatch marker, guard prose, etc.).

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { listSkillDirs, relPath } from '../helpers/vault.js';

// Skills with a real interactive gate deliberately left to a follow-up wave —
// same gate class as the in-scope nine but NOT in this change's scope. Add
// SPARINGLY, with a reason, and burn down. The companion assertion below fails
// if any listed skill stops being a genuine carrier, so a stale exception can
// never silently pre-exempt a future gate.
const GATE_EXCEPTIONS = new Set<string>([
  // Pattern-5 carriers scheduled for the next headless-policy wave.
  'meta-add-schedule',
  'meta-add-app',
]);

// A line carries a *positive* interactive-tool mention when it names a tool AND
// is not the "Do NOT use …" negation the standard uses to document headlessness.
const INTERACTIVE_TOOL = /AskUserQuestion|ExitPlanMode/;
const NEGATION = /do not use/i;

function hasPositiveInteractiveMention(body: string): boolean {
  return body.split('\n').some((line) => INTERACTIVE_TOOL.test(line) && !NEGATION.test(line));
}

function declaresHeadlessPolicy(body: string): boolean {
  return /Headless:/.test(body);
}

const skills = listSkillDirs()
  .map((dir) => ({ name: basename(dir), md: join(dir, 'SKILL.md') }))
  .filter((s) => existsSync(s.md))
  .map((s) => ({ ...s, body: readFileSync(s.md, 'utf8') }));

describe('headless gate policies', () => {
  it('walks a non-empty skill tree', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  for (const skill of skills) {
    if (GATE_EXCEPTIONS.has(skill.name)) continue;
    if (!hasPositiveInteractiveMention(skill.body)) continue;
    it(`${skill.name}: interactive gate declares a Headless: policy`, () => {
      expect(
        declaresHeadlessPolicy(skill.body),
        `${relPath(skill.md)} has a positive AskUserQuestion/ExitPlanMode mention but no ` +
          '`Headless:` declaration. Declare a policy at the gate (default/park/refuse) per ' +
          'standard-skill-format § "Headless behavior", or — if the gate is genuinely ' +
          `interactive-only follow-up work — add ${skill.name} to GATE_EXCEPTIONS with a reason.`,
      ).toBe(true);
    });
  }

  // Every exception must be load-bearing: it must itself still carry a positive
  // interactive-tool mention. A stale exception (skill deleted, or its gate
  // designed out) fails HERE instead of silently pre-exempting a *future* gate.
  // Subsumes a plain existence check — and is exactly the assertion that would
  // have caught the rev-1 dead exceptions (meta-rename / meta-delete carry zero
  // interactive-tool mentions and were wrongly excepted).
  for (const name of GATE_EXCEPTIONS) {
    it(`exception ${name} is load-bearing (still a real carrier)`, () => {
      const skill = skills.find((s) => s.name === name);
      expect(
        skill,
        `GATE_EXCEPTIONS lists ${name} but .claude/skills/${name}/SKILL.md was not found — ` +
          'remove the stale exception.',
      ).toBeDefined();
      expect(
        hasPositiveInteractiveMention(skill!.body),
        `GATE_EXCEPTIONS lists ${name} but its SKILL.md has NO positive interactive-tool ` +
          'mention — the exception is stale (gate designed out or skill deleted). Remove it ' +
          'from GATE_EXCEPTIONS; do not leave a hole a future gate could slip through.',
      ).toBe(true);
    });
  }
});
