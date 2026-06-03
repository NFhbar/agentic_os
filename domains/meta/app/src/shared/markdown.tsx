// Markdown rendering primitive with optional `## Update N` decoration.
// Locked by standard-app-design § 11.5.

import type React from 'react';
import { Fragment, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icons } from './components';

export type MarkdownDecorate = 'updates' | null;

export interface UpdateSection {
  n: number;
  heading: string;
  body: string;
}

export interface MarkdownSplitResult {
  preamble: string;
  updates: UpdateSection[];
}

const UPDATE_HEADING_RE = /^##\s+Update\s+(\d+)\s*(?:[—-]\s*(.*))?$/i;

export function splitOnUpdateSections(text: string): MarkdownSplitResult {
  const lines = text.split('\n');
  let preambleBuf: string[] = [];
  const updates: UpdateSection[] = [];
  let current: UpdateSection | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) {
      current.body = buf.join('\n');
      updates.push(current);
    } else {
      preambleBuf = buf;
    }
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(UPDATE_HEADING_RE);
    if (m) {
      flush();
      current = {
        n: Number.parseInt(m[1] ?? '0', 10),
        heading: (m[2] ?? '').trim(),
        body: '',
      };
    } else {
      buf.push(line);
    }
  }
  flush();
  return {
    preamble: preambleBuf.join('\n').trim(),
    updates,
  };
}

export const MarkdownBlock: React.FC<{
  text: string;
  decorate?: MarkdownDecorate;
}> = ({ text, decorate = null }) => {
  const parts = useMemo(() => {
    if (decorate !== 'updates') return null;
    return splitOnUpdateSections(text);
  }, [text, decorate]);

  if (!parts) {
    return (
      <div className="prose">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="prose">
      {parts.preamble && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{parts.preamble}</ReactMarkdown>
      )}
      {parts.updates.map((u) => (
        <Fragment key={u.n}>
          <UpdateDivider n={u.n} />
          {u.heading && <h2 style={{ marginTop: 0 }}>{u.heading}</h2>}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{u.body}</ReactMarkdown>
        </Fragment>
      ))}
    </div>
  );
};

function UpdateDivider({ n }: { n: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '18px 0',
        color: 'var(--accent-text)',
      }}
    >
      <hr style={{ flex: 1, border: 0, borderTop: '1px solid var(--accent-border)' }} />
      <span
        className="badge"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-border)',
          color: 'var(--accent-text)',
          fontSize: 11.5,
          padding: '2px 8px',
        }}
      >
        <Icons.Sparkles size={11} /> Update {n}
      </span>
      <hr style={{ flex: 1, border: 0, borderTop: '1px solid var(--accent-border)' }} />
    </div>
  );
}
