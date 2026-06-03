import type React from 'react';
import { useState } from 'react';

interface Props {
  title: string;
  // Body description — can include affected scope
  message: React.ReactNode;
  // If set, user must type this exact string before confirm is enabled.
  // Use for destructive ops.
  requireType?: string;
  // Confirm button label (default: "Confirm")
  confirmLabel?: string;
  // Mark confirm as destructive (red styling)
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  title,
  message,
  requireType,
  confirmLabel,
  destructive,
  onCancel,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState('');

  const canConfirm = !requireType || typed === requireType;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button className="close" onClick={onCancel}>
            ×
          </button>
        </header>

        <section>
          <div className="confirm-body">{message}</div>
        </section>

        {requireType && (
          <section className="form-fields">
            <div className="form-field">
              <label>
                Type <code>{requireType}</code> to confirm
              </label>
              <input
                type="text"
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canConfirm) onConfirm();
                }}
              />
            </div>
          </section>
        )}

        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button
            className={destructive ? 'destructive' : 'primary'}
            disabled={!canConfirm}
            onClick={() => canConfirm && onConfirm()}
          >
            {confirmLabel ?? 'Confirm'}
          </button>
        </footer>
      </div>
    </div>
  );
}
