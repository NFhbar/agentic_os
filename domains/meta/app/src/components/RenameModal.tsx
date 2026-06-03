import React, { useState } from 'react';

interface Props {
  title: string;
  // Current last-segment name, prefilled in the input
  currentName: string;
  // What the user is renaming, shown for context (e.g. ".claude/skills/dev-pr-review")
  targetPath: string;
  // Optional validation pattern (defaults to kebab-case)
  pattern?: RegExp;
  // Optional list of taken names (to prevent collisions)
  taken?: string[];
  onCancel: () => void;
  onConfirm: (newName: string) => void;
}

const DEFAULT_PATTERN = /^[a-z][a-z0-9-]*$/;

export function RenameModal({
  title,
  currentName,
  targetPath,
  pattern,
  taken,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(currentName);
  const re = pattern ?? DEFAULT_PATTERN;

  const trimmed = value.trim();
  let err: string | null = null;
  if (!trimmed) err = 'Required';
  else if (!re.test(trimmed)) err = `Must match ${re.source}`;
  else if (trimmed === currentName) err = 'Same as current name';
  else if (taken?.includes(trimmed)) err = `\`${trimmed}\` already exists`;

  const canSubmit = !err;

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
          <label>Target</label>
          <p className="muted" style={{ margin: 0 }}>
            <code>{targetPath}</code>
          </p>
        </section>

        <section className="form-fields">
          <div className="form-field">
            <label>
              New name<span className="required">*</span>
            </label>
            <p className="hint">
              New last-segment name (kebab-case). Cross-references are updated automatically.
            </p>
            <input
              type="text"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) onConfirm(trimmed);
              }}
            />
            {err && <p className="err">{err}</p>}
          </div>
        </section>

        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={!canSubmit}
            onClick={() => canSubmit && onConfirm(trimmed)}
          >
            Rename
          </button>
        </footer>
      </div>
    </div>
  );
}
