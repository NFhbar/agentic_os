// /api/settings — per-install Claude Code settings surface for the dashboard.
//
// Reads both layers of the project's .claude settings:
//
//   .claude/settings.json        — team baseline, git-tracked, ships with OS
//   .claude/settings.local.json  — per-install override, gitignored
//
// Writes only land in settings.local.json so the team baseline stays clean
// and each install can tune its own effort/preferences without conflicts.
//
// Also scans .claude/skills/*/SKILL.md for per-skill `effort:` frontmatter
// values so the dashboard can show which skills opt up/down from the project
// default. PUT /api/settings/skills/:skill/effort surgically edits the
// frontmatter — these files ARE git-tracked, so per-skill effort changes
// propagate to the team via commit. The team-tracked aspect is surfaced
// in the UI so users know the write hits a shared file.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';

// Effort levels accepted by Claude Code. `low` < `medium` < `high` < `xhigh`
// < `max`. `xhigh` requires Opus 4.7/4.8; older models silently fall back
// to `high`. We don't enforce the model gate here — just keep the value
// well-formed.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = (typeof EFFORT_LEVELS)[number];

function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

const SETTINGS_PROJECT_PATH = join(REPO_ROOT, '.claude', 'settings.json');
const SETTINGS_LOCAL_PATH = join(REPO_ROOT, '.claude', 'settings.local.json');
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

interface SettingsLayer {
  path: string;
  exists: boolean;
  parsed: Record<string, unknown> | null;
  parse_error: string | null;
}

interface SkillEffortRow {
  name: string;
  // The skill's explicit `effort:` frontmatter value. null when the field is
  // absent — the skill then inherits the project-wide effort. The dispatch
  // resolver only sees this field; `recommended_effort` is UI-only metadata.
  effort: EffortLevel | null;
  // Optional `recommended_effort:` frontmatter value — pure metadata for the
  // dashboard's Settings UI to surface as a suggestion. Does NOT affect the
  // dispatch path. When present and != current effective effort, the UI shows
  // an "apply" action that copies this value into the skill's `effort:` field
  // via the standard PUT /api/settings/skills/:skill/effort endpoint.
  recommended_effort: EffortLevel | null;
}

interface SettingsResponse {
  project: SettingsLayer;
  local: SettingsLayer;
  effective_effort: EffortLevel | null;
  effort_source: 'local' | 'project' | 'unset';
  skills: SkillEffortRow[];
  effort_levels: typeof EFFORT_LEVELS;
}

async function readJsonLayer(path: string): Promise<SettingsLayer> {
  try {
    const text = await readFile(path, 'utf8');
    try {
      const parsed = JSON.parse(text);
      return { path, exists: true, parsed, parse_error: null };
    } catch (e) {
      return {
        path,
        exists: true,
        parsed: null,
        parse_error: e instanceof Error ? e.message : String(e),
      };
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { path, exists: false, parsed: null, parse_error: null };
    }
    return {
      path,
      exists: false,
      parsed: null,
      parse_error: e instanceof Error ? e.message : String(e),
    };
  }
}

function extractEffort(layer: SettingsLayer): EffortLevel | null {
  if (!layer.parsed) return null;
  const v = (layer.parsed as Record<string, unknown>).effortLevel;
  return isEffortLevel(v) ? v : null;
}

