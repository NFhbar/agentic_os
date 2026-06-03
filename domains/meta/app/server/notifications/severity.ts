// Single source of truth for severity collapse — audit hooks, the rate
// limiter, and the dispatcher all agree on what 'urgent' means by importing
// from here rather than re-deriving it.

import type { EventRow } from './types.js';

export type Severity = 'success' | 'info' | 'warning' | 'urgent';

export function eventSeverity(event: EventRow): Severity {
  if (event.status === 'error') return 'urgent';
  if (event.exit_status != null && event.exit_status !== 0) return 'urgent';
  if (event.action === 'failed') return 'urgent';
  if (
    event.status === 'warning' ||
    event.action === 'suppressed-rate-limit' ||
    event.action === 'suppressed-dedupe'
  ) {
    return 'warning';
  }
  if (event.status === 'success' || event.exit_status === 0) return 'success';
  return 'info';
}
