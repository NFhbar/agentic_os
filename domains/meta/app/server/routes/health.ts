// /api/health — unified action-items endpoint.
//
// Aggregates findings from multiple drift sources into a single
// dashboard-renderable list. Each item carries an optional `proposedAction`
// so the Overview's Action Items panel can offer a one-click "Accept" that
// dispatches the appropriate fix (skill, navigation, or manifest rebuild).
//
// Sources (in priority order):
//   1. Lifecycle drift  — changes whose state contradicts GitHub or the
//      OS-side workflow (e.g. PR merged but status still in-review).
//      Highest priority since these block forward progress.
//   2. Audit findings   — scripts/audit.mjs warn/error rows. Mapped to
//      proposed actions when the finding has an obvious one-click fix
//      (e.g. manifest-stale → rebuild-vault-index hook).
//   3. Audit info       — same audit, info-severity rows. Surfaced for
//      visibility, not urgency.
//
// Dismissal state lives at .claude/state/dismissed-action-items.jsonl —
// one JSON line per dismissal with {id, ts, rationale?}. Dismissed items
// are filtered out of the API response but never deleted from the log
// (audit trail).

import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';

// ---------------------------------------------------------------------------
// Shared shapes — mirrored in the frontend's overview/View.tsx.
// ---------------------------------------------------------------------------

type Severity = 'error' | 'warn' | 'info';

interface ProposedAction {
  // 'skill' → caller dispatches /api/action with a generated prompt that
  //   reads the skill's SKILL.md and passes the supplied args.
  // 'navigate' → caller routes to href.
  // 'rebuild-manifest' → caller POSTs an empty body to a manifest-rebuild
  //   endpoint (or fires the local hook script directly).
  // 'accept-drafts' → caller POSTs to /api/changes/<changeId>/accept-drafts.
  //   Strips DRAFT-marker blockquotes from the body of the change entry,
  //   leaving the auto-drafted content accepted. Idempotent.
  type: 'skill' | 'navigate' | 'rebuild-manifest' | 'accept-drafts';
  // For type=skill
  skill?: string;
  args?: Record<string, unknown>;
  // For type=navigate
  href?: string;
  // For type=accept-drafts — the target change id (resolved from the
  // audit finding's path: vault/wiki/<domain>/change/<id>.md → <id>).
  changeId?: string;
}

interface ActionItem {
  // Stable id used for dismissal. Composes the source + the finding's own
  // id + a discriminator (e.g. change id, skill name). Same drift in two
  // runs produces the same id so dismissal persists.
  id: string;
  severity: Severity;
  title: string;
  message: string;
  // Optional supplemental hint shown below the message in muted text.
  hint?: string;
  // Where in the OS this finding came from — used for the "View" deep link.
  source: {
    kind: 'audit' | 'lifecycle' | 'runbook';
    path?: string; // file path or app URL (e.g. '/changes/add-license')
  };
  proposedAction?: ProposedAction;
  // True when the user has previously dismissed this finding (filtered out
  // by default; set to false when ?include_dismissed=1 query is passed).
  dismissed?: boolean;
}

// ---------------------------------------------------------------------------
// Dismissal store
// ---------------------------------------------------------------------------

const DISMISSAL_PATH = join(REPO_ROOT, '.claude', 'state', 'dismissed-action-items.jsonl');

