// /api/mcps — surface the OS's MCP configuration as a unified list for the
// dashboard's MCPs view. Reads .mcp.json (truth for what Claude Code sees) +
// mcps/*/manifest.json (truth for OS-built MCPs) and joins them.
//
// Heuristic for classifying entries that exist in .mcp.json but not under
// mcps/<id>/: if they have a `url` field (with `type: http|sse`), they're
// vendor-hosted third-party MCPs; if they're command-based with no folder,
// they're stale (probably a deleted managed MCP) and surface as such.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { REPO_ROOT } from '../repo.js';
import type {
  ManifestFile,
  McpConfig,
  McpKind,
  McpRow,
  McpServerEntry,
} from './mcps.types.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./mcps.types.js per standard-shared-types.
export type {
  ManifestFile,
  ManifestTool,
  McpConfig,
  McpKind,
  McpRow,
  McpServerEntry,
  McpsListResponse,
} from './mcps.types.js';

// Local alias — the file used `Kind` internally for terseness. Keep the alias
// so existing call sites don't churn.
type Kind = McpKind;

function loadConfig(): { config: McpConfig; configExists: boolean } {
  const path = join(REPO_ROOT, '.mcp.json');
  if (!existsSync(path)) return { config: { mcpServers: {} }, configExists: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      config: { mcpServers: raw.mcpServers ?? {} },
      configExists: true,
    };
  } catch {
    return { config: { mcpServers: {} }, configExists: false };
  }
}

function loadManifest(id: string): ManifestFile | null {
  const path = join(REPO_ROOT, 'mcps', id, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ManifestFile;
  } catch {
    return null;
  }
}

function listMcpFolders(): string[] {
  const dir = join(REPO_ROOT, 'mcps');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => {
      if (name.startsWith('.') || name.startsWith('_')) return false;
      const sub = join(dir, name);
      return statSync(sub).isDirectory();
    });
  } catch {
    return [];
  }
}

function customStatus(
  id: string,
  manifest: ManifestFile | null,
): {
  hasManifest: boolean;
  hasEnvExample: boolean;
  hasEnv: boolean;
  hasNodeModules: boolean;
  statusHint: string;
} {
  const dir = join(REPO_ROOT, 'mcps', id);
  const hasManifest = manifest != null;
  const hasEnvExample = existsSync(join(dir, '.env.example'));
  const hasEnv = existsSync(join(dir, '.env'));
  const hasNodeModules = existsSync(join(dir, 'node_modules'));

  const envVars = manifest?.env ?? [];

  let statusHint = 'Ready.';
  if (!hasManifest) statusHint = "Missing manifest.json — won't appear in .mcp.json after sync.";
  else if (!hasNodeModules)
    statusHint = `Run \`cd mcps/${id} && npm install\` to install dependencies.`;
  else if (envVars.length > 0 && !hasEnv) {
    statusHint = `Required env vars not configured — copy .env.example to .env and fill ${envVars.join(', ')}.`;
  }
  return { hasManifest, hasEnvExample, hasEnv, hasNodeModules, statusHint };
}

function classify(
  id: string,
  entry: McpServerEntry,
  hasFolder: boolean,
): {
  kind: Kind;
  transport: string;
} {
  // Hosted/remote: declared with type + url, no command.
  if (
    (entry.type === 'http' || entry.type === 'sse' || entry.type === 'streamable-http') &&
    entry.url
  ) {
    return { kind: 'hosted', transport: entry.type };
  }
  // Custom OS-built: has command + matching folder.
  if (entry.command && hasFolder) {
    return { kind: 'custom', transport: 'stdio' };
  }
  // Command but no folder — managed entry whose folder was deleted, OR a
  // third-party local-binary MCP. We can't safely tell; show as stale so the
  // user investigates.
  return { kind: 'stale', transport: entry.command ? 'stdio' : 'unknown' };
}

export const mcpsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const { config, configExists } = loadConfig();
    const servers = config.mcpServers ?? {};
    const folders = new Set(listMcpFolders());

    const rows: McpRow[] = [];

    // 1. Every entry in .mcp.json — enrich with manifest where present.
    for (const [id, entry] of Object.entries(servers)) {
      const hasFolder = folders.has(id);
      const { kind, transport } = classify(id, entry, hasFolder);
      const manifest = hasFolder ? loadManifest(id) : null;

      const row: McpRow = {
        id,
        kind,
        transport,
        statusHint: '',
      };

      if (kind === 'hosted') {
        row.url = entry.url;
        row.statusHint = 'Hosted — run /mcp in Claude Code to authenticate if needed.';
      } else if (kind === 'custom') {
        row.command = entry.command;
        row.args = entry.args;
        row.domain = manifest?.domain;
        row.description = manifest?.description;
        row.tools = manifest?.tools ?? [];
        row.envVarsRequired = manifest?.env ?? [];
        const probe = customStatus(id, manifest);
        row.hasManifest = probe.hasManifest;
        row.hasEnvExample = probe.hasEnvExample;
        row.hasEnv = probe.hasEnv;
        row.hasNodeModules = probe.hasNodeModules;
        row.statusHint = probe.statusHint;
      } else {
        row.command = entry.command;
        row.args = entry.args;
        row.statusHint = hasFolder
          ? 'Unknown shape — entry has neither typical hosted nor custom fields. Inspect .mcp.json.'
          : 'No matching mcps/<id>/ folder — either a deleted managed MCP (remove this row) or a local-binary third-party (ignore this warning).';
      }

      rows.push(row);
    }

    // 2. Folders without a .mcp.json row — they were scaffolded but not synced.
    for (const id of folders) {
      if (servers[id] != null) continue;
      const manifest = loadManifest(id);
      const probe = customStatus(id, manifest);
      rows.push({
        id,
        kind: 'custom',
        transport: 'stdio',
        domain: manifest?.domain,
        description: manifest?.description,
        tools: manifest?.tools ?? [],
        envVarsRequired: manifest?.env ?? [],
        ...probe,
        statusHint: 'Folder exists but not in .mcp.json — run `node scripts/sync-mcp-config.mjs`.',
      });
    }

    // Stable ordering: custom (alpha) → hosted (alpha) → stale.
    const order: Record<Kind, number> = { custom: 0, hosted: 1, stale: 2 };
    rows.sort((a, b) => {
      const k = order[a.kind] - order[b.kind];
      return k !== 0 ? k : a.id.localeCompare(b.id);
    });

    return {
      mcps: rows,
      configExists,
      configPath: '.mcp.json',
      syncScript: 'scripts/sync-mcp-config.mjs',
    };
  });
};
