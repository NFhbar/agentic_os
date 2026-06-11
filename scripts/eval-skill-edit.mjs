#!/usr/bin/env node
// Replay-eval harness for skill edits — the mechanical half of
// meta-eval-skill-edit (Finding 3.3: SKILL.md edits ship with zero
// regression check while the runs table stores every prompt + output).
//
// v1 is scoped to dev-pr-review. The replay contract:
//   - the EDITED SKILL.md travels INLINE in the replay prompt (the on-disk
//     file is never touched — propose mode is read-only w.r.t. the target)
//   - the diff under review is PINNED to the head sha the original pass
//     saw, reconstructed from the merge commit when the entry predates
//     last_head_sha (merge^2 chain filtered by pass timestamp); the base is
//     the historic merge-base (merge^1 side), NOT today's main — after the
//     merge, merge-base(main, head) IS head and a three-dot diff is empty
//   - side effects are overridden off: no vault writes, no gh fetches or
//     posts, no event recording; the review lands in the final message
//
// Subcommands (all print JSON):
//   list-candidates [--limit N]           replayable historical runs
//   compose-replay --run <id> --skill-file <patched> --out <file>
//   replay --prompt-file <f> --model <m> --out-dir <d> [--skill <name>]
//
// Replays spawn through dispatch-claude's spawnClaude (the single spawn
// site) and deliberately do NOT create runs-table rows: they are eval
// artifacts, not OS work — a replay in the runs table would pollute the
// per-skill duration/cost history that wall caps and audits derive from.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';
import { extractResultEvent } from './runs-finalize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EVENTS_DB_PATH = join(REPO_ROOT, '.claude', 'state', 'events.db');
const PR_REVIEW_DIR = join(REPO_ROOT, 'vault', 'wiki', 'development', 'pr-review');
const ENTITY_DIR = join(REPO_ROOT, 'vault', 'wiki', 'development', 'entity');

