// Load + cache the active notification-config rule set. TTL + directory-mtime
// gate the cache; fs.watch on a vault subtree is fragile cross-platform and
// the rule set is small (tens of entries at most). Load-time channel
// validation keeps adapters/index.ts's exhaustive switch sound at runtime —
// a malformed `channel` is dropped here once per cache refresh rather than
// reaching `getAdapter()` per dispatch.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type { ChannelId } from './channel-adapter.js';

export const VALID_CHANNELS: readonly ChannelId[] = ['slack', 'email', 'desktop'];
export const EVENT_TYPE_RE = /^[a-z0-9_-]+\.[a-z0-9_-]+$/;
const CACHE_TTL_MS = 30_000;
const SKIP_DOMAINS = new Set(['_seed', '_templates']);

export interface Rule {
  id: string;
  event_type: string;
  channel: ChannelId;
  filter: Record<string, unknown>;
  delivery: Record<string, unknown>;
  rate_limit: Record<string, unknown> | null;
}

interface CacheEntry {
  rules: Rule[];
  loadedAt: number;
  dirSignature: string;
}

let _cache: CacheEntry | null = null;

function isChannelId(v: unknown): v is ChannelId {
  return typeof v === 'string' && (VALID_CHANNELS as readonly string[]).includes(v);
}

async function listDomainDirs(): Promise<string[]> {
  const wiki = join(REPO_ROOT, 'vault', 'wiki');
  try {
    const entries = await readdir(wiki, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DOMAINS.has(e.name))
      .map((e) => join(wiki, e.name));
  } catch {
    return [];
  }
}

async function listRuleFiles(): Promise<string[]> {
  const domains = await listDomainDirs();
  const out: string[] = [];
  for (const d of domains) {
    const ruleDir = join(d, 'notification-config');
    try {
      const entries = await readdir(ruleDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) {
          out.push(join(ruleDir, e.name));
        }
      }
    } catch {
      /* domain has no notification-config — common */
    }
  }
  return out;
}

async function computeDirSignature(): Promise<string> {
  const domains = await listDomainDirs();
  const parts: string[] = [];
  for (const d of domains) {
    const ruleDir = join(d, 'notification-config');
    try {
      const s = await stat(ruleDir);
      parts.push(`${ruleDir}:${s.mtimeMs}`);
    } catch {
      parts.push(`${ruleDir}:none`);
    }
  }
  return parts.join('|');
}

function parseRule(filePath: string, content: string): Rule | null {
  const { fm, parseError } = parseFrontmatter(content);
  if (parseError) {
    console.error(`notifications/rules: failed to parse ${filePath}: ${parseError}`);
    return null;
  }
  if (fm.type !== 'notification-config') return null;
  if (fm.enabled !== true) return null;

  const id = typeof fm.id === 'string' && fm.id.length > 0 ? fm.id : null;
  if (!id) {
    console.error(`notifications/rules: ${filePath} missing required "id", skipping`);
    return null;
  }

  const event_type = typeof fm.event_type === 'string' ? fm.event_type : '';
  if (!EVENT_TYPE_RE.test(event_type)) {
    console.error(
      `notifications/rules: rule "${id}" has invalid event_type "${event_type}" (must match {kind}.{action}), skipping`,
    );
    return null;
  }

  if (!isChannelId(fm.channel)) {
    console.error(
      `notifications/rules: rule "${id}" has invalid channel "${fm.channel}" (must be slack|email|desktop), skipping`,
    );
    return null;
  }

  const filter = isPlainObject(fm.filter) ? fm.filter : {};
  const delivery = isPlainObject(fm.delivery) ? fm.delivery : {};
  const rate_limit = isPlainObject(fm.rate_limit) ? fm.rate_limit : null;

  return {
    id,
    event_type,
    channel: fm.channel,
    filter,
    delivery,
    rate_limit,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readAllRules(): Promise<Rule[]> {
  const files = await listRuleFiles();
  const rules: Rule[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = await readFile(f, 'utf8');
    } catch (err) {
      console.error(`notifications/rules: failed to read ${f}`, err);
      continue;
    }
    const r = parseRule(f, content);
    if (r) rules.push(r);
  }
  return rules;
}

export async function loadActiveRules(): Promise<Rule[]> {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    const sig = await computeDirSignature();
    if (sig === _cache.dirSignature) return _cache.rules;
  }
  const sig = await computeDirSignature();
  const rules = await readAllRules();
  _cache = { rules, loadedAt: now, dirSignature: sig };
  return rules;
}

export function clearRuleCache(): void {
  _cache = null;
}
