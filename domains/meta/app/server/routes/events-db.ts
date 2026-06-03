import type { FastifyPluginAsync } from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts
import { queryEvents, statsEvents } from '../../../../../scripts/events-db.mjs';

interface EventsQuery {
  kind?: string;
  skill?: string;
  project?: string;
  change_id?: string;
  // Matches `json_extract(raw, '$.args.review')` — used to pull the activity
  // timeline for a pr-review entry whose events don't carry change_id.
  review_id?: string;
  model?: string;
  domain?: string;
  since?: string;
  until?: string;
  limit?: string;
}

export const eventsDbRoutes: FastifyPluginAsync = async (fastify) => {
  // Filtered event rows.
  fastify.get<{ Querystring: EventsQuery }>('/', async (req) => {
    const q = req.query ?? {};
    const rows = queryEvents({
      kind: q.kind || undefined,
      skill: q.skill || undefined,
      project: q.project || undefined,
      change_id: q.change_id || undefined,
      review_id: q.review_id || undefined,
      model: q.model || undefined,
      domain: q.domain || undefined,
      since: q.since || undefined,
      until: q.until || undefined,
      limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
    });
    return { events: rows };
  });

  // Aggregate stats over a time window (default 30 days).
  fastify.get<{ Querystring: { window?: string } }>('/stats', async (req) => {
    const window = req.query?.window ? Math.max(1, Number.parseInt(req.query.window, 10)) : 30;
    return statsEvents(window);
  });
};
