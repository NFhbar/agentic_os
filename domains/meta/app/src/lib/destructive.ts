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

// Helper: extract the last path segment (for showing in confirm prompts and as default for rename).
export function lastSegment(path: string): string {
  const parts = path
    .replace(/\/SKILL\.md$/, '')
    .replace(/\.md$/, '')
    .split('/');
  return parts[parts.length - 1] ?? path;
}
