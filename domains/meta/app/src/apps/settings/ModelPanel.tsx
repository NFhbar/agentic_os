// Model panel. Mirrors EffortPanel exactly — same Effective / Override /
// Recommended triad — but on the model axis. Reads/writes the `model` field
// on settings.local.json (per-install) + SKILL.md frontmatter (per-skill
// override + per-skill recommendation). Dropdown options sourced from
// scripts/models-registry.mjs via the /api/settings response's `models[]`.
//
// Dispatch picks up the resolved model via resolveModelForRun(skill) on the
// server. Precedence: per-skill frontmatter > settings.local.json > settings.json
// > Claude Code user-global default. Same chain as effort.

import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../lib/api';

interface SettingsLayer {
  path: string;
  exists: boolean;
  parsed: Record<string, unknown> | null;
  parse_error: string | null;
}

interface RegistryModel {
  id: string;
  family: 'mythos' | 'opus' | 'sonnet' | 'haiku' | string;
  latest: boolean;
  pricing: {
    input: number;
    output: number;
    cache_read: number;
    cache_write_5m: number;
  };
  aliases?: string;
  note?: string;
}

interface SkillConfigRow {
  name: string;
  effort: string | null;
  recommended_effort: string | null;
  model: string | null;
  recommended_model: string | null;
}

interface SettingsResponse {
  project: SettingsLayer;
  local: SettingsLayer;
  effective_model: string | null;
  model_source: 'local' | 'project' | 'unset';
  skills: SkillConfigRow[];
  models: RegistryModel[];
}

// Render a model id as a friendly short label: "claude-opus-4-7" → "Opus 4.7",
// "claude-fable-5" → "Fable 5". Falls back to the raw id when the pattern
// doesn't match. Pure cosmetic — the underlying value stays canonical.
function formatModelLabel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-([0-9]+(?:-[0-9]+)?)(?:-([0-9]+))?$/);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[2].replace('-', '.');
  return m[3] ? `${family} ${version} (${m[3]})` : `${family} ${version}`;
}

// Group registry models by family for the dropdown's optgroup structure.
// Returns families in canonical display order (newest tier first).
function groupModelsByFamily(models: RegistryModel[]): Array<[string, RegistryModel[]]> {
  const order = ['mythos', 'opus', 'sonnet', 'haiku'];
  const byFamily = new Map<string, RegistryModel[]>();
  for (const m of models) {
    const list = byFamily.get(m.family) ?? [];
    list.push(m);
    byFamily.set(m.family, list);
  }
  return order
    .map((f) => [f, byFamily.get(f) ?? []] as [string, RegistryModel[]])
    .filter(([, list]) => list.length > 0);
}

