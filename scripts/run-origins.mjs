// The four-value run-origin vocabulary — who dispatched a run. Stamped on the
// runs table's `origin` column at create time; NULL (legacy rows) reads as
// `human` at the derive/display layer.
//
// This module is intentionally dependency-free so both the SQLite-tainted
// runtime (scripts/runs-db-init.mjs imports node:sqlite at module top) AND
// vitest-loadable consumers (the server-side validator server/lib/run-origin.ts
// + its unit test) can import the same source. runs-db-init.mjs re-exports it
// so existing importers (scripts/audit.mjs) keep resolving unchanged. Mirror
// this list as the `RunOrigin` type union in
// domains/meta/app/server/routes/runs.types.ts (that file is types-only and
// cannot import this runtime value).
export const RUN_ORIGINS = ['human', 'automation', 'scheduler', 'driver'];
