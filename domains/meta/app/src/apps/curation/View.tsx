// Curation — raw → wiki promotion queue. Migrated to apps/ + restyled with
// the prototype design system: .page wrapper, .card per item, .btn-primary
// for Curate, .badge for auto-discovered tag, .mono for paths.

import { useEffect, useState } from 'react';
import type {
  CurationItem,
  CurationListResponse,
} from '../../../server/routes/curation.types';
import { getJson, postJson } from '../../lib/api';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { formatRelative } from '../../lib/time';
import { Icons } from '../../shared';
import '../../shared/styles.css';

type CurationData = CurationListResponse;

export default function Curation() {
  const [data, setData] = useState<CurationData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { startSkillRun } = useDispatch();

  function refresh() {
    getJson<CurationData>('/api/curation')
      .then(setData)
      .catch(() => setData({ items: [] }));
  }

  useEffect(() => {
    refresh();
  }, []);

  // Refetch the curation list whenever any meta-curate run terminates so
  // items that were just curated (and moved to .archived/) disappear from
  // the list.
  useRunTerminal({ skill: 'meta-curate' }, () => refresh());

  async function ignore(path: string) {
    setBusy(path);
    try {
      await postJson('/api/curation/ignore', { path });
      refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  const curatePrompt = (item: CurationItem) =>
    [
      `Curate ${item.path} — invoke the meta-curate skill.`,
      'Read .claude/skills/meta-curate/SKILL.md and follow its Procedure.',
      '',
      'IMPORTANT — this is a headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt — pick your best',
      '  classification (archetype + domain + slug) and proceed without confirmation.',
      '- The user has already confirmed by clicking Curate. Execute directly.',
      '- Write the new wiki entry to vault/wiki/<domain>/<archetype>/<slug>.md.',
      '- Remove the source path line from .claude/state/pending-curation.txt.',
      '- Move the source file to vault/raw/.archived/<date>/ when done.',
      '',
      `Source path: ${item.path}`,
      '',
      'Report a short summary of what you did: archetype chosen, domain, slug, target path.',
    ].join('\n');

  const queueCount = data.items.filter((i) => !i.discovered).length;
  const discoveredCount = data.items.filter((i) => i.discovered).length;

  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Curation queue</h1>
        {data.items.length > 0 && (
          <>
            <span className="tiny">
              {queueCount} queued
              {discoveredCount > 0 && (
                <>
                  {' · '}
                  <strong style={{ color: 'var(--warning-text)' }}>
                    {discoveredCount} auto-discovered
                  </strong>
                </>
              )}
            </span>
          </>
        )}
      </header>

      {data.items.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <p className="subtle">
            Nothing pending. To add files, drop them into <strong>Vault → raw</strong> (or via{' '}
            <span className="mono">/os curate</span>).
          </p>
        </div>
      ) : (
        <>
          <p className="subtle" style={{ marginBottom: 18 }}>
            <strong>Curate</strong> runs <span className="mono">/os curate &lt;path&gt;</span> via
            the AI bridge — the meta-curate skill picks an archetype + domain + slug and writes the
            wiki entry. Add new files via <strong>Vault → raw</strong>.
            {discoveredCount > 0 && (
              <>
                {' '}
                <em>Auto-discovered</em> items were found in{' '}
                <span className="mono">vault/raw/</span> via disk scan — not registered through
                Claude Code's PostToolUse hook (typically external file drops).
              </>
            )}
          </p>

          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {data.items.map((it) => (
              <li key={it.path} className="card">
                <div className="card-header">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <span className="mono" style={{ fontSize: 12.5, color: 'var(--text)' }}>
                      {it.path}
                    </span>
                    {it.discovered && (
                      <span
                        className="badge warning"
                        title="Found in vault/raw/ via disk scan — not added via Claude Code's PostToolUse hook (probably dropped externally)."
                      >
                        <span className="badge-dot" />
                        auto-discovered
                      </span>
                    )}
                    {it.mtime && (
                      <span className="tiny" title={it.mtime}>
                        {formatRelative(it.mtime)}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        const prompt = curatePrompt(it);
                        startSkillRun(prompt, `Curate ${it.path}`, {
                          skill: 'meta-curate',
                          domain: 'meta',
                        }).then((res) => {
                          if ('blocked' in res && res.blocked) {
                            alert(
                              `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`,
                            );
                          } else if ('error' in res && res.error) {
                            alert(`Dispatch failed: ${res.error}`);
                          }
                        });
                      }}
                    >
                      <Icons.Sparkles size={11} /> Curate
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy === it.path || it.discovered}
                      title={
                        it.discovered
                          ? 'Not in the queue — Ignore is a no-op. Remove the file from vault/raw/ to make it disappear, or run Curate.'
                          : undefined
                      }
                      onClick={() => ignore(it.path)}
                    >
                      {busy === it.path ? 'Ignoring…' : 'Ignore'}
                    </button>
                  </div>
                </div>
                <pre
                  className="mono"
                  style={{
                    margin: 0,
                    padding: '12px 18px',
                    background: 'var(--bg-2)',
                    fontSize: 12,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--text-2)',
                    maxHeight: 200,
                    overflow: 'auto',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  {it.preview}
                </pre>
              </li>
            ))}
          </ul>
        </>
      )}

    </div>
  );
}
