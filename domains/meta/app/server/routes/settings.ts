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
// Two axes are exposed: effort (`low|medium|high|xhigh|max`) and model
// (Claude model id from scripts/models-registry.mjs). Both follow the same
// resolution chain: per-skill frontmatter > settings.local.json > settings.json
// > Claude Code default. Both can be set per-skill via SKILL.md frontmatter
// (`effort:` and `model:`); both surface optional `recommended_effort:` /
// `recommended_model:` metadata that the UI uses for guidance without
// affecting dispatch.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
// @ts-expect-error — .mjs import from JS module; type-checked via JSDoc
import { WALL_CAP_CEILING_MINUTES } from '../../../../../scripts/dispatch-claude.mjs';
// @ts-expect-error — .mjs import from JS module; type-checked via JSDoc
import { resolveWallTimeCapMs } from '../../../../../scripts/dispatch-claude.mjs';
// @ts-expect-error — .mjs import from JS module; type-checked via JSDoc
import { MODELS } from '../../../../../scripts/models-registry.mjs';
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

// Valid model ids come from the models registry. Accept the canonical id
// plus the optional `[<context-window>]` suffix variant (e.g.
// `claude-opus-4-7[1m]`) the OS uses to flag 1M-context invocations. The
// registry's `pricingFor()` already does that suffix-strip; we mirror its
// validation rule here so the Settings PUT endpoints can validate inputs.
interface RegistryModel {
  id: string;
  family: string;
  latest: boolean;
  aliases?: string;
}
function isValidModel(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0) return false;
  const normalized = v.replace(/\[[^\]]+\]$/, '');
  return (MODELS as RegistryModel[]).some(
    (m) => m.id === normalized || m.aliases?.split(',').includes(normalized),
  );
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

interface SkillConfigRow {
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
  // Model-side parallels of the effort fields. `model:` is the per-skill
  // override that dispatch reads; `recommended_model:` is UI-only guidance
  // that the Settings → Model tab surfaces as ↑ apply / ↓ apply actions.
  model: string | null;
  recommended_model: string | null;
  // Wall-time cap: explicit `wall_time_cap_minutes:` frontmatter (null =
  // none) and the resolved effective cap the watchdog/supervisor will
  // actually enforce (frontmatter > 2×p95 duration history > 25m floor).
  wall_time_cap_minutes: number | null;
  effective_wall_cap_minutes: number;
}