export function extractPrRef(prompt) {
  const url = prompt.match(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (url) return { kind: 'url', owner: url[1], repo: url[2], number: Number(url[3]) };
  const change = prompt.match(/for change "([a-z0-9][a-z0-9-]*)"/);
  if (change) return { kind: 'change', change_id: change[1] };
  return null;
}

export function isContinuationPrompt(prompt) {
  return /continuation/i.test(prompt);
}

export function loadPrReviewIndex() {
  const byUrl = new Map();
  const byChange = new Map();
  if (!existsSync(PR_REVIEW_DIR)) return { byUrl, byChange };
  for (const f of readdirSync(PR_REVIEW_DIR)) {
    if (!f.endsWith('.md')) continue;
    const path = join(PR_REVIEW_DIR, f);
    let fm;
    try {
      ({ fm } = parseFrontmatter(readFileSync(path, 'utf8')));
    } catch {
      continue;
    }
    if (fm?.type !== 'pr-review') continue;
    const rec = {
      id: fm.id,
      path,
      pr_url: fm.pr_url ?? null,
      pr_number: fm.pr_number ?? null,
      repo: fm.repo ?? null,
      base: fm.base ?? 'main',
      branch: fm.branch ?? null,
      change_id: fm.change_id ?? null,
      last_head_sha: fm.last_head_sha ?? null,
      pass_count: fm.pass_count ?? null,
    };
    if (rec.pr_url) byUrl.set(rec.pr_url, rec);
    if (rec.change_id && !byChange.has(rec.change_id)) byChange.set(rec.change_id, rec);
  }
  return { byUrl, byChange };
}

function localPathForRepo(repoId) {
  const p = join(ENTITY_DIR, `${repoId}.md`);
  if (!existsSync(p)) return null;
  try {
    const { fm } = parseFrontmatter(readFileSync(p, 'utf8'));
    return fm?.kind === 'repo' ? (fm.local_path ?? null) : null;
  } catch {
    return null;
  }
}

function git(localPath, args) {
  const r = spawnSync('git', ['-C', localPath, ...args], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Pin the replay to the commit state the original pass reviewed. Strategy
// ladder (a repo's merge style decides which fires):
//   merge-commit  — true merges: head chain = merge^2, historic base =
//                   merge-base(merge^1, pinned). Never today's main: after
//                   the merge, merge-base(main, head) IS head → empty diff.
//   squash-branch — squash merges leave no merge commit, but the entry's
//                   `branch:` usually survives locally (or as origin/…);
//                   pin its tip at pass time, base = merge-base(squash^,
//                   pinned).
//   squash-only   — branch gone: the squash commit itself carries the
//                   FINAL diff. Not pass-time-accurate (later passes'
//                   fixes are baked in) — flagged so the judge can weigh it.
//   branch-only   — PR never merged: branch tip at pass time vs merge-base
//                   with the base branch.
export function pinForRun({ localPath, prNumber, base, branch, runStartedAt }) {
  const tryRefAtTime = (ref) => {
    if (!ref) return null;
    if (!git(localPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return null;
    return git(localPath, ['rev-list', '-1', `--until=${runStartedAt}`, ref]) ?? git(localPath, ['rev-parse', ref]);
  };

  const merge = git(localPath, ['rev-list', '--merges', '--grep', `Merge pull request #${prNumber} `, '-1', base]);
  if (merge) {
    const finalHead = git(localPath, ['rev-parse', `${merge}^2`]);
    if (finalHead) {
      const pinnedHead = git(localPath, ['rev-list', '-1', `--until=${runStartedAt}`, finalHead]) ?? finalHead;
      const baseSha = git(localPath, ['merge-base', `${merge}^1`, pinnedHead]);
      if (baseSha)
        return { ok: true, via: 'merge-commit', pinnedHead, baseSha, pinnedToPassTime: pinnedHead !== finalHead };
    }
  }

  const squash = git(localPath, ['log', base, '--fixed-strings', `--grep=(#${prNumber})`, '--format=%H', '-1']);
  if (squash) {
    const pinnedHead = tryRefAtTime(branch) ?? tryRefAtTime(branch ? `origin/${branch}` : null);
    if (pinnedHead) {
      const baseSha = git(localPath, ['merge-base', `${squash}^`, pinnedHead]);
      if (baseSha) return { ok: true, via: 'squash-branch', pinnedHead, baseSha, pinnedToPassTime: true };
    }
    const baseSha = git(localPath, ['rev-parse', `${squash}^`]);
    if (baseSha) return { ok: true, via: 'squash-only', pinnedHead: squash, baseSha, pinnedToPassTime: false };
  }

  const pinnedHead = tryRefAtTime(branch) ?? tryRefAtTime(branch ? `origin/${branch}` : null);
  if (pinnedHead) {
    const baseSha = git(localPath, ['merge-base', base, pinnedHead]);
    if (baseSha) return { ok: true, via: 'branch-only', pinnedHead, baseSha, pinnedToPassTime: true };
  }

  return { ok: false, reason: `no merge commit, squash commit, or branch ref found for PR #${prNumber} on ${base}` };
}

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(EVENTS_DB_PATH, { readOnly: true });
}

export async function listCandidates({ skill = 'dev-pr-review', limit = 3 } = {}) {
  const db = await openDb();
  const rows = db
    .prepare(
      `SELECT id, prompt, output_path, model, cost_usd, duration_ms, started_at
       FROM runs WHERE skill = ? AND state = 'done' ORDER BY started_at ASC`,
    )
    .all(skill);
  const { byUrl, byChange } = loadPrReviewIndex();
  const perPr = new Map(); // entry id → first (initial-pass) replayable run
  for (const row of rows) {
    if (isContinuationPrompt(row.prompt)) continue;
    const ref = extractPrRef(row.prompt);
    if (!ref) continue;
    const entry =
      ref.kind === 'url'
        ? byUrl.get(`https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`)
        : byChange.get(ref.change_id);
    if (!entry || perPr.has(entry.id)) continue;
    const localPath = localPathForRepo(entry.repo);
    const candidate = {
      run_id: row.id,
      run_started_at: row.started_at,
      run_model: row.model,
      run_cost_usd: row.cost_usd,
      output_path: row.output_path,
      pr_review_id: entry.id,
      pr_review_path: entry.path,
      pr_url: entry.pr_url,
      pr_number: entry.pr_number,
      repo: entry.repo,
      base: entry.base,
      local_path: localPath,
      replayable: false,
      reason: null,
      pin: null,
    };
    if (!localPath || !existsSync(localPath)) {
      candidate.reason = `repo entity local_path missing (${localPath ?? 'unset'})`;
    } else {
      const pin = pinForRun({
        localPath,
        prNumber: entry.pr_number,
        base: entry.base,
        branch: entry.branch,
        runStartedAt: row.started_at,
      });
      if (pin.ok) {
        candidate.replayable = true;
        candidate.pin = pin;
      } else {
        candidate.reason = pin.reason;
      }
    }
    perPr.set(entry.id, candidate);
  }
  // Most recent PRs first; replayable ones only count toward the limit.
  const all = [...perPr.values()].reverse();
  const replayable = all.filter((c) => c.replayable).slice(0, limit);
  const skipped = all.filter((c) => !c.replayable);
  return { replayable, skipped };
}

export function composeReplayPrompt({ storedPrompt, patchedSkill, localPath, baseSha, pinnedHead, prUrl }) {
  return `REPLAY EVAL MODE — read this entire preamble before acting; it OVERRIDES any conflicting instruction in the replayed dispatch prompt at the bottom.

You are re-running a historical dev-pr-review pass to evaluate an EDITED version of the skill. Rules:

1. The SKILL.md content between the SKILL-OVERRIDE markers below SUPERSEDES .claude/skills/dev-pr-review/SKILL.md on disk. Do NOT read the on-disk skill file; follow the inline version's Procedure.
2. The diff under review is PINNED. Do NOT run \`gh pr diff\`, \`gh pr view\`, or fetch ANY live PR state (the PR at ${prUrl} has moved since this pass ran). Obtain the diff with EXACTLY:
   git -C ${localPath} diff ${baseSha} ${pinnedHead}
   To read a file's full content as it existed under review:
   git -C ${localPath} show ${pinnedHead}:<path>
3. NO side effects: do not create or edit ANY file in vault/, do not run record-dashboard-action.mjs or write to events.db, do not post review comments to GitHub, do not modify the repo at ${localPath}. Skip every step of the skill that publishes, persists, or records — produce the review content only.
4. Output contract: your FINAL message must be the complete review you would have filed, structured as the skill's comment format (one block per comment: severity, category, file:line, body), followed by a one-line summary count (N bug / N blocker / N suggestion / N nit). No prose about being in replay mode.

===== SKILL-OVERRIDE BEGIN =====
${patchedSkill}
===== SKILL-OVERRIDE END =====

The historical dispatch prompt being replayed (its PR reference and entry-edit instructions are overridden by rules 2 and 3 above):

${storedPrompt}`;
}

async function cmdListCandidates(args) {
  const limit = Number(argValue(args, '--limit') ?? 3);
  const skill = argValue(args, '--skill') ?? 'dev-pr-review';
  console.log(JSON.stringify(await listCandidates({ skill, limit }), null, 2));
}

async function cmdComposeReplay(args) {
  const runId = argValue(args, '--run');
  const skillFile = argValue(args, '--skill-file');
  const out = argValue(args, '--out');
  if (!runId || !skillFile || !out) {
    console.error('usage: compose-replay --run <run_id> --skill-file <patched SKILL.md> --out <prompt-file>');
    process.exit(1);
  }
  const db = await openDb();
  const row = db
    .prepare(`SELECT id, prompt, started_at FROM runs WHERE id = ?`)
    .get(runId);
  if (!row) {
    console.error(`run ${runId} not found`);
    process.exit(1);
  }
  const { byUrl, byChange } = loadPrReviewIndex();
  const ref = extractPrRef(row.prompt);
  const entry =
    ref?.kind === 'url'
      ? byUrl.get(`https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`)
      : byChange.get(ref?.change_id);
  if (!entry) {
    console.error(`cannot resolve a pr-review entry from run ${runId}'s prompt`);
    process.exit(1);
  }
  const localPath = localPathForRepo(entry.repo);
  const pin = pinForRun({
    localPath,
    prNumber: entry.pr_number,
    base: entry.base,
    branch: entry.branch,
    runStartedAt: row.started_at,
  });
  if (!pin.ok) {
    console.error(`pin failed: ${pin.reason}`);
    process.exit(1);
  }
  const prompt = composeReplayPrompt({
    storedPrompt: row.prompt,
    patchedSkill: readFileSync(skillFile, 'utf8'),
    localPath,
    baseSha: pin.baseSha,
    pinnedHead: pin.pinnedHead,
    prUrl: entry.pr_url,
  });
  const { writeFileSync } = await import('node:fs');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, prompt);
  console.log(
    JSON.stringify(
      { prompt_file: out, run_id: runId, pr_review_id: entry.id, pr_review_path: entry.path, pin },
      null,
      2,
    ),
  );
}

async function cmdReplay(args) {
  const promptFile = argValue(args, '--prompt-file');
  const model = argValue(args, '--model');
  const outDir = argValue(args, '--out-dir') ?? join(REPO_ROOT, 'vault', 'output', 'meta', 'tuning-evals');
  const skill = argValue(args, '--skill') ?? 'dev-pr-review';
  if (!promptFile || !model) {
    console.error('usage: replay --prompt-file <f> --model <m> [--out-dir <d>] [--skill <name>]');
    process.exit(1);
  }
  const prompt = readFileSync(promptFile, 'utf8');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = join(outDir, `replay-${stamp}.jsonl`);
  const fd = openSync(jsonlPath, 'w');
  const { spawnClaude } = await import('./dispatch-claude.mjs');
  const { child } = await spawnClaude(prompt, skill, {
    logPrefix: 'replay-eval',
    stdio: ['ignore', fd, fd],
    model,
  });
  const exit = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  const result = extractResultEvent(jsonlPath);
  console.log(
    JSON.stringify(
      {
        jsonl_path: jsonlPath,
        exit,
        ok: exit === 0 && result != null && !result.isError,
        total_cost_usd: result?.costUsd ?? null,
        duration_ms: result?.durationMs ?? null,
        result_text: result?.resultText ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(exit === 0 ? 0 : 1);
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'list-candidates') await cmdListCandidates(rest);
  else if (cmd === 'compose-replay') await cmdComposeReplay(rest);
  else if (cmd === 'replay') await cmdReplay(rest);
  else {
    console.error('usage: eval-skill-edit.mjs <list-candidates|compose-replay|replay> [flags]');
    process.exit(1);
  }
}
