import { existsSync, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';

const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');

// A domain is any folder under domains/ that contains a playbook.md.
// Sub-domains are folders inside another domain that also have a playbook.md.
export interface DomainNode {
  name: string;
  path: string; // repo-relative, after `domains/`. e.g. "development/pr-review"
  children: DomainNode[];
}

async function hasPlaybook(absDir: string): Promise<boolean> {
  try {
    await access(join(absDir, 'playbook.md'));
    return true;
  } catch {
    return false;
  }
}

async function walkDomain(absDir: string, relPath: string, name: string): Promise<DomainNode> {
  const children: DomainNode[] = [];
  try {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      if (e.name === 'app') continue; // apps are not sub-domains
      const childAbs = join(absDir, e.name);
      const childRel = `${relPath}/${e.name}`;
      if (await hasPlaybook(childAbs)) {
        children.push(await walkDomain(childAbs, childRel, e.name));
      }
    }
  } catch {
    /* unreadable dir */
  }
  children.sort((a, b) => a.name.localeCompare(b.name));
  return { name, path: relPath, children };
}

// Walk vault/wiki/<domain>/ — counts entries by archetype, tallies
// in-flight changes/projects, returns the latest activity timestamp.
// Cheap enough to read on each request; the wiki is small.
interface DomainContent {
  entries_by_archetype: Record<string, number>;
  changes_by_status: Record<string, number>;
  projects_by_status: Record<string, number>;
  total_entries: number;
  latest_activity: string | null;
}

async function buildDomainContent(domainPath: string): Promise<DomainContent> {
  // domainPath is the same shape as the URL (`development` or
  // `development/pr-review`). We walk vault/wiki/<domainPath>/ for entries.
  const wikiRoot = join(REPO_ROOT, 'vault', 'wiki', domainPath);
  const content: DomainContent = {
    entries_by_archetype: {},
    changes_by_status: {},
    projects_by_status: {},
    total_entries: 0,
    latest_activity: null,
  };
  if (!existsSync(wikiRoot)) return content;

  async function walk(dir: string, archetype: string | null): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, archetype ?? e.name);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        let raw: string;
        try {
          raw = await readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const { fm, parseError } = parseFrontmatter(raw);
        if (parseError) continue;
        const arch = (typeof fm.type === 'string' && fm.type) || archetype || 'unknown';
        content.entries_by_archetype[arch] = (content.entries_by_archetype[arch] ?? 0) + 1;
        content.total_entries += 1;
        // js-yaml parses bare ISO timestamps as Date objects; coerce both
        // forms to a string so the comparison is sound.
        const updated: string | null =
          typeof fm.updated === 'string'
            ? fm.updated
            : fm.updated instanceof Date
              ? fm.updated.toISOString()
              : null;
        if (updated && (!content.latest_activity || updated > content.latest_activity)) {
          content.latest_activity = updated;
        }
        if (fm.type === 'change' && typeof fm.status === 'string') {
          content.changes_by_status[fm.status] =
            (content.changes_by_status[fm.status] ?? 0) + 1;
        }
        if (fm.type === 'project' && typeof fm.status === 'string') {
          content.projects_by_status[fm.status] =
            (content.projects_by_status[fm.status] ?? 0) + 1;
        }
      }
    }
  }
  await walk(wikiRoot, null);
  return content;
}

// Per-domain cost/run rollup. Same shape as buildChangeRollup but joined
// on `events.domain` instead of `events.change_id`. The `domain` column
// is set by the event-attribution helper at record time (when the prompt
// or skill matches a known domain).
interface DomainRollup {
  cost_usd: number;
  duration_ms: number;
  skill_count: number;
  by_skill: Array<{ skill: string; count: number; cost_usd: number; duration_ms: number }>;
  ai_prompt_runs: number;
  failed_runs: number;
}

