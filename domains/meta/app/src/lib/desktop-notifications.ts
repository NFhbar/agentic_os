import { useEffect } from 'react';

// Track whether we've already issued the one-and-only permission prompt in
// localStorage rather than re-reading `Notification.permission` each load:
// browsers reset revoked permissions back to 'default', so without this flag
// every tab open after a revocation would re-call requestPermission() — the
// exact annoyance the "prompt once on first load" decision is trying to avoid.
const PROMPTED_KEY = 'agentic-os/desktop-notifications-prompted';

interface DesktopFrame {
  title: string;
  body: string;
}

export function useDesktopNotifications(): void {
  useEffect(() => {
    if (typeof Notification === 'undefined') return;

    if (Notification.permission === 'default') {
      let alreadyPrompted = false;
      try {
        alreadyPrompted = localStorage.getItem(PROMPTED_KEY) === '1';
      } catch {
        /* localStorage may be unavailable */
      }
      if (!alreadyPrompted) {
        try {
          localStorage.setItem(PROMPTED_KEY, '1');
        } catch {
          /* ignore */
        }
        Notification.requestPermission().catch(() => {
          /* user-gesture-required browsers reject silently — handled via Settings UI later */
        });
      }
    }

    const es = new EventSource('/api/notifications/desktop/stream');
    es.onmessage = (event) => {
      if (Notification.permission !== 'granted') return;
      let frame: DesktopFrame;
      try {
        frame = JSON.parse(event.data) as DesktopFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.title !== 'string' || typeof frame.body !== 'string') return;
      try {
        new Notification(frame.title, { body: frame.body });
      } catch {
        /* secure-context violations etc. — fire-and-forget */
      }
    };

    return () => {
      es.close();
    };
  }, []);
}
