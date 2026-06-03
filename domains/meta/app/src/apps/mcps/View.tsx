// MCPs — lists configured MCP servers with kind/status/tools. Scaffold new
// ones via meta-add-mcp (custom or hosted modes).
//
// Read-only diagnostic view: every action that mutates MCP state (add, sync)
// goes through the existing skill/script surface so the audit + standard
// stay authoritative.

import { useCallback, useEffect, useState } from 'react';
import type {
  ManifestTool,
  McpKind,
  McpRow,
  McpsListResponse,
} from '../../../server/routes/mcps.types';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { getJson } from '../../lib/api';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { Icons } from '../../shared';
import '../../shared/styles.css';

type Kind = McpKind;
type McpsResponse = McpsListResponse;

type FilterId = 'all' | 'custom' | 'hosted' | 'stale';

export default function Mcps() {
  const [data, setData] = useState<McpsResponse | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [addSkill, setAddSkill] = useState<SkillSummary | null>(null);
  const { startSkillRun } = useDispatch();

  const refresh = useCallback(async () => {
    try {
      const r = await getJson<McpsResponse>('/api/mcps');
      setData(r);
    } catch {
      setData({ mcps: [], configExists: false, configPath: '.mcp.json', syncScript: '' });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh MCP list whenever a meta-add-mcp run terminates.
  useRunTerminal({ skill: 'meta-add-mcp' }, () => refresh());

  async function openAddForm() {
    let skill = await findSkill('meta-add-mcp');
    if (!skill) {
      await fetchSkills(true);
      skill = await findSkill('meta-add-mcp');
    }
    if (!skill) {
      alert('meta-add-mcp skill not found in .claude/skills/');
      return;
    }
    setAddSkill(skill);
  }

  if (!data) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  const counts = {
    all: data.mcps.length,
    custom: data.mcps.filter((m) => m.kind === 'custom').length,
    hosted: data.mcps.filter((m) => m.kind === 'hosted').length,
    stale: data.mcps.filter((m) => m.kind === 'stale').length,
  };
  const filtered = filter === 'all' ? data.mcps : data.mcps.filter((m) => m.kind === filter);

  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">MCPs</h1>
        <span className="tiny">
          {counts.all} configured · {counts.custom} OS-built · {counts.hosted} hosted
          {counts.stale > 0 && (
            <>
              {' · '}
              <strong style={{ color: 'var(--warning-text)' }}>{counts.stale} stale</strong>
            </>
          )}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={openAddForm}>
          <Icons.Plus size={13} /> Add MCP
        </button>
      </header>

      <p className="subtle" style={{ marginBottom: 16, fontSize: 12.5 }}>
        Structured tool surfaces Claude Code calls during sessions. <strong>OS-built</strong> MCPs
        live under <span className="mono">mcps/&lt;id&gt;/</span>; <strong>hosted</strong> are
        vendor-run endpoints declared in <span className="mono">.mcp.json</span>. After scaffolding
        a new MCP, restart Claude Code to pick it up; run <span className="mono">/mcp</span> to
        authenticate hosted ones.
      </p>

      <div
        className="tabs"
        style={{
          marginBottom: 18,
          padding: '0 0 0 0',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 4,
        }}
      >
        {(
          [
            ['all', 'All', counts.all],
            ['custom', 'OS-built', counts.custom],
            ['hosted', 'Hosted', counts.hosted],
            ['stale', 'Needs review', counts.stale],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            className={filter === id ? 'tab active' : 'tab'}
            onClick={() => setFilter(id)}
            disabled={n === 0 && id !== 'all'}
            style={n === 0 && id !== 'all' ? { opacity: 0.4 } : undefined}
          >
            {label} <span className="count">{n}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <p className="subtle" style={{ margin: 0 }}>
            {filter === 'all'
              ? 'No MCPs configured yet. Click "Add MCP" to scaffold one.'
              : `No ${filter} MCPs.`}
          </p>
        </div>
      ) : (
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
          {filtered.map((m) => (
            <McpCard key={m.id} mcp={m} />
          ))}
        </ul>
      )}

      <div className="card" style={{ marginTop: 18, padding: 14, background: 'var(--bg-2)' }}>
        <div
          className="tiny"
          style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}
        >
          Manual operations
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          <div>
            <strong>Re-sync</strong> <span className="mono">.mcp.json</span> from manifests:{' '}
            <code className="mono">node {data.syncScript}</code>
          </div>
          <div>
            <strong>Edit hosted entries</strong> directly in{' '}
            <code className="mono">{data.configPath}</code> (sync preserves third-party rows)
          </div>
          <div>
            <strong>Authenticate hosted MCPs</strong>: run <code className="mono">/mcp</code> in
            Claude Code (browser OAuth flow)
          </div>
          <div>
            <strong>Remove a managed MCP</strong>: delete{' '}
            <code className="mono">mcps/&lt;id&gt;/</code> and the matching row in{' '}
            <code className="mono">.mcp.json</code>, then re-sync
          </div>
        </div>
      </div>

      {addSkill && (
        <ScaffoldForm
          skill={addSkill}
          title="Add MCP"
          onCancel={() => setAddSkill(null)}
          onSubmit={(prompt) => {
            setAddSkill(null);
            startSkillRun(prompt, 'Adding MCP…', { skill: 'meta-add-mcp', domain: 'meta' }).then(
              (res) => {
                if ('blocked' in res && res.blocked) {
                  alert(
                    `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`,
                  );
                } else if ('error' in res && res.error) {
                  alert(`Dispatch failed: ${res.error}`);
                }
              },
            );
          }}
        />
      )}
    </div>
  );
}

function McpCard({ mcp }: { mcp: McpRow }) {
  const kindClass =
    mcp.kind === 'custom' ? 'badge accent' : mcp.kind === 'hosted' ? 'badge info' : 'badge warning';
  const kindLabel =
    mcp.kind === 'custom' ? 'OS-built' : mcp.kind === 'hosted' ? 'Hosted' : 'Needs review';

  return (
    <li className="card">
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            flexWrap: 'wrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>{mcp.id}</span>
          <span className={kindClass}>{kindLabel}</span>
          <span className="badge muted" style={{ fontSize: 10.5 }}>
            {mcp.transport}
          </span>
          {mcp.domain && (
            <span className="tiny mono" title={`domain: ${mcp.domain}`}>
              {mcp.domain}
            </span>
          )}
        </div>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {mcp.description && <div style={{ fontSize: 13 }}>{mcp.description}</div>}

        {mcp.url && (
          <div>
            <div
              className="tiny"
              style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}
            >
              Endpoint
            </div>
            <code className="mono" style={{ fontSize: 12 }}>
              {mcp.url}
            </code>
          </div>
        )}

        {mcp.command && mcp.args && (
          <div>
            <div
              className="tiny"
              style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}
            >
              Spawn
            </div>
            <code className="mono" style={{ fontSize: 12 }}>
              {mcp.command} {mcp.args.join(' ')}
            </code>
          </div>
        )}

        {mcp.tools && mcp.tools.length > 0 && (
          <div>
            <div
              className="tiny"
              style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}
            >
              Tools ({mcp.tools.length})
            </div>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {mcp.tools.map((t) => (
                <li key={t.name} style={{ fontSize: 12.5 }}>
                  <code className="mono" style={{ color: 'var(--accent)' }}>
                    {t.name}
                  </code>
                  {t.summary && <span className="subtle"> — {t.summary}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {mcp.envVarsRequired && mcp.envVarsRequired.length > 0 && (
          <div>
            <div
              className="tiny"
              style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}
            >
              Required env
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {mcp.envVarsRequired.map((v) => (
                <span key={v} className="badge muted" style={{ fontSize: 11 }}>
                  <code className="mono">{v}</code>
                </span>
              ))}
              <span className="tiny" style={{ marginLeft: 'auto' }}>
                {mcp.hasEnv ? (
                  <span style={{ color: 'var(--success-text)' }}>✓ .env present</span>
                ) : (
                  <span style={{ color: 'var(--warning-text)' }}>.env missing</span>
                )}
              </span>
            </div>
          </div>
        )}

        {mcp.kind === 'custom' && (
          <div
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              fontSize: 11.5,
              color: 'var(--text-3)',
            }}
          >
            <span>{mcp.hasManifest ? '✓' : '✗'} manifest</span>
            <span>{mcp.hasEnvExample ? '✓' : '✗'} .env.example</span>
            <span>{mcp.hasEnv ? '✓' : '○'} .env</span>
            <span>{mcp.hasNodeModules ? '✓' : '✗'} node_modules</span>
          </div>
        )}
      </div>

      <div
        className="tiny"
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-2)',
          color: mcp.kind === 'stale' ? 'var(--warning-text)' : 'var(--text-3)',
        }}
      >
        {mcp.statusHint}
      </div>
    </li>
  );
}
