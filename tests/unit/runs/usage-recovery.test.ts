// Killed-run usage recovery (scripts/runs-finalize.mjs). Runs that die with
// no result event carry no cost/token data; these pin the journal-tail
// recovery: dedupe by message.id, per-model summing, dominant-model pick,
// registry-pinned cost math, and the tail-bounded read window.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeCost } from '../../../scripts/models-registry.mjs';
import {
  JOURNAL_USAGE_TAIL_BYTES,
  extractJournalUsage,
  recoverUsageFromJournal,
} from '../../../scripts/runs-finalize.mjs';

const dir = mkdtempSync(join(tmpdir(), 'usage-recovery-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function fixture(lines: string[]): string {
  const path = join(dir, `journal-${n++}.raw.jsonl`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

function assistantEvent(
  id: string,
  model: string,
  usage: Record<string, number>,
): string {
  return JSON.stringify({ type: 'assistant', message: { id, model, usage } });
}

describe('extractJournalUsage', () => {
  it('dedupes assistant events by message.id (last write wins)', () => {
    const path = fixture([
      assistantEvent('msg_1', 'claude-fable-5', { input_tokens: 10, output_tokens: 5 }),
      assistantEvent('msg_1', 'claude-fable-5', { input_tokens: 10, output_tokens: 50 }),
      assistantEvent('msg_2', 'claude-fable-5', { input_tokens: 7, output_tokens: 3 }),
    ]);
    const out = extractJournalUsage(path);
    expect(out).not.toBeNull();
    expect(out.perModel['claude-fable-5']).toEqual({
      input: 17,
      output: 53,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it('sums per-model and picks the dominant model by output tokens', () => {
    const path = fixture([
      assistantEvent('msg_1', 'claude-fable-5', { input_tokens: 1, output_tokens: 100 }),
      assistantEvent('msg_2', 'claude-haiku-4-5', { input_tokens: 1, output_tokens: 5 }),
      assistantEvent('msg_3', 'claude-fable-5', { input_tokens: 2, output_tokens: 200 }),
    ]);
    const out = extractJournalUsage(path);
    expect(out.model).toBe('claude-fable-5');
    expect(out.perModel['claude-fable-5'].output).toBe(300);
    expect(out.perModel['claude-haiku-4-5'].output).toBe(5);
  });

  it('returns null for journals with no assistant events', () => {
    const path = fixture([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      'not json at all',
      JSON.stringify({ type: 'result', is_error: false }),
    ]);
    expect(extractJournalUsage(path)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(extractJournalUsage(join(dir, 'nope.raw.jsonl'))).toBeNull();
    expect(extractJournalUsage(null)).toBeNull();
  });

  it('reads only the tail window of oversized journals (boundary line dropped)', () => {
    const early = assistantEvent('msg_early', 'claude-fable-5', {
      input_tokens: 999,
      output_tokens: 999,
    });
    // Padding pushes the early event past the window; the cut lands inside
    // the padding, so the dropped first partial line is a padding line.
    const padLine = JSON.stringify({ type: 'system', pad: 'x'.repeat(64 * 1024) });
    const padCount = Math.ceil(JOURNAL_USAGE_TAIL_BYTES / padLine.length) + 2;
    const late = assistantEvent('msg_late', 'claude-fable-5', {
      input_tokens: 11,
      output_tokens: 13,
    });
    const path = fixture([early, ...Array(padCount).fill(padLine), late]);
    const out = extractJournalUsage(path);
    expect(out.perModel['claude-fable-5']).toEqual({
      input: 11,
      output: 13,
      cache_read: 0,
      cache_write: 0,
    });
  });
});

describe('recoverUsageFromJournal', () => {
  it('computes cost from registry rates (pinned to computeCost)', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 10_000,
    };
    const path = fixture([assistantEvent('msg_1', 'claude-fable-5', usage)]);
    const out = recoverUsageFromJournal(path);
    expect(out).toEqual({
      costUsd: computeCost('claude-fable-5', {
        input: 1000,
        output: 2000,
        cache_read: 100_000,
        cache_write: 10_000,
      }),
      tokensIn: 1000,
      tokensOut: 2000,
      tokensCacheRead: 100_000,
      tokensCacheWrite: 10_000,
      model: 'claude-fable-5',
    });
    // $5/$25 + cache 0.5/6.25 per M → fixed expectation, not just self-consistency.
    expect(out.costUsd).toBe(0.1675);
  });

  it('recovers tokens but leaves cost null for unregistered models', () => {
    const path = fixture([
      assistantEvent('msg_1', 'claude-fable-5', { input_tokens: 100, output_tokens: 10 }),
      assistantEvent('msg_2', 'claude-unknown-experimental', {
        input_tokens: 50,
        output_tokens: 5,
      }),
    ]);
    const out = recoverUsageFromJournal(path);
    expect(out.costUsd).toBeNull();
    expect(out.tokensIn).toBe(150);
    expect(out.tokensOut).toBe(15);
  });

  it('returns null when there is nothing to recover', () => {
    const path = fixture([JSON.stringify({ type: 'system' })]);
    expect(recoverUsageFromJournal(path)).toBeNull();
  });
});
