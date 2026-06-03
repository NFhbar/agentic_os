// Surgical line-based frontmatter rewriter — preserves byte-equivalent
// representation of unchanged lines, only rewriting keys present in `updates`.
// New keys are appended at the end of the block.
//
// Why surgical (vs. yaml.dump round-trip): js-yaml's serializer promotes
// `last_verified: 2026-05-22` into a fully-qualified `2026-05-22T00:00:00.000Z`,
// re-orders keys to its internal preference, and reflows arrays. Surgical
// edits keep the source file byte-equivalent on unchanged lines — which is
// what archetype-driven entries expect, and what makes diffs reviewable.
//
// Lifted byte-equivalent from routes/pr-review-config.ts (lines 160-220)
// during research-derived change `notification-settings-ui-matrix-table-…`
// to share the same surgical rewriter across pr-review-config + notification
// rule CRUD. See standard-code-quality § 1 ("Reuse before introducing").

// Serialize a JS value to its inline-YAML form. Used by the surgical line
// rewriter below. Handles the value shapes we actually edit (strings,
// arrays of strings); falls back to JSON for anything exotic.
export function serializeYamlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return `[${v.map(serializeYamlValue).join(', ')}]`;
  }
  if (typeof v === 'string') {
    if (v === '') return "''";
    // Quote if any YAML-significant char appears OR the string has leading/
    // trailing whitespace or starts with a special character. Keeps bare
    // identifiers (slugs, model names, enum values) unquoted for readability.
    const needsQuotes = /[:'"\n#@&*!|>%`{}[\],]/.test(v) || /^[\s\-?]/.test(v) || /\s$/.test(v);
    if (!needsQuotes) return v;
    if (v.includes('\n')) {
      // Double-quoted form supports \n; single-quote can't represent newlines.
      return `"${v
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')}"`;
    }
    // Single-quoted with '' escaping for embedded apostrophes.
    return `'${v.replace(/'/g, "''")}'`;
  }
  return JSON.stringify(v);
}

// Surgical line-based frontmatter rewrite. Only lines whose key appears in
// `updates` are replaced; every other line is preserved verbatim, which
// avoids the round-trip distortion that a whole-frontmatter yaml.dump would
// introduce (`last_verified: 2026-05-22` getting promoted to
// `2026-05-22T00:00:00.000Z`, etc). New keys are appended to the end of the
// block.
export function rewriteFrontmatter(content: string, updates: Record<string, unknown>): string {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error('source file has no frontmatter to rewrite');
  const fmText = m[1];
  const body = content.slice(m[0].length);
  const lines = fmText.split('\n');
  const applied = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const km = line.match(/^([a-z_][a-z0-9_]*):/i);
    if (km && updates[km[1]] !== undefined && !applied.has(km[1])) {
      out.push(`${km[1]}: ${serializeYamlValue(updates[km[1]])}`);
      applied.add(km[1]);
    } else {
      out.push(line);
    }
  }
  for (const key of Object.keys(updates)) {
    if (!applied.has(key)) {
      out.push(`${key}: ${serializeYamlValue(updates[key])}`);
    }
  }
  return `---\n${out.join('\n')}\n---\n${body}`;
}

// Drop top-level frontmatter keys entirely (whole line). Used for lifecycle
// transitions that revert a state stamp (e.g. project reopen clearing
// `completed_at`). Nested keys aren't supported — the existing surgical
// rewriter only operates at the top level too.
export function removeFrontmatterFields(content: string, keys: readonly string[]): string {
  if (keys.length === 0) return content;
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error('source file has no frontmatter to rewrite');
  const fmText = m[1];
  const body = content.slice(m[0].length);
  const drop = new Set(keys);
  const out: string[] = [];
  for (const line of fmText.split('\n')) {
    const km = line.match(/^([a-z_][a-z0-9_]*):/i);
    if (km && drop.has(km[1])) continue;
    out.push(line);
  }
  return `---\n${out.join('\n')}\n---\n${body}`;
}
