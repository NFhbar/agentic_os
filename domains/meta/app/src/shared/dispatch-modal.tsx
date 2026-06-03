// Dispatch modal — generic confirm shell for long-running dispatches with a
// trigger-source pill, optional auto-diff list, and a free-text
// additional-context box. See decision-remove-dispatch-cost-cap for context
// on why the cost-cap slider was removed.

import type React from 'react';
import { useState } from 'react';
import { Icons, SharedModal } from './components';

export interface DispatchModalConfirm {
  notes: string;
}

export interface DispatchModalProps {
  title: string;
  triggerSource: string;
  autoDiff?: React.ReactNode | null;
  autoDiffLabel?: string;
  autoDiffHint?: string;
  additionalContextPlaceholder?: string;
  confirmLabel?: string;
  onConfirm: (result: DispatchModalConfirm) => void;
  onCancel: () => void;
}

export const DispatchModal: React.FC<DispatchModalProps> = ({
  title,
  triggerSource,
  autoDiff = null,
  autoDiffLabel,
  autoDiffHint,
  additionalContextPlaceholder,
  confirmLabel = 'Run',
  onConfirm,
  onCancel,
}) => {
  const [notes, setNotes] = useState('');

  return (
    <SharedModal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onConfirm({ notes: notes.trim() })}
          >
            <Icons.Play size={12} /> {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Trigger source">
          <div
            className="mono"
            style={{
              padding: '8px 12px',
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 12.5,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icons.Flag size={13} style={{ color: 'var(--muted)' }} />
            {triggerSource}
          </div>
        </Field>

        {autoDiff != null && (
          <Field label={autoDiffLabel ?? 'Auto-detected diff'} hint={autoDiffHint}>
            {autoDiff}
          </Field>
        )}

        <Field
          label="Additional context (optional)"
          hint="Anything not captured in the materials drop — Slack threads, decisions, hallway conversations."
        >
          <textarea
            className="textarea"
            rows={3}
            placeholder={additionalContextPlaceholder ?? '…'}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ fontFamily: 'inherit', fontSize: 12.5, padding: '8px 10px', width: '100%' }}
          />
        </Field>

      </div>
    </SharedModal>
  );
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && (
        <div className="tiny" style={{ marginTop: 4, color: 'var(--muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
