// Desktop adapter — fans rendered notifications out over Server-Sent Events
// to whichever dashboard tab(s) currently hold a subscription on
// /api/notifications/desktop/stream. The browser hook then converts each
// frame into a native `new Notification(title, { body })` call.
//
// SSE helpers (ssePreludeFor / sseSendFrame) are duplicated from
// routes/runs.ts on purpose: the originals are module-private there and
// extracting them into server/lib/sse.ts would balloon this change to also
// refactor routes/runs.ts + routes/schedules.ts (a known follow-up — see
// the plan's § Out-of-scope concerns).

import type { FastifyReply } from 'fastify';
import type { ChannelAdapter, RenderedNotification, SendResult } from '../channel-adapter.js';

const subscribers = new Set<FastifyReply>();

function ssePreludeFor(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function sseSendFrame(reply: FastifyReply, payload: Record<string, unknown>) {
  try {
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* socket may be closed — best-effort */
  }
}

export function subscribeDesktopClient(reply: FastifyReply): () => void {
  ssePreludeFor(reply);
  subscribers.add(reply);
  return () => {
    subscribers.delete(reply);
  };
}

async function sendToSubscribers(rendered: RenderedNotification): Promise<SendResult> {
  if (subscribers.size === 0) {
    return {
      status: 'failed',
      error: 'no dashboard subscriber connected (desktop tab closed)',
    };
  }
  const frame: Record<string, unknown> = { title: rendered.title, body: rendered.body };
  if (rendered.links) frame.links = rendered.links;
  for (const sub of subscribers) sseSendFrame(sub, frame);
  return { status: 'ok' };
}

export const desktopAdapter: ChannelAdapter = {
  id: 'desktop',
  async send(rendered): Promise<SendResult> {
    return sendToSubscribers(rendered);
  },
};
