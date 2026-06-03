// Tooltip — portal-rendered hover tip. Escapes any `overflow: hidden`
// ancestor (notably the .card wrapper around tables) by rendering into
// document.body via React.createPortal. Position is computed from the
// trigger element's bounding rect on mouseenter.
//
// Usage:
//   <Tooltip tip="Re-index — git fetch + reset">
//     <button className="icon-btn"><Icons.Refresh size={14} /></button>
//   </Tooltip>
//
// The wrapped child receives onMouseEnter/onMouseLeave/onFocus/onBlur
// handlers; ensure children either accept them as a single React element or
// pass them through. The wrapper is a span — no layout impact.

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  tip: string;
  children: React.ReactElement;
  // 'bottom' (default) places the tooltip below the trigger; 'top' places it above.
  // 'auto' picks based on trigger's distance from viewport bottom.
  placement?: 'bottom' | 'top' | 'auto';
}

export function Tooltip({ tip, children, placement = 'auto' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' }>({
    top: 0,
    left: 0,
    placement: 'bottom',
  });
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const updatePos = useCallback(() => {
    const node = wrapRef.current?.firstElementChild as HTMLElement | undefined;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const centerX = r.left + r.width / 2;
    const margin = 8;
    let resolved: 'top' | 'bottom';
    if (placement === 'auto') {
      // If the trigger is in the lower 30% of the viewport, place above
      // to keep the tip visible — otherwise prefer below.
      resolved = r.bottom > window.innerHeight * 0.7 ? 'top' : 'bottom';
    } else {
      resolved = placement;
    }
    const top = resolved === 'bottom' ? r.bottom + margin : r.top - margin;
    setPos({ top, left: centerX, placement: resolved });
  }, [placement]);

  const show = useCallback(() => {
    updatePos();
    setVisible(true);
  }, [updatePos]);

  const hide = useCallback(() => {
    setVisible(false);
  }, []);

  return (
    <span
      ref={wrapRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={{ display: 'inline-flex' }}
    >
      {children}
      {visible &&
        createPortal(
          <div
            className="tooltip-portal"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              transform: `translate(-50%, ${pos.placement === 'top' ? '-100%' : '0'})`,
            }}
            role="tooltip"
          >
            {tip}
          </div>,
          document.body,
        )}
    </span>
  );
}
