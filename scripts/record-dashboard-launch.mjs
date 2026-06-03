#!/usr/bin/env node
// Dual-write wrapper for dashboard launch events. Invoked by the
// `meta-dashboard` skill when it starts the dashboard. Same pattern as
// record-router-event: append historical JSONL line + insert structured row.
//
// Usage:
//   node scripts/record-dashboard-launch.mjs --port-web 5173 --port-api 5174

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEvent } from './events-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_PATH = join(REPO_ROOT, 'vault', 'raw', 'dashboard-actions.jsonl');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const portWeb = parseInt(args['port-web'], 10);
  const portApi = parseInt(args['port-api'], 10);
  if (!Number.isFinite(portWeb) || !Number.isFinite(portApi)) {
    console.error(
      'record-dashboard-launch: --port-web and --port-api are required integers',
    );
    process.exit(2);
  }
  const ts = new Date().toISOString();

  const line = { ts, action: 'launch', port_web: portWeb, port_api: portApi };
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(line) + '\n');

  recordEvent({
    ts,
    kind: 'dashboard',
    action: 'launch',
    source: 'cli',
    status: 'success',
    description: `dashboard launched (web=${portWeb}, api=${portApi})`,
  });
}

main();