// Exported so other routes (e.g. audit.ts) can join their findings against
// the user's dismissal log without duplicating the file I/O + parsing.
export async function loadDismissedIds(): Promise<Set<string>> {
  if (!existsSync(DISMISSAL_PATH)) return new Set();
  try {
    const content = await readFile(DISMISSAL_PATH, 'utf8');
    const ids = new Set<string>();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { id?: string };
        if (typeof e.id === 'string') ids.add(e.id);
      } catch {
        /* skip malformed */
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function recordDismissal(id: string, rationale: string | null): Promise<void> {
  await mkdir(dirname(DISMISSAL_PATH), { recursive: true });
  const entry = { id, ts: new Date().toISOString(), rationale };
  await appendFile(DISMISSAL_PATH, `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Source 1: Lifecycle drift — scan change entries for state contradictions
// that have an obvious one-click resolution.
// ---------------------------------------------------------------------------

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function lifecycleDriftFindings(): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  // Two-pass walk: first collect every kind=repo entity's id so we can
  // detect dangling change.repo references in the second pass. Cheap
  // (one extra hashmap insert per file).
  const repoEntityIds = new Set<string>();
  type ChangeFm = Record<string, unknown> & { __path: string };
  const changes: ChangeFm[] = [];
  for (const file of files) {
    let fm: Record<string, unknown>;
    try {
      const content = await readFile(file, 'utf8');
      const parsed = parseFrontmatter(content);
      if (parsed.parseError) continue;
      fm = parsed.fm as Record<string, unknown>;
    } catch {
      continue;
    }
    if (fm.type === 'entity' && fm.kind === 'repo' && typeof fm.id === 'string') {
      repoEntityIds.add(fm.id);
      continue;
    }
    if (fm.type === 'change') {
      changes.push({ ...fm, __path: file } as ChangeFm);
    }
  }
  for (const fm of changes) {
    const changeId = typeof fm.id === 'string' ? fm.id : null;
    if (!changeId) continue;

    // Drift 0: change references a repo entity that doesn't exist.
    // Blocks dev-write-change PLAN because the entity is how skills
    // resolve owner/repo → cache + local_path → working tree. One-click
    // proposed action: dispatch dev-ingest-repo for the orphan repo id.
    if (typeof fm.repo === 'string' && fm.repo && !repoEntityIds.has(fm.repo)) {
      items.push({
        id: `lifecycle:orphan-repo:${changeId}:${fm.repo}`,
        severity: 'warn',
        title: `Change ${changeId} references missing repo entity "${fm.repo}"`,
        message: `The change's frontmatter has \`repo: ${fm.repo}\` but no entity entry exists at vault/wiki/*/entity/${fm.repo}.md (with kind: repo). dev-write-change PLAN will fail to resolve the read source. Run dev-ingest-repo to create the entity + local clone.`,
        hint: 'After ingest, the entity entry is in place and PLAN can proceed.',
        source: { kind: 'lifecycle', path: `/changes/${changeId}` },
        proposedAction: {
          type: 'skill',
          skill: 'dev-ingest-repo',
          args: { repo: fm.repo },
        },
      });
    }

    // Drift 1: status: in-review but pr_review_status: ready-for-human AND
    // comments_to_address is 0 (the change is fully signed off but the PR
    // hasn't been merged yet). Not actually drift — just a reminder.
    // Skipped for now since the Changes detail already surfaces this.

    // Drift 2: status: planning + plan_path set + review_status: approved.
    // The plan is ready to execute. One-click action: dispatch
    // dev-write-change (which will run the EXECUTE phase).
    if (
      fm.status === 'planning' &&
      typeof fm.plan_path === 'string' &&
      fm.review_status === 'approved'
    ) {
      items.push({
        id: `lifecycle:plan-ready-to-execute:${changeId}`,
        severity: 'info',
        title: `Plan approved for ${changeId} — ready to execute`,
        message: `The plan for "${typeof fm.title === 'string' ? fm.title : changeId}" has been reviewed and approved. Run dev-write-change to execute it.`,
        hint: 'EXECUTE phase creates the branch, makes edits, runs tests, and commits.',
        source: { kind: 'lifecycle', path: `/changes/${changeId}` },
        proposedAction: {
          type: 'skill',
          skill: 'dev-write-change',
          args: { change: changeId },
        },
      });
    }

    // Drift 3: review_status: pending + plan_path set → awaiting review.
    if (
      fm.status === 'planning' &&
      typeof fm.plan_path === 'string' &&
      (fm.review_status === 'pending' || !fm.review_status)
    ) {
      items.push({
        id: `lifecycle:plan-awaits-review:${changeId}`,
        severity: 'info',
        title: `Plan written for ${changeId} — awaiting review`,
        message: `The plan exists but hasn't been reviewed yet. Run dev-review-change to gate execution.`,
        source: { kind: 'lifecycle', path: `/changes/${changeId}` },
        proposedAction: {
          type: 'skill',
          skill: 'dev-review-change',
          args: { change: changeId },
        },
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Source 2: Audit findings — call scripts/audit.mjs --json and map each
// row to an ActionItem with a proposed action (when one applies).
// ---------------------------------------------------------------------------

interface AuditFinding {
  id: string;
  severity: Severity;
  message: string;
  path?: string;
  hint?: string;
  // Optional stable disambiguator used in the dismissal id when present.
  // Drift-prone checks (messages with day counts, ages, etc.) set this so
  // the id doesn't change run-to-run. See dismissalIdForAuditFinding.
  dedupe_key?: string;
}

function runAudit(): AuditFinding[] {
  try {
    const result = spawnSync('node', [join(REPO_ROOT, 'scripts', 'audit.mjs'), '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status === null || !result.stdout) return [];
    const parsed = JSON.parse(result.stdout) as { findings?: AuditFinding[] };
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return [];
  }
}

// Map a known audit finding id to a one-click proposed action. Returns null
// when there's no obvious automation — the user has to fix manually
// (the Action item still surfaces; just without an Accept button).
function proposedActionForAudit(f: AuditFinding): ProposedAction | null {
  switch (f.id) {
    case 'manifest-stale':
      return { type: 'rebuild-manifest' };
    case 'router-vocab-skill-uncovered': {
      // Extract the skill name from the finding's message (audit.mjs format:
      // `User-invocable skill "<name>" is not in OS.md's intent vocabulary…`).
      // When found, dispatch meta-add-skill-to-router-vocab with the name +
      // a default phrasing (the skill name itself; user can refine in OS.md
      // afterward). Falls back to navigation when the message shape changed.
      const m = f.message.match(/skill "([a-z0-9][a-z0-9-]*)"/);
      if (m) {
        return {
          type: 'skill',
          skill: 'meta-add-skill-to-router-vocab',
          args: { skill: m[1], phrasings: m[1] },
        };
      }
      return { type: 'navigate', href: '/router' };
    }
    case 'router-vocab-missing':
      return { type: 'navigate', href: '/router' };
    case 'playbook-skill-coverage': {
      // Extract the skill name from the finding's message (audit.mjs format:
      // `Skill "<name>" claims domain "<d>" but isn't listed…`). When found,
      // dispatch meta-add-skill-to-playbook; the skill resolves the owning
      // domain from the skill's own SKILL.md frontmatter, so we don't need
      // to pass it explicitly here.
      const m = f.message.match(/Skill "([a-z0-9][a-z0-9-]*)"/);
      if (m) {
        return {
          type: 'skill',
          skill: 'meta-add-skill-to-playbook',
          args: { skill: m[1] },
        };
      }
      return { type: 'navigate', href: '/domains' };
    }
    case 'mcp-tool-orphan':
      return f.path ? { type: 'navigate', href: `/vault/entries/${pathToId(f.path)}` } : null;
    case 'change-body-template-placeholder': {
      // Two failure modes in this finding (per audit.mjs):
      //   - placeholder text → user has to write content (no one-click fix)
      //   - DRAFT markers → user just needs to accept the auto-drafted body
      // When the message mentions DRAFT but not placeholder, the accept-drafts
      // endpoint can do it in one POST. Mixed case falls back to navigation
      // (the Overview banner will show the placeholder warning first, then
      // surface the Accept Drafts button once the placeholders are gone).
      const hasDrafts = /DRAFT marker/.test(f.message);
      const hasPlaceholders = /template placeholder/.test(f.message);
      if (hasDrafts && !hasPlaceholders && f.path) {
        return { type: 'accept-drafts', changeId: pathToId(f.path) };
      }
      return f.path ? { type: 'navigate', href: `/changes/${pathToId(f.path)}` } : null;
    }
    default:
      return null;
  }
}

// Best-effort: derive an entry id from a file path like
// `vault/wiki/<domain>/<archetype>/<id>.md` → `<id>`. Returns the basename
// without extension if the shape doesn't match.
function pathToId(p: string): string {
  const m = p.match(/\/([a-z0-9][a-z0-9-]*)\.md$/);
  if (m) return m[1];
  return p.split('/').pop()?.replace(/\.md$/, '') ?? p;
}

// Stable hash of an arbitrary string — used to disambiguate audit findings
// that share the same id+path (e.g. multiple `mcp-tool-orphan` rows from
// one manifest) so each gets its own dismissal lane. djb2; same shape as
// the manifest-key hashes elsewhere in the codebase.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// Compose the canonical dismissal id for an audit finding. Exported so
// the audit route can stamp its findings with `dismissed: true` by joining
// against `loadDismissedIds()` — keeps the id-shape in one place.
//
// Prefers `dedupe_key` when the finding provides one — that's the stable
// disambiguator for drift-prone checks (where `message` interpolates day
// counts / ages / counts and changes run-to-run, breaking dismissal match).
// Falls back to hash(message) for backward compat — stable-message checks
// don't need to set dedupe_key. Closes #424 (dismissal-id drift).
export function dismissalIdForAuditFinding(f: AuditFinding): string {
  const disambiguator = f.dedupe_key ?? f.message;
  return `audit:${f.id}:${f.path ?? ''}:${hash(disambiguator)}`;
}

function auditItems(findings: AuditFinding[]): ActionItem[] {
  return findings.map((f) => ({
    // Include message hash so multiple findings of the same {id, path}
    // shape don't collide on dismissal.
    id: dismissalIdForAuditFinding(f),
    severity: f.severity,
    title: humanizeAuditTitle(f),
    message: f.message,
    hint: f.hint,
    source: { kind: 'audit', path: f.path },
    proposedAction: proposedActionForAudit(f) ?? undefined,
  }));
}

// Turn an audit check id ('mcp-tool-orphan') into a human-readable card
// title. Falls back to the kebab-case id when no humanization is defined.
function humanizeAuditTitle(f: AuditFinding): string {
  const titles: Record<string, string> = {
    'manifest-stale': 'Vault manifest is stale',
    'mcp-tool-orphan': 'MCP tool has no consumer',
    'router-vocab-skill-uncovered': 'Skill missing from router vocabulary',
    'router-vocab-missing': 'Router vocabulary table missing',
    'playbook-skill-coverage': 'Skill missing from domain playbook',
    'wiki-link-dangling': 'Dangling wikilink',
    'events-db-stale': 'Event store has been quiet',
  };
  return titles[f.id] ?? f.id;
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/health/action-items[?include_dismissed=1]
  fastify.get<{ Querystring: { include_dismissed?: string } }>('/action-items', async (req) => {
    const includeDismissed = req.query.include_dismissed === '1';
    const [lifecycle, dismissed] = await Promise.all([
      lifecycleDriftFindings(),
      loadDismissedIds(),
    ]);
    const audit = auditItems(runAudit());
    const allItems = [...lifecycle, ...audit];
    const items = allItems
      .map((i) => ({ ...i, dismissed: dismissed.has(i.id) }))
      .filter((i) => includeDismissed || !i.dismissed);
    const summary = {
      error: items.filter((i) => i.severity === 'error' && !i.dismissed).length,
      warn: items.filter((i) => i.severity === 'warn' && !i.dismissed).length,
      info: items.filter((i) => i.severity === 'info' && !i.dismissed).length,
      dismissed: dismissed.size,
    };
    return { items, summary };
  });

  // POST /api/health/action-items/:id/dismiss — record dismissal so the
  // finding doesn't surface on subsequent list calls. Body may carry an
  // optional `rationale` string for the audit log.
  fastify.post<{ Params: { id: string }; Body: { rationale?: string } }>(
    '/action-items/:id/dismiss',
    async (req) => {
      const id = decodeURIComponent(req.params.id);
      const rationale =
        typeof req.body?.rationale === 'string' && req.body.rationale.trim()
          ? req.body.rationale.trim()
          : null;
      await recordDismissal(id, rationale);
      return { ok: true };
    },
  );

  // POST /api/health/rebuild-manifest — one-click wrapper for the
  // manifest-stale proposed action. Spawns the existing hook synchronously.
  fastify.post('/rebuild-manifest', async (_req, reply) => {
    try {
      const result = spawnSync(
        'node',
        [join(REPO_ROOT, '.claude', 'hooks', 'rebuild-vault-index.mjs')],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 },
      );
      if (result.status !== 0) {
        reply.code(500);
        return { ok: false, error: result.stderr || 'rebuild failed' };
      }
      return { ok: true, stdout: result.stdout.trim() };
    } catch (e) {
      reply.code(500);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
};
