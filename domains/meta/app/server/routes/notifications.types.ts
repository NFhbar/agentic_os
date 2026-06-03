// Wire-shape types for the notifications route. Imported by `notifications.ts`
// (server) and `src/apps/notifications/data.ts` (client) so both sides agree
// on a single contract.
//
// Convention (see standard-shared-types): this file holds ONLY type defs +
// `as const` tuples for shared enums. No node:* imports, no runtime values
// that require execution beyond literals. Anything stateful belongs in the
// sibling `notifications.ts`.
//
// Design call documented in the polish-bundle #8 special-case + the
// shared-types-notifications-migration change: the STRICT shape is canonical
// (matches the client's existing form-rendering view). The server parses
// frontmatter via YAML (which produces unknown shapes) but the validateBody
// gate on writes enforces strict conformance — so the casts from
// `Record<string, unknown>` to the strict shape on read are sound in practice.

// ── Atom enums ───────────────────────────────────────────────────────────────

export const VALID_CHANNELS = ['slack', 'email', 'desktop'] as const;
export type ChannelId = (typeof VALID_CHANNELS)[number];

export const VALID_SEVERITIES = ['success', 'info', 'warning', 'urgent'] as const;
export type NotificationSeverity = (typeof VALID_SEVERITIES)[number];

export const VALID_URGENCIES = ['low', 'normal', 'critical'] as const;
export type DesktopUrgency = (typeof VALID_URGENCIES)[number];

export type SlackMode = 'bot-token' | 'webhook' | 'none';

// ── Rule sub-shapes ──────────────────────────────────────────────────────────

export interface RuleFilter {
  project?: string | null;
  domain?: string | null;
  severity?: NotificationSeverity | null;
}

export interface RuleDelivery {
  slack_channel?: string;
  tags?: string[];
  to?: string[];
  cc?: string[];
  from?: string;
  urgency?: DesktopUrgency;
}

export interface RuleRateLimit {
  cap_per_day?: number | null;
}

// ── Top-level wire shapes ────────────────────────────────────────────────────

export interface RuleListItem {
  id: string;
  domain: string;
  title: string;
  event_type: string;
  channel: ChannelId;
  enabled: boolean;
  filter: RuleFilter;
  delivery: RuleDelivery;
  rate_limit: RuleRateLimit | null;
  source_path: string;
}

export interface RenderedNotification {
  title: string;
  body: string;
  links?: Array<{ label: string; url: string }>;
}

export interface TestSendResult {
  ok: boolean;
  rendered: RenderedNotification;
  channel: ChannelId;
  adapter_result: { status: 'ok' | 'failed'; error?: string };
}

export interface ValidationError {
  ok: false;
  error: string;
  field: string;
}

export interface EventCatalogEntry {
  event_type: string;
  description: string;
  entity: 'project' | 'change' | 'research-report' | 'none' | string;
  entity_filter_field: string | null;
  // Comma-separated `<context>:<step-id>` values declaring which lifecycle-
  // stepper steps subscribe to this event. Empty array when not on any stepper.
  lifecycle_steps: string[];
}

export interface NotificationEvent {
  id: number;
  ts: string;
  rule_id: string | null;
  rule_title: string | null;
  rule_exists: boolean;
  channel: ChannelId | null;
  event_type: string | null;
  action: string;
  status: string | null;
  description: string | null;
  project: string | null;
  change_id: string | null;
  skill: string | null;
  is_test: boolean;
}
