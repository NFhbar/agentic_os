// `delivery` is `Record<string, unknown>` because the dispatcher hands it
// verbatim from the rule's frontmatter — each adapter narrows to its own
// `*Delivery` shape internally rather than fixing one schema at the interface.

export type ChannelId = 'slack' | 'email' | 'desktop';

export interface Link {
  label: string;
  url: string;
}

export interface RenderedNotification {
  title: string;
  body: string;
  links?: Link[];
}

export type SendResult = { status: 'ok' } | { status: 'failed'; error: string };

export interface ChannelAdapter {
  id: ChannelId;
  send(rendered: RenderedNotification, delivery: Record<string, unknown>): Promise<SendResult>;
}
