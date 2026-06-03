// Skills — split-pane list + SKILL.md editor. Migrated to apps/ + restyled
// header chrome (h1 + .btn + Icons). Split-pane and picker structure preserved.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ConfirmModal } from '../../components/ConfirmModal';
import { EditableMarkdown } from '../../components/EditableMarkdown';
import { RenameModal } from '../../components/RenameModal';
import { ResizeHandle } from '../../components/ResizeHandle';
import { ScaffoldForm } from '../../components/ScaffoldForm';
import { buildDeletePrompt, buildRenamePrompt } from '../../lib/destructive';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { useNavigation } from '../../lib/navigation';
import { type SkillSummary, fetchSkills, findSkill } from '../../lib/skills';
import { useResizable } from '../../lib/useResizable';
import { fetchEntry } from '../../lib/vault';
import { Icons } from '../../shared';
import '../../shared/styles.css';

type Destructive = { kind: 'rename'; current: string } | { kind: 'delete'; current: string };

const COLLAPSED_GROUPS_KEY = 'agentic-os/collapsed-skill-groups';
const UNGROUPED_LABEL = '(no domain)';

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    /* unavailable */
  }
  return new Set();
}

function compareGroups(a: string, b: string): number {
  if (a === UNGROUPED_LABEL) return 1;
  if (b === UNGROUPED_LABEL) return -1;
  if (a === 'meta') return -1;
  if (b === 'meta') return 1;
  return a.localeCompare(b);
}

