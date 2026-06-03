#!/usr/bin/env node
// check-mcp — pre-flight verifier for skills (or any caller) that depend on
// a specific MCP. Reads .mcp.json and reports whether the named MCP is
// configured, what kind it is (hosted vs OS-built), and an actionable hint
// when it's not.
//
// Usage:
//   node scripts/check-mcp.mjs <id>            # exits 0 if configured, 1 otherwise
//   node scripts/check-mcp.mjs <id> --json     # machine-readable output
//   node scripts/check-mcp.mjs --list          # show all configured MCPs
//
// Why a CLI helper: skill bodies are markdown; they call Bash to exec a
// small program. This is that program. Single source of truth for the
// "is the github MCP wired up?" question every skill needs to answer.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MCP_CONFIG = join(REPO_ROOT, '.mcp.json');
const MCPS_DIR = join(REPO_ROOT, 'mcps');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readConfig() {
  if (!existsSync(MCP_CONFIG)) {
    return { mcpServers: {}, present: false };
  }
  try {
    const raw = JSON.parse(readFileSync(MCP_CONFIG, 'utf8'));
    return {
      mcpServers: raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : {},
      present: true,
    };
  } catch (e) {
    fail(`.mcp.json present but not parseable: ${e instanceof Error ? e.message : e}`);
  }
}

function classify(entry, id) {
  // Hosted: HTTP/SSE endpoint, OAuth handled by Claude Code's /mcp.
  if ((entry.type === 'http' || entry.type === 'sse' || entry.type === 'streamable-http') && entry.url) {
    return { kind: 'hosted', transport: entry.type, url: entry.url };
  }
  // OS-built: stdio + a matching mcps/<id>/ folder.
  const folderPath = join(MCPS_DIR, id);
  const hasFolder = existsSync(folderPath) && statSync(folderPath).isDirectory();
  if (entry.command && hasFolder) {
    return { kind: 'custom', transport: 'stdio', folder: folderPath, hasFolder };
  }
  return { kind: 'unknown', transport: entry.command ? 'stdio' : 'unknown' };
}

function checkEnv(folder) {
  // For OS-built MCPs: read manifest.env and report which env vars are missing
  // from mcps/<id>/.env. Returns { required: [...], envFile: 'path' | null,
  // missing: [...] } so the caller can produce specific hints.
  const manifestPath = join(folder, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const required = Array.isArray(manifest.env) ? manifest.env : [];
  if (required.length === 0) return { required, envFile: null, missing: [] };
  const envPath = join(folder, '.env');
  if (!existsSync(envPath)) return { required, envFile: envPath, missing: [...required] };
  const envContent = readFileSync(envPath, 'utf8');
  const missing = required.filter((v) => !new RegExp(`^${v}=\\S+`, 'm').test(envContent));
  return { required, envFile: envPath, missing };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const list = args.includes('--list');
const id = args.find((a) => !a.startsWith('--'));

const { mcpServers, present } = readConfig();

if (list) {
  const ids = Object.keys(mcpServers);
  if (json) {
    console.log(JSON.stringify({ configured: ids }, null, 2));
  } else if (ids.length === 0) {
    console.log('No MCPs configured. Add one with `/os add-mcp`.');
  } else {
    console.log(`${ids.length} MCP${ids.length === 1 ? '' : 's'} configured: ${ids.join(', ')}`);
  }
  process.exit(0);
}

if (!id) {
  fail('Usage: check-mcp <id> [--json] | --list');
}

if (!present) {
  const result = {
    ok: false,
    id,
    reason: 'config-missing',
    hint: 'No `.mcp.json` at repo root. Run `node scripts/sync-mcp-config.mjs` to generate it from `mcps/`, or add a hosted MCP via `/os add-mcp`.',
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.error(`✗ MCP \`${id}\` not configured. ${result.hint}`);
  process.exit(1);
}

const entry = mcpServers[id];
if (!entry) {
  const result = {
    ok: false,
    id,
    reason: 'not-registered',
    available: Object.keys(mcpServers),
    hint: `MCP \`${id}\` is not in .mcp.json. Either add it via \`/os add-mcp\` (custom mode for OS-built, hosted mode for vendor endpoints like https://api.githubcopilot.com/mcp/) or pick from the configured ones: ${
      Object.keys(mcpServers).join(', ') || '(none)'
    }.`,
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.error(`✗ MCP \`${id}\` not configured. ${result.hint}`);
  process.exit(1);
}

const classification = classify(entry, id);
const result = {
  ok: true,
  id,
  kind: classification.kind,
  transport: classification.transport,
};

if (classification.kind === 'hosted') {
  result.url = classification.url;
  result.auth_hint = `Run \`/mcp\` in Claude Code to authenticate via OAuth (browser flow) if not already done.`;
} else if (classification.kind === 'custom') {
  result.folder = classification.folder.replace(`${REPO_ROOT}/`, '');
  const envCheck = checkEnv(classification.folder);
  if (envCheck) {
    result.env_required = envCheck.required;
    result.env_missing = envCheck.missing;
    if (envCheck.missing.length > 0) {
      result.ok = false;
      result.reason = 'env-missing';
      result.hint = `MCP \`${id}\` is registered but env vars are not set: ${envCheck.missing.join(', ')}. Copy ${result.folder}/.env.example to ${result.folder}/.env and fill the values.`;
    }
  }
} else {
  result.ok = false;
  result.reason = 'unrecognized-shape';
  result.hint = `MCP \`${id}\` has neither typical hosted (url+type) nor custom (command+folder) shape. Inspect .mcp.json manually.`;
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  const detail =
    classification.kind === 'hosted'
      ? `hosted at ${classification.url}`
      : classification.kind === 'custom'
        ? `custom at ${result.folder}`
        : 'shape unknown';
  console.log(`✓ MCP \`${id}\` configured (${detail})`);
  if (result.auth_hint) console.log(`  ${result.auth_hint}`);
} else {
  console.error(`✗ MCP \`${id}\` ${result.reason}. ${result.hint}`);
}

process.exit(result.ok ? 0 : 1);
