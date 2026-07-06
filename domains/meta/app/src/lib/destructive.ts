// Prompt builders for rename/delete operations. Dashboard already collects
// confirmation, so prompts include "execute directly without entering plan
// mode" to keep the meta-* skills out of interactive plan flows.

export type TargetType = 'skill' | 'domain' | 'wiki-entry';

export function buildRenamePrompt(
  targetType: TargetType,
  targetPath: string,
  newName: string,
): string {
  return [
    'The user has confirmed a rename from the OS dashboard.',
    'Read .claude/skills/meta-rename/SKILL.md and execute its Procedure.',
    'Do NOT enter plan mode — the dashboard has already obtained user approval.',
    '',
    'Inputs:',
    `- target_type: ${JSON.stringify(targetType)}`,
    `- target_path: ${JSON.stringify(targetPath)}`,
    `- new_name: ${JSON.stringify(newName)}`,
    '',
    'Report what was renamed and which cross-references were updated.',
  ].join('\n');
}

export function buildDeletePrompt(targetType: TargetType, targetPath: string): string {
  return [
    'The user has confirmed a deletion from the OS dashboard (type-to-match passed).',
    'Read .claude/skills/meta-delete/SKILL.md and execute its Procedure.',
    'Do NOT enter plan mode — the dashboard has already obtained user approval.',
    '',
    'Inputs:',
    `- target_type: ${JSON.stringify(targetType)}`,
    `- target_path: ${JSON.stringify(targetPath)}`,
    '',
    'Report what was removed and any dangling cross-references that remain.',
  ].join('\n');
}

// Prompt builder for project closure (complete / abandon). The dashboard has
// already confirmed the action; the skill runs its owned-work disposition gate.
// `complete` defaults to refusal-first (disposition_default: block) so open
// recommendations/notes surface instead of being silently archived; `abandon`
// opts into disposition_default: abandon with an operator-supplied rationale so
// a deliberate abandon-all closes cleanly with zero dangling queue items.
//
// The mode/rationale dependency is encoded in the overloads: `abandon` requires
// a rationale (an empty one downgrades every abandon disposition to `block` in
// the skill, so the dispatch would be a guaranteed refusal), while `complete`
// takes none. This keeps a second caller from shipping the dead abandon-without-
// rationale path.
export function buildCloseProjectPrompt(projectId: string, mode: 'complete'): string;
export function buildCloseProjectPrompt(
  projectId: string,
  mode: 'abandon',
  rationale: string,
): string;
export function buildCloseProjectPrompt(
  projectId: string,
  mode: 'complete' | 'abandon',
  rationale?: string,
): string {
  const verb = mode === 'complete' ? 'completing' : 'abandoning';
  const lines = [
    `The user has confirmed ${verb} project ${projectId} from the OS dashboard.`,
    'Read .claude/skills/meta-close-project/SKILL.md and execute its Procedure.',
    'Do NOT enter plan mode / do NOT use interactive prompts — the dashboard has already obtained user approval.',
    '',
    'Inputs:',
    `- project: ${JSON.stringify(projectId)}`,
    `- mode: ${JSON.stringify(mode)}`,
  ];
  if (mode === 'abandon') {
    lines.push('- disposition_default: "abandon"');
    lines.push(`- rationale: ${JSON.stringify(rationale ?? '')}`);
  } else {
    lines.push('- disposition_default: "block"');
  }
  lines.push('');
  lines.push(
    'If open items lack dispositions, refuse with the itemized list; report what was closed and every disposition applied.',
  );
  return lines.join('\n');
}

// Helper: extract the last path segment (for showing in confirm prompts and as default for rename).
export function lastSegment(path: string): string {
  const parts = path
    .replace(/\/SKILL\.md$/, '')
    .replace(/\.md$/, '')
    .split('/');
  return parts[parts.length - 1] ?? path;
}
