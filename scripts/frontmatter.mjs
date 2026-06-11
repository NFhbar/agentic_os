// The single runtime frontmatter parser for the OS.
//
// Before this module, five hand-rolled line-based parsers (audit, scheduler
// tick, index hook, vault MCP, app server) parsed the same files with
// different semantics — and the archetype contracts were contorted to the
// weakest one ("recommended_changes MUST be a single-line JSON array"
// because multi-line YAML silently dropped). Fable review, Cross-cutting 1.
//
// This is real YAML via js-yaml with CORE_SCHEMA, chosen deliberately:
//   - timestamps stay STRINGS (DEFAULT_SCHEMA coerces them to Date objects,
//     which already bit /api/decisions in 0.3.0)
//   - `~` and `null` resolve to null (Task #420 class)
//   - block sequences, nested maps, inline JSON all parse correctly
//   - duplicate keys THROW → surfaced as parseError instead of silently
//     last-wins (the lifecycle-audit duplicate-tags bug class)
//
// Return shape is the superset of what the five call sites need:
//   fm            — parsed mapping; {} when absent or on parse error
//   body          — content after the closing fence (whole input when no fence)
//   raw           — the raw text between the fences ('' when no fence)
//   hasFrontmatter— whether a frontmatter fence was found at all
//   parseError    — js-yaml's message when the YAML is invalid, else null
//
// Requires js-yaml from the ROOT node_modules (a root dependency;
// install.sh's `npm install` provides it). Resolution is relative to THIS
// file, so importers in other packages (mcps/vault) still get the root copy.

import yaml from 'js-yaml';

export function parseFrontmatter(content) {
  const m = (content ?? '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    return { fm: {}, body: content ?? '', raw: '', hasFrontmatter: false, parseError: null };
  }
  try {
    const parsed = yaml.load(m[1], { schema: yaml.CORE_SCHEMA });
    const fm =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    return { fm, body: m[2], raw: m[1], hasFrontmatter: true, parseError: null };
  } catch (e) {
    return {
      fm: {},
      body: m[2],
      raw: m[1],
      hasFrontmatter: true,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
}
