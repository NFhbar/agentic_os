// Cluster session-transcript turns into recurring-workflow candidates.
//
// The mechanical half of meta-mine-sessions: reads kind='session' rows from
// events.db (imported by import-session-usage.mjs, which stores a per-turn
// tool/file digest in `raw`), normalizes each turn's intent into a template
// key, and aggregates clusters by frequency + spend. The skill layers
// judgment on top (classifying clusters as skill / schedule / orchestrator
// candidates); this script only counts.
//
// Why: ~46:1 of OS spend was interactive and unmined — the Fable review
// found 29 hand-typed "Run the dev-write-change skill…" turns (~$594) that
// were dispatch-shaped work the OS couldn't see (Finding 2.2 / Bet 2).
//
// Usage:
//   node scripts/mine-sessions.mjs              # human-readable, 28-day window
//   node scripts/mine-sessions.mjs --days 7
//   node scripts/mine-sessions.mjs --json       # full structured output

const APPROVALS = new Set([
  'yes', 'y', 'ok', 'okay', 'go', 'go ahead', 'continue', 'proceed', 'sure',
  'do it', 'yes please', 'sounds good', 'lgtm', 'correct', 'yep', 'yeah',
  'next', 'ship it', 'approved', 'looks good',
]);

function normalizeKey(text) {
  let t = (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  t = t.replace(/"[^"]*"/g, '"<x>"');
  t = t.replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, '<id>');
  t = t.replace(/\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g, '<slug>');
  t = t.replace(/@?[\w./-]*\//g, '<path>/');
  t = t.replace(/\b\d+\b/g, '<n>');
  return t.split(' ').slice(0, 10).join(' ');
}

export function classifyTurn(row) {
  if (row.action === 'slash-command') return { key: `slash:/${row.skill ?? '?'}`, kind: 'slash' };
  const desc = (row.description ?? '').trim();
  const lower = desc.toLowerCase().replace(/[.!]+$/, '');
  // Headless `claude -p` runs ALSO write transcripts under ~/.claude/projects,
  // so dispatched runs re-import as "session" turns — their prompts carry the
  // dispatcher template's signature. Surfacing them as their own kind keeps
  // them out of "manual workflow" candidates AND exposes the double-count
  // (the same spend already exists as kind=dashboard/schedule events).
  if (
    /read .*\.claude\/skills\/.* and follow its procedure/i.test(desc) ||
    /skill\.md and follow its procedure/i.test(lower) ||
    /\bdispatched by the\b/i.test(lower)
  ) {
    return { key: 'dispatched-run transcript echoes (headless claude -p)', kind: 'dispatched-echo' };
  }
  if (APPROVALS.has(lower) || (lower.length <= 14 && lower.split(/\s+/).length <= 2)) {
    return { key: 'approval / continuation turns', kind: 'approval' };
  }
  if (desc.startsWith('This session is being continued')) {
    return { key: 'compaction continuations', kind: 'compaction' };
  }
  if (desc.startsWith('<command-message>')) {
    return { key: `slash:/${row.skill ?? '?'}`, kind: 'slash' };
  }
  return { key: normalizeKey(desc), kind: 'freeform' };
}

export async function mineSessions({ days = 28 } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const db = new DatabaseSync(join(repoRoot, '.claude', 'state', 'events.db'), {
    readOnly: true,
  });
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT ts, action, skill, cost_usd, description, raw FROM events
          WHERE kind = 'session' AND ts > datetime('now', ?)
          ORDER BY ts ASC`,
      )
      .all(`-${days} days`);
  } finally {
    db.close();
  }

  const clusters = new Map();
  for (const row of rows) {
    const { key, kind } = classifyTurn(row);
    let c = clusters.get(key);
    if (!c) {
      c = { key, kind, count: 0, cost_usd: 0, tools: {}, files: {}, samples: [] };
      clusters.set(key, c);
    }
    c.count += 1;
    c.cost_usd += row.cost_usd ?? 0;
    try {
      const digest = JSON.parse(row.raw ?? '{}').digest;
      for (const [tool, n] of Object.entries(digest?.tools ?? {})) {
        c.tools[tool] = (c.tools[tool] ?? 0) + n;
      }
      for (const f of digest?.files ?? []) c.files[f] = (c.files[f] ?? 0) + 1;
    } catch {
      /* pre-digest row */
    }
    if (c.samples.length < 2 && row.description) {
      c.samples.push(row.description.slice(0, 110));
    }
  }

  const top = (obj, n) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}×${v}`);

  const out = [...clusters.values()]
    .map((c) => ({
      key: c.key,
      kind: c.kind,
      count: c.count,
      cost_usd: Math.round(c.cost_usd * 100) / 100,
      avg_cost_usd: Math.round((c.cost_usd / c.count) * 100) / 100,
      tools_top: top(c.tools, 5),
      files_top: top(c.files, 5),
      samples: c.samples,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  return { window_days: days, turns: rows.length, clusters: out };
}

const invokedDirectly =
  process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? Number.parseInt(args[daysIdx + 1], 10) || 28 : 28;
  const result = await mineSessions({ days });
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.turns} turns / ${result.clusters.length} clusters — last ${days}d\n`);
    for (const c of result.clusters.slice(0, 20)) {
      console.log(
        `$${String(c.cost_usd).padStart(8)}  ×${String(c.count).padStart(4)}  [${c.kind}] ${c.key}`,
      );
      if (c.tools_top.length) console.log(`            tools: ${c.tools_top.join(', ')}`);
    }
  }
}
