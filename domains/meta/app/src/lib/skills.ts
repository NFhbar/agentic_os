// Shared types + helpers for skills, matching the /api/skills response shape.

import { getJson } from './api';

export interface InputField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  pattern?: string;
  description?: string;
  default?: unknown;
  // Strict-enum field — the form renders a select instead of a free-text
  // input. Already exposed by the /api/skills endpoint; just typed here so
  // the React form can use it without a cast.
  enum?: string[];
}

export interface SkillSummary {
  name: string;
  description: string | null;
  domain: string | null;
  version: number | null;
  tags: string[];
  inputs: Record<string, InputField>;
  userInvocable: boolean;
  modified: string;
  // YAML parse error message if the SKILL.md frontmatter couldn't be parsed.
  // When non-null, `description`, `inputs` etc. will be falsy/empty.
  parseError: string | null;
}

interface SkillsData {
  skills: SkillSummary[];
}

let cache: Promise<SkillsData> | null = null;

export function fetchSkills(force = false): Promise<SkillsData> {
  if (force || !cache) {
    cache = getJson<SkillsData>('/api/skills');
  }
  return cache;
}

export async function findSkill(name: string): Promise<SkillSummary | null> {
  const data = await fetchSkills();
  return data.skills.find((s) => s.name === name) ?? null;
}

// Returns the set of all skill names. Used by EditableMarkdown to resolve
// wikilinks polymorphically — [[name]] navigates to the Skills view when
// `name` is a skill, otherwise to the Vault view.
export async function fetchSkillNames(): Promise<Set<string>> {
  const data = await fetchSkills();
  return new Set(data.skills.map((s) => s.name));
}

// Build the prompt sent to `claude -p` when the dashboard submits a scaffold form.
export function buildScaffoldPrompt(skill: SkillSummary, values: Record<string, string>): string {
  const lines = [
    `The user is invoking the ${skill.name} skill from the OS dashboard.`,
    '',
    `Skill location: .claude/skills/${skill.name}/SKILL.md`,
    'Read the skill and follow its Procedure exactly with the inputs below.',
    'Report success and any errors. Do not skip steps.',
    'Do NOT use AskUserQuestion — run non-interactively; where the Procedure offers an interactive choice, take its documented headless fallback or a conservative default and record the decision in your report.',
    '',
    'Inputs:',
  ];
  for (const [name, def] of Object.entries(skill.inputs)) {
    const v = values[name];
    if (v !== undefined && v !== '') {
      lines.push(`- ${name}: ${JSON.stringify(v)}`);
    } else if (def.default !== undefined) {
      lines.push(`- ${name}: ${JSON.stringify(def.default)} (default)`);
    }
  }
  return lines.join('\n');
}
