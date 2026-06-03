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
