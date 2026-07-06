// Tier 1 unit tests for the project-closure prompt builder.
//
// `buildCloseProjectPrompt` composes the headless dispatch prompt the dashboard
// hands the AI bridge when an operator Completes or Abandons a project. Its
// mode-dependent lines are load-bearing: `complete` must emit
// `disposition_default: block` (refusal-first) and `abandon` must emit
// `disposition_default: abandon` + a JSON-quoted `rationale` (an empty or
// mis-quoted rationale downgrades every abandon disposition to `block` in the
// skill, turning the dispatch into a guaranteed refusal). These pin both modes
// plus a quote-containing rationale so the quoting stays intact.

import { describe, expect, it } from 'vitest';
import { buildCloseProjectPrompt } from '../../../domains/meta/app/src/lib/destructive.js';

describe('buildCloseProjectPrompt', () => {
  it('complete mode is refusal-first and carries no rationale', () => {
    const prompt = buildCloseProjectPrompt('mercury', 'complete');
    expect(prompt).toContain('The user has confirmed completing project mercury');
    expect(prompt).toContain('Read .claude/skills/meta-close-project/SKILL.md');
    expect(prompt).toContain('- project: "mercury"');
    expect(prompt).toContain('- mode: "complete"');
    expect(prompt).toContain('- disposition_default: "block"');
    expect(prompt).not.toContain('rationale');
  });

  it('abandon mode opts into abandon-all with a rationale', () => {
    const prompt = buildCloseProjectPrompt('mercury', 'abandon', 'sunset — vendor pulled the API');
    expect(prompt).toContain('The user has confirmed abandoning project mercury');
    expect(prompt).toContain('- mode: "abandon"');
    expect(prompt).toContain('- disposition_default: "abandon"');
    expect(prompt).toContain('- rationale: "sunset — vendor pulled the API"');
  });

  it('JSON-quotes a rationale containing embedded double quotes', () => {
    const rationale = 'dropped — the "beta" SDK never shipped';
    const prompt = buildCloseProjectPrompt('mercury', 'abandon', rationale);
    // The line must be valid JSON on the value side so the skill parses it back
    // to the original string rather than truncating at the embedded quote.
    expect(prompt).toContain(`- rationale: ${JSON.stringify(rationale)}`);
    expect(prompt).toContain('- rationale: "dropped — the \\"beta\\" SDK never shipped"');
  });
});
