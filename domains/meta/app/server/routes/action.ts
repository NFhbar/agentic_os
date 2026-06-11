import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { spawnClaude } from '../../../../../scripts/dispatch-claude.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { recordEvent } from '../../../../../scripts/events-db.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractFromPrompt } from '../../../../../scripts/extract-event-attribution.mjs';
// @ts-expect-error — pure-ESM .mjs helper with no .d.ts; node resolves fine
import { extractSkill } from '../../../../../scripts/extract-event-attribution.mjs';
import { parseStreamJsonLine } from '../lib/stream-json.js';
import { REPO_ROOT } from '../repo.js';

const AUDIT_LOG = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');

// Legacy route — POST /api/runs is now the canonical dispatcher (writes a
// row in `runs`, streams to disk, supports multi-subscriber SSE). This route
// stays registered for backwards compatibility with the scheduler's run-now
// path and any unmigrated callers; it will be removed once those are gone.
export const actionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: { prompt: string } }>('/', async (req, reply) => {
    const { prompt } = req.body;
    const ts = new Date().toISOString();
    const startedMs = Date.now();
    const skill = extractSkill(prompt);
    // Best-effort attribution via the shared extract-event-attribution helper.
    // Lifts `change: "<id>"` / `project: "<id>"` / `domain: "<name>"` out of
    // the prompt body so the event row is queryable by primitive.
    const { change_id, project, domain, report_id } = extractFromPrompt(prompt);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    // stream-json + verbose: each stdout line is a JSON event.
    // - type:assistant message carries content chunks → forward as chunks
    // - type:result is the final summary → capture metrics
    // - any non-JSON line is forwarded as a plain chunk (defensive)
    //
    // --permission-mode bypassPermissions: in -p (headless) mode there's
    // no interactive prompt for tool approvals. The dashboard has already
    // collected user confirmation (button click + form/typed-confirm).
    const { child } = await spawnClaude(prompt, skill, { logPrefix: 'action' });

    let stdoutBuf = '';
    let stderrAll = '';
    // Captured from the final result event.
    let model: string | null = null;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let tokensCacheRead: number | null = null;
    let tokensCacheWrite: number | null = null;
    let costUsd: number | null = null;
    let claudeDurationMs: number | null = null;
    let isError = false;
    let combinedText = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (!line) continue;
        const parsed = parseStreamJsonLine(line);
        for (const p of parsed) {
          if (p.kind === 'assistant-text' || p.kind === 'raw') {
            combinedText += p.text;
            reply.raw.write(`data: ${JSON.stringify({ chunk: p.text })}\n\n`);
          } else if (p.kind === 'result') {
            model = p.model;
            tokensIn = p.tokensIn;
            tokensOut = p.tokensOut;
            tokensCacheRead = p.tokensCacheRead;
            tokensCacheWrite = p.tokensCacheWrite;
            costUsd = p.costUsd;
            claudeDurationMs = p.claudeDurationMs;
            isError = p.isError;
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      stderrAll += s;
      reply.raw.write(`data: ${JSON.stringify({ stderr: s })}\n\n`);
    });
    child.on('close', async (code: number | null) => {
      reply.raw.write(`data: ${JSON.stringify({ done: true, exit: code })}\n\n`);
      reply.raw.end();

      const durationMs = Date.now() - startedMs;

      // Layer 1: JSONL audit (legacy, unchanged). Telemetry dual-writes below.
      await mkdir(dirname(AUDIT_LOG), { recursive: true });
      await appendFile(
        AUDIT_LOG,
        JSON.stringify({ ts, action: 'ai-prompt', prompt, exit_status: code }) + '\n',
      );

      // Layer 2: events.db structured row. Best-effort, never blocks.
      recordEvent({
        ts,
        kind: 'dashboard',
        action: 'ai-prompt',
        source: 'dashboard',
        skill,
        change_id,
        project,
        report_id,
        domain,
        model,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        tokens_cache_hit: tokensCacheRead,
        tokens_cache_write: tokensCacheWrite,
        cost_usd: costUsd,
        duration_ms: claudeDurationMs ?? durationMs,
        exit_status: code,
        status: code === 0 && !isError ? 'success' : 'error',
        prompt,
        stdout_preview: combinedText,
        stderr: stderrAll || null,
      });
    });
  });
};
