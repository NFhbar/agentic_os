// Type re-exports from the server's wire-shape definitions + client-only
// fetch helpers. Per standard-shared-types (sibling .types.ts pattern), the
// server route file's .types.ts is the single source of truth.

import { getJson, postJson } from '../../lib/api';

export type {
  ChannelId,
  RenderedNotification,
  RuleDelivery,
  RuleFilter,
  RuleListItem,
  RuleRateLimit,
  TestSendResult,
  ValidationError,
} from '../../../server/routes/notifications.types';

// Re-export the as-const tuples too so callers can iterate them (e.g. the
// channel-picker buttons in RuleEditor).
export { VALID_CHANNELS } from '../../../server/routes/notifications.types';

// Imports for the function signatures below.
import type {
  ChannelId,
  RuleListItem,
  TestSendResult,
  ValidationError,
} from '../../../server/routes/notifications.types';

export async function listRules(): Promise<{ rules: RuleListItem[] }> {
  return getJson('/api/notifications/rules');
}

export async function getRule(id: string): Promise<RuleListItem> {
  return getJson(`/api/notifications/rules/${encodeURIComponent(id)}`);
}

export async function listEventTypes(): Promise<{ event_types: string[] }> {
  return getJson('/api/notifications/event-types');
}

export async function listOwningDomains(): Promise<{ domains: string[] }> {
  return getJson('/api/notifications/owning-domains');
}

export async function listProjectIds(): Promise<{ ids: string[]; titles: Record<string, string> }> {
  return getJson('/api/projects/ids');
}

export type { EventCatalogEntry } from '../../../server/routes/notifications.types';
import type { EventCatalogEntry } from '../../../server/routes/notifications.types';

export async function getEventCatalog(): Promise<{ entries: EventCatalogEntry[] }> {
  return getJson('/api/notifications/event-catalog');
}

// Resolve the event_type that a lifecycle-stepper step subscribes to. Per
// event-catalog: each step is identified by `<context>:<step-id>` (e.g.
// `change:scaffolded`, `research-report:drafted`, `project:in-research`).
// Returns null when no catalog entry declares the step — the bell is then
// omitted on that step (honest gap > false subscription target).
export function findEventForStep(
  catalog: EventCatalogEntry[],
  context: 'change' | 'research-report' | 'project',
  stepId: string,
): string | null {
  const want = `${context}:${stepId}`;
  for (const entry of catalog) {
    if (entry.lifecycle_steps.includes(want)) return entry.event_type;
  }
  return null;
}

export type { SlackMode } from '../../../server/routes/notifications.types';
import type { SlackMode } from '../../../server/routes/notifications.types';

export async function getSlackMode(): Promise<{ mode: SlackMode }> {
  return getJson('/api/notifications/slack-mode');
}

// Build a Map<event_type, rule_id> for the bell-on-lifecycle-step UX. Matches
// rules that are EITHER scoped to this entity's project OR globally scoped
// (no filter.project — applies everywhere). Project-scoped rules win when
// both exist for the same event_type (more specific). Disabled rules skipped.
//
// The map drives the bell's "subscribed" visual state on each lifecycle
// stepper step; the resolved rule_id lets the click handler open the
// existing rule for edit instead of always creating a new one.
export function buildSubscriptionMap(
  rules: RuleListItem[],
  entityProject: string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (!r.enabled) continue;
    const ruleProject =
      typeof r.filter?.project === 'string' && r.filter.project.length > 0
        ? r.filter.project
        : null;
    // Match: rule is global OR rule's project matches this entity's project.
    if (ruleProject !== null && ruleProject !== entityProject) continue;
    const existing = out.get(r.event_type);
    // Project-scoped rule wins over global for the same event_type. If we
    // already have an entry and the new rule is global, skip; if we already
    // have a global and the new is project-scoped, replace.
    if (existing) {
      const existingRule = rules.find((x) => x.id === existing);
      const existingIsGlobal = !existingRule || !existingRule.filter?.project;
      const newIsProjectScoped = ruleProject !== null;
      if (existingIsGlobal && newIsProjectScoped) {
        out.set(r.event_type, r.id);
      }
      continue;
    }
    out.set(r.event_type, r.id);
  }
  return out;
}

export async function createRule(
  body: Partial<RuleListItem> & {
    domain: string;
    title: string;
    event_type: string;
    channel: ChannelId;
  },
): Promise<{ ok: true; id: string; source_path: string } | ValidationError> {
  return postJson('/api/notifications/rules', body);
}

export async function updateRule(
  id: string,
  body: Partial<Omit<RuleListItem, 'id' | 'domain' | 'source_path'>>,
): Promise<{ ok: true; id: string } | ValidationError> {
  const r = await fetch(`/api/notifications/rules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<{ ok: true; id: string } | ValidationError>;
}

export async function deleteRule(id: string): Promise<{ ok: true; warning?: string }> {
  const r = await fetch(`/api/notifications/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return r.json() as Promise<{ ok: true; warning?: string }>;
}

export async function testSend(id: string): Promise<TestSendResult> {
  return postJson(`/api/notifications/rules/${encodeURIComponent(id)}/test-send`, {});
}

export type { NotificationEvent } from '../../../server/routes/notifications.types';
import type { NotificationEvent } from '../../../server/routes/notifications.types';

export async function listNotificationEvents(
  opts: { limit?: number; since?: string } = {},
): Promise<{ events: NotificationEvent[]; total: number }> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.since) params.set('since', opts.since);
  const qs = params.toString();
  return getJson(`/api/notifications/events${qs ? `?${qs}` : ''}`);
}
