// /api/models — exposes the OS's known-good Claude model list to the
// dashboard. Backed by scripts/models-registry.mjs (the single source of
// truth shared with import-session-usage's pricing table).
//
// Returns the full list always; clients filter for "latest only" view via
// the `latest` flag on each entry. No external API calls — the registry is
// the durable shared knowledge of "what models exist in this install."

import type { FastifyPluginAsync } from 'fastify';
// @ts-expect-error — .mjs import from sibling JS module; type-checked via JSDoc
import { MODELS } from '../../../../../scripts/models-registry.mjs';

interface ModelEntry {
  id: string;
  family: 'mythos' | 'opus' | 'sonnet' | 'haiku';
  latest: boolean;
  pricing: {
    input: number;
    output: number;
    cache_read: number;
    cache_write_5m: number;
  };
  aliases?: string;
  // Optional caveat surfaced in the Settings model dropdown (e.g. "restricted
  // access — research partners only" for Mythos 5).
  note?: string;
}

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/models — return the registry. Static-ish payload; safe to cache
  // long. The dashboard fetches once on Settings page mount.
  fastify.get('/', async () => {
    return { models: MODELS as ModelEntry[] };
  });
};
