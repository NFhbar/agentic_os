// Shared helpers for structural tests. Read-only access to the vault, the
// vault manifest, and the skills directory. Kept deliberately small — tests
// should be self-explanatory; helpers are just for "load + parse" plumbing.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, '..', '..');

export const MANIFEST_PATH = join(REPO_ROOT, 'vault', '.index', 'manifest.json');
export const VAULT_WIKI = join(REPO_ROOT, 'vault', 'wiki');
export const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

export interface ManifestEntry {
  path: string;
  id: string | null;
  type: string | null;
  domain: string | null;
  title: string | null;
  // Many more fields exist (project, repo, status, plan_path, …). Tests
  // narrow to the fields they care about; we keep this index loose.
  [key: string]: unknown;
}

export interface Manifest {
  version: number;
  generated: string | null;
  entries: ManifestEntry[];
}

export function readManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `Vault manifest not found at ${relative(REPO_ROOT, MANIFEST_PATH)}. ` +
        `Run \`node .claude/hooks/rebuild-vault-index.mjs\` first.`,
    );
  }
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw) as Manifest;
}

// Walk vault/wiki/ recursively, returning absolute paths to every .md file.
export function walkWikiMarkdown(): string[] {
  return walkMd(VAULT_WIKI);
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkMd(p));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

// List skill directories — one per skill, each containing a SKILL.md.
export function listSkillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(SKILLS_DIR, e.name));
}

// Parse a markdown file's frontmatter. Returns null when the file has no
// frontmatter or it's malformed (tests assert on the absence themselves).
export interface FrontmatterResult {
  fm: Record<string, unknown> | null;
  body: string;
  parseError: string | null;
}

export function parseFrontmatter(filePath: string): FrontmatterResult {
  const content = readFileSync(filePath, 'utf8');
  if (!content.startsWith('---\n')) {
    return { fm: null, body: content, parseError: null };
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) {
    return { fm: null, body: content, parseError: 'unterminated frontmatter block' };
  }
  const yamlText = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  try {
    const parsed = parseYaml(yamlText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { fm: parsed as Record<string, unknown>, body, parseError: null };
    }
    return { fm: null, body, parseError: 'frontmatter is not a YAML object' };
  } catch (e) {
    return {
      fm: null,
      body,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
}

export function relPath(absPath: string): string {
  return relative(REPO_ROOT, absPath);
}
