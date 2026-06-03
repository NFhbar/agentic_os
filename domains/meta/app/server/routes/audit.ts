import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';
import type { AuditResponse, AuditResult } from './audit.types.js';
import { dismissalIdForAuditFinding, loadDismissedIds } from './health.js';

// Re-export wire-shape types for backward-compat. New consumers should
// import from ./audit.types.js per standard-shared-types.
export type { AuditFinding, AuditResponse, AuditResult, AuditSeverity } from './audit.types.js';

// Spawn `node scripts/audit.mjs --json` and parse the result.
// Audit is pure-Node and runs in <100ms on a normal-sized OS, so no caching
// is needed — every request is fresh.
function runAudit(): Promise<AuditResponse> {
  const startMs = Date.now();
  const ranAt = new Date().toISOString();
  return new Promise((resolve) => {
    const child = spawn('node', [join(REPO_ROOT, 'scripts', 'audit.mjs'), '--json'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('close', async () => {
      const durationMs = Date.now() - startMs;
      try {
        const parsed = JSON.parse(stdout) as AuditResult;
        // Stamp dismissal status on every finding so the Health UI can
        // default-hide them with a toggle to reveal. Same dismissal-id
        // composition as the action-items endpoint — shared via the
        // `dismissalIdForAuditFinding` helper exported from health.ts so
        // the two surfaces stay aligned on the id shape.
        const dismissed = await loadDismissedIds();
        const findings = parsed.findings.map((f) => ({
          ...f,
          dismissed: dismissed.has(dismissalIdForAuditFinding(f)),
        }));
        resolve({
          ok: true,
          ran_at: ranAt,
          duration_ms: durationMs,
          findings,
          summary: parsed.summary,
        });
      } catch (e) {
        resolve({
          ok: false,
          ran_at: ranAt,
          duration_ms: durationMs,
          findings: [],
          summary: { error: 0, warn: 0, info: 0 },
          error: `audit JSON parse failed: ${e instanceof Error ? e.message : String(e)} — stderr: ${stderr.slice(0, 500)}`,
        });
      }
    });
    child.on('error', (e) => {
      const durationMs = Date.now() - startMs;
      resolve({
        ok: false,
        ran_at: ranAt,
        duration_ms: durationMs,
        findings: [],
        summary: { error: 0, warn: 0, info: 0 },
        error: `spawn failed: ${e.message}`,
      });
    });
  });
}

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => runAudit());
};