async function scanSkillEfforts(): Promise<SkillEffortRow[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return [];
  }
  const rows: SkillEffortRow[] = [];
  await Promise.all(
    entries.map(async (name) => {
      const path = join(SKILLS_DIR, name, 'SKILL.md');
      try {
        const text = await readFile(path, 'utf8');
        const { fm } = parseFrontmatter(text);
        const effort = isEffortLevel(fm.effort) ? fm.effort : null;
        const recommended_effort = isEffortLevel(fm.recommended_effort)
          ? fm.recommended_effort
          : null;
        rows.push({ name, effort, recommended_effort });
      } catch {
        // Directory entries without SKILL.md are skipped silently —
        // some directories under skills/ aren't actual skills (placeholders,
        // README, etc.).
      }
    }),
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (): Promise<SettingsResponse> => {
    const [project, local, skills] = await Promise.all([
      readJsonLayer(SETTINGS_PROJECT_PATH),
      readJsonLayer(SETTINGS_LOCAL_PATH),
      scanSkillEfforts(),
    ]);
    const localEffort = extractEffort(local);
    const projectEffort = extractEffort(project);
    const effective = localEffort ?? projectEffort;
    const source: SettingsResponse['effort_source'] = localEffort
      ? 'local'
      : projectEffort
        ? 'project'
        : 'unset';
    return {
      project,
      local,
      effective_effort: effective,
      effort_source: source,
      skills,
      effort_levels: EFFORT_LEVELS,
    };
  });

  // PUT /effort — set the per-install effort level. Always writes to
  // settings.local.json; never modifies the team-tracked settings.json.
  // Refuses to clobber a settings.local.json that exists but parses as
  // invalid JSON — the user has something there we shouldn't lose.
  fastify.put<{ Body: { effortLevel: EffortLevel | null } }>('/effort', async (req, reply) => {
    const body = req.body ?? ({} as { effortLevel: EffortLevel | null });
    const next = body.effortLevel;
    if (next !== null && !isEffortLevel(next)) {
      return reply.code(400).send({
        ok: false,
        error: `effortLevel must be one of ${EFFORT_LEVELS.join(' / ')} or null`,
      });
    }

    // Read existing local settings (if any). Merge — we touch only the
    // effortLevel key, leaving every other user preference alone.
    let existing: Record<string, unknown> = {};
    try {
      const text = await readFile(SETTINGS_LOCAL_PATH, 'utf8');
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch (e) {
        return reply.code(409).send({
          ok: false,
          error: `existing settings.local.json is not valid JSON — refusing to overwrite. Fix or remove it first. (${e instanceof Error ? e.message : String(e)})`,
        });
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        return reply.code(500).send({
          ok: false,
          error: `failed to read settings.local.json: ${err.message}`,
        });
      }
    }

    // null → strip the key (rebuild without it). Anything else → set it.
    const merged: Record<string, unknown> =
      next === null
        ? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== 'effortLevel'))
        : { ...existing, effortLevel: next };

    await mkdir(dirname(SETTINGS_LOCAL_PATH), { recursive: true });
    await writeFile(SETTINGS_LOCAL_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

    return { ok: true, effortLevel: next };
  });

  // PUT /skills/:skill/effort — surgically edit a single skill's SKILL.md
  // frontmatter `effort:` field. Three cases:
  //   - field exists, new value → replace the line
  //   - field missing, new value → insert before frontmatter close
  //   - new value is null → remove the line (revert to project default)
  // Refuses to touch a SKILL.md whose frontmatter fails to parse, so a
  // typo'd file isn't worsened by automated edits.
  fastify.put<{
    Params: { skill: string };
    Body: { effortLevel: EffortLevel | null };
  }>('/skills/:skill/effort', async (req, reply) => {
    const { skill } = req.params;
    const next = req.body?.effortLevel ?? null;
    if (next !== null && !isEffortLevel(next)) {
      return reply.code(400).send({
        ok: false,
        error: `effortLevel must be one of ${EFFORT_LEVELS.join(' / ')} or null`,
      });
    }
    if (!/^[a-z][a-z0-9-]*$/.test(skill)) {
      return reply.code(400).send({ ok: false, error: 'invalid skill name' });
    }

    const path = join(SKILLS_DIR, skill, 'SKILL.md');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return reply.code(404).send({ ok: false, error: `skill not found: ${skill}` });
    }

    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) {
      return reply.code(409).send({
        ok: false,
        error: `${skill}/SKILL.md has no parseable frontmatter`,
      });
    }
    const { parseError } = parseFrontmatter(text);
    if (parseError) {
      return reply.code(409).send({
        ok: false,
        error: `${skill}/SKILL.md frontmatter has a parse error — refusing to edit: ${parseError}`,
      });
    }

    let fmText = m[1];
    const body = m[2];
    const effortLineRe = /^effort:\s*\S+\s*$/m;

    if (next === null) {
      // Strip the effort: line (and any trailing blank that would be left)
      fmText = fmText.replace(/^effort:\s*\S+\s*\n?/m, '').trimEnd();
    } else if (effortLineRe.test(fmText)) {
      fmText = fmText.replace(effortLineRe, `effort: ${next}`);
    } else {
      // Append before the closing fence — guarantees a newline before our line.
      fmText = `${fmText.trimEnd()}\neffort: ${next}`;
    }

    const updated = `---\n${fmText}\n---\n${body}`;
    if (updated === text) {
      return { ok: true, effortLevel: next, unchanged: true };
    }
    await writeFile(path, updated, 'utf8');
    return { ok: true, effortLevel: next };
  });
};
