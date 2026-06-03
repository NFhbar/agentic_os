// Frontmatter parser. Uses js-yaml so nested objects (like skill `inputs:`
// schemas) parse correctly. The simpler .mjs parser at
// .claude/hooks/rebuild-vault-index.mjs only needs flat key-values for
// wiki entries; this one needs the full YAML grammar for skill frontmatter.

import yaml from 'js-yaml';

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
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content, parseError: null };

  try {
    const parsed = yaml.load(m[1]) as Frontmatter | null;
    return { fm: parsed ?? {}, body: m[2], parseError: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { fm: {}, body: m[2], parseError: msg };
  }
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
