// Ops → New protocol. A dedicated screen at /ops/new, not a modal: the form
// carries a dozen fields including several multi-line ones, which is exactly
// the shape that needs page real estate, a real URL, and a back button.
//
// The form itself is generated from the ops-add-protocol skill's own `inputs:`
// schema via ScaffoldForm's inline mode, so the screen can never drift from the
// skill it dispatches — adding an input to the skill adds a field here.

import { ScaffoldForm } from '../../../components/ScaffoldForm';
import type { SkillSummary } from '../../../lib/skills';
import { Empty, Icons } from '../../../shared';

export interface NewProtocolPageProps {
  // null while the skill definition is still loading, or when it couldn't be
  // found on disk at all.
  skill: SkillSummary | null;
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
}

export function NewProtocolPage({ skill, onSubmit, onCancel }: NewProtocolPageProps) {
  if (!skill) {
    return (
      <div className="page">
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          ← Ops
        </button>
        <Empty
          title="Loading the protocol scaffolder…"
          hint="If this persists, .claude/skills/ops-add-protocol/SKILL.md is missing or its frontmatter doesn't parse."
          icon={<Icons.Flag size={24} />}
        />
      </div>
    );
  }

  return (
    <ScaffoldForm
      inline
      skill={skill}
      title="New review protocol"
      backLabel="Ops"
      submitLabel="Create protocol"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