export function ModelPanel() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getJson<SettingsResponse>('/api/settings')
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function saveModel(next: string | null) {
    setSaving(true);
    setSaveError(null);
    setSavedToast(null);
    try {
      const r = await fetch('/api/settings/model', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: next }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      setSavedToast(next ? `Saved — ${formatModelLabel(next)}` : 'Saved — using project default');
      setTimeout(() => {
        setSavedToast(null);
        refresh();
      }, 1500);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div
        className="card"
        style={{
          padding: '10px 14px',
          borderColor: 'var(--danger)',
          background: 'var(--danger-soft)',
          color: 'var(--danger-text)',
        }}
      >
        <strong>Failed to load settings:</strong> {error}
      </div>
    );
  }
  if (!data) {
    return <p className="subtle">Loading settings…</p>;
  }

  const { effective_model, model_source, skills, models, project, local } = data;
  const projectModel = (project.parsed?.model as string | undefined) ?? null;
  const localModel = (local.parsed?.model as string | undefined) ?? null;
  const grouped = groupModelsByFamily(models);
  const overriddenCount = skills.filter((s) => s.model).length;
  const inheritedCount = skills.length - overriddenCount;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Project-wide model */}
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 4 }}>
          Project-wide model
        </h3>
        <div className="tiny subtle" style={{ marginBottom: 14 }}>
          Default model for all dispatched skill runs in this workspace. Skills can opt to a
          different model via their <code className="mono">model:</code> frontmatter.
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="model-select" className="tiny subtle">
            Model:
          </label>
          <select
            id="model-select"
            className="input"
            value={effective_model ?? ''}
            onChange={(e) => saveModel(e.target.value || null)}
            disabled={saving}
            style={{ height: 32, fontSize: 13, minWidth: 240 }}
          >
            <option value="">
              {projectModel
                ? `(use project default — ${formatModelLabel(projectModel)})`
                : '(use project default — Claude Code CLI default)'}
            </option>
            {grouped.map(([family, list]) => (
              <optgroup key={family} label={family.charAt(0).toUpperCase() + family.slice(1)}>
                {list.map((m) => (
                  <option key={m.id} value={m.id}>
                    {formatModelLabel(m.id)}
                    {m.latest ? ' ★' : ''}
                    {m.note ? ' — restricted' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {model_source === 'local' && (
            <span
              className="badge muted"
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}
              title={`Set in settings.local.json (per-install). Project default: ${projectModel ? formatModelLabel(projectModel) : '(unset)'}`}
            >
              per-install
            </span>
          )}
          {model_source === 'project' && (
            <span
              className="badge muted"
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}
              title="Inherited from team-tracked settings.json. Override by selecting a model above."
            >
              inherited
            </span>
          )}
          {model_source === 'unset' && (
            <span
              className="badge muted"
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}
              title="Neither settings.json nor settings.local.json sets a model — dispatched runs fall back to Claude Code's user-global default (~/.claude/settings.json)."
            >
              cli default
            </span>
          )}
          {savedToast && (
            <span style={{ color: 'var(--accent-text)', fontSize: 12 }}>✓ {savedToast}</span>
          )}
          {saveError && (
            <span style={{ color: 'var(--danger-text)', fontSize: 12 }}>✗ {saveError}</span>
          )}
        </div>

        <details style={{ marginTop: 14 }}>
          <summary
            className="tiny subtle"
            style={{ cursor: 'pointer', fontSize: 11, marginBottom: 8 }}
          >
            How this writes to disk
          </summary>
          <div className="tiny subtle" style={{ fontSize: 11, lineHeight: 1.6 }}>
            <div>
              <strong>Project baseline:</strong> <code className="mono">.claude/settings.json</code>{' '}
              — git-tracked, ships with the OS. Current:{' '}
              <code className="mono">{projectModel ?? '(unset)'}</code>
            </div>
            <div>
              <strong>Per-install override:</strong>{' '}
              <code className="mono">.claude/settings.local.json</code> — gitignored. Current:{' '}
              <code className="mono">{localModel ?? '(unset)'}</code>
            </div>
            <div style={{ marginTop: 4 }}>
              Writes from this panel land in the local file. Selecting{' '}
              <em>(use project default)</em> removes the key entirely so the team baseline takes
              over. When both layers are unset, dispatched runs use the CLI's user-global default —
              set via Claude Code&apos;s <code className="mono">/model</code> command.
            </div>
          </div>
        </details>
      </section>

      {/* Per-skill model overrides */}
      <section className="card" style={{ padding: 0 }}>
        <div className="card-header">
          <div>
            <h3 className="card-title">Per-skill model overrides</h3>
            <span className="tiny subtle">
              {overriddenCount} of {skills.length} skill{skills.length !== 1 ? 's' : ''} override
              the project default · {inheritedCount} inherit
            </span>
          </div>
          <ApplyAllModelRecommendationsButton
            skills={skills}
            projectDefault={effective_model}
            onChanged={refresh}
          />
        </div>
        <div className="tiny subtle" style={{ padding: '10px 16px', fontSize: 11 }}>
          Pin a specific model for a skill — e.g. <code className="mono">claude-fable-5</code> for
          deep-reasoning synthesis, <code className="mono">claude-haiku-4-5</code> for cheap
          mechanical work. The <strong>Recommended</strong> column shows guidance from each
          skill&apos;s <code className="mono">recommended_model:</code> frontmatter. Writes go to
          team-tracked <code className="mono">.claude/skills/&lt;name&gt;/SKILL.md</code> — commit
          to share with your team, or <code className="mono">git checkout</code> to discard.
        </div>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Skill</th>
              <th style={{ width: 160 }}>Effective model</th>
              <th style={{ width: 240 }}>Override</th>
              <th style={{ width: 180 }}>Recommended</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <SkillModelRowEditor
                key={s.name}
                skill={s}
                projectDefault={effective_model}
                models={models}
                grouped={grouped}
                onSaved={refresh}
              />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ApplyAllModelRecommendationsButton({
  skills,
  projectDefault,
  onChanged,
}: {
  skills: SkillConfigRow[];
  projectDefault: string | null;
  onChanged: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const candidates = skills.filter((s) => {
    if (!s.recommended_model) return false;
    const effective = s.model ?? projectDefault;
    return s.recommended_model !== effective;
  });

  async function applyAll() {
    if (candidates.length === 0) return;
    setApplying(true);
    setToast(null);
    let ok = 0;
    let failed = 0;
    for (const s of candidates) {
      try {
        const r = await fetch(`/api/settings/skills/${encodeURIComponent(s.name)}/model`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: s.recommended_model }),
        });
        const j = (await r.json()) as { ok: boolean };
        if (r.ok && j.ok) ok++;
        else failed++;
      } catch {
        failed++;
      }
    }
    setToast(
      failed > 0
        ? `Applied ${ok}/${candidates.length} — ${failed} failed`
        : `Applied ${ok} recommendation${ok !== 1 ? 's' : ''}`,
    );
    setApplying(false);
    onChanged();
    setTimeout(() => setToast(null), 3000);
  }

  if (candidates.length === 0) {
    return (
      <span
        className="tiny subtle"
        style={{ fontSize: 11 }}
        title="No model recommendations to apply"
      >
        ✓ all match recommendations
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {toast && <span style={{ color: 'var(--accent-text)', fontSize: 11 }}>{toast}</span>}
      <button
        type="button"
        className="btn btn-sm"
        onClick={applyAll}
        disabled={applying}
        title={`Apply recommended_model to ${candidates.length} skill${candidates.length !== 1 ? 's' : ''} where it differs from current effective. Writes to each skill's SKILL.md frontmatter.`}
      >
        {applying ? 'Applying…' : `Apply recommendations (${candidates.length})`}
      </button>
    </div>
  );
}

function SkillModelRowEditor({
  skill,
  projectDefault,
  models,
  grouped,
  onSaved,
}: {
  skill: SkillConfigRow;
  projectDefault: string | null;
  models: RegistryModel[];
  grouped: Array<[string, RegistryModel[]]>;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const effective = skill.model ?? projectDefault;
  const isOverridden = skill.model !== null;

  async function save(next: string | null) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/settings/skills/${encodeURIComponent(skill.name)}/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: next }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td>
        <code className="mono" style={{ fontSize: 12 }}>
          {skill.name}
        </code>
      </td>
      <td>
        <span
          className="mono"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: isOverridden ? 'var(--accent-text)' : 'var(--text-1)',
          }}
        >
          {effective ? formatModelLabel(effective) : '—'}
        </span>
        {!isOverridden && effective && (
          <span
            className="tiny subtle"
            style={{ fontSize: 10, marginLeft: 6, color: 'var(--text-3)' }}
            title="Inherits from the project-wide model dropdown above"
          >
            (from project)
          </span>
        )}
        {!effective && (
          <span
            className="tiny subtle"
            style={{ fontSize: 10, marginLeft: 6, color: 'var(--text-3)' }}
            title="No project-wide model set; falls back to Claude Code's user-global default"
          >
            (cli default)
          </span>
        )}
      </td>
      <td>
        <select
          className="input"
          value={skill.model ?? ''}
          onChange={(e) => save(e.target.value || null)}
          disabled={saving}
          style={{ height: 26, fontSize: 12, minWidth: 220 }}
        >
          <option value="">— inherit (no override) —</option>
          {grouped.map(([family, list]) => (
            <optgroup key={family} label={family.charAt(0).toUpperCase() + family.slice(1)}>
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {formatModelLabel(m.id)}
                  {m.latest ? ' ★' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {savedAt && Date.now() - savedAt < 2000 && (
          <span style={{ color: 'var(--accent-text)', fontSize: 10, marginLeft: 6 }}>✓</span>
        )}
        {error && (
          <div style={{ color: 'var(--danger-text)', fontSize: 10, marginTop: 2 }}>✗ {error}</div>
        )}
      </td>
      <td>
        <ModelRecommendedCell
          recommended={skill.recommended_model}
          effective={effective}
          models={models}
          saving={saving}
          onApply={(v) => save(v)}
        />
      </td>
    </tr>
  );
}

function ModelRecommendedCell({
  recommended,
  effective,
  saving,
  onApply,
}: {
  recommended: string | null;
  effective: string | null;
  models: RegistryModel[];
  saving: boolean;
  onApply: (id: string) => void;
}) {
  if (!recommended) {
    return (
      <span className="tiny subtle" style={{ fontSize: 11, color: 'var(--text-3)' }}>
        —
      </span>
    );
  }
  if (effective && recommended === effective) {
    return (
      <span style={{ fontSize: 12 }}>
        <code className="mono">{formatModelLabel(recommended)}</code>{' '}
        <span style={{ color: 'var(--success-text, #4caf80)', marginLeft: 2 }}>✓</span>
      </span>
    );
  }
  // Model "direction" isn't naturally ordered (Fable vs Opus vs Haiku) — show
  // a neutral "apply" indicator instead of ↑/↓.
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <code className="mono">{formatModelLabel(recommended)}</code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onApply(recommended)}
        disabled={saving}
        title={`Switch this skill from ${effective ? formatModelLabel(effective) : '(cli default)'} to ${formatModelLabel(recommended)} (writes to SKILL.md frontmatter).`}
        style={{
          fontSize: 11,
          padding: '2px 8px',
          color: 'var(--accent-text)',
        }}
      >
        ↻ apply
      </button>
    </span>
  );
}
