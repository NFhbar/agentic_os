// Wire-shape types for the audit route. Per standard-shared-types — both
// the server (`audit.ts`) and the Health UI (`apps/health/View.tsx`) consume
// the same shape; this is the canonical definition.

export type AuditSeverity = 'error' | 'warn' | 'info';

export interface AuditFinding {
  id: string;
  severity: AuditSeverity;
  message: string;
  path?: string;
  hint?: string;
  // Optional stable disambiguator used to compute the dismissal id when set.
  // Findings whose `message` interpolates non-deterministic content (days
  // counters, ages, timestamps, counts) MUST set this to a stable string so
  // the dismissal id doesn't drift run-to-run. When absent, the dismissal id
  // falls back to hash(message) — fine for stable-message checks. See
  // dismissalIdForAuditFinding in health.ts.
  dedupe_key?: string;
  // Stamped by the audit route after joining each finding against the
  // action-item dismissal log. The Health UI uses this to default-hide
  // dismissed findings while keeping them available via a "Show dismissed"
  // toggle. Absent on legacy clients — treat as false.
  dismissed?: boolean;
}

export interface AuditResult {
  findings: AuditFinding[];
  summary: { error: number; warn: number; info: number };
}

// Full response from GET /api/audit — extends AuditResult with run metadata.
export interface AuditResponse extends AuditResult {
  ok: boolean;
  ran_at: string;
  duration_ms: number;
  error?: string;
}
