import type React from 'react';

interface Props {
  // From useResizable's startDrag — initiates a drag on mousedown.
  onMouseDown: (e: React.MouseEvent) => void;
  // Optional className for variant styling (e.g. lighter handle in main sidebar).
  variant?: 'default' | 'thin';
}

// Thin vertical drag handle, intended to be absolutely-positioned on the right
// edge of its parent (which must have `position: relative`).
export function ResizeHandle({ onMouseDown, variant = 'default' }: Props) {
  return (
    <div
      className={`resize-handle resize-handle-${variant}`}
      onMouseDown={onMouseDown}
      aria-hidden
    />
  );
}
