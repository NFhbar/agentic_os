// Template-rendered notification payloads with a per-`dedupe_key` LRU.
// Template lives at `vault/wiki/_seed/meta/template/notification-default.md`
// (override at `vault/wiki/meta/template/notification-default.md`) with
// Mustache-style {{var}} substitution against event + rule fields. Reads are
// file-mtime-cached so template edits land without a server restart. When no
// template resolves, falls through to a minimal payload (event_type as title,
// description as body) — same shape as the prior LLM-fallback path.
//
// The earlier Claude-subprocess renderer was removed in slack-mcp Change B:
// templates give us consistency + zero per-dispatch cost + no spawn latency,
// at the cost of free-form prose. The dispatch cache stays as-is so callers
// don't pay the fs-stat per fire on hot dedupe_keys.

import type { RenderedNotification } from './channel-adapter.js';
import type { Rule } from './rules.js';
import { clearTemplateCache, renderViaTemplate } from './template.js';
import type { EventRow } from './types.js';

const RENDER_CACHE_DEFAULT_CAPACITY = 256;

interface RenderCache {
  get(key: string): RenderedNotification | undefined;
  set(key: string, value: RenderedNotification): void;
  size: number;
  clear(): void;
}

export function createRenderCache(capacity = RENDER_CACHE_DEFAULT_CAPACITY): RenderCache {
  const store = new Map<string, RenderedNotification>();
  return {
    get size() {
      return store.size;
    },
    get(key) {
      if (!store.has(key)) return undefined;
      const value = store.get(key) as RenderedNotification;
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > capacity) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    clear() {
      store.clear();
    },
  };
}

const _renderCache = createRenderCache();

function fallbackPayload(event: EventRow): RenderedNotification {
  return {
    title: `${event.kind}.${event.action}`,
    body: event.description ?? '(no description)',
    links: [],
  };
}

export async function renderEvent(
  event: EventRow,
  rule: Rule,
  opts?: { bypassCache?: boolean },
): Promise<RenderedNotification> {
  const cacheKey = event.dedupe_key;
  if (!opts?.bypassCache && cacheKey) {
    const hit = _renderCache.get(cacheKey);
    if (hit) return hit;
  }

  const rendered = await renderViaTemplate(event, rule);
  const payload = rendered ?? fallbackPayload(event);
  if (cacheKey) _renderCache.set(cacheKey, payload);
  return payload;
}

export function clearRenderCache(): void {
  _renderCache.clear();
  clearTemplateCache();
}
