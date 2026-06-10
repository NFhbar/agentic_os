// Effort & cost panel.
//
// Two cards:
//
//   1. Project-wide effort — dropdown. Reads effective_effort + effort_source
//      from /api/settings (local override wins; falls back to project default).
//      Writes via PUT /api/settings/effort, always landing in
//      settings.local.json (gitignored, per-install).
//
//   2. Per-skill effort overrides — read-only table. Each skill's frontmatter
//      `effort:` field, scanned from .claude/skills/*/SKILL.md. Skills that
//      don't set one inherit the project-wide value (shown muted). Editing
//      these would modify git-tracked files; we leave that to manual edits.

import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../lib/api';

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface SettingsLayer {
  path: string;
  exists: boolean;
  parsed: Record<string, unknown> | null;
  parse_error: string | null;
}

interface SkillEffortRow {
  name: string;
  effort: EffortLevel | null;
  recommended_effort: EffortLevel | null;
}

// Ordering for compare-with-recommendation logic. Higher index = higher effort.
const EFFORT_ORDER: Record<EffortLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

interface SettingsResponse {
  project: SettingsLayer;
  local: SettingsLayer;
  effective_effort: EffortLevel | null;
  effort_source: 'local' | 'project' | 'unset';
  skills: SkillEffortRow[];
  effort_levels: readonly EffortLevel[];
}

const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: 'Fastest, cheapest. Light reasoning. Good for routers and CRUD wrappers.',
  medium: 'Default for most tasks. Balanced speed/quality.',
  high: 'Deeper reasoning. Recommended baseline for the OS — handles synthesis well.',
  xhigh: 'Maximum standard depth. Requires Opus 4.7/4.8; falls back to high on others.',
  max: 'Highest available effort. Slow + expensive. Reserve for hardest synthesis tasks.',
};

// Rough cost multiplier vs `high`. Still used in the project-effort details
// panel; per-skill table now shows the per-skill Recommended column instead.
const EFFORT_COST_HINT: Record<EffortLevel, string> = {
  low: '~0.3×',
  medium: '~0.7×',
  high: '1×',
  xhigh: '~2-4×',
  max: '~5×+',
};

