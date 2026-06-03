// Pre-send gate that caps notification dispatch. Two gates in series:
// a global daily cap (default 100/day across all rules) and an optional
// per-rule override read from `rule.rate_limit.cap_per_day`. Only
// action='dispatched' rows count toward the cap — failures and prior
// suppressions don't feedback-loop the gate. The composite index
// `events_rate_limit(kind, action, ts, source)` covers both queries.

// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { countEvents } from '../../../../../scripts/events-db.mjs';
import type { Rule } from './rules.js';

export const GLOBAL_DAILY_CAP_DEFAULT = 100;

const ONE_DAY_MS = 86_400_000;

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; scope: 'global' | 'rule'; cap: number; current: number };

// `cap_per_day: 0` is admitted intentionally — that suppresses every send for
// the rule, matching the archetype's "soft cap" framing.
function readPerRuleCap(rule: Rule): number | null {
  const v = rule.rate_limit?.cap_per_day;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return null;
}

export function checkRateLimit(
  rule: Rule,
  globalCap: number = GLOBAL_DAILY_CAP_DEFAULT,
): RateLimitDecision {
  const since = new Date(Date.now() - ONE_DAY_MS).toISOString();

  const globalCount: number = countEvents({
    kind: 'notification',
    action: 'dispatched',
    since,
  });
  if (globalCount >= globalCap) {
    return { allowed: false, scope: 'global', cap: globalCap, current: globalCount };
  }

  const perRuleCap = readPerRuleCap(rule);
  if (perRuleCap != null) {
    const ruleCount: number = countEvents({
      kind: 'notification',
      action: 'dispatched',
      source: `rule:${rule.id}`,
      since,
    });
    if (ruleCount >= perRuleCap) {
      return { allowed: false, scope: 'rule', cap: perRuleCap, current: ruleCount };
    }
  }

  return { allowed: true };
}
