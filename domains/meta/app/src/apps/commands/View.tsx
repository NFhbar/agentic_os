// Commands — /os intent vocabulary view. Migrated to apps/ + restyled with
// the prototype design system: .page wrapper, .card per domain, .table for
// command rows, .badge for drift count, .mono for intent codes.

import React, { useEffect, useMemo, useState } from 'react';
import { getJson } from '../../lib/api';
import { useNavigation } from '../../lib/navigation';
import { type SkillSummary, fetchSkills } from '../../lib/skills';
import '../../shared/styles.css';

interface VocabRow {
  intents: string[];
  skill: string;
}

interface CommandsData {
  vocabulary: VocabRow[];
}

interface JoinedRow extends VocabRow {
  description: string | null;
  domain: string | null;
}

export default function Commands() {
  const nav = useNavigation();
  const [vocab, setVocab] = useState<VocabRow[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getJson<CommandsData>('/api/commands').catch(() => ({ vocabulary: [] as VocabRow[] })),
      fetchSkills(true),
    ]).then(([cmds, sk]) => {
      setVocab(cmds.vocabulary);
      setSkills(sk.skills);
      setLoading(false);
    });
  }, []);

  const skillByName = useMemo(() => {
    const m = new Map<string, SkillSummary>();
    for (const s of skills) m.set(s.name, s);
    return m;
  }, [skills]);

  const { byDomain, broken, orphans, parseFails } = useMemo(() => {
    const byDomain: Record<string, JoinedRow[]> = {};
    const broken: VocabRow[] = [];
    const vocabSkillNames = new Set<string>();

    for (const v of vocab) {
      vocabSkillNames.add(v.skill);
      const sd = skillByName.get(v.skill);
      if (!sd) {
        broken.push(v);
        continue;
      }
      const domain = sd.domain ?? '(no domain)';
      const row: JoinedRow = { ...v, description: sd.description, domain };
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(row);
    }

    const orphans = skills.filter(
      (s) => !vocabSkillNames.has(s.name) && s.name !== 'os' && !s.parseError,
    );
    const parseFails = skills.filter((s) => s.parseError);
    return { byDomain, broken, orphans, parseFails };
  }, [vocab, skills, skillByName]);

  if (loading) {
    return (
      <div className="page">
        <p className="subtle">Loading…</p>
      </div>
    );
  }

  const totalCommands = vocab.length;
  const domains = Object.keys(byDomain).sort();
  const driftCount = broken.length + orphans.length + parseFails.length;

  return (
    <div className="page">
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
        <h1 className="h1">Commands</h1>
        <span className="spacer" />
        <span className="tiny">
          <strong style={{ color: 'var(--text)' }}>{totalCommands}</strong> commands across{' '}
          <strong style={{ color: 'var(--text)' }}>{domains.length}</strong>{' '}
          {domains.length === 1 ? 'domain' : 'domains'}
        </span>
        {driftCount > 0 && (
          <span className="badge warning">
            <span className="badge-dot" />
            {driftCount} drift
          </span>
        )}
      </header>

      <p className="subtle" style={{ marginBottom: 18 }}>
        Dispatched via <span className="mono">/os &lt;intent&gt;</span>. The router reads the intent
        vocabulary in <span className="mono">OS.md</span> and routes to the matching skill. This
        view re-parses the vocabulary and the skill list on every load — adding a skill + vocabulary
        row makes the command appear here automatically.
      </p>

      {domains.map((domain) => (
        <div key={domain} className="card" style={{ marginBottom: 14 }}>
          <div className="card-header">
            <h3 className="card-title">{domain}</h3>
            <span className="tiny">{byDomain[domain].length} commands</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '38%' }}>Intent triggers</th>
                <th style={{ width: '20%' }}>Skill</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {byDomain[domain].map((r) => (
                <tr key={r.skill}>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {r.intents.map((intent) => (
                        <span key={intent} className="kbd">
                          /os {intent}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => nav.navigateToSkill(r.skill)}
                      title={`Open ${r.skill} in Skills view`}
                    >
                      {r.skill}
                    </button>
                  </td>
                  <td>{r.description ?? <em className="tiny">(no description)</em>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {driftCount > 0 && (
        <div
          className="card"
          style={{ borderColor: 'color-mix(in oklab, var(--warning) 30%, var(--border))' }}
        >
          <div className="card-header" style={{ background: 'var(--warning-soft)' }}>
            <h3 className="card-title">Drift</h3>
            <span className="badge warning">
              <span className="badge-dot" />
              {driftCount} issues
            </span>
          </div>
          <div className="card-body">
            {parseFails.length > 0 && (
              <section style={{ marginBottom: 18 }}>
                <h4 className="h3" style={{ marginBottom: 6 }}>
                  Skills with broken YAML frontmatter ({parseFails.length})
                </h4>
                <p className="tiny" style={{ marginBottom: 8 }}>
                  These skills exist on disk but their frontmatter can't be parsed — they won't
                  appear in forms or scaffolders. Fix the YAML and reload.
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {parseFails.map((s) => (
                    <li key={s.name} style={{ marginBottom: 4 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => nav.navigateToSkill(s.name)}
                      >
                        {s.name}
                      </button>
                      {s.parseError && (
                        <>
                          {' '}
                          —{' '}
                          <span className="mono tiny" style={{ color: 'var(--danger-text)' }}>
                            {s.parseError.split('\n')[0]}
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {broken.length > 0 && (
              <section style={{ marginBottom: 18 }}>
                <h4 className="h3" style={{ marginBottom: 6 }}>
                  Vocabulary rows pointing to skills not on disk ({broken.length})
                </h4>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {broken.map((r) => (
                    <li key={r.skill} style={{ marginBottom: 4 }}>
                      <span className="mono">{r.skill}</span> — intents:{' '}
                      {r.intents.map((i, idx) => (
                        <React.Fragment key={i}>
                          {idx > 0 && ', '}
                          <span className="kbd">/os {i}</span>
                        </React.Fragment>
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {orphans.length > 0 && (
              <section>
                <h4 className="h3" style={{ marginBottom: 6 }}>
                  Skills without a vocabulary row ({orphans.length})
                </h4>
                <p className="tiny" style={{ marginBottom: 8 }}>
                  These skills exist on disk but no <span className="mono">/os</span> intent matches
                  them. They can still be invoked directly (e.g.{' '}
                  <span className="mono">/&lt;skill-name&gt;</span>).
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {orphans.map((s) => (
                    <li key={s.name} style={{ marginBottom: 4 }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => nav.navigateToSkill(s.name)}
                      >
                        {s.name}
                      </button>
                      {s.description && <> — {s.description}</>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
