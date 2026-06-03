import type { Rule } from './rules.js';
import { eventSeverity } from './severity.js';
import type { EventRow } from './types.js';

export function matchEvent(rule: Rule, event: EventRow): boolean {
  if (rule.event_type !== `${event.kind}.${event.action}`) return false;

  for (const [key, expected] of Object.entries(rule.filter)) {
    if (expected == null) continue;
    const actual =
      key === 'severity'
        ? eventSeverity(event)
        : (event as unknown as Record<string, unknown>)[key];
    if (actual !== expected) return false;
  }
  return true;
}
