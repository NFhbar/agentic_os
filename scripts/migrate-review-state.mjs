#!/usr/bin/env node
// One-time, idempotent migration of project entries to the shared
// review-state contract (standard-review-state; Fable review Finding 4.2).
//
// The contract landed with the 0.4.x wave but the vault is per-install —
// each install migrates its own entries. This script does exactly what the
// mapping table in standard-review-state.md § "plan_status is lifecycle-only"
// documents:
//
//   legacy plan_status      new pair
//   reviewed-pending     →  drafted + review_status: pending
//   request-changes      →  drafted + review_status: request-changes
//   approved             →  drafted + review_status: approved
//
// plus the field renames: plan_review_path → review_path,
// plan_reviewed_at → reviewed_at. Entries already on the new vocabulary are
// untouched (run it twice — the second run reports 0 changes). Enforced by
// the plan-status-enum / review-status-enum audit errors, whose hints point
// here.
//
// Usage:
//   node scripts/migrate-review-state.mjs            # migrate + rebuild index
//   node scripts/migrate-review-state.mjs --dry-run  # print actions only

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIKI_DIR = join(REPO_ROOT, 'vault', 'wiki');

const LEGACY_PLAN_STATUS = {
  'reviewed-pending': 'pending',
  'request-changes': 'request-changes',
  approved: 'approved',
};

// Pure transform — exported for tests. Operates on the frontmatter block
// only; returns the (possibly unchanged) full text plus the action list.
export function migrateProjectText(text) {
  const actions = [];
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { text, actions };
  let fm = fmMatch[1];

  const planMatch = fm.match(/^plan_status:\s*['"]?([a-z-]+)['"]?\s*$/m);
  const legacy = planMatch ? LEGACY_PLAN_STATUS[planMatch[1]] : undefined;
  if (planMatch && legacy !== undefined) {
    const hasReviewStatus = /^review_status:/m.test(fm);
    const replacement = hasReviewStatus
      ? 'plan_status: drafted'
      : `plan_status: drafted\nreview_status: ${legacy}`;
    fm = fm.replace(planMatch[0], replacement);
    actions.push(
      `plan_status: ${planMatch[1]} → drafted${hasReviewStatus ? ' (review_status already present — kept)' : ` + review_status: ${legacy}`}`,
    );
  }

  if (/^plan_review_path:/m.test(fm)) {
    if (/^review_path:/m.test(fm)) {
      actions.push('plan_review_path: NOT renamed — review_path already present (resolve by hand)');
    } else {
      fm = fm.replace(/^plan_review_path:/m, 'review_path:');
      actions.push('plan_review_path → review_path');
    }
  }
  if (/^plan_reviewed_at:/m.test(fm)) {
    if (/^reviewed_at:/m.test(fm)) {
      actions.push('plan_reviewed_at: NOT renamed — reviewed_at already present (resolve by hand)');
    } else {
      fm = fm.replace(/^plan_reviewed_at:/m, 'reviewed_at:');
      actions.push('plan_reviewed_at → reviewed_at');
    }
  }

  const mutated = actions.some((a) => !a.includes('NOT renamed'));
  if (mutated) {
    fm = fm.replace(/^updated:\s*.*$/m, `updated: ${new Date().toISOString()}`);
  }
  return { text: text.replace(fmMatch[1], fm), actions };
}

function projectFiles() {
  const out = [];
  if (!existsSync(WIKI_DIR)) return out;
  for (const domain of readdirSync(WIKI_DIR, { withFileTypes: true })) {
    if (!domain.isDirectory() || domain.name.startsWith('.') || domain.name.startsWith('_'))
      continue;
    const projDir = join(WIKI_DIR, domain.name, 'project');
    if (!existsSync(projDir)) continue;
    for (const f of readdirSync(projDir)) {
      if (f.endsWith('.md')) out.push(join(projDir, f));
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const files = projectFiles();
  let migrated = 0;
  for (const p of files) {
    const before = readFileSync(p, 'utf8');
    const { text, actions } = migrateProjectText(before);
    if (actions.length === 0) continue;
    migrated += 1;
    console.log(`${dryRun ? '[dry-run] ' : ''}${relative(REPO_ROOT, p)}`);
    for (const a of actions) console.log(`  - ${a}`);
    if (!dryRun && text !== before) writeFileSync(p, text);
  }
  console.log(
    `${dryRun ? '[dry-run] ' : ''}${files.length} project entr${files.length === 1 ? 'y' : 'ies'} scanned, ${migrated} need${migrated === 1 ? 's' : ''} migration`,
  );
  if (!dryRun && migrated > 0) {
    spawnSync('node', [join(REPO_ROOT, '.claude', 'hooks', 'rebuild-vault-index.mjs')], {
      stdio: 'inherit',
    });
  }
}
