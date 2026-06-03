// Dotenv loader for the dashboard server. Reads `domains/meta/app/.env` if
// present and injects entries into process.env (existing values are NOT
// overwritten — process.env wins so explicit shell-set vars stay authoritative).
//
// Convention mirrors `mcps/github/server.mjs::loadEnv` (see
// `standard-env-config`): one `.env` file per surface, loaded at process
// start, no dotenv dependency. Lines are `KEY=value`; comments start with `#`;
// optional surrounding single/double quotes are stripped.
//
// Called from `index.ts` BEFORE any route module that might read process.env
// at import time. New env vars (SLACK_BOT_TOKEN, future ANTHROPIC_API_KEY,
// etc.) just go in the .env file; consumers continue to read process.env.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadAppEnv(): { loaded: number; path: string; missing: boolean } {
  // The loader lives in `server/`; .env lives one level up at the app root.
  const envPath = join(__dirname, '..', '.env');
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return { loaded: 0, path: envPath, missing: true };
  }
  let loaded = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    // process.env wins — shell-exported values stay authoritative. Only
    // populate keys that are otherwise unset.
    if (!process.env[key]) {
      process.env[key] = val;
      loaded += 1;
    }
  }
  return { loaded, path: envPath, missing: false };
}