export function EffortPanel() {
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

  async function saveEffort(next: EffortLevel | null) {
    setSaving(true);
    setSaveError(null);
    setSavedToast(null);
    try {
      const r = await fetch('/api/settings/effort', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effortLevel: next }),
      });
      const j = (await r.json()) as { ok: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      setSavedToast(next ? `Saved — ${next}` : 'Saved — using project default');
      // Give the user a moment to see the toast, then refresh.
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

  const { effective_effort, effort_source, skills, effort_levels, project, local } = data;
  const projectEffort = (project.parsed?.effortLevel as EffortLevel | undefined) ?? null;
  const localEffort = (local.parsed?.effortLevel as EffortLevel | undefined) ?? null;
  const inheritedCount = skills.filter((s) => !s.effort).length;
  const overriddenCount = skills.filter((s) => s.effort).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Project-wide effort */}
      <section className="card" style={{ padding: 16 }}>
        <h3 className="card-title" style={{ marginBottom: 4 }}>
          Project-wide effort
        </h3>
        <div className="tiny subtle" style={{ marginBottom: 14 }}>
          Reasoning depth for all sessions in this workspace. Skills can opt higher or lower via
          their <code className="mono">effort:</code> frontmatter.
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="effort-select" className="tiny subtle">
            Effort level:
          </label>
          <select
            id="effort-select"
            className="input"
            value={effective_effort ?? ''}
            onChange={(e) => saveEffort((e.target.value || null) as EffortLevel | null)}
            disabled={saving}
            style={{ height: 32, fontSize: 13, minWidth: 140 }}
          >
            <option value="">
              {projectEffort
                ? `(use project default — ${projectEffort})`
                : '(use project default — unset, Claude Code built-in)'}
            </option>
            {effort_levels.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
          {effort_source !== 'unset' && (
            <span
              className="badge muted"
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}
              title={
                effort_source === 'local'
                  ? `Set in settings.local.json (per-install). Project default: ${projectEffort ?? '(unset)'}`
                  : 'Inherited from team-tracked settings.json. Override by selecting a level above.'
              }
            >
              {effort_source === 'local' ? 'per-install' : 'inherited'}
            </span>
          )}
          {effort_source === 'unset' && (
            <span
              className="badge muted"
              style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}
              title="Neither settings.json nor settings.local.json has effortLevel set — Claude Code uses its model-specific built-in default (xhigh on Opus 4.7, high on Opus 4.8)."
            >
              built-in
            </span>
          )}
          {savedToast && (
            <span style={{ color: 'var(--accent-text)', fontSize: 12 }}>✓ {savedToast}</span>
          )}
          {saveError && (
            <span style={{ color: 'var(--danger-text)', fontSize: 12 }}>✗ {saveError}</span>
          )}
        </div>

        {effective_effort && (
          <div
            className="tiny subtle"
            style={{
              marginTop: 10,
              padding: '8px 10px',
              background: 'var(--bg-2)',
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <strong>{effective_effort}</strong> — {EFFORT_DESCRIPTIONS[effective_effort]}
          </div>
        )}

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
              <code className="mono">{projectEffort ?? '(unset)'}</code>
            </div>
            <div>
              <strong>Per-install override:</strong>{' '}
              <code className="mono">.claude/settings.local.json</code> — gitignored. Current:{' '}
              <code className="mono">{localEffort ?? '(unset)'}</code>
            </div>
            <div style={{ marginTop: 4 }}>
              Writes from this panel land in the local file. Selecting{' '}
              <em>(use project default)</em> removes the key entirely so the team baseline takes
              over.
            </div>
          </div>
        </details>
      </section>

      {/* Per-skill effort overrides */}
      <section className="card" style={{ padding: 0 }}>
        <div className="card-header">
          <div>
            <h3 className="card-title">Per-skill effort overrides</h3>
            <span className="tiny subtle">
              {overriddenCount} of {skills.length} skill{skills.length !== 1 ? 's' : ''} override
              the project default · {inheritedCount} inherit
            </span>
          </div>
          <ApplyAllRecommendationsButton
            skills={skills}
            projectDefault={effective_effort}
            onChanged={refresh}
          />
        </div>
        <div className="tiny subtle" style={{ padding: '10px 16px', fontSize: 11 }}>
          By default every skill inherits the project-wide effort above. Use Override to opt a
          specific skill up or down. The <strong>Recommended</strong> column shows guidance baked
          into each skill (<code className="mono">recommended_effort:</code> frontmatter) — click
          <strong> ↑ apply</strong> / <strong>↓ apply</strong> on any row to copy the recommendation
          into the override, or use <strong>Apply recommendations</strong> above to batch all deltas
          at once. Writes go to team-tracked{' '}
          <code className="mono">.claude/skills/&lt;name&gt;/SKILL.md</code> frontmatter — commit to
          share with your team, or <code className="mono">git checkout</code> to discard.
        </div>
        <table className="table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Skill</th>
              <th style={{ width: 130 }}>Effective effort</th>
              <th style={{ width: 200 }}>Override</th>
              <th style={{ width: 160 }}>Recommended</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <SkillEffortRowEditor
                key={s.name}
                skill={s}
                projectDefault={effective_effort}
                effortLevels={effort_levels}
                onSaved={refresh}
              />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// Bulk "Apply recommendations" — finds every skill whose recommended_effort
// differs from its current effective effort and applies the recommendation.
// Skips skills with no recommendation or with already-matching effective.
// Sequential PUTs (not parallel) to avoid hammering the server and to make
// any single failure easy to diagnose.
function ApplyAllRecommendationsButton({
  skills,
  projectDefault,
  onChanged,
}: {
  skills: SkillEffortRow[];
  projectDefault: EffortLevel | null;
  onChanged: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const candidates = skills.filter((s) => {
    if (!s.recommended_effort) return false;
    const effective = s.effort ?? projectDefault;
    return s.recommended_effort !== effective;
  });

  async function applyAll() {
    if (candidates.length === 0) return;
    setApplying(true);
    setToast(null);
    let ok = 0;
    let failed = 0;
    for (const s of candidates) {
      try {
        const r = await fetch(`/api/settings/skills/${encodeURIComponent(s.name)}/effort`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ effortLevel: s.recommended_effort }),
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
      <span className="tiny subtle" style={{ fontSize: 11 }} title="No deltas to apply">
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
        title={`Apply recommended_effort to ${candidates.length} skill${candidates.length !== 1 ? 's' : ''} where it differs from current effective. Writes to each skill's SKILL.md frontmatter.`}
      >
        {applying ? 'Applying…' : `Apply recommendations (${candidates.length})`}
      </button>
    </div>
  );
}

function SkillEffortRowEditor({
  skill,
  projectDefault,
  effortLevels,
  onSaved,
}: {
  skill: SkillEffortRow;
  projectDefault: EffortLevel | null;
  effortLevels: readonly EffortLevel[];
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const effective = skill.effort ?? projectDefault;
  const isOverridden = skill.effort !== null;

  async function save(next: EffortLevel | null) {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/settings/skills/${encodeURIComponent(skill.name)}/effort`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effortLevel: next }),
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
          {effective ?? '—'}
        </span>
        {!isOverridden && (
          <span
            className="tiny subtle"
            style={{ fontSize: 10, marginLeft: 6, color: 'var(--text-3)' }}
            title="Inherits from the project-wide effort dropdown above"
          >
            (from project)
          </span>
        )}
      </td>
      <td>
        <select
          className="input"
          value={skill.effort ?? ''}
          onChange={(e) => save((e.target.value || null) as EffortLevel | null)}
          disabled={saving}
          style={{ height: 26, fontSize: 12, minWidth: 180 }}
        >
          <option value="">— inherit (no override) —</option>
          {effortLevels.map((lvl) => (
            <option key={lvl} value={lvl}>
              {lvl}
            </option>
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
        <RecommendedCell
          recommended={skill.recommended_effort}
          effective={effective}
          saving={saving}
          onApply={(lvl) => save(lvl)}
        />
      </td>
    </tr>
  );
}

// Renders the per-skill Recommended column cell. Four visual states:
//   - no recommendation → muted "—"
//   - recommendation matches effective → "<level> ✓" (subtle success color)
//   - recommendation > effective → "<level> ↑ apply" button (bump up)
//   - recommendation < effective → "<level> ↓ apply" button (drop down)
// Clicking "apply" copies the recommendation into the skill's effort: override
// via the same PUT endpoint the dropdown uses — no special API path.
function RecommendedCell({
  recommended,
  effective,
  saving,
  onApply,
}: {
  recommended: EffortLevel | null;
  effective: EffortLevel | null;
  saving: boolean;
  onApply: (lvl: EffortLevel) => void;
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
        <code className="mono">{recommended}</code>{' '}
        <span style={{ color: 'var(--success-text, #4caf80)', marginLeft: 2 }}>✓</span>
      </span>
    );
  }
  const direction =
    effective && EFFORT_ORDER[recommended] > EFFORT_ORDER[effective] ? 'up' : 'down';
  const arrow = direction === 'up' ? '↑' : '↓';
  const tooltip =
    direction === 'up'
      ? `Bump this skill from ${effective ?? '(unset)'} to ${recommended} (writes to SKILL.md frontmatter).`
      : `Drop this skill from ${effective ?? '(unset)'} to ${recommended} (writes to SKILL.md frontmatter).`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <code className="mono">{recommended}</code>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onApply(recommended)}
        disabled={saving}
        title={tooltip}
        style={{
          fontSize: 11,
          padding: '2px 8px',
          color: direction === 'up' ? 'var(--accent-text)' : 'var(--warning-text)',
        }}
      >
        {arrow} apply
      </button>
    </span>
  );
}
