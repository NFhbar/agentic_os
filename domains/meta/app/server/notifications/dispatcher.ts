// Main entry for notification dispatch. The feedback-loop guard runs FIRST,
// before any rule load — kind=notification rows are the dispatcher's own
// writes, and processing them would create recursive dispatch even from
// misconfigured rules. Per matching rule we then run the rate-limit gate
// (global daily cap + per-rule override) before send; cap-exceeded rules
// emit a `suppressed-rate-limit` row attributed to `rule:<id>` and skip
// the actual dispatch. Storage dedupe vs. source dedupe distinction: the
// dispatcher does NOT set `dedupe_key` on the outbound row (recordEvent
// computes its own composite from ts|kind|action|raw), and stamps the
// triggering event's dedupe_key into `raw.source_dedupe_key` so downstream
// consumers (rate limiter) can read it via json_extract.

// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { recordEvent } from '../../../../../scripts/events-db.mjs';
import type { RenderedNotification } from './channel-adapter.js';
import { getAdapter } from './adapters/index.js';
import { matchEvent } from './matcher.js';
import { checkRateLimit } from './rate-limiter.js';
import { renderEvent } from './render.js';
import { type Rule, loadActiveRules } from './rules.js';
import type { EventRow } from './types.js';

const TRANSIENT_ERROR_RE = /network|ECONN|timeout|5xx|429|50[34]/i;
const RETRY_DELAY_MS = 2000;

function isTransientError(msg: string | undefined): boolean {
  if (!msg) return false;
  return TRANSIENT_ERROR_RE.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Exported so `routes/notifications.ts` can call a single-rule dispatch path
// directly from `POST /rules/:id/test-send` rather than re-entering
// dispatchEvent (which would fan the synthetic event out to EVERY matching
// rule). Production traffic still goes through dispatchEvent → loadActiveRules
// → matcher → rate-limit → dispatchForRule.
export async function dispatchForRule(event: EventRow, rule: Rule): Promise<void> {
  const rendered = await renderEvent(event, rule);
  const adapter = getAdapter(rule.channel);
  let result = await adapter.send(rendered, rule.delivery);
  if (result.status === 'failed' && isTransientError(result.error)) {
    await sleep(RETRY_DELAY_MS);
    result = await adapter.send(rendered, rule.delivery);
  }

  const ok = result.status === 'ok';
  const errorMsg = result.status === 'failed' ? result.error : null;
  recordEvent({
    kind: 'notification',
    action: ok ? 'dispatched' : 'failed',
    source: `rule:${rule.id}`,
    change_id: event.change_id ?? null,
    project: event.project ?? null,
    domain: event.domain ?? null,
    report_id: event.report_id ?? null,
    status: ok ? 'success' : 'error',
    description: ok ? `dispatched to ${rule.channel} via rule ${rule.id}` : `failed: ${errorMsg}`,
    raw: {
      rendered,
      rule_id: rule.id,
      channel: rule.channel,
      source_dedupe_key: event.dedupe_key,
    },
  });
}

// Test-send variant — exposed so `routes/notifications.ts` can fire a
// synthetic event for ONE specific rule from the Settings UI's test-send
// button. Three differences from `dispatchForRule`:
//   1. Bypasses `checkRateLimit` entirely (the user is testing — they
//      expect the message to go through even if the rule is over its cap).
//      `dispatchForRule` already has no rate-limit gate; the gate lives in
//      `dispatchEvent` before the per-rule call. So nothing to remove here;
//      this helper just doesn't ADD a gate.
//   2. Passes `{ bypassCache: true }` to `renderEvent` — test sends have a
//      unique `dedupe_key` (`'test:' + rule.id + ':' + Date.now()`), so they
//      would never hit a cached render anyway; populating the LRU with
//      one-shot entries would be wasteful.
//   3. Prepends `[TEST] ` to the rendered title before adapter dispatch.
//      The `:test` source suffix on the audit row is the machine-readable
//      marker; the visible `[TEST]` prefix is the user-facing analog.
// Returns `{ rendered, adapter_result }` so the test-send endpoint can
// surface the rendered output + adapter status in its response body.
export async function dispatchForTest(
  event: EventRow,
  rule: Rule,
): Promise<{
  rendered: RenderedNotification;
  adapter_result: { status: 'ok' | 'failed'; error?: string };
}> {
  const baseRendered = await renderEvent(event, rule, { bypassCache: true });
  // Prepend [TEST] to the visible title; the source suffix on the audit
  // row is the canonical machine-readable marker.
  const rendered = { ...baseRendered, title: `[TEST] ${baseRendered.title}` };
  const adapter = getAdapter(rule.channel);
  let result = await adapter.send(rendered, rule.delivery);
  if (result.status === 'failed' && isTransientError(result.error)) {
    await sleep(RETRY_DELAY_MS);
    result = await adapter.send(rendered, rule.delivery);
  }
  const ok = result.status === 'ok';
  const errorMsg = result.status === 'failed' ? result.error : null;
  recordEvent({
    kind: 'notification',
    action: ok ? 'dispatched' : 'failed',
    // `:test` suffix distinguishes test-send rows from production traffic
    // while still keeping `rule:<id>` as the matcher/rate-limiter prefix.
    source: `rule:${rule.id}:test`,
    change_id: event.change_id ?? null,
    project: event.project ?? null,
    domain: event.domain ?? null,
    report_id: event.report_id ?? null,
    status: ok ? 'success' : 'error',
    description: ok
      ? `test-send dispatched to ${rule.channel} via rule ${rule.id}`
      : `test-send failed: ${errorMsg}`,
    raw: {
      rendered,
      rule_id: rule.id,
      channel: rule.channel,
      source_dedupe_key: event.dedupe_key,
      test: true,
    },
  });
  return {
    rendered,
    adapter_result:
      result.status === 'ok'
        ? { status: 'ok' as const }
        : { status: 'failed' as const, error: result.error },
  };
}

export async function dispatchEvent(event: EventRow): Promise<void> {
  if (event.kind === 'notification') return;

  let rules: Rule[];
  try {
    rules = await loadActiveRules();
  } catch (err) {
    console.error('notifications/dispatcher: loadActiveRules failed', err);
    return;
  }

  for (const rule of rules) {
    if (!matchEvent(rule, event)) continue;
    const decision = checkRateLimit(rule);
    if (!decision.allowed) {
      recordEvent({
        kind: 'notification',
        action: 'suppressed-rate-limit',
        source: `rule:${rule.id}`,
        change_id: event.change_id ?? null,
        project: event.project ?? null,
        domain: event.domain ?? null,
        report_id: event.report_id ?? null,
        status: 'warning',
        description: `rate-limit cap exceeded (${decision.scope}: ${decision.current}/${decision.cap})`,
        raw: {
          rule_id: rule.id,
          channel: rule.channel,
          source_dedupe_key: event.dedupe_key,
          cap_scope: decision.scope,
          cap: decision.cap,
          current: decision.current,
        },
      });
      continue;
    }
    try {
      await dispatchForRule(event, rule);
    } catch (err) {
      console.error(`notifications/dispatcher: rule ${rule.id} failed`, err);
    }
  }
}
