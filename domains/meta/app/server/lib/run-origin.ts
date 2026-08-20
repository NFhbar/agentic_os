// Runtime validation of the run-origin wire value. The four-value vocabulary
// is a runtime property (RUN_ORIGINS in scripts/run-origins.mjs); the
// RunOrigin type union in runs.types.ts mirrors it for compile-time callers.
//
// HTTP dispatch paths accept an untrusted `origin` string off the wire and
// must run it through here before threading it into startRun — the TS type is
// a wire claim, not a guarantee (standard-code-quality § 4: validate at trust
// boundaries, trust internal contracts). One validator shared by every
// dispatch path; a per-route membership check would be the canonical
// single-source-of-truth regression.
//
// undefined/null pass through as `{ ok: true, origin: undefined }` so
// startRun's `input.origin ?? 'human'` stays the single place the default
// resolves. A known value returns itself; anything else is a rejection the
// caller maps to HTTP 400 (mirrors the trigger_source expected-one-of idiom).
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { RUN_ORIGINS } from '../../../../../scripts/run-origins.mjs';
import type { RunOrigin } from '../routes/runs.types.js';

export type ParseRunOriginResult =
  | { ok: true; origin: RunOrigin | undefined }
  | { ok: false; error: string };

export function parseRunOrigin(value: unknown): ParseRunOriginResult {
  if (value === undefined || value === null) return { ok: true, origin: undefined };
  if (typeof value === 'string' && RUN_ORIGINS.includes(value)) {
    return { ok: true, origin: value as RunOrigin };
  }
  return {
    ok: false,
    error: `invalid origin '${String(value)}' — expected one of: ${RUN_ORIGINS.join(', ')}`,
  };
}
