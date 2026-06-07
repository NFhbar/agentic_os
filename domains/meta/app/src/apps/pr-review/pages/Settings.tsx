// Settings — Phase B (editable). Fetches /api/pr-review/config, tracks local
// edits in a `editing` snapshot, and PUTs the diff on Save. Custom instruction
// hash is recomputed server-side. Automation / Notifications stay as Phase B+
// placeholders.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PrReviewConfig } from '../../../../server/routes/pr-review-config.types';
import { Icons } from '../../../shared';

type SectionId = 'overview' | 'models' | 'review' | 'automation' | 'notifications';

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Icons.Settings size={14} /> },
  { id: 'models', label: 'Models', icon: <Icons.Cpu size={14} /> },
  { id: 'review', label: 'Review style', icon: <Icons.Code size={14} /> },
  { id: 'automation', label: 'Automation', icon: <Icons.Zap size={14} /> },
  { id: 'notifications', label: 'Notifications', icon: <Icons.Bell size={14} /> },
];

// Subset of the config that's editable via PUT — matches the EDITABLE_FIELDS
// set on the backend. Used as the shape of the local `editing` state.
type EditableConfig = Pick<
  PrReviewConfig,
  | 'primary_model'
  | 'analyzer_model'
  | 'comment_style'
  | 'focus_areas'
  | 'context_strategy'
  | 'custom_instructions'
>;

// All known focus areas — the six built-in categories plus any custom labels
// already present in the saved config (we always include those so the user
// can toggle existing entries off without losing the label).
const BUILT_IN_FOCUS_AREAS = [
  'logic',
  'security',
  'performance',
  'style',
  'tests',
  'docs',
] as const;
const COMMENT_STYLES: PrReviewConfig['comment_style'][] = ['terse', 'concise', 'detailed'];

function pickEditable(c: PrReviewConfig): EditableConfig {
  return {
    primary_model: c.primary_model,
    analyzer_model: c.analyzer_model,
    comment_style: c.comment_style,
    focus_areas: c.focus_areas,
    context_strategy: c.context_strategy,
    custom_instructions: c.custom_instructions,
  };
}

// Shallow diff: returns the keys where `editing` differs from `saved`. Array
// fields are compared by content (length + element equality).
function dirtyKeys(saved: EditableConfig, editing: EditableConfig): Array<keyof EditableConfig> {
  const out: Array<keyof EditableConfig> = [];
  for (const k of Object.keys(saved) as Array<keyof EditableConfig>) {
    const a = saved[k];
    const b = editing[k];
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) out.push(k);
    } else if (a !== b) {
      out.push(k);
    }
  }
  return out;
}

