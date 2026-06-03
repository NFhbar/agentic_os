#!/usr/bin/env node
// sync-mcp-config.mjs — merges OS-built MCP manifests (mcps/<id>/manifest.json)
// into .mcp.json at the repo root. Preserves third-party / hosted MCP rows
// (e.g. the official GitHub MCP at api.githubcopilot.com/mcp/) that were
// added by hand and don't have a corresponding mcps/<id>/ folder.
//
// Discovered manifests overwrite their matching .mcp.json entries on each run.
// Third-party entries are passed through unchanged.
// If you remove an mcps/<id>/ folder, also manually delete the matching row
// from .mcp.json — sync deliberately doesn't auto-remove (can't safely tell
// which orphans were once-managed vs always third-party).
//
// The MCP manifest contract is documented in
// vault/wiki/_seed/meta/reference/standard-mcp-architecture.md.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MCPS_DIR = join(REPO_ROOT, 'mcps');
const OUTPUT = join(REPO_ROOT, '.mcp.json');

const REQUIRED = ['id', 'domain', 'description', 'transport', 'command', 'args'];

function discoverManifests() {
  let entries;
  try {
    entries = readdirSync(MCPS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = join(MCPS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync-mcp-config] skipping ${name}: ${msg}`);
      continue;
    }
    const missing = REQUIRED.filter((k) => manifest[k] == null);
    if (missing.length > 0) {
      console.error(
        `[sync-mcp-config] skipping ${name}: missing required fields [${missing.join(', ')}]`,
      );
      continue;
    }
    if (manifest.id !== name) {
      console.error(
        `[sync-mcp-config] skipping ${name}: manifest.id (${manifest.id}) must match folder name`,
      );
      continue;
    }
    out.push(manifest);
  }
  return out;
}

function buildEntry(m) {
  const server = {
    command: m.command,
    args: m.args,
  };
  // env-passthrough: list of env var names. Claude Code passes them from the
  // parent shell env to the spawned MCP process. The MCP server itself
  // reads its own mcps/<id>/.env at boot — so this is just a safety net
  // for shell-set vars (CI, devs who prefer ~/.zshrc exports).
  if (Array.isArray(m.env) && m.env.length > 0) {
    const env = {};
    for (const key of m.env) {
      if (process.env[key] != null) env[key] = process.env[key];
    }
    if (Object.keys(env).length > 0) server.env = env;
  }
  return server;
}

function loadExisting() {
  if (!existsSync(OUTPUT)) return { mcpServers: {} };
  try {
    const raw = JSON.parse(readFileSync(OUTPUT, 'utf8'));
    if (!raw || typeof raw !== 'object') return { mcpServers: {} };
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') raw.mcpServers = {};
    return raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-mcp-config] existing .mcp.json unreadable, replacing: ${msg}`);
    return { mcpServers: {} };
  }
}

const manifests = discoverManifests();
const existing = loadExisting();
const discoveredIds = new Set(manifests.map((m) => m.id));

// Start from existing config (preserves third-party rows). Overwrite
// discovered entries with freshly-built ones.
const merged = { ...existing, mcpServers: { ...existing.mcpServers } };
for (const m of manifests) {
  merged.mcpServers[m.id] = buildEntry(m);
}

writeFileSync(OUTPUT, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

const totalCount = Object.keys(merged.mcpServers).length;
const thirdPartyIds = Object.keys(merged.mcpServers).filter((id) => !discoveredIds.has(id));
const parts = [];
if (manifests.length > 0) parts.push(`${manifests.length} managed: ${manifests.map((m) => m.id).join(', ')}`);
if (thirdPartyIds.length > 0) parts.push(`${thirdPartyIds.length} third-party preserved: ${thirdPartyIds.join(', ')}`);
console.log(
  `✓ wrote ${OUTPUT.replace(`${REPO_ROOT}/`, '')} — ${totalCount} MCP server${totalCount === 1 ? '' : 's'}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`,
);
