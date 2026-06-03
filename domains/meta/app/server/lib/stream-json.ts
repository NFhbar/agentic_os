// Shared parser for `claude -p --output-format stream-json` output lines.
// Both /api/action and /api/runs spawn the same CLI; centralizing the line
// parsing keeps the assistant/result event handling in one place — the audit
// flagged earlier copies as a duplication risk.

export interface ParsedAssistantChunk {
  kind: 'assistant-text';
  text: string;
}

export interface ParsedResult {
  kind: 'result';
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  costUsd: number | null;
  claudeDurationMs: number | null;
  isError: boolean;
}

export interface ParsedRaw {
  kind: 'raw';
  text: string;
}

export interface ParsedOther {
  kind: 'other';
}

export type ParsedStreamLine = ParsedAssistantChunk | ParsedResult | ParsedRaw | ParsedOther;

/**
 * Parse one line of stream-json output. The contract:
 * - `assistant` events with text parts → ParsedAssistantChunk (one per part)
 * - `result` events → ParsedResult with the usage block extracted
 * - non-JSON lines → ParsedRaw (forwarded verbatim as a chunk)
 * - other JSON events (system, rate_limit_event, …) → ParsedOther
 *
 * Returns an array because a single assistant event can hold multiple text
 * parts; the caller iterates and decides what to forward.
 */
export function parseStreamJsonLine(line: string): ParsedStreamLine[] {
  if (!line) return [];
  let evt: unknown;
  try {
    evt = JSON.parse(line);
  } catch {
    return [{ kind: 'raw', text: line + '\n' }];
  }
  const e = evt as Record<string, unknown>;
  if (e.type === 'assistant') {
    const msg = e.message as { content?: Array<{ type: string; text?: string }> };
    const content = msg?.content ?? [];
    const out: ParsedStreamLine[] = [];
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        out.push({ kind: 'assistant-text', text: part.text });
      }
    }
    return out;
  }
  if (e.type === 'result') {
    const usage = (e.usage as Record<string, unknown>) ?? {};
    const modelUsage = e.modelUsage as Record<string, unknown> | undefined;
    let model: string | null = null;
    if (modelUsage) {
      const keys = Object.keys(modelUsage);
      if (keys.length > 0) model = keys[0];
    }
    return [
      {
        kind: 'result',
        model,
        tokensIn: (usage.input_tokens as number) ?? null,
        tokensOut: (usage.output_tokens as number) ?? null,
        tokensCacheRead: (usage.cache_read_input_tokens as number) ?? null,
        tokensCacheWrite: (usage.cache_creation_input_tokens as number) ?? null,
        costUsd: (e.total_cost_usd as number) ?? null,
        claudeDurationMs: (e.duration_ms as number) ?? null,
        isError: Boolean(e.is_error),
      },
    ];
  }
  return [{ kind: 'other' }];
}