export default function Skills() {
  const nav = useNavigation();
  const picker = useResizable({
    storageKey: 'skills-picker',
    defaultWidth: 280,
    min: 180,
    max: 560,
  });
  const [list, setList] = useState<SkillSummary[]>([]);
  // URL-backed selection: /skills/<name> selects that skill, /skills selects
  // none (falls back to first skill on load).
  const navigate = useNavigate();
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const selected: string | null = splat.length > 0 ? splat : null;
  const setSelected = useCallback(
    (name: string | null) => {
      navigate(name ? `/skills/${name}` : '/skills');
    },
    [navigate],
  );
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsedGroups());

  const [addSkill, setAddSkill] = useState<SkillSummary | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [destructive, setDestructive] = useState<Destructive | null>(null);
  const { startSkillRun } = useDispatch();

  async function dispatch(prompt: string, title: string, skill: string) {
    const res = await startSkillRun(prompt, title, { skill, domain: 'meta' });
    if ('blocked' in res && res.blocked) {
      alert(
        `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id})`,
      );
    } else if ('error' in res && res.error) {
      alert(`Dispatch failed: ${res.error}`);
    }
  }

  // Refresh the skills list whenever any meta-* run terminates — rename /
  // delete / add-skill change the on-disk skill set.
  useRunTerminal({ domain: 'meta' }, () => {
    setSelected(null);
    refreshList();
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups]));
    } catch {
      /* unavailable */
    }
  }, [collapsedGroups]);

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const grouped = useMemo(() => {
    const map = new Map<string, SkillSummary[]>();
    for (const s of list) {
      const key = s.domain ?? UNGROUPED_LABEL;
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(s);
    }
    return [...map.entries()].sort(([a], [b]) => compareGroups(a, b));
  }, [list]);

  const refreshList = useCallback(async () => {
    const data = await fetchSkills(true);
    const sorted = [...data.skills].sort((a, b) => a.name.localeCompare(b.name));
    setList(sorted);
    if (sorted.length && !selected) setSelected(sorted[0].name);
  }, [selected]);

  useEffect(() => {
    refreshList();
    // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  }, []);

  // URL routing drives selection now (App.tsx's navigateToSkill navigates to
  // /skills/<name> directly). The targetSkillName signal still exists as the
  // legacy NavigationContext field; clear it here once we've observed it so
  // it doesn't linger across navigations.
  useEffect(() => {
    if (nav.targetSkillName) nav.clearTargetSkill();
  }, [nav.targetSkillName, nav.clearTargetSkill]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetchEntry(`.claude/skills/${selected}/SKILL.md`)
      .then((e) => setContent(e.content))
      .catch(() => setContent('(skill not found)'))
      .finally(() => setLoading(false));
  }, [selected]);

  async function openAddForm() {
    const skill = await findSkill('meta-add-skill');
    if (!skill) {
      alert('meta-add-skill skill not found in .claude/skills/');
      return;
    }
    setAddSkill(skill);
    setShowForm(true);
  }

  function runRename(newName: string) {
    if (!selected) return;
    dispatch(
      buildRenamePrompt('skill', `.claude/skills/${selected}`, newName),
      `Renaming ${selected} → ${newName}…`,
      'meta-rename',
    );
    setDestructive(null);
  }

  function runDelete() {
    if (!selected) return;
    dispatch(
      buildDeletePrompt('skill', `.claude/skills/${selected}`),
      `Deleting ${selected}…`,
      'meta-delete',
    );
    setDestructive(null);
  }

  return (
    <div
      className="view skills"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">Skills</h1>
        <span className="tiny">{list.length} total</span>
        {selected && <span className="badge muted">{selected}</span>}
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={openAddForm}>
          <Icons.Plus size={13} /> New Skill
        </button>
      </header>

      <div
        className="split"
        style={{ gridTemplateColumns: `${picker.width}px 1fr`, flex: 1, minHeight: 0 }}
      >
        <div className="picker-column">
          <ul className="picker tall grouped">
            {grouped.map(([group, skills]) => {
              const isCollapsed = collapsedGroups.has(group);
              return (
                <li key={group} className="skill-group">
                  <button
                    type="button"
                    className="skill-group-header"
                    onClick={() => toggleGroup(group)}
                    title={isCollapsed ? 'Expand group' : 'Collapse group'}
                  >
                    <span className="tree-chevron-inline">{isCollapsed ? '▶' : '▼'}</span>
                    <span className="skill-group-label">{group}</span>
                    <span className="skill-group-count">{skills.length}</span>
                  </button>
                  {!isCollapsed && (
                    <ul className="skill-group-items">
                      {skills.map((s) => (
                        <li key={s.name}>
                          <button
                            type="button"
                            className={s.name === selected ? 'active' : ''}
                            onClick={() => setSelected(s.name)}
                          >
                            <div className="row1">
                              <span className="name">{s.name}</span>
                            </div>
                            {s.description && <div className="desc">{s.description}</div>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <ResizeHandle onMouseDown={picker.startDrag} />
        </div>
        <div className="detail">
          {loading ? (
            <em className="subtle">loading…</em>
          ) : selected ? (
            <>
              <div
                className="detail-toolbar"
                style={{
                  display: 'flex',
                  gap: 6,
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setDestructive({ kind: 'rename', current: selected })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setDestructive({ kind: 'delete', current: selected })}
                >
                  <Icons.Trash size={11} /> Delete
                </button>
              </div>
              <EditableMarkdown
                path={`.claude/skills/${selected}/SKILL.md`}
                content={content}
                onSaved={setContent}
              />
            </>
          ) : (
            <p className="subtle">Pick a skill.</p>
          )}
        </div>
      </div>

      {showForm && addSkill && (
        <ScaffoldForm
          skill={addSkill}
          title="Add Skill"
          onCancel={() => setShowForm(false)}
          onSubmit={(prompt) => {
            setShowForm(false);
            dispatch(prompt, 'Adding skill…', 'meta-add-skill');
          }}
        />
      )}

      {destructive?.kind === 'rename' && (
        <RenameModal
          title={`Rename skill ${destructive.current}`}
          currentName={destructive.current}
          targetPath={`.claude/skills/${destructive.current}`}
          taken={list.map((s) => s.name)}
          onCancel={() => setDestructive(null)}
          onConfirm={runRename}
        />
      )}

      {destructive?.kind === 'delete' && (
        <ConfirmModal
          title={`Delete skill ${destructive.current}?`}
          message={
            <>
              <p>
                This will permanently delete <code>.claude/skills/{destructive.current}/</code> and
                clean up references in OS.md and the owning domain's playbook.
              </p>
              <p className="subtle">
                Other skills that reference this in their <code>spawns:</code> array will also be
                updated.
              </p>
            </>
          }
          requireType={destructive.current}
          confirmLabel="Delete"
          destructive
          onCancel={() => setDestructive(null)}
          onConfirm={runDelete}
        />
      )}

    </div>
  );
}
