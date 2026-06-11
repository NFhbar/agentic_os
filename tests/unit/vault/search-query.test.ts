// FTS5 MATCH-expression construction for the vault MCP search
// (mcps/vault/search.mjs). Free text must never reach MATCH raw — FTS5
// treats unquoted tokens like AND/OR/NEAR/^/* as operators and throws
// syntax errors on stray punctuation.

import { describe, expect, it } from 'vitest';
import { buildMatchExpression } from '../../../mcps/vault/search.mjs';

describe('buildMatchExpression', () => {
  it('quotes tokens and OR-joins them', () => {
    expect(buildMatchExpression('silent data loss')).toBe('"silent" OR "data" OR "loss"');
  });

  it('lowercases and strips punctuation/operators', () => {
    expect(buildMatchExpression('Why was the cost-cap REMOVED?')).toBe(
      '"why" OR "was" OR "the" OR "cost" OR "cap" OR "removed"',
    );
  });

  it('neutralizes FTS5 operator injection', () => {
    // NEAR/AND/quotes/parens must come out as plain quoted tokens.
    expect(buildMatchExpression('a") OR (b NEAR c')).toBe('"a" OR "or" OR "b" OR "near" OR "c"');
  });

  it('returns null when nothing tokenizable survives', () => {
    expect(buildMatchExpression('!!! --- ???')).toBeNull();
    expect(buildMatchExpression('')).toBeNull();
    expect(buildMatchExpression(undefined as unknown as string)).toBeNull();
  });
});