export function Settings() {
  const [section, setSection] = useState<SectionId>('overview');
  const [config, setConfig] = useState<PrReviewConfig | null>(null);
  const [editing, setEditing] = useState<EditableConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Models registry loaded once on mount; the dropdowns in SectionModels
  // consume it via props. Cached for the lifetime of this view — the
  // registry is updated by editing scripts/models-registry.mjs which
  // requires a server restart anyway.
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/pr-review/config');
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = (await r.json()) as { config: PrReviewConfig };
      setConfig(j.config);
      setEditing(pickEditable(j.config));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Load the models registry once. Failure is non-fatal — SectionModels
  // renders a degraded read-only view with the saved value as plain text.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/models')
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<{ models: ModelEntry[] }>;
      })
      .then((j) => {
        if (!cancelled) setModels(j.models);
      })
      .catch((e) => {
        if (!cancelled) setModelsError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => {
    if (!config || !editing) return [] as Array<keyof EditableConfig>;
    return dirtyKeys(pickEditable(config), editing);
  }, [config, editing]);

  const onSave = useCallback(async () => {
    if (!editing || !config || dirty.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Send only the dirty fields — keeps the audit trail tight and avoids
      // touching unmodified frontmatter lines on the server's surgical write.
      const payload: Partial<EditableConfig> = {};
      for (const k of dirty) {
        // biome-ignore lint/suspicious/noExplicitAny: assigning union-typed value
        (payload as any)[k] = editing[k];
      }
      const r = await fetch('/api/pr-review/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = (await r.json()) as { ok: boolean; config?: PrReviewConfig; error?: string };
      if (!r.ok || !j.ok || !j.config) {
        throw new Error(j.error ?? `save failed (status ${r.status})`);
      }
      setConfig(j.config);
      setEditing(pickEditable(j.config));
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [editing, config, dirty]);

  const onDiscard = useCallback(() => {
    if (!config) return;
    setEditing(pickEditable(config));
    setSaveError(null);
  }, [config]);

  // Knobs the per-section editors use to mutate `editing`. Memoized so the
  // function references stay stable across renders.
  const update = useMemo(() => {
    return <K extends keyof EditableConfig>(key: K, value: EditableConfig[K]) => {
      setEditing((prev) => (prev ? { ...prev, [key]: value } : prev));
    };
  }, []);

  return (
    <div className="page">
      <div style={{ marginBottom: 14 }}>
        <h1 className="h1">Settings</h1>
        <div className="subtle" style={{ marginTop: 2 }}>
          Policy values for PR review. Edit any field; changes save explicitly.
        </div>
      </div>

      <SaveBanner
        config={config}
        dirtyCount={dirty.length}
        saving={saving}
        saveError={saveError}
        onSave={onSave}
        onDiscard={onDiscard}
      />

      <div className="settings-grid">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={section === s.id}
              onClick={() => setSection(s.id)}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--muted)' }}>{s.icon}</span>
                {s.label}
              </span>
            </button>
          ))}
        </nav>

        <div>
          {error && <ErrorCard message={error} />}
          {!error && !config && <LoadingCard />}
          {config && editing && section === 'overview' && <SectionOverview config={config} />}
          {config && editing && section === 'models' && (
            <SectionModels
              editing={editing}
              update={update}
              models={models}
              modelsError={modelsError}
            />
          )}
          {config && editing && section === 'review' && (
            <SectionReview editing={editing} update={update} />
          )}
          {config && section === 'automation' && <PhaseBPlaceholder name="Automation" />}
          {config && section === 'notifications' && <PhaseBPlaceholder name="Notifications" />}
        </div>
      </div>
    </div>
  );
}

