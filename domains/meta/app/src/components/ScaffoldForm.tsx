import React, { useEffect, useMemo, useState } from 'react';
import { type InputField, type SkillSummary, buildScaffoldPrompt } from '../lib/skills';
import { type ManifestEntry, fetchManifest } from '../lib/vault';

interface Props {
  skill: SkillSummary;
  title?: string;
  initialValues?: Record<string, string>;
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
  // Opt-in, project usage only: renders an inline "Repo not listed? Ingest
  // one →" affordance in the repo picker. Absent for the Overview scaffolders,
  // which keep the CLI-only empty-state hint unchanged.
  onIngestRepo?: () => void;
  // Bump to force the manifest pickers to refetch (e.g. after an ingest run
  // completes) so a freshly-ingested repo becomes selectable without a remount.
  manifestRefreshKey?: number;
}

// Strict-validated form generated from a skill's `inputs:` frontmatter schema.
// Required fields enforced; pattern regex validated; submit disabled until clean.
// Emits a prompt for the parent to feed into ActionRunner.
export function ScaffoldForm({
  skill,
  title,
  initialValues,
  onSubmit,
  onCancel,
  onIngestRepo,
  manifestRefreshKey,
}: Props) {
  const fields = useMemo(() => Object.entries(skill.inputs), [skill.inputs]);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [name, def] of fields) {
      initial[name] =
        initialValues?.[name] ?? (def.default !== undefined ? String(def.default) : '');
    }
    return initial;
  });
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Manifest-driven pickers — pull repo + project entities once on mount.
  // Used to populate the dropdowns for fields named `repo` / `project`
  // instead of free-text input (eliminates typos + surfaces what exists).
  // Skipped when neither field is in the schema (avoids the fetch cost for
  // skills that don't need it).
  const [manifestEntries, setManifestEntries] = useState<ManifestEntry[] | null>(null);
  const needsManifest = useMemo(() => {
    return fields.some(([name]) => name === 'repo' || name === 'project');
  }, [fields]);
  useEffect(() => {
    if (!needsManifest) return;
    let cancelled = false;
    // Cache-friendly on first mount (key absent/0); forced on every subsequent
    // bump so a just-ingested repo lands in the picker without a remount.
    fetchManifest((manifestRefreshKey ?? 0) > 0)
      .then((m) => {
        if (!cancelled) setManifestEntries(m.entries);
      })
      .catch(() => {
        if (!cancelled) setManifestEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsManifest, manifestRefreshKey]);
  const repoOptions = useMemo(() => {
    if (!manifestEntries) return null;
    return manifestEntries
      .filter((e) => e.type === 'entity' && e.kind === 'repo')
      .map((e) => ({ id: e.id as string, title: e.title ?? (e.id as string) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [manifestEntries]);
  const projectOptions = useMemo(() => {
    if (!manifestEntries) return null;
    return manifestEntries
      .filter((e) => e.type === 'project')
      .map((e) => ({ id: e.id as string, title: e.title ?? (e.id as string) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [manifestEntries]);

  function validate(value: string, def: InputField): string | null {
    if (def.required && !value.trim()) return 'Required';
    if (value && def.pattern) {
      try {
        if (!new RegExp(def.pattern).test(value)) {
          return `Must match pattern: ${def.pattern}`;
        }
      } catch {
        /* invalid regex in schema — skip */
      }
    }
    return null;
  }

  const errors = useMemo(() => {
    const e: Record<string, string | null> = {};
    for (const [name, def] of fields) {
      e[name] = validate(values[name] ?? '', def);
    }
    return e;
  }, [fields, values]);

  // Block submit if the skill's frontmatter couldn't be parsed — otherwise the
  // form would have zero fields and Submit would be vacuously enabled, leading
  // to an empty prompt being sent to the AI bridge.
  const canSubmit = !skill.parseError && fields.every(([name]) => !errors[name]);

  function handleChange(name: string, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
  }

  function handleBlur(name: string) {
    setTouched((t) => ({ ...t, [name]: true }));
  }

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(buildScaffoldPrompt(skill, values));
  }

  // Detect fields that warrant a textarea instead of a single-line input.
  // Heuristics:
  //   - structured shapes (object/array)
  //   - description hints at multi-line prose (`paragraph`, `describing`,
  //     `free-form context`, `motivation`)
  //   - any input field literally named `description` (the most common
  //     long-form field — caught the dev-add-change friction)
  function isMultiline(def: InputField, name?: string): boolean {
    if (def.type === 'object' || def.type === 'array') return true;
    if (name === 'description') return true;
    const d = def.description?.toLowerCase() ?? '';
    return (
      d.includes('paragraph') ||
      d.includes('describing') ||
      d.includes('free-form') ||
      d.includes('motivation')
    );
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal scaffold-form" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title ?? `Run ${skill.name}`}</h3>
          <button className="close" onClick={onCancel}>
            ×
          </button>
        </header>

        <section>
          <label>Skill</label>
          <p className="muted" style={{ margin: 0 }}>
            <code>{skill.name}</code> — {skill.description ?? '(no description)'}
          </p>
        </section>

        {skill.parseError && (
          <section className="banner-section">
            <div className="banner warn">
              <strong>Frontmatter parse error:</strong>
              <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>
                {skill.parseError}
              </pre>
              <p style={{ margin: '6px 0 0' }} className="muted">
                The skill's inputs schema couldn't be loaded. Fix the YAML frontmatter in{' '}
                <code>.claude/skills/{skill.name}/SKILL.md</code> and reload.
              </p>
            </div>
          </section>
        )}

        <section className="form-fields">
          {!skill.parseError && fields.length === 0 && (
            <p className="muted">This skill takes no inputs.</p>
          )}
          {fields.map(([name, def]) => {
            const showErr = touched[name] && errors[name];
            // Picker mode selection (in priority order):
            //   - field has `enum` → strict select
            //   - field is `repo` + manifest loaded → repo entity picker
            //     with "+ Ingest new repo" hint when empty
            //   - field is `project` + manifest loaded → project entity picker
            //   - multiline-looking field → textarea
            //   - else → text input
            const isEnum = Array.isArray(def.enum) && def.enum.length > 0;
            const isRepoPicker = name === 'repo' && repoOptions !== null;
            const isProjectPicker = name === 'project' && projectOptions !== null;
            return (
              <div className="form-field" key={name}>
                <label>
                  {name}
                  {def.required && <span className="required">*</span>}
                </label>
                {def.description && <p className="hint">{def.description}</p>}

                {isEnum ? (
                  <select
                    value={values[name] ?? ''}
                    onChange={(e) => handleChange(name, e.target.value)}
                    onBlur={() => handleBlur(name)}
                  >
                    {!def.required && <option value="">(unset)</option>}
                    {def.required && !values[name] && (
                      <option value="" disabled>
                        — choose —
                      </option>
                    )}
                    {def.enum?.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : isRepoPicker ? (
                  <>
                    <select
                      value={values[name] ?? ''}
                      onChange={(e) => handleChange(name, e.target.value)}
                      onBlur={() => handleBlur(name)}
                    >
                      {!def.required && <option value="">(unset)</option>}
                      {def.required && !values[name] && (
                        <option value="" disabled>
                          — choose a repo —
                        </option>
                      )}
                      {repoOptions?.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.id}
                          {opt.title !== opt.id ? ` — ${opt.title}` : ''}
                        </option>
                      ))}
                    </select>
                    {onIngestRepo && (
                      <button
                        type="button"
                        className="link-button"
                        style={{ padding: 0, marginTop: 6, textAlign: 'left' }}
                        onClick={onIngestRepo}
                      >
                        Repo not listed? Ingest one →
                      </button>
                    )}
                    {repoOptions?.length === 0 &&
                      (onIngestRepo ? (
                        <p className="hint muted" style={{ marginTop: 6 }}>
                          Or via CLI: <code>/os ingest repo &lt;owner/repo&gt;</code>
                        </p>
                      ) : (
                        <p className="hint" style={{ color: 'var(--warn-text)', marginTop: 6 }}>
                          No repo entities found. Run{' '}
                          <code>/os ingest repo &lt;owner/repo&gt;</code> via CLI to add one, or use
                          the Overview app's Action Items panel after the action item surfaces.
                        </p>
                      ))}
                  </>
                ) : isProjectPicker ? (
                  <select
                    value={values[name] ?? ''}
                    onChange={(e) => handleChange(name, e.target.value)}
                    onBlur={() => handleBlur(name)}
                  >
                    {!def.required && <option value="">(none)</option>}
                    {def.required && !values[name] && (
                      <option value="" disabled>
                        — choose a project —
                      </option>
                    )}
                    {projectOptions?.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.id}
                        {opt.title !== opt.id ? ` — ${opt.title}` : ''}
                      </option>
                    ))}
                  </select>
                ) : isMultiline(def, name) ? (
                  <textarea
                    rows={5}
                    value={values[name] ?? ''}
                    onChange={(e) => handleChange(name, e.target.value)}
                    onBlur={() => handleBlur(name)}
                  />
                ) : (
                  <input
                    type="text"
                    value={values[name] ?? ''}
                    onChange={(e) => handleChange(name, e.target.value)}
                    onBlur={() => handleBlur(name)}
                  />
                )}
                {showErr && <p className="err">{errors[name]}</p>}
              </div>
            );
          })}
        </section>

        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!canSubmit} onClick={handleSubmit}>
            Run
          </button>
        </footer>
      </div>
    </div>
  );
}
