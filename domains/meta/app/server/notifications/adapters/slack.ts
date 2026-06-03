// Slack adapter — dual-mode (bot-token preferred, webhook fallback).
// Mode detection per send call (no module-level capture so test/runtime env
// changes are honored):
//
//   SLACK_BOT_TOKEN set      → bot-token mode (chat.postMessage; per-rule channel routing)
//   else SLACK_WEBHOOK_URL    → webhook mode (POST to webhook; channel fixed at install)
//   else                      → fail "no slack transport configured"
//
// Bot-token mode requires the bot to be invited to each target channel
// (or `chat:write.public` scope to post in public channels without joining).
// The `delivery.slack_channel` field is honored in bot-token mode and is
// the difference between the modes from a user POV.

import type { ChannelAdapter, RenderedNotification, SendResult } from '../channel-adapter.js';

export interface SlackDelivery {
  slack_channel: string;
  tags?: string[];
}

export type SlackMode = 'bot-token' | 'webhook' | 'none';

export function detectSlackMode(): SlackMode {
  if (process.env.SLACK_BOT_TOKEN) return 'bot-token';
  if (process.env.SLACK_WEBHOOK_URL) return 'webhook';
  return 'none';
}

interface SectionBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
}

interface ContextBlock {
  type: 'context';
  elements: { type: 'mrkdwn'; text: string }[];
}

type Block = SectionBlock | ContextBlock;

interface BlockKitMessage {
  unfurl_links: false;
  blocks: Block[];
}

function renderBlocks(rendered: RenderedNotification, delivery: SlackDelivery): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${rendered.title}*\n${rendered.body}` },
    },
  ];
  if (delivery.tags && delivery.tags.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: delivery.tags.join(' ') },
    });
  }
  if (rendered.links && rendered.links.length > 0) {
    const linkText = rendered.links.map((l) => `<${l.url}|${l.label}>`).join(' · ');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: linkText }],
    });
  }
  return blocks;
}

async function postWebhook(rendered: RenderedNotification, delivery: SlackDelivery): Promise<SendResult> {
  const url = process.env.SLACK_WEBHOOK_URL as string;
  const payload: BlockKitMessage = {
    unfurl_links: false,
    blocks: renderBlocks(rendered, delivery),
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { status: 'ok' };
    return {
      status: 'failed',
      error: `slack webhook returned ${res.status} ${res.statusText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: `slack webhook network error: ${message}` };
  }
}

async function postChatMessage(rendered: RenderedNotification, delivery: SlackDelivery): Promise<SendResult> {
  const token = process.env.SLACK_BOT_TOKEN as string;
  const channel = (delivery.slack_channel ?? '').trim();
  if (!channel) {
    return {
      status: 'failed',
      error: 'bot-token mode requires delivery.slack_channel on the rule (e.g. "#alerts" or channel ID Cxxxxxxx)',
    };
  }
  const body = {
    channel,
    blocks: renderBlocks(rendered, delivery),
    unfurl_links: false,
    // text is the fallback for clients that don't render Block Kit + the
    // notification preview shown in OS-level notifications + the channel
    // sidebar. Use the rendered title so it's at least intelligible.
    text: rendered.title,
  };
  let res: Response;
  try {
    res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: `slack chat.postMessage network error: ${message}` };
  }
  if (!res.ok) {
    return {
      status: 'failed',
      error: `slack chat.postMessage HTTP ${res.status} ${res.statusText}`,
    };
  }
  // Slack returns 200 even on logical errors; the body's `ok` field is
  // authoritative. Common errors: channel_not_found (bot not invited or wrong
  // id), missing_scope (chat:write not granted), invalid_auth (token revoked).
  let parsed: { ok: boolean; error?: string };
  try {
    parsed = (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { status: 'failed', error: 'slack chat.postMessage returned non-JSON body' };
  }
  if (!parsed.ok) {
    return {
      status: 'failed',
      error: `slack chat.postMessage rejected: ${parsed.error ?? 'unknown error'}`,
    };
  }
  return { status: 'ok' };
}

export const slackAdapter: ChannelAdapter = {
  id: 'slack',
  async send(rendered, delivery): Promise<SendResult> {
    const mode = detectSlackMode();
    if (mode === 'none') {
      return {
        status: 'failed',
        error: 'no slack transport configured (set SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL in env)',
      };
    }
    const slackDelivery = delivery as unknown as SlackDelivery;
    if (mode === 'bot-token') {
      return postChatMessage(rendered, slackDelivery);
    }
    return postWebhook(rendered, slackDelivery);
  },
};