function buildDomainRollup(domainPath: string): DomainRollup {
  const empty: DomainRollup = {
    cost_usd: 0,
    duration_ms: 0,
    skill_count: 0,
    by_skill: [],
    ai_prompt_runs: 0,
    failed_runs: 0,
  };
  if (!existsSync(EVENTS_DB_PATH)) return empty;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
    interface Row {
      skill: string | null;
      n: number;
      cost: number | null;
      dur: number | null;
      failures: number;
    }
    // Match by exact domain string. Sub-domain attribution (e.g.
    // `domain: development/pr-review` in an event) isn't done today; the
    // event attribution helper writes the top-level domain. So sub-domain
    // rollups will show their parent's totals; we treat that as fine for
    // the v1 surface.
    const rows = db
      .prepare(`
        SELECT skill,
               COUNT(*) AS n,
               SUM(cost_usd) AS cost,
               SUM(duration_ms) AS dur,
               SUM(CASE WHEN exit_status != 0 THEN 1 ELSE 0 END) AS failures
          FROM events
         WHERE action = 'ai-prompt' AND domain = ?
         GROUP BY skill
      `)
      .all(domainPath) as unknown as Row[];
    let cost = 0;
    let dur = 0;
    let runs = 0;
    let failed = 0;
    const bySkill: DomainRollup['by_skill'] = [];
    for (const r of rows) {
      runs += r.n;
      cost += r.cost ?? 0;
      dur += r.dur ?? 0;
      failed += r.failures ?? 0;
      if (r.skill) {
        bySkill.push({
          skill: r.skill,
          count: r.n,
          cost_usd: Number((r.cost ?? 0).toFixed(4)),
          duration_ms: r.dur ?? 0,
        });
      }
    }
    bySkill.sort((a, b) => b.cost_usd - a.cost_usd);
    return {
      cost_usd: Number(cost.toFixed(4)),
      duration_ms: dur,
      skill_count: bySkill.length,
      by_skill: bySkill,
      ai_prompt_runs: runs,
      failed_runs: failed,
    };
  } catch {
    return empty;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export const domainsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const dir = join(REPO_ROOT, 'domains');
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const topLevel = entries.filter(
        (e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'),
      );

      const domains = (
        await Promise.all(
          topLevel.map(async (e) => {
            const abs = join(dir, e.name);
            if (!(await hasPlaybook(abs))) return null;
            return walkDomain(abs, e.name, e.name);
          }),
        )
      ).filter((d): d is DomainNode => d !== null);

      domains.sort((a, b) => a.name.localeCompare(b.name));
      return { domains };
    } catch {
      return { domains: [] };
    }
  });

  // GET /api/domains/rollup?path=<domain-path>
  // Query-string carries the domain path so both top-level and
  // sub-domain rollups (e.g. `development/pr-review`) go through one
  // route without wildcard gymnastics. Returns the runtime rollup
  // (cost/runs from events.db filtered by `domain` column) AND a content
  // rollup (entries by archetype, changes/projects by status).
  fastify.get<{ Querystring: { path?: string } }>('/rollup', async (req, reply) => {
    const domainPath = (req.query.path ?? '').trim();
    return await loadDomainRollup(domainPath, reply);
  });

  async function loadDomainRollup(
    domainPath: string,
    reply: import('fastify').FastifyReply,
  ) {
    if (!domainPath) {
      reply.code(400);
      return { ok: false, error: 'domain path required' };
    }
    // Verify the domain actually exists (playbook.md present).
    const absDir = join(REPO_ROOT, 'domains', domainPath);
    if (!(await hasPlaybook(absDir))) {
      reply.code(404);
      return { ok: false, error: `domain "${domainPath}" not found` };
    }
    const [content, rollup] = await Promise.all([
      buildDomainContent(domainPath),
      Promise.resolve(buildDomainRollup(domainPath)),
    ]);
    return { ok: true, domain: domainPath, content, rollup };
  }
};
