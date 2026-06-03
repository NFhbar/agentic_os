// Mirrors scripts/events-db-init.mjs EXPECTED_COLUMNS — update when the
// schema changes. Shared across the notification modules so they agree
// on the EventRow contract instead of each typing it locally.

export interface EventRow {
  id?: number | bigint;
  ts: string;
  dedupe_key: string | null;
  kind: string;
  action: string;
  source?: string | null;
  skill?: string | null;
  project?: string | null;
  change_id?: string | null;
  report_id?: string | null;
  domain?: string | null;
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  tokens_cache_hit?: number | null;
  tokens_cache_write?: number | null;
  cost_usd?: number | null;
  duration_ms?: number | null;
  exit_status?: number | null;
  status?: string | null;
  description?: string | null;
  files_touched?: string | null;
  prompt?: string | null;
  stdout_preview?: string | null;
  stderr?: string | null;
  origin_log?: string | null;
  raw?: string | null;
}
