// Drag-to-resize hook with localStorage persistence.
// Used by the main sidebar and each view's picker column.

import type React from 'react';
import { useEffect, useState } from 'react';

export interface ResizableOptions {
  // localStorage key suffix — actual key is `width-${storageKey}`.
  storageKey: string;
  // Initial width if nothing is stored (or stored value is out of bounds).
  defaultWidth: number;
  // Bounds for the resize.
  min?: number;
  max?: number;
}

const KEY_PREFIX = 'agentic-os/width/';

export function useResizable({ storageKey, defaultWidth, min = 120, max = 800 }: ResizableOptions) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    try {
      const stored = window.localStorage.getItem(KEY_PREFIX + storageKey);
      const parsed = stored !== null ? Number(stored) : Number.NaN;
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    } catch {
      /* unavailable */
    }
    return defaultWidth;
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY_PREFIX + storageKey, String(width));
    } catch {
      /* unavailable */
    }
  }, [width, storageKey]);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;

    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startX;
      const next = Math.max(min, Math.min(max, startWidth + delta));
      setWidth(next);
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return { width, startDrag };
}