interface SettingsResponse {
  project: SettingsLayer;
  local: SettingsLayer;
  effective_effort: EffortLevel | null;
  effort_source: 'local' | 'project' | 'unset';
  // Parallel to effort_*: which model the resolver lands on at the project
  // tier (per-install > project > unset). null when neither layer sets `model`
  // — Claude Code's user-global default takes over.
  effective_model: string | null;
  model_source: 'local' | 'project' | 'unset';
  skills: SkillConfigRow[];
  effort_levels: typeof EFFORT_LEVELS;
  // The full models registry — id, family, pricing, latest flag, note. The
  // Settings UI's dropdowns consume this to render labels + group by family
  // without a separate /api/models fetch.
  models: RegistryModel[];
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

function extractModel(layer: SettingsLayer): string | null {
  if (!layer.parsed) return null;
  const v = (layer.parsed as Record<string, unknown>).model;
  return isValidModel(v) ? v : null;
}

// Read a single skill's relevant frontmatter fields. Used by the per-skill
// /resolved endpoint — separate from scanSkillConfigs which walks every skill.
async function readSkillFrontmatter(
  name: string,
): Promise<{ effort: EffortLevel | null; model: string | null; model_execute: string | null }> {
  try {
    const path = join(SKILLS_DIR, name, 'SKILL.md');
    const text = await readFile(path, 'utf8');
    const { fm } = parseFrontmatter(text);
    return {
      effort: isEffortLevel(fm.effort) ? fm.effort : null,
      model: isValidModel(fm.model) ? fm.model : null,
      model_execute: isValidModel(fm.model_execute) ? fm.model_execute : null,
    };
  } catch {
    return { effort: null, model: null, model_execute: null };
  }
}

async function scanSkillConfigs(): Promise<SkillConfigRow[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return [];
  }
  const rows: SkillConfigRow[] = [];
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
        const model = isValidModel(fm.model) ? fm.model : null;
        const recommended_model = isValidModel(fm.recommended_model) ? fm.recommended_model : null;
        const capRaw = fm.wall_time_cap_minutes;
        const capNum =
          typeof capRaw === 'number'
            ? capRaw
            : typeof capRaw === 'string' && /^\d+$/.test(capRaw)
              ? Number.parseInt(capRaw, 10)
              : null;
        const wall_time_cap_minutes = capNum && capNum > 0 ? capNum : null;
        const effective_wall_cap_minutes = Math.round(
          ((await resolveWallTimeCapMs(name)) as number) / 60000,
        );
        rows.push({
          name,
          effort,
          recommended_effort,
          model,
          recommended_model,
          wall_time_cap_minutes,
          effective_wall_cap_minutes,
        });
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
      scanSkillConfigs(),
    ]);
    const localEffort = extractEffort(local);
    const projectEffort = extractEffort(project);
    const effective_effort = localEffort ?? projectEffort;
    const effort_source: SettingsResponse['effort_source'] = localEffort
      ? 'local'
      : projectEffort
        ? 'project'
        : 'unset';
    const localModel = extractModel(local);
    const projectModel = extractModel(project);
    const effective_model = localModel ?? projectModel;
    const model_source: SettingsResponse['model_source'] = localModel
      ? 'local'
      : projectModel
        ? 'project'
        : 'unset';
    return {
      project,
      local,
      effective_effort,
      effort_source,
      effective_model,
      model_source,
      skills,
      effort_levels: EFFORT_LEVELS,
      models: MODELS as RegistryModel[],
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

  // PUT /skills/:skill/wall-cap — surgically edit a single skill's SKILL.md
  // `wall_time_cap_minutes:` field. Mirrors PUT /skills/:skill/effort: replace
  // / insert / strip (null reverts to the history-derived default). The
  // watchdog + supervisor resolve via dispatch-claude.mjs, so edits take
  // effect on the next spawn / supervision pass (10-minute resolver cache).
  fastify.put<{
    Params: { skill: string };
    Body: { wallCapMinutes: number | null };
  }>('/skills/:skill/wall-cap', async (req, reply) => {
    const { skill } = req.params;
    const next = req.body?.wallCapMinutes ?? null;
    if (
      next !== null &&
      (!Number.isInteger(next) || next < 1 || next > (WALL_CAP_CEILING_MINUTES as number))
    ) {
      return reply.code(400).send({
        ok: false,
        error: `wallCapMinutes must be an integer 1–${WALL_CAP_CEILING_MINUTES} or null`,
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
    const capLineRe = /^wall_time_cap_minutes:\s*\S+\s*$/m;

    if (next === null) {
      fmText = fmText.replace(/^wall_time_cap_minutes:\s*\S+\s*\n?/m, '').trimEnd();
    } else if (capLineRe.test(fmText)) {
      fmText = fmText.replace(capLineRe, `wall_time_cap_minutes: ${next}`);
    } else {
      fmText = `${fmText.trimEnd()}\nwall_time_cap_minutes: ${next}`;
    }

    const updated = `---\n${fmText}\n---\n${body}`;
    if (updated === text) {
      return { ok: true, wallCapMinutes: next, unchanged: true };
    }
    await writeFile(path, updated, 'utf8');
    return { ok: true, wallCapMinutes: next };
  });

  // PUT /model — set the per-install model. Mirrors PUT /effort exactly.
  // Writes only to settings.local.json (gitignored, per-install). The
  // team baseline in settings.json stays clean. Refuses to clobber malformed
  // JSON. Pass null to strip the key — dispatch falls back to project default
  // (or Claude Code's user-global default).
  fastify.put<{ Body: { model: string | null } }>('/model', async (req, reply) => {
    const body = req.body ?? ({} as { model: string | null });
    const next = body.model;
    if (next !== null && !isValidModel(next)) {
      return reply.code(400).send({
        ok: false,
        error: `model must be a known Claude id from scripts/models-registry.mjs (or null)`,
      });
    }

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

    const merged: Record<string, unknown> =
      next === null
        ? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== 'model'))
        : { ...existing, model: next };

    await mkdir(dirname(SETTINGS_LOCAL_PATH), { recursive: true });
    await writeFile(SETTINGS_LOCAL_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

    return { ok: true, model: next };
  });

  // GET /skills/:skill/resolved — return the resolver's verdict for a given
  // skill: which model + effort will actually be used when this skill is
  // dispatched, and which layer in the precedence chain supplied each value.
  // Powers UI surfaces that need to display "this skill will run with model X
  // because of layer Y" without duplicating the precedence logic client-side.
  //
  // Response shape:
  //   {
  //     skill: 'dev-pr-review',
  //     effort: { resolved: 'xhigh', source: 'local',
  //               layers: { skill: null, local: 'xhigh', project: 'high' } },
  //     model:  { resolved: 'claude-fable-5', source: 'skill',
  //               layers: { skill: 'claude-fable-5', local: null, project: null } }
  //   }
  //
  // `source: 'cli-default'` means no layer specified a value — dispatch will
  // omit the flag and Claude Code falls back to its user-global setting
  // (~/.claude/settings.json).
  fastify.get<{ Params: { skill: string } }>('/skills/:skill/resolved', async (req, reply) => {
    const { skill } = req.params;
    if (!/^[a-z][a-z0-9-]*$/.test(skill)) {
      return reply.code(400).send({ ok: false, error: 'invalid skill name' });
    }

    const [project, local, skillEntry] = await Promise.all([
      readJsonLayer(SETTINGS_PROJECT_PATH),
      readJsonLayer(SETTINGS_LOCAL_PATH),
      readSkillFrontmatter(skill),
    ]);

    const layers = {
      effort: {
        skill: skillEntry.effort,
        local: extractEffort(local),
        project: extractEffort(project),
      },
      model: {
        skill: skillEntry.model,
        local: extractModel(local),
        project: extractModel(project),
      },
    };

    const effortResolved =
      layers.effort.skill ?? layers.effort.local ?? layers.effort.project ?? null;
    const effortSource: 'skill' | 'local' | 'project' | 'cli-default' = layers.effort.skill
      ? 'skill'
      : layers.effort.local
        ? 'local'
        : layers.effort.project
          ? 'project'
          : 'cli-default';

    const modelResolved = layers.model.skill ?? layers.model.local ?? layers.model.project ?? null;
    const modelSource: 'skill' | 'local' | 'project' | 'cli-default' = layers.model.skill
      ? 'skill'
      : layers.model.local
        ? 'local'
        : layers.model.project
          ? 'project'
          : 'cli-default';

    return {
      skill,
      effort: { resolved: effortResolved, source: effortSource, layers: layers.effort },
      model: { resolved: modelResolved, source: modelSource, layers: layers.model },
      // Phase-aware override for dual-phase skills — skill-frontmatter-only
      // (no local/project layers, hence no {source, layers} object). Dispatch
      // consumes it only for EXECUTE-bound runs; see execute-phase.ts.
      model_execute: skillEntry.model_execute,
    };
  });

  // PUT /skills/:skill/model — surgically edit a single skill's SKILL.md
  // frontmatter `model:` field. Same three-case pattern as /skills/:skill/effort.
  fastify.put<{
    Params: { skill: string };
    Body: { model: string | null };
  }>('/skills/:skill/model', async (req, reply) => {
    const { skill } = req.params;
    const next = req.body?.model ?? null;
    if (next !== null && !isValidModel(next)) {
      return reply.code(400).send({
        ok: false,
        error: `model must be a known Claude id from scripts/models-registry.mjs (or null)`,
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
    const modelLineRe = /^model:\s*\S+\s*$/m;

    if (next === null) {
      fmText = fmText.replace(/^model:\s*\S+\s*\n?/m, '').trimEnd();
    } else if (modelLineRe.test(fmText)) {
      fmText = fmText.replace(modelLineRe, `model: ${next}`);
    } else {
      fmText = `${fmText.trimEnd()}\nmodel: ${next}`;
    }

    const updated = `---\n${fmText}\n---\n${body}`;
    if (updated === text) {
      return { ok: true, model: next, unchanged: true };
    }
    await writeFile(path, updated, 'utf8');
    return { ok: true, model: next };
  });
};
