#!/usr/bin/env node
// Routable non-skill tuning targets — the path map that lets the Overseer
// loop name TypeScript/script/route surfaces, not just markdown skills.
//
// Finding 3.2 (research-fable-os-review-2026-06-11): the Overseer's most
// consequential orchestrator finding was rationale-only because tuning
// suggestions could only target SKILL.md files — the suggestion guessed the
// orchestrator lives in "domains/development/playbook.md or the runner
// script" when it lives in routes/automation.ts. This module is the single
// source of truth mapping canonical target ids → repo paths so propose-mode
// names the right file and scaffolds a change instead of a dead end.
//
// Consumers: meta-overseer-review (emits `target_kind` + canonical ids),
// meta-apply-tuning-suggestion (resolves ids → paths, scaffolds changes),
// audit.mjs (tuning-target-path-missing freshness check).
//
// CLI: node scripts/tuning-targets.mjs            # list the map
//      node scripts/tuning-targets.mjs <name>     # resolve one target (JSON)

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const TARGET_KINDS = ['skill', 'orchestrator', 'route', 'script'];

// Where a change scaffolded for any of these targets should land. The repo
// id must match the OS repo entity (vault/wiki/development/entity/<repo>.md,
// kind: repo) — per-install, so consumers verify it exists before composing.
export const CHANGE_DEFAULTS = { domain: 'development', repo: 'agentic-os' };

export const TUNING_TARGETS = [
  {
    id: 'automation-orchestrator',
    kind: 'orchestrator',
    aliases: [
      'orchestrator',
      'automation orchestrator',
      'meta automation orchestrator',
      'change lifecycle orchestrator',
      'automation state machine',
    ],
    paths: [
      'domains/meta/app/server/routes/automation.ts',
      'domains/meta/app/server/routes/automation-state-machine.ts',
    ],
    summary:
      'Change-lifecycle automation: the state machine + dispatch policy that advances changes plan → review → execute → PR.',
  },
  {
    id: 'router-vocabulary',
    kind: 'route',
    aliases: ['router', 'os router', 'intent vocabulary', 'router vocabulary table', 'intent table'],
    paths: ['OS.md'],
    summary:
      'The /os intent → skill vocabulary table in OS.md. The os skill reads it at dispatch time; the table is the tunable surface.',
  },
  {
    id: 'dispatch-helper',
    kind: 'script',
    aliases: ['dispatch', 'claude dispatch', 'dispatch claude', 'spawn helper', 'dispatch script'],
    paths: ['scripts/dispatch-claude.mjs'],
    summary:
      'The single claude spawn site: effort/model resolution, per-skill wall-time caps, arg building.',
  },
  {
    id: 'scheduler',
    kind: 'script',
    aliases: ['scheduler tick', 'runbook scheduler', 'launchd tick'],
    paths: ['scripts/scheduler-tick.mjs'],
    summary: 'Per-minute tick: due-runbook evaluation, precondition queries, dispatch.',
  },
  {
    id: 'runs-supervisor',
    kind: 'script',
    aliases: ['supervisor', 'run supervision', 'runs finalizer', 'run finalization'],
    paths: ['scripts/runs-supervisor.mjs', 'scripts/runs-finalize.mjs'],
    summary:
      'Dead-run sweep, wall-cap enforcement, and terminal-state finalization for dispatched runs.',
  },
  {
    id: 'session-importer',
    kind: 'script',
    aliases: ['importer', 'session usage importer', 'transcript importer', 'usage importer'],
    paths: ['scripts/import-session-usage.mjs'],
    summary:
      'Transcript → events.db importer: slash attribution, token/cost computation, workflow digests.',
  },
  {
    id: 'os-audit',
    kind: 'script',
    aliases: ['audit', 'audit script', 'structural audit', 'os audit script'],
    paths: ['scripts/audit.mjs'],
    summary: 'The structural audit: skills/wiki/router/dispatch checks.',
  },
];

export function normalizeTargetName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Resolution order: exact id → exact alias → substring (historical audits
// wrote free prose like "meta — automation orchestrator"; the substring pass
// rescues those). Returns the target object or null.
export function resolveTuningTarget(name) {
  const norm = normalizeTargetName(name);
  if (!norm) return null;
  for (const t of TUNING_TARGETS) {
    if (t.id === norm) return t;
  }
  for (const t of TUNING_TARGETS) {
    if (t.aliases.some((a) => normalizeTargetName(a) === norm)) return t;
  }
  for (const t of TUNING_TARGETS) {
    if (norm.includes(t.id)) return t;
    if (t.aliases.some((a) => norm.includes(normalizeTargetName(a)))) return t;
  }
  return null;
}

export function missingTargetPaths() {
  const missing = [];
  for (const t of TUNING_TARGETS) {
    for (const p of t.paths) {
      if (!existsSync(join(REPO_ROOT, p))) missing.push({ id: t.id, path: p });
    }
  }
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    for (const t of TUNING_TARGETS) {
      console.log(`${t.id}  (${t.kind})\n  paths:   ${t.paths.join(', ')}\n  aliases: ${t.aliases.join(' | ')}`);
    }
  } else {
    const t = resolveTuningTarget(name);
    if (!t) {
      console.error(`no tuning target matches "${name}" — extend TUNING_TARGETS in scripts/tuning-targets.mjs if this surface should be routable`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ...t, change_defaults: CHANGE_DEFAULTS }, null, 2));
  }
}
