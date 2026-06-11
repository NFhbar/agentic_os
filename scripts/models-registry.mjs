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
// Pricing is per-million-token rates in USD. Cache-write pricing is the
// 5-MINUTE-TTL rate (1.25× input) — the TTL Claude Code sessions use. The
// 1h-TTL rate (2× input) is not represented; add a `cache_write_1h` field
// if it becomes load-bearing. (The field was previously NAMED cache_write_1h
// while carrying 5m values — renamed 2026-06-11.)
//
// GROUND TRUTH: rates here must reproduce the `total_cost_usd` that
// `claude -p --output-format stream-json` reports in its result events.
// Validated 2026-06-11 against events.db dispatched-run rows: opus-4-7 and
// fable-5 rows match $5/$25 (read 0.5, write_5m 6.25) to 8 decimals. The
// previous opus entries ($15/$75 — the pre-4.5 list price) overstated every
// computed session cost 3×. tests/unit/models-pricing.test.ts pins these
// fixtures.
//
// This file is intentionally .mjs + plain JS so .mjs scripts (import-session-usage)
// and .ts server code can both import it without TS compilation gymnastics.

/**
 * @typedef {Object} ModelPricing
 * @property {number} input              per-M input tokens
 * @property {number} output             per-M output tokens
 * @property {number} cache_read         per-M cache-read tokens
 * @property {number} cache_write_5m     per-M cache-write tokens (5-minute TTL)
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} id                 canonical model id used by the Anthropic API
 * @property {'mythos'|'opus'|'sonnet'|'haiku'} family
 * @property {boolean} latest            true for the family's current default
 * @property {ModelPricing} pricing
 * @property {string} [aliases]          comma-separated id variants (dated suffixes, etc.)
 * @property {string} [note]             optional caveat (access restrictions, preview status, etc.)
 */

/** @type {ModelEntry[]} */
export const MODELS = [
  // Mythos-class — Anthropic's new flagship tier above Opus (released 2026-06-09).
  // Mythos 5 is the same model with safeguards relaxed for restricted research
  // partners — leave it in the registry but flag the access caveat so
  // dashboards don't recommend it accidentally.
  // PRICING NOTE: the announcement (anthropic.com/news/claude-fable-5-mythos-5)
  // said $10/$50, but the CLI's own total_cost_usd on fable-5 runs reproduces
  // $5/$25 exactly (validated 2026-06-11, two events.db rows to 8 decimals).
  // The registry follows the CLI — its job is to predict what gets billed.
  {
    id: 'claude-fable-5',
    family: 'mythos',
    latest: true,
    pricing: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write_5m: 6.25 },
  },
  {
    id: 'claude-mythos-5',
    family: 'mythos',
    latest: false,
    pricing: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write_5m: 6.25 },
    note: 'Restricted access — Project Glasswing partners and select biology researchers only',
  },
  // Opus 4.x family — repriced to $5/$25 from Opus 4.5 onward. Validated
  // against CLI-reported total_cost_usd; the prior $15/$75 entries were the
  // pre-4.5 list price and overstated computed session costs 3×.
  {
    id: 'claude-opus-4-8',
    family: 'opus',
    latest: true,
    pricing: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write_5m: 6.25 },
  },
  {
    id: 'claude-opus-4-7',
    family: 'opus',
    latest: false,
    pricing: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write_5m: 6.25 },
  },
  {
    id: 'claude-opus-4-6',
    family: 'opus',
    latest: false,
    pricing: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write_5m: 6.25 },
  },
  {
    id: 'claude-opus-4-5',
    family: 'opus',
    latest: false,
    pricing: { input: 5.0, output: 25.0, cache_read: 0.5, cache_write_5m: 6.25 },
  },
  // Sonnet 4.x family — mid-cost / balanced. (No CLI ground-truth rows in
  // events.db yet — rates unvalidated; the empirical method above applies
  // the moment a sonnet run lands.)
  {
    id: 'claude-sonnet-4-6',
    family: 'sonnet',
    latest: true,
    pricing: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_5m: 3.75 },
  },
  {
    id: 'claude-sonnet-4-5',
    family: 'sonnet',
    latest: false,
    pricing: { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_5m: 3.75 },
  },
  // Haiku 4.x family — low-cost / fast. (Unvalidated — see sonnet note.)
  {
    id: 'claude-haiku-4-5-20251001',
    family: 'haiku',
    latest: true,
    pricing: { input: 0.8, output: 4.0, cache_read: 0.08, cache_write_5m: 1.0 },
    aliases: 'claude-haiku-4-5',
  },
  {
    id: 'claude-haiku-4-5',
    family: 'haiku',
    latest: false,
    pricing: { input: 0.8, output: 4.0, cache_read: 0.08, cache_write_5m: 1.0 },
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

// Convenience — just the latest-of-family entries, in canonical display
// order (newest tier first: Mythos → Opus → Sonnet → Haiku).
export const RECOMMENDED = ['mythos', 'opus', 'sonnet', 'haiku']
  .map((f) => latestOfFamily(f))
  .filter(Boolean);

// Token-bucket → USD. Single cost-math site — the session importer and any
// future consumer compute through here so rates and math can't fork again.
// Models not in the registry return null (we don't guess).
export function computeCost(model, tokens) {
  const r = pricingFor(model);
  if (!r) return null;
  const M = 1_000_000;
  const cost =
    ((tokens.input || 0) * r.input) / M +
    ((tokens.output || 0) * r.output) / M +
    ((tokens.cache_read || 0) * r.cache_read) / M +
    ((tokens.cache_write || 0) * r.cache_write_5m) / M;
  // Round to 6 decimals — sub-cent precision is enough; full float drift looks bad
  return Math.round(cost * 1_000_000) / 1_000_000;
}
