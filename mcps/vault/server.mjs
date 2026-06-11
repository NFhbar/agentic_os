// Vault MCP — surfaces the OS wiki as typed tools for Claude Code.
//
// Three tools: search_wiki, get_entry, list_archetypes. All read-only;
// reads the prebuilt index at vault/.index/manifest.json plus individual
// wiki entry files on demand. No network, no auth.
//
// Repo root is resolved via CLAUDE_PROJECT_DIR (Claude Code sets this when
// spawning MCP servers) with a fallback to walking up from this file's dir.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { searchWiki } from './search.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR
  ? resolve(process.env.CLAUDE_PROJECT_DIR)
  : resolve(__dirname, '..', '..');

const INDEX_PATH = join(REPO_ROOT, 'vault', '.index', 'manifest.json');

function loadIndex() {
  if (!existsSync(INDEX_PATH)) {
    throw new Error(
      `vault index missing at ${INDEX_PATH} — run node .claude/hooks/rebuild-vault-index.mjs`,
    );
  }
  const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  return Array.isArray(raw.entries) ? raw.entries : [];
}

const SEARCH_DB_PATH = join(REPO_ROOT, 'vault', '.index', 'search.db');

const TOOLS = [
  {
    name: 'search_wiki',
    description:
      'Full-text search over wiki entries — FTS5/BM25 across id, title, tags, and entry BODIES (falls back to substring-over-snippets when the search index is missing). Optional filters: archetype (e.g. "decision", "runbook"), domain (e.g. "meta", "development"). Returns top hits with id, title, archetype, domain, path, match snippet, score, and the engine used.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query (matched against id, title, tags, and entry bodies).',
        },
        archetype: {
          type: 'string',
          description: 'Optional. Filter by archetype (entry.type in the index).',
        },
        domain: { type: 'string', description: 'Optional. Filter by owning domain.' },
        limit: { type: 'number', description: 'Max results. Default 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entry',
    description:
      'Fetch a full wiki entry by id (preferred) or path. Returns the frontmatter (parsed), the markdown body, and the resolved path.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id (as it appears in the index).' },
        path: {
          type: 'string',
          description: 'Repo-relative path to the entry file. Used if id is omitted.',
        },
      },
    },
  },
  {
    name: 'list_archetypes',
    description:
      'List all wiki archetypes currently in the index with entry counts. Use to discover what kinds of entries exist before calling search_wiki with an archetype filter.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleSearchWiki({ query, archetype, domain, limit = 10 }) {
  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }
  return await searchWiki(
    { query, archetype, domain, limit },
    { loadIndex, searchDbPath: SEARCH_DB_PATH },
  );
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: content };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const eq = line.indexOf(':');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    fm[key] = val;
  }
  return { frontmatter: fm, body: m[2] };
}

function handleGetEntry({ id, path }) {
  let entry;
  if (id) {
    const entries = loadIndex();
    entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(`No entry with id "${id}"`);
  } else if (path) {
    entry = { path, id: null };
  } else {
    throw new Error('Either id or path is required');
  }
  const fullPath = join(REPO_ROOT, entry.path);
  if (!existsSync(fullPath)) {
    throw new Error(`Entry file not found: ${entry.path}`);
  }
  const content = readFileSync(fullPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    id: entry.id ?? frontmatter?.id ?? null,
    path: entry.path,
    title: entry.title ?? frontmatter?.title ?? null,
    archetype: entry.type ?? frontmatter?.type ?? null,
    domain: entry.domain ?? frontmatter?.domain ?? null,
    frontmatter,
    body,
  };
}

function handleListArchetypes() {
  const entries = loadIndex();
  const counts = new Map();
  for (const e of entries) {
    const t = e.type ?? 'unknown';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return {
    archetypes: [...counts.entries()]
      .map(([archetype, count]) => ({ archetype, count }))
      .sort((a, b) => b.count - a.count),
    total_entries: entries.length,
  };
}

const HANDLERS = {
  search_wiki: handleSearchWiki,
  get_entry: handleGetEntry,
  list_archetypes: handleListArchetypes,
};

const server = new Server(
  { name: 'agentic-os-vault', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = await handler(args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error in ${name}: ${msg}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
