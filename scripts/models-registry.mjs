// Models registry — the single source of truth for which Claude model IDs the
// OS knows about + their pricing. Consumed by:
//
//   - scripts/import-session-usage.mjs    (token → cost computation)
//   - domains/meta/app/server/routes/models.ts  (GET /api/models for the dashboard)
//   - (future) any skill that wants to validate a user-supplied model id
//
// Update this file when new models release. Order within each family is
// newest-first; `latest: true` marks the family's current default for the
// dashboard's "show recommended only" view.
//
// Pricing is per-million-token rates in USD. Cache pricing matches Anthropic's
// published 1-hour cache write rate (5-min variant pricing is not represented
// here yet — add a `cache_write_5m` field if it becomes load-bearing).
//
// This file is intentionally .mjs + plain JS so .mjs scripts (import-session-usage)
// and .ts server code can both import it without TS compilation gymnastics.

/**
 * @typedef {Object} ModelPricing
 * @property {number} input              per-M input tokens
 * @property {number} output             per-M output tokens
 * @property {number} cache_read         per-M cache-read tokens
 * @property {number} cache_write_1h     per-M cache-write tokens (1h TTL)
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} id                 canonical model id used by the Anthropic API
 * @property {'opus'|'sonnet'|'haiku'} family
 * @property {boolean} latest            true for the family's current default
 * @property {ModelPricing} pricing
 * @property {string} [aliases]          comma-separated id variants (dated suffixes, etc.)
 */

/** @type {ModelEntry[]} */
export const MODELS = [
  // Opus 4.x family — high-cost / high-capability
  {
    id: 'claude-opus-4-7',
    family: 'opus',
    latest: true,
    pricing: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  },
  {
    id: 'claude-opus-4-6',
    family: 'opus',
    latest: false,
    pricing: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  },
  {
    id: 'claude-opus-4-5',
    family: 'opus',
    latest: false,
    pricing: { input: 15.0, output: 75.0, cache_read: 1.5, cache_write_1h: 18.75 },
  },
  // Sonnet 4.x family — mid-cost / balanced
  {
    id: 'claude-sonnet-4-6',
    family: 'sonnet',
    latest: true,
    pricing: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_1h: 3.75 },
  },
  {
    id: 'claude-sonnet-4-5',
    family: 'sonnet',
    latest: false,
    pricing: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_1h: 3.75 },
  },
  // Haiku 4.x family — low-cost / fast
  {
    id: 'claude-haiku-4-5-20251001',
    family: 'haiku',
    latest: true,
    pricing: { input: 0.8, output: 4.0, cache_read: 0.08, cache_write_1h: 1.0 },
    aliases: 'claude-haiku-4-5',
  },
  {
    id: 'claude-haiku-4-5',
    family: 'haiku',
    latest: false,
    pricing: { input: 0.8, output: 4.0, cache_read: 0.08, cache_write_1h: 1.0 },
  },
];

// Lookup map for pricing — accepts model ids, normalized of any
// `[context-window]` suffix (e.g. `claude-opus-4-7[1m]`).
export function pricingFor(id) {
  if (!id) return null;
  const normalized = id.replace(/\[[^\]]+\]$/, '');
  const match = MODELS.find((m) => m.id === normalized || m.aliases?.split(',').includes(normalized));
  return match?.pricing ?? null;
}

// Return just the family's current default. Used by the dashboard when the
// user clicks "use latest opus / sonnet / haiku".
export function latestOfFamily(family) {
  return MODELS.find((m) => m.family === family && m.latest) ?? null;
}

// Convenience — just the three latest-of-family entries, in canonical
// display order (Opus → Sonnet → Haiku).
export const RECOMMENDED = ['opus', 'sonnet', 'haiku']
  .map((f) => latestOfFamily(f))
  .filter(Boolean);
