// Frontmatter parser — thin TS facade over the shared runtime parser at
// scripts/frontmatter.mjs (real YAML via js-yaml CORE_SCHEMA, the single
// implementation every subsystem uses since the parser consolidation).
// CORE_SCHEMA means timestamps stay STRINGS — the DEFAULT_SCHEMA Date
// coercion that bit /api/decisions in 0.3.0 can't recur; routes'
// asIsoString() helpers accept both shapes regardless.

// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { parseFrontmatter as sharedParseFrontmatter } from '../../../../scripts/frontmatter.mjs';

// biome-ignore lint/suspicious/noExplicitAny: frontmatter shape is arbitrary YAML
export type FmValue = any;
export type Frontmatter = Record<string, FmValue>;

export interface ParseResult {
  fm: Frontmatter;
  body: string;
  // null when parsing succeeded; the YAML error message when it failed.
  // When set, fm will be empty {} — callers should surface this rather than
  // silently render an empty schema.
  parseError: string | null;
}

export function parseFrontmatter(content: string): ParseResult {
  const r = sharedParseFrontmatter(content) as {
    fm: Frontmatter;
    body: string;
    parseError: string | null;
  };
  return { fm: r.fm, body: r.body, parseError: r.parseError };
}

// Input schema as declared in skill frontmatter (under `inputs:`).
export interface InputField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  pattern?: string;
  description?: string;
  default?: FmValue;
}
export type InputSchema = Record<string, InputField>;