function SaveBanner({
  config,
  dirtyCount,
  saving,
  saveError,
  onSave,
  onDiscard,
}: {
  config: PrReviewConfig | null;
  dirtyCount: number;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!config) return null;
  const isDirty = dirtyCount > 0;
  return (
    <div
      className="card"
      style={{
        marginBottom: 18,
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: isDirty ? 'var(--panel)' : 'var(--panel-2)',
        borderColor: isDirty ? 'var(--accent)' : 'var(--border)',
      }}
    >
      <span style={{ color: isDirty ? 'var(--accent)' : 'var(--muted)', fontWeight: 500 }}>ⓘ</span>
      <div className="tiny" style={{ flex: 1 }}>
        {isDirty ? (
          <>
            <strong>{dirtyCount}</strong> unsaved change{dirtyCount === 1 ? '' : 's'} — click Save
            to write back to <code>{config.source_path}</code>
          </>
        ) : (
          <>
            Saved. Source file: <code>{config.source_path}</code>
          </>
        )}
        {saveError && (
          <div style={{ color: 'var(--danger-text)', marginTop: 4 }}>Save failed: {saveError}</div>
        )}
      </div>
      {config.updated && (
        <div className="tiny mono" style={{ color: 'var(--muted)' }}>
          updated {new Date(config.updated).toLocaleString()}
        </div>
      )}
      {isDirty && (
        <>
          <button type="button" className="btn" onClick={onDiscard} disabled={saving}>
            Discard
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    </div>
  );
}

function SettingsCard({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-header">
        <div>
          <h3 className="card-title">{title}</h3>
          {desc && (
            <div className="tiny" style={{ marginTop: 2 }}>
              {desc}
            </div>
          )}
        </div>
      </div>
      <div style={{ padding: '14px 18px 18px' }}>{children}</div>
    </div>
  );
}

function KvRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 1fr',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div>
        <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
        {hint && (
          <div className="tiny" style={{ marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>{children}</div>
    </div>
  );
}

function CodeChip({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        background: 'var(--panel-2)',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 12.5,
        border: '1px solid var(--border)',
      }}
    >
      {children}
    </code>
  );
}

function SectionOverview({ config }: { config: PrReviewConfig }) {
  return (
    <SettingsCard
      title="Configuration overview"
      desc="High-level summary of every policy knob currently in effect"
    >
      <KvRow label="Source file" hint="Editing this file changes review behavior for new runs">
        <CodeChip>{config.source_path}</CodeChip>
      </KvRow>
      <KvRow label="Review model" hint="Used by dev-pr-review for the analysis pass">
        <CodeChip>{config.primary_model}</CodeChip>
      </KvRow>
      <KvRow label="Analyzer model" hint="Used by dev-analyze-repo-for-review for Stage 2 prose">
        <CodeChip>{config.analyzer_model}</CodeChip>
      </KvRow>
      <KvRow label="Comment style">
        <CodeChip>{config.comment_style}</CodeChip>
      </KvRow>
      <KvRow label="Focus areas" hint="Aspects the reviewer considers + tags comments with">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {config.focus_areas.map((area) => (
            <CodeChip key={area}>{area}</CodeChip>
          ))}
        </div>
      </KvRow>
      <KvRow label="Context strategy" hint="How code context is assembled for the review prompt">
        <CodeChip>{config.context_strategy}</CodeChip>
      </KvRow>
      <KvRow label="Custom instructions" hint="Free-text appended to the review prompt">
        {config.custom_instructions ? (
          <span className="tiny mono">
            ({config.custom_instructions.length} chars · hash{' '}
            {config.custom_instructions_hash ?? '—'})
          </span>
        ) : (
          <span className="tiny" style={{ color: 'var(--muted)' }}>
            (none)
          </span>
        )}
      </KvRow>
    </SettingsCard>
  );
}

// Model registry shape — mirrors scripts/models-registry.mjs. Inlined here
// as a narrow client-side projection so the .tsx doesn't have to import a
// .mjs across the dashboard build boundary.
interface ModelEntry {
  id: string;
  family: 'opus' | 'sonnet' | 'haiku';
  latest: boolean;
  pricing: {
    input: number;
    output: number;
    cache_read: number;
    cache_write_1h: number;
  };
  aliases?: string;
}

// Picker that drives both primary_model and analyzer_model. Loads the
// registry from /api/models once; renders a dropdown showing latest-of-family
// by default with a "Show historical versions" toggle for older minor versions.
function ModelPicker({
  value,
  onChange,
  models,
  showAll,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ModelEntry[];
  showAll: boolean;
}) {
  // Visible set = latest-of-family by default; full registry when showAll.
  const visible = showAll ? models : models.filter((m) => m.latest);
  // If the current value isn't in the visible set (e.g. user has a historical
  // model saved + showAll is off), inject it so the dropdown stays consistent
  // with the saved state instead of silently switching away from it.
  const inVisible = visible.some((m) => m.id === value);
  const options = inVisible
    ? visible
    : [...visible, models.find((m) => m.id === value) ?? null].filter(Boolean as unknown as (x: ModelEntry | null) => x is ModelEntry);

  return (
    <select
      className="input mono"
      style={{ width: 320, padding: '6px 10px', fontSize: 13 }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((m) => {
        // Per-Mtoken pricing summary — input/output in USD with one decimal.
        const price = `$${m.pricing.input.toFixed(2)} / $${m.pricing.output.toFixed(2)} per M tok`;
        const flag = m.latest ? '' : ' (older)';
        return (
          <option key={m.id} value={m.id}>
            {m.id}{flag} — {m.family} — {price}
          </option>
        );
      })}
      {/* If value isn't in the registry at all (e.g. a model id added since
          this OS install was last updated), surface it as a disabled fallback
          so the user sees what they have without us silently rewriting their
          config. */}
      {!models.some((m) => m.id === value) && value && (
        <option value={value} disabled>
          {value} (not in registry — update scripts/models-registry.mjs)
        </option>
      )}
    </select>
  );
}

function SectionModels({
  editing,
  update,
  models,
  modelsError,
}: {
  editing: EditableConfig;
  update: <K extends keyof EditableConfig>(k: K, v: EditableConfig[K]) => void;
  models: ModelEntry[] | null;
  modelsError: string | null;
}) {
  const [showAll, setShowAll] = useState(false);

  if (modelsError) {
    return (
      <SettingsCard title="Model picker unavailable" desc="Failed to load /api/models">
        <div className="tiny" style={{ color: 'var(--danger-text)' }}>
          {modelsError} — saved values shown below as plain text. Refresh once the server is
          available.
        </div>
        <KvRow label="Review model">
          <span className="mono tiny">{editing.primary_model || '(unset)'}</span>
        </KvRow>
        <KvRow label="Analyzer model">
          <span className="mono tiny">{editing.analyzer_model || '(unset)'}</span>
        </KvRow>
      </SettingsCard>
    );
  }

  if (!models) {
    return (
      <SettingsCard title="Loading models…" desc="Fetching the registry from /api/models">
        <div className="tiny" style={{ color: 'var(--muted)' }}>Loading…</div>
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard
        title="Review model"
        desc="The model dev-pr-review uses when analyzing a pull request diff and producing comments"
      >
        <KvRow label="Model id">
          <ModelPicker
            value={editing.primary_model}
            onChange={(id) => update('primary_model', id)}
            models={models}
            showAll={showAll}
          />
        </KvRow>
        <KvRow label="Snapshotted" hint="Each pr-review entry records the model it ran under">
          <span className="tiny">
            stored in <code>config.primary_model</code>
          </span>
        </KvRow>
      </SettingsCard>

      <SettingsCard
        title="Analyzer model"
        desc="The model dev-analyze-repo-for-review uses to generate the Stage 2 prose knowledge doc (repo overview / conventions / deps)"
      >
        <KvRow label="Model id">
          <ModelPicker
            value={editing.analyzer_model}
            onChange={(id) => update('analyzer_model', id)}
            models={models}
            showAll={showAll}
          />
        </KvRow>
        <KvRow label="Trade-off" hint="Opus is richer; Haiku is ~3× faster + ~20× cheaper per token">
          <span className="tiny">
            For small repos, switching to{' '}
            <code>{models.find((m) => m.family === 'haiku' && m.latest)?.id ?? 'claude-haiku-4-5'}</code>{' '}
            gives noticeably snappier re-indexing at modest cost to overview depth.
          </span>
        </KvRow>
        <KvRow
          label="Dispatch caveat"
          hint="Saved here today; Phase C wires this to the actual model dispatched"
        >
          <span className="tiny" style={{ color: 'var(--muted)' }}>
            Saving persists the choice to the config file. The running model is still inherited from
            the parent <code>claude -p</code> invocation until Phase C wires this to the actual
            dispatch.
          </span>
        </KvRow>
      </SettingsCard>

      <SettingsCard title="Versions" desc="Toggle visibility of older minor versions in the dropdowns">
        <KvRow label="Show historical versions">
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            {showAll ? 'Showing all versions' : 'Latest of each family only'}
          </label>
        </KvRow>
        <KvRow label="Registry" hint="Source of truth for the dropdown list + cost-per-token data">
          <span className="tiny">
            <code>scripts/models-registry.mjs</code> — update when new models release
          </span>
        </KvRow>
      </SettingsCard>
    </>
  );
}

function SectionReview({
  editing,
  update,
}: {
  editing: EditableConfig;
  update: <K extends keyof EditableConfig>(k: K, v: EditableConfig[K]) => void;
}) {
  // Surface the union of built-in categories + any custom ones already in
  // the saved focus_areas, so the user can toggle off custom labels too.
  const customAreas = editing.focus_areas.filter(
    (a) => !BUILT_IN_FOCUS_AREAS.includes(a as (typeof BUILT_IN_FOCUS_AREAS)[number]),
  );
  const allAreas = [...BUILT_IN_FOCUS_AREAS, ...customAreas];
  const toggleArea = (area: string) => {
    const set = new Set(editing.focus_areas);
    if (set.has(area)) set.delete(area);
    else set.add(area);
    // Preserve canonical order (built-ins first, then customs in original order).
    update(
      'focus_areas',
      allAreas.filter((a) => set.has(a)),
    );
  };

  return (
    <>
      <SettingsCard
        title="Comment style"
        desc="How verbose the model should be when producing review comments"
      >
        <KvRow label="Style">
          <div style={{ display: 'flex', gap: 6 }}>
            {COMMENT_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className={`btn ${editing.comment_style === style ? 'btn-primary' : ''}`}
                onClick={() => update('comment_style', style)}
                style={{ height: 32, padding: '0 14px', fontSize: 13 }}
              >
                {style}
              </button>
            ))}
          </div>
        </KvRow>
        <KvRow label="What this means">
          <span className="tiny">
            {editing.comment_style === 'terse' && 'One-line observations; no explanation'}
            {editing.comment_style === 'concise' &&
              'Two-to-three sentences with brief reasoning and a suggestion where applicable'}
            {editing.comment_style === 'detailed' &&
              'Full reasoning, suggestion code blocks, links to related context'}
          </span>
        </KvRow>
      </SettingsCard>

      <SettingsCard
        title="Focus areas"
        desc="Toggle which aspects the model considers + tags each comment with"
      >
        <KvRow label="Categories">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {allAreas.map((area) => {
              const enabled = editing.focus_areas.includes(area);
              return (
                <button
                  key={area}
                  type="button"
                  className={`btn ${enabled ? 'btn-primary' : ''}`}
                  onClick={() => toggleArea(area)}
                  style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                >
                  {area}
                </button>
              );
            })}
          </div>
        </KvRow>
        <KvRow label="At least one">
          <span className="tiny" style={{ color: 'var(--muted)' }}>
            Save is rejected if you disable every focus area — the model needs something to look
            for. Add custom labels by editing the source file (free-form labels editor lands later).
          </span>
        </KvRow>
      </SettingsCard>

      <SettingsCard
        title="Context strategy"
        desc="How code context is assembled for the review prompt"
      >
        <KvRow label="Strategy">
          <CodeChip>{editing.context_strategy}</CodeChip>
          <span className="tiny" style={{ marginLeft: 10, color: 'var(--muted)' }}>
            (only <code>full-diff</code> supported in v1; alternatives gated by Phase 3+ work)
          </span>
        </KvRow>
        <KvRow label="What this means">
          <span className="tiny">
            Sends the full PR diff to the model. Simplest path; only supported value in v1.
          </span>
        </KvRow>
      </SettingsCard>

      <SettingsCard
        title="Custom instructions"
        desc="Free-text appended to the review prompt skeleton — use for repo-specific concerns"
      >
        <textarea
          className="input mono"
          value={editing.custom_instructions}
          onChange={(e) => update('custom_instructions', e.target.value)}
          placeholder="e.g. 'Prefer Result<T,E>; flag any thrown errors' or 'This repo uses Effect; surface non-Effect error handling'"
          rows={6}
          style={{
            width: '100%',
            fontSize: 12.5,
            padding: 10,
            lineHeight: 1.4,
            resize: 'vertical',
          }}
        />
        <div className="tiny mono" style={{ marginTop: 8, color: 'var(--muted)' }}>
          {editing.custom_instructions.length} chars · hash recomputed on save
        </div>
      </SettingsCard>
    </>
  );
}

function PhaseBPlaceholder({ name }: { name: string }) {
  return (
    <SettingsCard title={name} desc="Coming in Phase B — config schema extends here">
      <div className="tiny" style={{ color: 'var(--muted)', padding: '12px 0' }}>
        <span style={{ marginRight: 6 }}>ⓘ</span>
        The {name.toLowerCase()} knobs aren't part of the current config schema. Phase B will add
        editor UI and the matching fields to <code>reference-pr-review-config.md</code>.
      </div>
    </SettingsCard>
  );
}

function LoadingCard() {
  return (
    <div className="card" style={{ padding: '24px 18px', color: 'var(--muted)' }}>
      Loading config…
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div
      className="card"
      style={{
        padding: '14px 18px',
        color: 'var(--danger-text)',
        borderColor: 'var(--danger-text)',
      }}
    >
      <strong>Failed to load config:</strong> {message}
      <div className="tiny" style={{ marginTop: 6, color: 'var(--muted)' }}>
        Check that <code>vault/wiki/_seed/development/reference/reference-pr-review-config.md</code>{' '}
        exists.
      </div>
    </div>
  );
}
