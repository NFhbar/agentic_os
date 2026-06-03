import type { ChannelAdapter, ChannelId } from '../channel-adapter.js';
import { desktopAdapter } from './desktop.js';
import { slackAdapter } from './slack.js';

function stubAdapter(id: ChannelId): ChannelAdapter {
  return {
    id,
    async send() {
      return { status: 'failed', error: `adapter not yet implemented: ${id}` };
    },
  };
}

const emailAdapter = stubAdapter('email');

export function getAdapter(id: ChannelId): ChannelAdapter {
  switch (id) {
    case 'slack':
      return slackAdapter;
    case 'email':
      return emailAdapter;
    case 'desktop':
      return desktopAdapter;
  }
}
