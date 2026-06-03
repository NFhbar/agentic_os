// Generic fetch helpers + SSE wrapper for /api/action.

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export async function postJson<T, B = unknown>(path: string, body: B): Promise<T> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export interface ActionChunk {
  chunk?: string;
  stderr?: string;
  done?: boolean;
  exit?: number;
}

// Generic SSE consumer for any POST endpoint that streams the same
// chunk/stderr/done schema (/api/action, /api/schedules/run-now, …).
//
// Bug fix 2026-05-24: previously, when the reader signalled `done: true` we
// broke out of the loop WITHOUT flushing the buffer. If the server's final
// `data: {done:true,exit:N}\n\n` arrived in a chunk boundary that swallowed
// the trailing `\n\n` (Fastify's `reply.raw.end()` racing with the kernel's
// flush, Vite's proxy framing, or just TCP coalescing), the message stayed
// trapped in `buffer` and never reached the consumer. Result: ActionRunner
// UI stuck on "running" indefinitely even though the skill completed and
// recorded its event server-side.
//
// Now: on reader-done, flush the decoder one last time AND process any
// remaining lines in buffer, treating both `\n\n`-terminated AND
// unterminated trailing messages as valid `data:` SSE frames.
export async function* runStream(endpoint: string, body: unknown): AsyncGenerator<ActionChunk> {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.body) return;

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function* drain(text: string): Generator<ActionChunk> {
    // Split on `\n\n` (SSE message boundary). Any trailing fragment without
    // a terminator is still attempted as a final message — this is what
    // recovers the stranded `done` event when the stream closed early.
    for (const line of text.split('\n\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        yield JSON.parse(trimmed.slice(6));
      } catch {
        /* skip malformed line — best-effort consumer */
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode(); // flush any partial UTF-8
      if (buffer.length > 0) {
        yield* drain(buffer);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    // Pop the trailing fragment back into buffer — it may be an
    // incomplete message awaiting more bytes.
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          /* skip malformed mid-stream line */
        }
      }
    }
  }
}

export async function* runAction(prompt: string): AsyncGenerator<ActionChunk> {
  yield* runStream('/api/action', { prompt });
}
