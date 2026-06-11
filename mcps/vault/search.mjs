// Search implementation for the vault MCP.
//
// Primary engine: SQLite FTS5 with BM25 ranking over id + title + tags +
// entry BODIES (vault/.index/search.db, rebuilt by
// .claude/hooks/rebuild-vault-index.mjs on every wiki write). Snippets come
// from FTS5's snippet() — actual match context, not the manifest's first-200-
// chars. Column weights: id 10 > title 5 > tags 3 > body 1.
//
// Fallback engine: the original substring scorer over the JSON manifest's
// title/id/snippet — used when search.db is missing (fresh install before
// the first rebuild, FTS5-less node build) or briefly locked mid-rebuild.
// The fallback is what shipped before the Fable review demonstrated it
// returning wrong-or-nothing for 3 of 4 realistic queries (Finding 5.1):
// body-only knowledge was unreachable.
//
// Zero-hit queries are logged to events.db (kind=mcp, action=
// vault-search-miss) — retrieval misses used to vanish silently; now
// they're observable and can drive vocabulary/curation fixes.
//
// node:sqlite and events-db are imported lazily so this module stays
// loadable by vitest (which can't resolve node:sqlite) for the pure parts.

import { existsSync } from 'node:fs';

// Free text → FTS5 MATCH expression. Each token is double-quoted (neutralizes
// MATCH operators like AND/OR/NEAR/^/*) and tokens are OR-joined: BM25 ranks
// docs matching more terms higher, so OR gives recall without losing
// precision at the top. Returns null when no tokens survive — callers fall
// back to the substring engine.
export function buildMatchExpression(query) {
  const tokens = (query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// Legacy substring scorer (pre-FTS engine), kept verbatim as the fallback.
export function scoreEntry(entry, query) {
  const q = query.toLowerCase();
  const title = (entry.title ?? '').toLowerCase();
  const id = (entry.id ?? '').toLowerCase();
  const snippet = (entry.snippet ?? '').toLowerCase();
  let score = 0;
  if (id === q) score += 100;
  if (id.includes(q)) score += 40;
  if (title === q) score += 80;
  if (title.includes(q)) score += 30;
  if (snippet.includes(q)) score += 10;
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (title.includes(token)) score += 5;
    if (snippet.includes(token)) score += 2;
  }
  return score;
}

export function substringSearch(entries, { query, archetype, domain, limit = 10 }) {
  const filtered = entries.filter((e) => {
    if (archetype && e.type !== archetype) return false;
    if (domain && e.domain !== domain) return false;
    return true;
  });
  const scored = filtered
    .map((e) => ({ entry: e, score: scoreEntry(e, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(50, limit)));
  return {
    count: scored.length,
    total_searched: filtered.length,
    engine: 'substring',
    hits: scored.map(({ entry, score }) => ({
      id: entry.id,
      title: entry.title,
      archetype: entry.type,
      domain: entry.domain,
      path: entry.path,
      snippet: entry.snippet,
      score,
    })),
  };
}

async function ftsSearch(searchDbPath, { query, archetype, domain, limit = 10 }) {
  const match = buildMatchExpression(query);
  if (!match) return null;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(searchDbPath, { readOnly: true });
  try {
    const where = ['wiki_fts MATCH ?'];
    const params = [match];
    if (archetype) {
      where.push('type = ?');
      params.push(archetype);
    }
    if (domain) {
      where.push('domain = ?');
      params.push(domain);
    }
    const lim = Math.max(1, Math.min(50, Number(limit) || 10));
    const rows = db
      .prepare(
        `SELECT id, title, type, domain, path,
                snippet(wiki_fts, 3, '«', '»', ' … ', 12) AS snip,
                bm25(wiki_fts, 10.0, 5.0, 3.0, 1.0) AS rank
           FROM wiki_fts
          WHERE ${where.join(' AND ')}
          ORDER BY rank
          LIMIT ${lim}`,
      )
      .all(...params);
    const total =
      db
        .prepare(`SELECT count(*) AS n FROM wiki_fts WHERE ${where.join(' AND ')}`)
        .get(...params)?.n ?? rows.length;
    return {
      count: rows.length,
      total_matched: total,
      engine: 'fts5',
      hits: rows.map((r) => ({
        id: r.id || null,
        title: r.title || null,
        archetype: r.type || null,
        domain: r.domain || null,
        path: r.path,
        snippet: r.snip,
        // bm25 is negative-better; flip + round for a human-readable score.
        score: Math.round(-r.rank * 100) / 100,
      })),
    };
  } finally {
    db.close();
  }
}

// Best-effort telemetry — a failed write must never break a search.
function logSearchMiss({ query, archetype, domain, engine }) {
  import('../../scripts/events-db.mjs')
    .then(({ recordEvent }) =>
      recordEvent({
        ts: new Date().toISOString(),
        kind: 'mcp',
        action: 'vault-search-miss',
        source: 'vault-mcp',
        status: 'miss',
        description: query,
        raw: JSON.stringify({
          query,
          archetype: archetype ?? null,
          domain: domain ?? null,
          engine,
        }),
      }),
    )
    .catch(() => {});
}

export async function searchWiki({ query, archetype, domain, limit = 10 }, { loadIndex, searchDbPath }) {
  let result = null;
  if (searchDbPath && existsSync(searchDbPath)) {
    try {
      result = await ftsSearch(searchDbPath, { query, archetype, domain, limit });
    } catch {
      // locked mid-rebuild / corrupt / FTS5 unavailable — fall back.
      result = null;
    }
  }
  if (!result) {
    result = substringSearch(loadIndex(), { query, archetype, domain, limit });
  }
  if (result.count === 0) logSearchMiss({ query, archetype, domain, engine: result.engine });
  return result;
}
