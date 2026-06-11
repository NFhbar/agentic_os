#!/usr/bin/env node
// Claude Code contract smoke test.
//
// The OS couples to undocumented CC surfaces: CLI flags it passes on every
// dispatch, the stream-json result-event fields its telemetry reads, and
// the session-transcript format its importer parses. One of these already
// broke silently in production (the <command-message> slash format — found
// by the Fable review, not by monitoring; Finding 6.2). Drift fails as null
// telemetry columns, not errors. This script makes it fail LOUD.
//
// Tiers (CC's CLI is not installed in CI, so the tiers degrade):
//   fixture — pure node, no CLI: parse tests/fixtures/cc-session-transcript
//             .jsonl through the real importer; assert slash attribution,
//             bucketing, token sums, and workflow digests. Runs in CI.
//   flags   — `claude --help` must advertise every flag the OS passes.
//   live    — one minimal paid `claude -p` run (~$0.01, haiku); assert the
//             stream-json result event carries the fields scheduler-tick /
//             runs.ts / runs-finalize consume.
//
// Usage:
//   node scripts/check-cc-contract.mjs                 # all tiers
//   node scripts/check-cc-contract.mjs --no-live       # skip the paid probe
//   node scripts/check-cc-contract.mjs --fixture-only  # CI tier
//   node scripts/check-cc-contract.mjs --status-file <path>   # also write JSON status
//
// Exit 1 on any failure. The SessionStart hook runs --no-live in the
// background with --status-file; the next session's brief surfaces a WARN.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBuckets, extractSlashSkill } from './import-session-usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'cc-session-transcript.jsonl');

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(detail ? `${name}: ${detail}` : name);
  }
}

// ---------------------------------------------------------------------------
// Tier: fixture (pure node — the CI tier)
// ---------------------------------------------------------------------------

function runFixtureTier() {
  console.log('fixture tier — transcript format through the real importer');
  check(
    'extractSlashSkill parses <command-name> XML',
    extractSlashSkill('<command-message>os</command-message>\n<command-name>/os</command-name>') ===
      'os',
  );
  check('extractSlashSkill keeps the bare-slash fallback', extractSlashSkill('/meta-brief now') === 'meta-brief');
  let buckets = [];
  try {
    ({ buckets } = collectBuckets(FIXTURE));
  } catch (e) {
    check('collectBuckets parses the fixture', false, e.message);
    return;
  }
  check('fixture yields 2 buckets (one per user turn)', buckets.length === 2, `got ${buckets.length}`);
  const [slash, freeform] = buckets;
  check('bucket 1 attributes the /os slash command', slash?.slashSkill === 'os', `got ${slash?.slashSkill}`);
  check('bucket 1 sums usage tokens', slash?.tokens.output === 42 && slash?.tokens.cache_read === 1500);
  check('bucket 1 captures the model id', slash?.model === 'claude-fable-5');
  check(
    'bucket 1 digest captures tools + file paths',
    slash?.tools?.Read === 1 && [...(slash?.files ?? [])].includes('/tmp/agentic_os/OS.md'),
  );
  check('bucket 2 is freeform (no slash attribution)', freeform?.slashSkill === null);
  check('bucket 2 digest captures Bash tool use', freeform?.tools?.Bash === 1);
}

// ---------------------------------------------------------------------------
// Tier: flags (`claude --help`)
// ---------------------------------------------------------------------------

const REQUIRED_FLAGS = ['--print', '--effort', '--model', '--permission-mode', '--output-format'];

function runFlagsTier() {
  console.log('flags tier — claude --help advertises every flag the OS passes');
  const r = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.status !== 0) {
    check('claude --help runs', false, r.error?.message ?? `exit ${r.status}`);
    return;
  }
  const help = `${r.stdout}\n${r.stderr}`;
  for (const flag of REQUIRED_FLAGS) {
    check(`advertises ${flag}`, help.includes(flag));
  }
}

// ---------------------------------------------------------------------------
// Tier: live (one minimal paid run)
// ---------------------------------------------------------------------------

function runLiveTier() {
  console.log('live tier — minimal stream-json run (haiku, ~$0.01)');
  const r = spawnSync(
    'claude',
    ['-p', 'Reply with exactly: ok', '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-4-5'],
    { encoding: 'utf8', timeout: 180000, cwd: REPO_ROOT },
  );
  if (r.error || r.status !== 0) {
    check('claude -p stream-json run succeeds', false, r.error?.message ?? `exit ${r.status}`);
    return;
  }
  let result = null;
  let sawAssistant = false;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type === 'assistant') sawAssistant = true;
    if (evt.type === 'result') result = evt;
  }
  check('emits assistant events', sawAssistant);
  check('emits a result event', result !== null);
  if (!result) return;
  check('result.total_cost_usd is a number', typeof result.total_cost_usd === 'number');
  check('result.duration_ms is a number', typeof result.duration_ms === 'number');
  const u = result.usage ?? {};
  check(
    'result.usage carries the four token fields',
    ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(
      (k) => typeof u[k] === 'number',
    ),
    `usage keys: ${Object.keys(u).join(',')}`,
  );
  check(
    'result.modelUsage is a non-empty object (model attribution source)',
    result.modelUsage && typeof result.modelUsage === 'object' && Object.keys(result.modelUsage).length > 0,
  );
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const fixtureOnly = args.includes('--fixture-only');
const noLive = args.includes('--no-live');
const statusIdx = args.indexOf('--status-file');
const statusFile = statusIdx >= 0 ? args[statusIdx + 1] : null;

runFixtureTier();
if (!fixtureOnly) runFlagsTier();
if (!fixtureOnly && !noLive) runLiveTier();

const ok = failures.length === 0;
console.log(ok ? '\n✓ CC contract holds' : `\n✗ CC contract drift — ${failures.length} failure(s)`);

if (statusFile) {
  try {
    mkdirSync(dirname(statusFile), { recursive: true });
    writeFileSync(
      statusFile,
      `${JSON.stringify({ ts: new Date().toISOString(), ok, failures })}\n`,
    );
  } catch (e) {
    console.error(`status-file write failed: ${e.message}`);
  }
}

process.exit(ok ? 0 : 1);
