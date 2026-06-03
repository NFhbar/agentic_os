// LatestArtifactCard — shared collapsible card for surfacing a runbook's
// most recent output artifact (e.g. weekly triage report, weekly health
// check). Mirrors the Overview's "Latest brief" card shape but generalized
// so other views (Changes, Health) can drop one in without re-implementing
// the fetch + collapse + stale-badge logic.

import { useCallback, useEffect, useState } from 'react';
import { EditableMarkdown } from './EditableMarkdown';
import { formatLocal, formatRelative } from '../lib/time';
import { type EntryResponse, fetchEntryOptional } from '../lib/vault';

interface Props {
  // Display title shown in the card header (e.g. "Latest weekly triage").
  title: string;
  // Resolved vault path to the artifact. Pass `null` while you're still
  // discovering the path (e.g. listing a dir then picking newest); the
  // card renders a loading state.
  path: string | null;
  // Where to write/read the collapse state in localStorage. Unique per card.
  storageKey: string;
  // Hours after which the artifact is considered stale (badge shown).
  // Defaults to 168 (one week) — matches the weekly runbook cadence.
  staleAfterHours?: number;
  // Message rendered when `path` resolved to null OR fetchEntryOptional
  // returned null (file doesn't exist yet — runbook hasn't fired).
  emptyMessage: string;
  // Optional refresh callback — when provided, renders a "Refresh" button
  // in the card header. The brief card uses this to dispatch /os brief;
  // weekly cards don't need it (they fire on schedule).
  onRefresh?: () => void;
  // Optional re-fetch signal. When this value changes, the card re-fetches
  // its artifact from `path`. Use this to drive external refresh events —
  // e.g. when the parent's run-terminal hook fires after `/os brief` lands,
  // bump this so the card picks up the freshly-written file. Static cards
  // (weekly triage / health) can omit it.
  refreshKey?: number | string;
}

export function LatestArtifactCard({
  title,
  path,
  storageKey,
  staleAfterHours = 168,
  emptyMessage,
  onRefresh,
  refreshKey,
}: Props) {
  const [entry, setEntry] = useState<EntryResponse | null | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (path === null) {
      setEntry(undefined);
      return;
    }
    fetchEntryOptional(path)
      .then(setEntry)
      .catch(() => setEntry(null));
  }, [path, refreshKey]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* unavailable */
      }
      return next;
    });
  }, [storageKey]);

  // Don't render anything while we still don't know whether the artifact
  // exists. This avoids a flash of "no artifact yet" before the fetch lands.
  if (entry === undefined) return null;

  const isStale = entry?.mtime ? isOlderThanHours(entry.mtime, staleAfterHours) : false;

  return (
    <section className="card" style={{ marginBottom: 18, padding: 0 }}>
      <div className="card-header">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? `Expand ${title.toLowerCase()}` : `Collapse ${title.toLowerCase()}`}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text)',
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span aria-hidden style={{ color: 'var(--text-3)', fontSize: 11 }}>
            {collapsed ? '▸' : '▾'}
          </span>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {entry?.mtime && (
            <>
              <span className="tiny" title={formatLocal(entry.mtime)}>
                ran {formatRelative(entry.mtime)}
              </span>
              {isStale && (
                <span
                  className="badge warning"
                  title={`Older than ${staleAfterHours} hours`}
                >
                  stale
                </span>
              )}
            </>
          )}
          {onRefresh && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={onRefresh}
              title="Re-run the runbook"
            >
              Refresh
            </button>
          )}
        </div>
      </div>
      {!collapsed &&
        (entry === null ? (
          <p className="subtle" style={{ padding: 18, fontSize: 13, margin: 0 }}>
            {emptyMessage}
          </p>
        ) : (
          <EditableMarkdown
            path={entry.path}
            content={entry.content}
            onSaved={(c) =>
              setEntry({
                path: entry.path,
                content: c,
                mtime: new Date().toISOString(),
              })
            }
          />
        ))}
    </section>
  );
}

function isOlderThanHours(iso: string, hours: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > hours * 3600 * 1000;
}
