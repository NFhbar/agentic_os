// Project automation orchestrator. Phase 1 — schema + state machine + minimal
// UI. Drives one change at a time through its lifecycle:
//   write → open-pr → review → merge → (advance to next eligible change)
//
// State persists in the project entry's `automation:` frontmatter block so it
// survives server restarts and is readable in the markdown source. The
// orchestrator is dispatched manually for Phase 1 (Start/Pause/Resume/Stop
// buttons + Continue/tick on run completion) — Phase 1.5 wires automatic
// tick-on-run-terminate.

import { spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { rewriteFrontmatter } from '../frontmatter-rewrite.js';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import type {
  AutomationConfig,
  AutomationConfigureBody,
  AutomationPauseGate,
  AutomationState,
  AutomationStatusResponse,
  AutomationStep,
  AutomationTickBody,
  ChangeAutomationDecision,
  ChangeAutomationStatusResponse,
  ChangeAutomationStep,
} from './automation.types.js';
import type { ChangeAutomation } from './changes.types.js';
import { startRun } from './runs.js';

// Re-export wire-shape types for backward-compat. New consumers should import
// from ./automation.types.js per standard-shared-types.
export type {
  AutomationConfig,
  AutomationConfigureBody,
  AutomationPauseGate,
  AutomationPhase,
  AutomationState,
  AutomationStatusResponse,
  AutomationStep,
  AutomationTickBody,
  ChangeAutomationDecision,
  ChangeAutomationStatusResponse,
  ChangeAutomationStep,
} from './automation.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Canonical step order. The orchestrator advances through these positions
// when ticking forward after a successful skill run.
const STEP_ORDER: AutomationStep[] = ['write', 'open-pr', 'review', 'merge'];

// Map each step to the skill the orchestrator dispatches to drive it. The
// prompt body is built per-tick so the change_id is interpolated.
const STEP_SKILL: Record<AutomationStep, string> = {
  write: 'dev-write-change',
  'open-pr': 'dev-open-pr',
  review: 'dev-pr-review',
  // `merge` is the terminal step — no skill, the orchestrator just waits for
  // `change.status: merged` (via existing change-merge flow) and then ticks
  // forward to the next eligible change.
  merge: '',
};

// Default config block written when a project's automation is first enabled.
// `pause_on` defaults — the two gates we lock for Phase 1 per the design
// decisions captured in the smaller-fills planning AskUserQuestion.
const DEFAULT_PAUSE_GATES: AutomationPauseGate[] = ['review-not-approved', 'skill-failure'];

function defaultAutomationConfig(): AutomationConfig {
  return {
    enabled: false,
    mode: 'sequential-changes',
    pause_on: [...DEFAULT_PAUSE_GATES],
    state: {
      phase: 'idle',
      current_change: null,
      current_step: null,
      paused_reason: null,
      last_transition: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — file walks + frontmatter I/O
// ---------------------------------------------------------------------------

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Locate the project entry by id. Returns frontmatter + path; null when no
// project entry exists (typo guard for every endpoint).
async function findProject(
  projectId: string,
): Promise<{ fm: Record<string, unknown>; path: string; content: string } | null> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf8');
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type === 'project' && fm.id === projectId) {
        return { fm: fm as Record<string, unknown>, path: file, content };
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

// Read the automation block from a project's frontmatter. Returns the
// default (disabled) config when the block is absent — every endpoint
// treats missing-block as "automation has never been configured."
export function readAutomationConfig(fm: Record<string, unknown>): AutomationConfig {
  const raw = fm.automation;
  if (!raw || typeof raw !== 'object') return defaultAutomationConfig();
  const r = raw as Record<string, unknown>;
  const stateRaw = (r.state && typeof r.state === 'object' ? r.state : {}) as Record<
    string,
    unknown
  >;
  return {
    enabled: r.enabled === true,
    mode: 'sequential-changes',
    pause_on: Array.isArray(r.pause_on)
      ? r.pause_on.filter(
          (x): x is AutomationPauseGate => x === 'review-not-approved' || x === 'skill-failure',
        )
      : [...DEFAULT_PAUSE_GATES],
    state: {
      phase:
        stateRaw.phase === 'running' || stateRaw.phase === 'paused' || stateRaw.phase === 'failed'
          ? stateRaw.phase
          : 'idle',
      current_change: typeof stateRaw.current_change === 'string' ? stateRaw.current_change : null,
      current_step: isAutomationStep(stateRaw.current_step) ? stateRaw.current_step : null,
      paused_reason: typeof stateRaw.paused_reason === 'string' ? stateRaw.paused_reason : null,
      last_transition:
        typeof stateRaw.last_transition === 'string' ? stateRaw.last_transition : null,
    },
  };
}

function isAutomationStep(v: unknown): v is AutomationStep {
  return v === 'write' || v === 'open-pr' || v === 'review' || v === 'merge';
}

// Write the automation block back to the project's frontmatter. Serializes
// the whole block on one line (JSON-style YAML flow) so the surgical
// line-based rewriter can replace it atomically. Also bumps `updated`.
async function writeAutomationConfig(projectPath: string, config: AutomationConfig): Promise<void> {
  const content = await readFile(projectPath, 'utf8');
  const nowIso = new Date().toISOString();
  const updated = rewriteFrontmatter(content, {
    automation: config,
    updated: nowIso,
  });
  await writeFile(projectPath, updated, 'utf8');
}

// Locate every change entry owned by this project (frontmatter `project: <id>`).
// Returns refs sorted by `created` ascending — the v1 ordering rule (oldest
// first). Filters out terminal changes (status: merged or abandoned) since
// the orchestrator can't act on those.
async function findEligibleChanges(
  projectId: string,
): Promise<Array<{ id: string; title: string; status: string; path: string; created: string }>> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  const out: Array<{ id: string; title: string; status: string; path: string; created: string }> =
    [];
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'change') continue;
      if (fm.project !== projectId) continue;
      const status = typeof fm.status === 'string' ? fm.status : '';
      if (status === 'merged' || status === 'abandoned') continue;
      out.push({
        id: typeof fm.id === 'string' ? fm.id : '',
        title: typeof fm.title === 'string' ? fm.title : '(untitled)',
        status,
        path: relative(REPO_ROOT, file),
        created:
          typeof fm.created === 'string'
            ? fm.created
            : fm.created instanceof Date
              ? fm.created.toISOString()
              : '',
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.created.localeCompare(b.created));
  return out;
}

// Map a change's status to the orchestrator step that would drive it forward.
// Used both when starting fresh on a change and when resuming after a pause.
function stepForChangeStatus(status: string): AutomationStep | null {
  if (status === 'planning' || status === 'in-progress') return 'write';
  if (status === 'in-review') return 'review';
  // merged/abandoned aren't eligible (filtered by findEligibleChanges);
  // unknown statuses also fall through.
  return null;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

// Build the orchestrator prompt for a (step, change) pair. Embeds the
// change_id so the dispatched skill knows what to work on. Skills are
// invoked via their canonical SKILL.md path so the LLM picks up the
// procedure exactly as authored.
function buildStepPrompt(step: AutomationStep, changeId: string): string {
  const skill = STEP_SKILL[step];
  return `Run the ${skill} skill for change "${changeId}".

Inputs:
- change: ${changeId}

Read .claude/skills/${skill}/SKILL.md and follow its Procedure exactly.
Do NOT use AskUserQuestion or any interactive prompt — automation is driving the dispatch. Report a tight summary of what was produced when done.`;
}

// Pick the next change to drive after a successful merge (or on Start).
// Returns null when no eligible changes remain → orchestrator goes idle.
async function pickNextChange(
  projectId: string,
): Promise<{ id: string; status: string; step: AutomationStep } | null> {
  const eligible = await findEligibleChanges(projectId);
  for (const c of eligible) {
    const step = stepForChangeStatus(c.status);
    if (step) return { id: c.id, status: c.status, step };
  }
  return null;
}

// Dispatch the skill for the given step against the given change. Returns
// the run_id on success or an error on dispatch failure. Caller is
// responsible for updating the automation state to reflect the dispatch.
async function dispatchStep(
  projectId: string,
  changeId: string,
  step: AutomationStep,
  projectDomain: string | null,
): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const skill = STEP_SKILL[step];
  if (!skill) {
    // `merge` step — no skill to dispatch. The orchestrator just waits for
    // the change status to flip to `merged` and ticks forward.
    return { ok: false, error: 'merge step has no dispatchable skill' };
  }
  const result = await startRun({
    prompt: buildStepPrompt(step, changeId),
    title: `[automation] ${skill} ${changeId}`,
    tags: {
      project: projectId,
      domain: projectDomain ?? undefined,
      change_id: changeId,
      skill,
    },
  });
  if (!result.ok) {
    if ('blocking' in result) {
      return { ok: false, error: `blocked by run ${result.blocking.run_id}` };
    }
    return { ok: false, error: result.error };
  }
  return { ok: true, run_id: result.run_id };
}

// Build the status response — single source of truth for what the client
// renders. Includes the current change snapshot + index so the UI can show
// "Running change X (step 3 of 4)" without a second fetch.
async function buildStatusResponse(
  projectId: string,
  config: AutomationConfig,
): Promise<AutomationStatusResponse> {
  const eligible = await findEligibleChanges(projectId);
  let snap: AutomationStatusResponse['current_change_summary'] = null;
  let idx: number | null = null;
  const cur = config.state.current_change;
  if (cur) {
    const i = eligible.findIndex((c) => c.id === cur);
    if (i >= 0) {
      snap = {
        id: eligible[i].id,
        title: eligible[i].title,
        status: eligible[i].status,
        path: eligible[i].path,
      };
      idx = i + 1;
    }
  }
  return {
    ok: true,
    config,
    current_change_summary: snap,
    current_change_index: idx,
    total_eligible_changes: eligible.length,
  };
}

// Read the most recent pr-review entry for a given change and project, and
// normalize its `result` frontmatter into the wire-shape `review_result`
// the orchestrator's tick handler expects. Returns null when no entry exists
// yet (skill ran but the writeback step hasn't landed — treat as a pause).
//
// Mapping: entry.result === 'approved' | 'comment' → 'approve' (no blocker);
// 'request-changes' → 'changes' (must pause); 'none' / missing → null
// (review didn't reach a verdict; let the skill-failure gate handle it).
async function readLatestReviewResultForChange(
  changeId: string,
): Promise<'approve' | 'changes' | 'block' | null> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  // Pick the freshest pr-review entry for this change by updated/created.
  let pick: { result: string | null; updated: string } | null = null;
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'pr-review') continue;
      if (fm.change_id !== changeId) continue;
      const updated =
        typeof fm.updated === 'string'
          ? fm.updated
          : fm.updated instanceof Date
            ? fm.updated.toISOString()
            : typeof fm.created === 'string'
              ? fm.created
              : '';
      const result = typeof fm.result === 'string' ? fm.result : null;
      if (!pick || updated.localeCompare(pick.updated) > 0) {
        pick = { result, updated };
      }
    } catch {
      /* skip */
    }
  }
  if (!pick || !pick.result) return null;
  if (pick.result === 'approved' || pick.result === 'comment') return 'approve';
  if (pick.result === 'request-changes') return 'changes';
  return null;
}

// Core tick state machine — pure-ish (writes frontmatter + records audit
// internally; returns the new status). Shared between the HTTP /tick handler
// and the run-completion hook (`onAutomationStepComplete`).
//
// Returns the new status on success or an `error` string on dispatch failure.
async function executeTick(
  found: { fm: Record<string, unknown>; path: string },
  config: AutomationConfig,
  body: AutomationTickBody,
  projectId: string,
): Promise<{ ok: true; status: AutomationStatusResponse } | { ok: false; error: string }> {
  if (config.state.phase !== 'running') {
    // Not running — tick is a no-op. Return current status without writing.
    return { ok: true, status: await buildStatusResponse(projectId, config) };
  }
  const { skill, change_id, exit_status, review_result } = body;
  if (config.state.current_change !== change_id) {
    // Stale tick — ignore (idempotency guard).
    return { ok: true, status: await buildStatusResponse(projectId, config) };
  }
  // Gate 1: skill failure → pause if the gate is enabled.
  if (exit_status !== 0 && config.pause_on.includes('skill-failure')) {
    const next: AutomationConfig = {
      ...config,
      state: {
        ...config.state,
        phase: 'paused',
        paused_reason: `${skill} exited ${exit_status}`,
        last_transition: new Date().toISOString(),
      },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit(
      'automation-pause',
      { project: projectId, reason: `${skill}:exit-${exit_status}` },
      [relative(REPO_ROOT, found.path)],
    );
    return { ok: true, status: await buildStatusResponse(projectId, next) };
  }
  // Gate 2: review-not-approved → pause if the gate is enabled.
  if (
    skill === 'dev-pr-review' &&
    config.pause_on.includes('review-not-approved') &&
    review_result &&
    review_result !== 'approve'
  ) {
    const next: AutomationConfig = {
      ...config,
      state: {
        ...config.state,
        phase: 'paused',
        paused_reason: `review returned ${review_result}`,
        last_transition: new Date().toISOString(),
      },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit('automation-pause', { project: projectId, reason: `review:${review_result}` }, [
      relative(REPO_ROOT, found.path),
    ]);
    return { ok: true, status: await buildStatusResponse(projectId, next) };
  }
  // Advance: success → next step OR next change.
  const curIdx = config.state.current_step ? STEP_ORDER.indexOf(config.state.current_step) : -1;
  const nextStep = curIdx >= 0 && curIdx < STEP_ORDER.length - 1 ? STEP_ORDER[curIdx + 1] : null;
  const projectDomain = typeof found.fm.domain === 'string' ? found.fm.domain : null;

  if (nextStep && nextStep !== 'merge') {
    const dispatch = await dispatchStep(projectId, change_id, nextStep, projectDomain);
    if (!dispatch.ok) return { ok: false, error: `dispatch failed: ${dispatch.error}` };
    const next: AutomationConfig = {
      ...config,
      state: { ...config.state, current_step: nextStep, last_transition: new Date().toISOString() },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit(
      'automation-advance',
      { project: projectId, change: change_id, step: nextStep, run_id: dispatch.run_id },
      [relative(REPO_ROOT, found.path)],
    );
    return { ok: true, status: await buildStatusResponse(projectId, next) };
  }

  if (nextStep === 'merge') {
    const next: AutomationConfig = {
      ...config,
      state: { ...config.state, current_step: 'merge', last_transition: new Date().toISOString() },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit('automation-advance', { project: projectId, change: change_id, step: 'merge' }, [
      relative(REPO_ROOT, found.path),
    ]);
    return { ok: true, status: await buildStatusResponse(projectId, next) };
  }

  // We're at `merge` already — pick next change OR go idle.
  const pick = await pickNextChange(projectId);
  if (!pick) {
    const next: AutomationConfig = {
      ...config,
      state: {
        phase: 'idle',
        current_change: null,
        current_step: null,
        paused_reason: null,
        last_transition: new Date().toISOString(),
      },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit('automation-complete', { project: projectId }, [relative(REPO_ROOT, found.path)]);
    return { ok: true, status: await buildStatusResponse(projectId, next) };
  }
  const dispatch = await dispatchStep(projectId, pick.id, pick.step, projectDomain);
  if (!dispatch.ok) return { ok: false, error: `dispatch failed: ${dispatch.error}` };
  const next: AutomationConfig = {
    ...config,
    state: {
      ...config.state,
      current_change: pick.id,
      current_step: pick.step,
      last_transition: new Date().toISOString(),
    },
  };
  await writeAutomationConfig(found.path, next);
  recordAudit(
    'automation-advance',
    { project: projectId, change: pick.id, step: pick.step, run_id: dispatch.run_id },
    [relative(REPO_ROOT, found.path)],
  );
  return { ok: true, status: await buildStatusResponse(projectId, next) };
}

// Phase 1.5 entry point — called by `runs.ts` after a skill run terminates.
// Looks up the project's automation state and, when the terminating run is
// the current automation step, ticks the state machine forward. No-op when
// the project doesn't exist, automation isn't enabled, or the run is stale
// (different project / change / skill than what's tracked).
//
// Best-effort: errors are logged to console only — the calling code's job
// (finishRun → recordEvent) must complete regardless.
export async function onAutomationStepComplete(
  projectId: string | null | undefined,
  changeId: string | null | undefined,
  skill: string | null | undefined,
  exitStatus: number | null | undefined,
): Promise<void> {
  if (!projectId || !changeId || !skill || exitStatus === null || exitStatus === undefined) return;
  // Only relevant skills can advance the orchestrator.
  const stepEntry = (Object.entries(STEP_SKILL) as Array<[AutomationStep, string]>).find(
    ([, s]) => s === skill,
  );
  if (!stepEntry) return;
  try {
    const found = await findProject(projectId);
    if (!found) return;
    const config = readAutomationConfig(found.fm);
    if (!config.enabled || config.state.phase !== 'running') return;
    if (config.state.current_change !== changeId || config.state.current_step !== stepEntry[0]) {
      // Stale — the orchestrator already moved on (e.g. user manually
      // resumed or this was an orphan run). Quiet exit.
      return;
    }
    let review_result: 'approve' | 'changes' | 'block' | null = null;
    if (skill === 'dev-pr-review' && exitStatus === 0) {
      review_result = await readLatestReviewResultForChange(changeId);
    }
    const result = await executeTick(
      found,
      config,
      { skill, change_id: changeId, exit_status: exitStatus, review_result },
      projectId,
    );
    if (!result.ok) {
      console.error(`automation auto-tick failed for ${projectId}/${changeId}: ${result.error}`);
    }
  } catch (e) {
    console.error(
      `automation auto-tick threw for ${projectId}/${changeId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

// Phase 1.5+1 — periodic merge watcher. The orchestrator parks at the
// `merge` step after dev-pr-review approves, because the actual PR merge
// happens outside our skill-dispatch surface (GitHub UI, `gh pr merge`,
// dashboard Mark Merged, pr-ci-poll runbook flipping status:merged). None
// of those paths fire `onAutomationStepComplete`. This watcher polls every
// 60s and ticks any parked automation whose current_change has finally
// reached `status: merged`.
//
// Cheap by design: walks projects once, checks each candidate's current
// change once. Typical setup is <20 projects → <40 file reads per cycle.
async function isChangeMerged(changeId: string): Promise<boolean> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'change' || fm.id !== changeId) continue;
      return fm.status === 'merged';
    } catch {
      /* skip */
    }
  }
  // Change file missing = treat as not merged. The stuck-running audit hook
  // catches the prolonged-park case independently.
  return false;
}

// Sweep every project, advance any whose current change is now merged.
// Best-effort: per-project errors log to console and don't propagate, so
// one stuck project doesn't block the rest.
export async function checkMergedChangesAndAdvance(): Promise<void> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { fm, parseError } = parseFrontmatter(content);
    if (parseError) continue;
    if (fm.type !== 'project') continue;
    const projectId = typeof fm.id === 'string' ? fm.id : null;
    if (!projectId) continue;
    const config = readAutomationConfig(fm as Record<string, unknown>);
    if (!config.enabled) continue;
    if (config.state.phase !== 'running') continue;
    if (config.state.current_step !== 'merge') continue;
    if (!config.state.current_change) continue;
    try {
      const merged = await isChangeMerged(config.state.current_change);
      if (!merged) continue;
      // Synthesize a merge-complete tick. `change-merge` is a virtual skill
      // name — it doesn't dispatch anything, just drives the state machine's
      // merge → pickNext path. Distinct from `dev-*` so the review-result
      // gate (which only triggers on dev-pr-review) stays inert.
      const result = await executeTick(
        { fm: fm as Record<string, unknown>, path: file },
        config,
        {
          skill: 'change-merge',
          change_id: config.state.current_change,
          exit_status: 0,
        },
        projectId,
      );
      if (!result.ok) {
        console.error(`merge-watcher: tick failed for ${projectId}: ${result.error}`);
      } else {
        console.log(
          `merge-watcher: advanced ${projectId} past merged change ${config.state.current_change}`,
        );
      }
    } catch (e) {
      console.error(
        `merge-watcher: error processing ${projectId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

function recordAudit(action: string, args: Record<string, unknown>, filesTouched: string[]): void {
  try {
    spawnSync(
      'node',
      [
        join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs'),
        '--action',
        action,
        '--args',
        JSON.stringify(args),
        '--files-touched',
        JSON.stringify(filesTouched),
        '--exit-status',
        '0',
      ],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
  } catch {
    /* best-effort; the mutation already landed on disk */
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Per-change automation orchestrator
//
// Source of truth for the new model. Each CHANGE owns its automation block
// in frontmatter; the orchestrator iterates over changes directly. This
// supports orphan changes (no project) and per-change opt-in within a
// project — the two gaps the project-level orchestrator couldn't cover.
//
// The loop (canonical for v1, documented in archetype-change.md § Automation):
//
//   EXECUTE → OPEN-PR → PR-REVIEW ─┬─ approved → complete (PR open, awaiting human)
//                                  │
//                                  └─ needs-changes → ADDRESS-COMMENTS → PR-REVIEW
//                                                     (loop; iteration_count++;
//                                                      park at iteration_cap)
//
// Boundary: automation stops at "complete" after open-pr + clean review.
// The GitHub-side merge is the human's call.
// ---------------------------------------------------------------------------

// Skill ↔ step map. Two steps dispatch dev-write-change but with different
// prompt phases (EXECUTE vs address-comments); the orchestrator disambiguates
// via state.current_step rather than skill name alone.
const CHANGE_STEP_SKILLS: Record<ChangeAutomationStep, string> = {
  execute: 'dev-write-change',
  'open-pr': 'dev-open-pr',
  'pr-review': 'dev-pr-review',
  'address-comments': 'dev-write-change',
};

// Default iteration cap when the change's automation block doesn't override.
const DEFAULT_ITERATION_CAP = 4;

// Locate a change entry by id. Returns null if not found.
async function findChange(
  changeId: string,
): Promise<{ fm: Record<string, unknown>; path: string } | null> {
  const wikiDir = join(REPO_ROOT, 'vault', 'wiki');
  const files = await walkMd(wikiDir);
  for (const file of files) {
    try {
      const { fm, parseError } = parseFrontmatter(await readFile(file, 'utf8'));
      if (parseError) continue;
      if (fm.type !== 'change') continue;
      if (fm.id !== changeId) continue;
      return { fm: fm as Record<string, unknown>, path: file };
    } catch {
      /* skip unreadable files */
    }
  }
  return null;
}

// Parse the change's automation block from frontmatter. Mirrors
// readChangeAutomation in changes.ts but kept local here to avoid a circular
// import (changes.ts imports automation.ts for the hook re-export). Returns
// null when the block is absent — canonical signal that automation has never
// been touched for this change.
function readChangeAutomationLocal(fm: Record<string, unknown>): ChangeAutomation | null {
  const raw = fm.automation;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const stateRaw = (r.state && typeof r.state === 'object' ? r.state : {}) as Record<
    string,
    unknown
  >;
  const phase: ChangeAutomation['state']['phase'] =
    stateRaw.phase === 'running' || stateRaw.phase === 'paused' || stateRaw.phase === 'complete'
      ? stateRaw.phase
      : 'idle';
  return {
    enabled: r.enabled === true,
    iteration_cap:
      typeof r.iteration_cap === 'number' && r.iteration_cap > 0
        ? Math.floor(r.iteration_cap)
        : DEFAULT_ITERATION_CAP,
    state: {
      phase,
      current_step: typeof stateRaw.current_step === 'string' ? stateRaw.current_step : null,
      iteration_count:
        typeof stateRaw.iteration_count === 'number' && stateRaw.iteration_count >= 0
          ? Math.floor(stateRaw.iteration_count)
          : 0,
      paused_reason: typeof stateRaw.paused_reason === 'string' ? stateRaw.paused_reason : null,
      paused_at: typeof stateRaw.paused_at === 'string' ? stateRaw.paused_at : null,
      last_transition:
        typeof stateRaw.last_transition === 'string' ? stateRaw.last_transition : null,
      last_run_id: typeof stateRaw.last_run_id === 'string' ? stateRaw.last_run_id : null,
    },
  };
}

// Initialize a fresh automation block. Used when the user first toggles
// automation on for a change. iteration_cap takes the explicit value or
// the default.
function freshChangeAutomation(opts: {
  enabled: boolean;
  iteration_cap?: number;
}): ChangeAutomation {
  return {
    enabled: opts.enabled,
    iteration_cap:
      typeof opts.iteration_cap === 'number' && opts.iteration_cap > 0
        ? Math.floor(opts.iteration_cap)
        : DEFAULT_ITERATION_CAP,
    state: {
      phase: 'idle',
      current_step: null,
      iteration_count: 0,
      paused_reason: null,
      paused_at: null,
      last_transition: null,
      last_run_id: null,
    },
  };
}

// Write the change's automation block back to frontmatter atomically.
// Mirrors the project-level writeAutomationConfig pattern + bumps `updated`.
async function writeChangeAutomation(
  changePath: string,
  automation: ChangeAutomation,
): Promise<void> {
  const content = await readFile(changePath, 'utf8');
  const nowIso = new Date().toISOString();
  const updated = rewriteFrontmatter(content, {
    automation,
    updated: nowIso,
  });
  await writeFile(changePath, updated, 'utf8');
}

// Build the dispatcher prompt for a specific step on a specific change.
// Each step has its own canonical prompt; the skill consumes the change's
// own frontmatter for its detailed inputs (branch, repo, plan path, etc.).
function buildChangeStepPrompt(step: ChangeAutomationStep, changeId: string): string {
  const skill = CHANGE_STEP_SKILLS[step];
  // address-comments dispatches dev-write-change but with explicit phase
  // hint in the prompt body — the skill detects address-comments mode from
  // the presence of pr_review_status: needs-changes on the change entry,
  // but the prompt is explicit so behavior is unambiguous.
  const phaseLine =
    step === 'address-comments'
      ? '- mode: address-comments  (fold inline review comments into code, commit + push the follow-up)'
      : step === 'execute'
        ? '- phase: EXECUTE  (the plan is approved; write the code per the plan, run tests, commit + push)'
        : '';
  return [
    `Run the ${skill} skill for change "${changeId}". Dispatched by the change-automation orchestrator.`,
    `Read .claude/skills/${skill}/SKILL.md and follow its Procedure exactly.`,
    '',
    'Inputs:',
    `- change: ${changeId}`,
    phaseLine,
    '',
    'IMPORTANT — headless dashboard-driven call:',
    '- Do NOT use AskUserQuestion or any interactive prompt.',
    '- Report a tight summary block at the end (per the SKILL.md).',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

// Re-export the pure state-machine decider so existing consumers + the
// unit test surface keep their import path. The real implementation lives
// in `./automation-state-machine.ts` — that module has zero I/O imports
// so vitest can exercise the transition rules without pulling node:sqlite
// through the transitive graph (see tests/unit/automation/).
export { decideNextChangeStep } from './automation-state-machine.js';
import { decideNextChangeStep } from './automation-state-machine.js';
import { lookupLinkedReview } from './pr-review-lookup.js';

// Dispatch a step's skill run for a change. Returns the new run_id on
// success. Bumps `state.last_run_id` + `state.current_step` + `phase: running`
// + `iteration_count` (when entering address-comments) so the auto-tick
// hook can match runId against state on completion.
async function dispatchChangeStep(args: {
  changeId: string;
  changePath: string;
  fm: Record<string, unknown>;
  automation: ChangeAutomation;
  step: ChangeAutomationStep;
}): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const { changeId, changePath, fm, automation, step } = args;
  const prompt = buildChangeStepPrompt(step, changeId);
  const project = typeof fm.project === 'string' ? fm.project : null;
  const domain = typeof fm.domain === 'string' ? fm.domain : null;
  const repo = typeof fm.repo === 'string' ? fm.repo : null;
  const result = await startRun({
    prompt,
    title: `[automation] ${CHANGE_STEP_SKILLS[step]} ${changeId} (${step})`,
    tags: {
      skill: CHANGE_STEP_SKILLS[step],
      change_id: changeId,
      project: project ?? undefined,
      domain: domain ?? undefined,
      repo: repo ?? undefined,
    },
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  // Update state: phase: running, current_step, last_run_id, last_transition.
  // iteration_count increments only when entering address-comments (the body
  // of the loop) — pr-review iterations are counted by the address-comments
  // dispatches that precede them.
  const nowIso = new Date().toISOString();
  const nextAutomation: ChangeAutomation = {
    ...automation,
    state: {
      ...automation.state,
      phase: 'running',
      current_step: step,
      iteration_count:
        step === 'address-comments'
          ? automation.state.iteration_count + 1
          : automation.state.iteration_count,
      paused_reason: null,
      paused_at: null,
      last_transition: nowIso,
      last_run_id: result.run_id,
    },
  };
  await writeChangeAutomation(changePath, nextAutomation);
  recordAudit(
    'change-automation-advance',
    {
      change: changeId,
      step,
      run_id: result.run_id,
      iteration_count: nextAutomation.state.iteration_count,
    },
    [relative(REPO_ROOT, changePath)],
  );
  return { ok: true, run_id: result.run_id };
}

// Park a change's automation — phase: paused with a reason. No skill runs;
// just writes frontmatter + audit. Caller passes the reason verbatim. The
// emitted event_type differs by reason: `change-automation-cap-reached` for
// the iteration-cap park (so its richer template renders with PR + review
// links), else the generic `change-automation-park`. Both events fire with
// flattened args so notification templates can use {{change_id}}, {{reason}},
// {{iteration_count}}, etc. directly.
//
// For cap-reached events the caller passes `extraArgs` carrying pr_url,
// pr_review_path, last_review_concerns_count — fields the cap-reached
// template wants but generic park doesn't. We pass them through to recordAudit
// verbatim; record-dashboard-action.mjs stuffs args into event.raw.args, and
// the template renderer's args-flattening picks them up.
async function parkChangeAutomation(args: {
  changeId: string;
  changePath: string;
  automation: ChangeAutomation;
  reason: string;
  extraArgs?: Record<string, unknown>;
}): Promise<void> {
  const { changeId, changePath, automation, reason, extraArgs } = args;
  const nowIso = new Date().toISOString();
  const next: ChangeAutomation = {
    ...automation,
    state: {
      ...automation.state,
      phase: 'paused',
      paused_reason: reason,
      paused_at: nowIso,
      last_transition: nowIso,
    },
  };
  await writeChangeAutomation(changePath, next);
  const action = reason.startsWith('iteration-cap-reached')
    ? 'change-automation-cap-reached'
    : 'change-automation-park';
  recordAudit(
    action,
    {
      change: changeId,
      reason,
      iteration_count: next.state.iteration_count,
      iteration_cap: next.iteration_cap,
      ...(extraArgs ?? {}),
    },
    [relative(REPO_ROOT, changePath)],
  );
}

// Mark a change's automation complete — terminal state. PR is open, locally
// reviewed clean, awaiting human. No more dispatches.
//
// Also performs the equivalent of dev-mark-pr-ready inline: flips the
// change's `pr_review_status: pending → ready-for-human` and stamps
// `pr_ready_at` so the change exits automation in the canonical "human
// takeover required" state, not the ambiguous "review ran, no blockers"
// state. Vault-only — same semantic surface as the dev-mark-pr-ready skill,
// which is itself vault-only (no GitHub side-effects). Fires the
// `dashboard.mark-pr-ready` audit event so the lifecycle stepper + any
// notification rules subscribed to that event light up.
//
// If dev-mark-pr-ready ever gains non-vault side effects (GitHub API call,
// external notification, etc.), the orchestrator should switch to
// dispatching the skill as a real step rather than inline-writing here.
async function completeChangeAutomation(args: {
  changeId: string;
  changePath: string;
  automation: ChangeAutomation;
}): Promise<void> {
  const { changeId, changePath, automation } = args;
  const nowIso = new Date().toISOString();

  // Read current change frontmatter to check pr_review_status before
  // flipping. We only mark-ready when the current value is `pending`
  // (= "review ran, no blockers"). For other values (needs-changes,
  // ready-for-human already, null) we skip the flip and let the orchestrator
  // close out normally. The marked event still fires so the audit trail
  // is consistent.
  let content = await readFile(changePath, 'utf8');
  const { fm: cfm } = parseFrontmatter(content);
  const currentPrReviewStatus =
    typeof (cfm as Record<string, unknown>).pr_review_status === 'string'
      ? ((cfm as Record<string, unknown>).pr_review_status as string)
      : null;

  // Write the automation block via the existing writer first (which also
  // bumps `updated`). Then surgically flip pr_review_status + pr_ready_at
  // via direct frontmatter rewrite — keeps the diff focused.
  const nextAutomation: ChangeAutomation = {
    ...automation,
    state: {
      ...automation.state,
      phase: 'complete',
      paused_reason: null,
      paused_at: null,
      last_transition: nowIso,
    },
  };
  await writeChangeAutomation(changePath, nextAutomation);

  let markedReady = false;
  if (currentPrReviewStatus === 'pending') {
    content = await readFile(changePath, 'utf8');
    const updated = rewriteFrontmatter(content, {
      pr_review_status: 'ready-for-human',
      pr_ready_at: nowIso,
      updated: nowIso,
    });
    await writeFile(changePath, updated, 'utf8');
    markedReady = true;
  }

  recordAudit(
    'change-automation-complete',
    {
      change: changeId,
      iteration_count: nextAutomation.state.iteration_count,
      marked_ready_for_human: markedReady,
    },
    [relative(REPO_ROOT, changePath)],
  );
  if (markedReady) {
    recordAudit(
      'mark-pr-ready',
      { change: changeId, source: 'change-automation', override: false },
      [relative(REPO_ROOT, changePath)],
    );
  }
}

// Auto-tick hook — called from runs.ts close handler when ANY run terminates.
// Matches the run against the change's automation.state.last_run_id; if
// matched + the run was for a known automation step, advances the state
// machine per `decideNextChangeStep`.
//
// Best-effort: errors log to console only. The calling code (runs.ts
// finishRun) must complete regardless.
//
// Null/undefined `exitStatus` is treated as a failure (-1) — the subprocess
// died without a clean close (orphan-sweep case; see Task #398). Without
// this, the orchestrator silently stalls in phantom-running state because
// the auto-tick early-returns. Park with a clear reason so the user can
// inspect + Resume.
export async function onChangeAutomationStepComplete(
  changeId: string | null | undefined,
  skill: string | null | undefined,
  exitStatus: number | null | undefined,
  runId: string | null | undefined,
): Promise<void> {
  if (!changeId || !skill || !runId) return;
  // Treat null/undefined exit as a non-zero failure. The skill may have
  // partially written to disk before dying — the user inspects manually
  // before resuming.
  const effectiveExit = exitStatus === null || exitStatus === undefined ? -1 : exitStatus;
  try {
    const found = await findChange(changeId);
    if (!found) return;
    const automation = readChangeAutomationLocal(found.fm);
    if (!automation || !automation.enabled) return;
    if (automation.state.phase !== 'running') return;
    if (automation.state.last_run_id !== runId) {
      // Stale tick — the orchestrator advanced past this run (e.g. user
      // manually reset, or this was an orphan dispatch). Quiet exit.
      return;
    }
    // pr-review verdict drives the loop decision — re-read change frontmatter
    // for the latest pr_review_status (the skill writes it back via Edit).
    const refreshed = await findChange(changeId);
    const pr_review_status =
      refreshed && typeof refreshed.fm.pr_review_status === 'string'
        ? refreshed.fm.pr_review_status
        : null;
    // Task #427 — count of curated-not-acted-on comments on the latest
    // pr-review pass. Drives the no-op-loop guard in the state machine: when
    // verdict is needs-changes but this count is 0, all comments are still
    // status:new and dispatching address-comments would no-op. Null when no
    // pr_review_path is set (pre-review steps); the guard treats that as
    // unknown and falls through to existing behavior.
    const pr_review_path =
      refreshed && typeof refreshed.fm.pr_review_path === 'string'
        ? refreshed.fm.pr_review_path
        : null;
    const comments_to_address = pr_review_path
      ? lookupLinkedReview(pr_review_path).commentsToAddress
      : null;
    const decision = decideNextChangeStep({
      current_step: automation.state.current_step,
      iteration_count: automation.state.iteration_count,
      iteration_cap: automation.iteration_cap,
      last_exit: effectiveExit,
      pr_review_status,
      comments_to_address,
    });
    if (decision.action === 'park') {
      // For iteration-cap-reached parks, enrich the audit args with pr_url
      // + pr_review_path + concerns count so the cap-reached notification
      // template has links to the PR + review without a second lookup.
      // Concerns count: best-effort grep against the latest review file for
      // a 'concerns: <N>' line (matches dev-pr-review's report shape); when
      // absent we pass null and let the template fall back gracefully.
      const isCap = decision.reason.startsWith('iteration-cap-reached');
      // Task #427 — needs-triage parks attach pr_review_path + pr_url so the
      // dashboard / notification can deep-link the user to where they need
      // to act (triage status:new comments → accepted/dismissed) before
      // resuming.
      const isNeedsTriage = decision.reason.startsWith('needs-triage');
      let extraArgs: Record<string, unknown> | undefined;
      if (isCap) {
        const fmRef = (refreshed ?? found).fm;
        const pr_url = typeof fmRef.pr_url === 'string' ? fmRef.pr_url : null;
        const pr_review_path =
          typeof fmRef.pr_review_path === 'string' ? fmRef.pr_review_path : null;
        let last_review_concerns_count: number | null = null;
        if (pr_review_path) {
          try {
            const reviewSrc = await readFile(join(REPO_ROOT, pr_review_path), 'utf8');
            const m = reviewSrc.match(/concerns:\s*(\d+)/);
            if (m) last_review_concerns_count = Number.parseInt(m[1], 10);
          } catch {
            /* missing or unreadable — best-effort */
          }
        }
        extraArgs = { pr_url, pr_review_path, last_review_concerns_count };
      } else if (isNeedsTriage) {
        const fmRef = (refreshed ?? found).fm;
        extraArgs = {
          pr_url: typeof fmRef.pr_url === 'string' ? fmRef.pr_url : null,
          pr_review_path: typeof fmRef.pr_review_path === 'string' ? fmRef.pr_review_path : null,
        };
      }
      await parkChangeAutomation({
        changeId,
        changePath: (refreshed ?? found).path,
        automation,
        reason: decision.reason,
        extraArgs,
      });
      return;
    }
    if (decision.action === 'complete') {
      await completeChangeAutomation({
        changeId,
        changePath: (refreshed ?? found).path,
        automation,
      });
      return;
    }
    const dispatched = await dispatchChangeStep({
      changeId,
      changePath: (refreshed ?? found).path,
      fm: (refreshed ?? found).fm,
      automation,
      step: decision.step,
    });
    if (!dispatched.ok) {
      // Dispatch failure — park with the underlying error so the user can act.
      await parkChangeAutomation({
        changeId,
        changePath: (refreshed ?? found).path,
        automation,
        reason: `dispatch-failure: ${dispatched.error}`,
      });
    }
  } catch (e) {
    console.error(
      `change-automation auto-tick threw for change ${changeId}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

// Snapshot helper for the change-status endpoint. Builds the
// ChangeAutomationStatusResponse shape — the wire contract documented in
// automation.types.ts.
async function buildChangeStatusResponse(
  changeId: string,
): Promise<ChangeAutomationStatusResponse> {
  const found = await findChange(changeId);
  if (!found) {
    return { ok: false, automation: null, change_summary: null };
  }
  return {
    ok: true,
    automation: readChangeAutomationLocal(found.fm),
    change_summary: {
      id: changeId,
      title: typeof found.fm.title === 'string' ? found.fm.title : changeId,
      status: typeof found.fm.status === 'string' ? found.fm.status : null,
      review_status: typeof found.fm.review_status === 'string' ? found.fm.review_status : null,
      pr_url: typeof found.fm.pr_url === 'string' ? found.fm.pr_url : null,
      pr_review_status:
        typeof found.fm.pr_review_status === 'string' ? found.fm.pr_review_status : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const automationRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/projects/:id/automation — current status snapshot. The
  // detail endpoint also surfaces this via project.automation, but a
  // dedicated GET lets the header poll cheaply without rebuilding the
  // whole project payload.
  fastify.get<{ Params: { id: string } }>('/:id/automation', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProject(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const config = readAutomationConfig(found.fm);
    return buildStatusResponse(projectId, config);
  });

  // POST /api/projects/:id/automation/configure — partial update of
  // enabled / pause_on. Does NOT start the orchestrator — explicit Start
  // is the only way to transition into running phase.
  fastify.post<{ Params: { id: string }; Body: AutomationConfigureBody }>(
    '/:id/automation/configure',
    async (req, reply) => {
      const projectId = req.params.id;
      const found = await findProject(projectId);
      if (!found) {
        reply.code(404);
        return { ok: false, error: `project "${projectId}" not found` };
      }
      const current = readAutomationConfig(found.fm);
      const next: AutomationConfig = {
        ...current,
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : current.enabled,
        pause_on: Array.isArray(req.body?.pause_on)
          ? req.body.pause_on.filter(
              (g): g is AutomationPauseGate => g === 'review-not-approved' || g === 'skill-failure',
            )
          : current.pause_on,
      };
      // Disabling while running forces a clean stop — better than leaving
      // a stale running state in the frontmatter that nothing can advance.
      if (!next.enabled && current.state.phase === 'running') {
        next.state = {
          phase: 'idle',
          current_change: null,
          current_step: null,
          paused_reason: null,
          last_transition: new Date().toISOString(),
        };
      }
      await writeAutomationConfig(found.path, next);
      recordAudit(
        'automation-configure',
        { project: projectId, enabled: next.enabled, pause_on: next.pause_on },
        [relative(REPO_ROOT, found.path)],
      );
      return buildStatusResponse(projectId, next);
    },
  );

  // POST /api/projects/:id/automation/start — transition idle → running.
  // Picks the first eligible change, dispatches the first step. Refuses
  // if already running, paused, or failed (use resume/stop for those).
  fastify.post<{ Params: { id: string } }>('/:id/automation/start', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProject(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const config = readAutomationConfig(found.fm);
    if (!config.enabled) {
      reply.code(409);
      return { ok: false, error: 'automation is not enabled — configure first' };
    }
    if (config.state.phase !== 'idle') {
      reply.code(409);
      return {
        ok: false,
        error: `automation is ${config.state.phase}; use resume/stop, not start`,
      };
    }
    const pick = await pickNextChange(projectId);
    if (!pick) {
      // Nothing to do — stay idle. Surface a friendly response.
      return buildStatusResponse(projectId, config);
    }
    const projectDomain = typeof found.fm.domain === 'string' ? found.fm.domain : null;
    const dispatch = await dispatchStep(projectId, pick.id, pick.step, projectDomain);
    if (!dispatch.ok) {
      reply.code(500);
      return { ok: false, error: `dispatch failed: ${dispatch.error}` };
    }
    const nowIso = new Date().toISOString();
    const next: AutomationConfig = {
      ...config,
      state: {
        phase: 'running',
        current_change: pick.id,
        current_step: pick.step,
        paused_reason: null,
        last_transition: nowIso,
      },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit(
      'automation-start',
      { project: projectId, change: pick.id, step: pick.step, run_id: dispatch.run_id },
      [relative(REPO_ROOT, found.path)],
    );
    return buildStatusResponse(projectId, next);
  });

  // POST /api/projects/:id/automation/pause — running → paused. Does NOT
  // kill an in-flight skill run (let it finish); paused just stops the
  // orchestrator from advancing on the next tick.
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/automation/pause',
    async (req, reply) => {
      const projectId = req.params.id;
      const found = await findProject(projectId);
      if (!found) {
        reply.code(404);
        return { ok: false, error: `project "${projectId}" not found` };
      }
      const config = readAutomationConfig(found.fm);
      if (config.state.phase !== 'running') {
        reply.code(409);
        return { ok: false, error: `automation is ${config.state.phase}; only running can pause` };
      }
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual pause';
      const next: AutomationConfig = {
        ...config,
        state: {
          ...config.state,
          phase: 'paused',
          paused_reason: reason,
          last_transition: new Date().toISOString(),
        },
      };
      await writeAutomationConfig(found.path, next);
      recordAudit('automation-pause', { project: projectId, reason }, [
        relative(REPO_ROOT, found.path),
      ]);
      return buildStatusResponse(projectId, next);
    },
  );

  // POST /api/projects/:id/automation/resume — paused → running. Replays
  // the current step (re-dispatches the skill for the current change).
  // No automatic "move forward" without an explicit tick.
  fastify.post<{ Params: { id: string } }>('/:id/automation/resume', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProject(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const config = readAutomationConfig(found.fm);
    if (config.state.phase !== 'paused') {
      reply.code(409);
      return { ok: false, error: `automation is ${config.state.phase}; only paused can resume` };
    }
    if (!config.state.current_change || !config.state.current_step) {
      reply.code(500);
      return { ok: false, error: 'paused state missing current_change or current_step' };
    }
    const projectDomain = typeof found.fm.domain === 'string' ? found.fm.domain : null;
    const dispatch = await dispatchStep(
      projectId,
      config.state.current_change,
      config.state.current_step,
      projectDomain,
    );
    if (!dispatch.ok) {
      reply.code(500);
      return { ok: false, error: `dispatch failed: ${dispatch.error}` };
    }
    const next: AutomationConfig = {
      ...config,
      state: {
        ...config.state,
        phase: 'running',
        paused_reason: null,
        last_transition: new Date().toISOString(),
      },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit(
      'automation-resume',
      {
        project: projectId,
        change: config.state.current_change,
        step: config.state.current_step,
        run_id: dispatch.run_id,
      },
      [relative(REPO_ROOT, found.path)],
    );
    return buildStatusResponse(projectId, next);
  });

  // POST /api/projects/:id/automation/stop — any non-idle → idle. Clears
  // current_change/current_step; an in-flight run keeps running (we just
  // stop tracking it). The disable-while-running guard in configure does
  // the same transition.
  fastify.post<{ Params: { id: string } }>('/:id/automation/stop', async (req, reply) => {
    const projectId = req.params.id;
    const found = await findProject(projectId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `project "${projectId}" not found` };
    }
    const config = readAutomationConfig(found.fm);
    if (config.state.phase === 'idle') {
      // No-op — return current status without rewriting frontmatter.
      return buildStatusResponse(projectId, config);
    }
    const next: AutomationConfig = {
      ...config,
      state: {
        phase: 'idle',
        current_change: null,
        current_step: null,
        paused_reason: null,
        last_transition: new Date().toISOString(),
      },
    };
    await writeAutomationConfig(found.path, next);
    recordAudit('automation-stop', { project: projectId }, [relative(REPO_ROOT, found.path)]);
    return buildStatusResponse(projectId, next);
  });

  // POST /api/projects/:id/automation/tick — advance the state machine
  // after a relevant skill run terminated. Body carries the (skill,
  // change_id, exit_status) so the orchestrator can decide whether to
  // advance, pause, or fail.
  //
  // Idempotency: if the tick's change_id doesn't match
  // config.state.current_change (e.g. stale client), it's a no-op.
  fastify.post<{ Params: { id: string }; Body: AutomationTickBody }>(
    '/:id/automation/tick',
    async (req, reply) => {
      const projectId = req.params.id;
      const found = await findProject(projectId);
      if (!found) {
        reply.code(404);
        return { ok: false, error: `project "${projectId}" not found` };
      }
      const config = readAutomationConfig(found.fm);
      const result = await executeTick(
        found,
        config,
        req.body ?? ({} as AutomationTickBody),
        projectId,
      );
      if (!result.ok) {
        reply.code(500);
        return { ok: false, error: result.error };
      }
      return result.status;
    },
  );
};

// ---------------------------------------------------------------------------
// Phase 2 — Per-change automation routes
//
// Mount this plugin under `/api/changes` so the routes become:
//   GET    /api/changes/:id/automation
//   POST   /api/changes/:id/automation/enable
//   POST   /api/changes/:id/automation/disable
//   POST   /api/changes/:id/automation/pause
//   POST   /api/changes/:id/automation/resume
//   POST   /api/changes/:id/automation/reset
// ---------------------------------------------------------------------------

export const changeAutomationRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/changes/:id/automation — current status snapshot. The change
  // detail endpoint also surfaces this via `change.automation`, but a
  // dedicated GET lets the dashboard's Automation panel poll cheaply.
  fastify.get<{ Params: { id: string } }>('/:id/automation', async (req, reply) => {
    const status = await buildChangeStatusResponse(req.params.id);
    if (!status.ok) {
      reply.code(404);
    }
    return status;
  });

  // POST /api/changes/:id/automation/enable — toggle automation on.
  // Initializes the block if absent. Does NOT auto-dispatch — the next
  // periodic scan picks up the change OR the user clicks Resume.
  fastify.post<{
    Params: { id: string };
    Body: { iteration_cap?: number };
  }>('/:id/automation/enable', async (req, reply) => {
    const changeId = req.params.id;
    const found = await findChange(changeId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const current = readChangeAutomationLocal(found.fm);
    const next: ChangeAutomation = current
      ? {
          ...current,
          enabled: true,
          iteration_cap: req.body?.iteration_cap ?? current.iteration_cap,
        }
      : freshChangeAutomation({ enabled: true, iteration_cap: req.body?.iteration_cap });
    await writeChangeAutomation(found.path, next);
    recordAudit(
      'change-automation-enable',
      { change: changeId, iteration_cap: next.iteration_cap },
      [relative(REPO_ROOT, found.path)],
    );
    return buildChangeStatusResponse(changeId);
  });

  // POST /api/changes/:id/automation/disable — toggle automation off.
  // Preserves state.* so re-enabling resumes from the same point. Does NOT
  // cancel a running skill — that's a separate Stop gesture (TODO Phase 3).
  fastify.post<{ Params: { id: string } }>('/:id/automation/disable', async (req, reply) => {
    const changeId = req.params.id;
    const found = await findChange(changeId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const current = readChangeAutomationLocal(found.fm);
    if (!current) {
      // No block to disable — silent ok.
      return buildChangeStatusResponse(changeId);
    }
    await writeChangeAutomation(found.path, { ...current, enabled: false });
    recordAudit('change-automation-disable', { change: changeId }, [
      relative(REPO_ROOT, found.path),
    ]);
    return buildChangeStatusResponse(changeId);
  });

  // POST /api/changes/:id/automation/pause — phase: paused, user-driven.
  fastify.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/:id/automation/pause', async (req, reply) => {
    const changeId = req.params.id;
    const found = await findChange(changeId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const current = readChangeAutomationLocal(found.fm);
    if (!current) {
      reply.code(400);
      return { ok: false, error: 'automation not configured — call enable first' };
    }
    const reason = req.body?.reason ?? 'user-paused';
    await parkChangeAutomation({
      changeId,
      changePath: found.path,
      automation: current,
      reason,
    });
    return buildChangeStatusResponse(changeId);
  });

  // POST /api/changes/:id/automation/resume — phase: paused → idle. The
  // next periodic scan (or auto-tick of an in-flight run, though there
  // shouldn't be one when paused) picks up and dispatches from the current
  // step. Optionally resets iteration_count when `reset_iteration` is true.
  fastify.post<{
    Params: { id: string };
    Body: { reset_iteration?: boolean };
  }>('/:id/automation/resume', async (req, reply) => {
    const changeId = req.params.id;
    const found = await findChange(changeId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const current = readChangeAutomationLocal(found.fm);
    if (!current) {
      reply.code(400);
      return { ok: false, error: 'automation not configured — call enable first' };
    }
    if (current.state.phase !== 'paused') {
      // Already idle/running/complete — noop.
      return buildChangeStatusResponse(changeId);
    }
    const nowIso = new Date().toISOString();
    const next: ChangeAutomation = {
      ...current,
      state: {
        ...current.state,
        phase: 'idle',
        paused_reason: null,
        paused_at: null,
        last_transition: nowIso,
        iteration_count: req.body?.reset_iteration === true ? 0 : current.state.iteration_count,
      },
    };
    await writeChangeAutomation(found.path, next);
    recordAudit(
      'change-automation-resume',
      { change: changeId, reset_iteration: req.body?.reset_iteration === true },
      [relative(REPO_ROOT, found.path)],
    );
    return buildChangeStatusResponse(changeId);
  });

  // POST /api/changes/:id/automation/start — manual kick. Required because
  // the auto-tick hook only advances after a run terminates; the very first
  // dispatch (or post-Resume restart) needs an explicit user gesture. Logic:
  //   - phase: running   → 409 (already running)
  //   - phase: complete  → 400 (call reset first)
  //   - phase: paused    → transition idle in-memory, then dispatch
  //   - phase: idle      → dispatch the next step
  //   current_step null  → first dispatch ever; default to 'execute'
  //   current_step set   → re-evaluate decideNextChangeStep assuming the
  //                        previous step succeeded
  fastify.post<{ Params: { id: string } }>('/:id/automation/start', async (req, reply) => {
    const changeId = req.params.id;
    const found = await findChange(changeId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const current = readChangeAutomationLocal(found.fm);
    if (!current) {
      reply.code(400);
      return { ok: false, error: 'automation not configured — call enable first' };
    }
    if (!current.enabled) {
      reply.code(400);
      return { ok: false, error: 'automation is disabled — call enable first' };
    }
    if (current.state.phase === 'running') {
      reply.code(409);
      return { ok: false, error: 'automation is already running this change' };
    }
    if (current.state.phase === 'complete') {
      reply.code(400);
      return { ok: false, error: 'automation is complete — call reset to restart' };
    }
    // Decide the next step. First dispatch (current_step null) defaults to
    // execute. Subsequent restarts (post-Resume) re-evaluate the state
    // machine assuming the previous step succeeded.
    const pr_review_status =
      typeof found.fm.pr_review_status === 'string' ? found.fm.pr_review_status : null;
    const decision: ChangeAutomationDecision =
      current.state.current_step === null
        ? { action: 'dispatch', step: 'execute' }
        : decideNextChangeStep({
            current_step: current.state.current_step,
            iteration_count: current.state.iteration_count,
            iteration_cap: current.iteration_cap,
            last_exit: 0,
            pr_review_status,
          });
    if (decision.action === 'park') {
      await parkChangeAutomation({
        changeId,
        changePath: found.path,
        automation: current,
        reason: decision.reason,
      });
      return buildChangeStatusResponse(changeId);
    }
    if (decision.action === 'complete') {
      await completeChangeAutomation({
        changeId,
        changePath: found.path,
        automation: current,
      });
      return buildChangeStatusResponse(changeId);
    }
    // dispatch. If paused, transition idle in-memory before dispatching.
    const automationForDispatch =
      current.state.phase === 'paused'
        ? {
            ...current,
            state: {
              ...current.state,
              phase: 'idle' as const,
              paused_reason: null,
              paused_at: null,
            },
          }
        : current;
    const dispatched = await dispatchChangeStep({
      changeId,
      changePath: found.path,
      fm: found.fm,
      automation: automationForDispatch,
      step: decision.step,
    });
    if (!dispatched.ok) {
      reply.code(500);
      return { ok: false, error: `dispatch failed: ${dispatched.error}` };
    }
    return buildChangeStatusResponse(changeId);
  });

  // POST /api/changes/:id/automation/reset — wipe state to initial (phase
  // idle, current_step null, iteration_count 0). Doesn't change `enabled`.
  // Use after fixing whatever caused a park to restart the loop cleanly.
  fastify.post<{ Params: { id: string } }>('/:id/automation/reset', async (req, reply) => {
    const changeId = req.params.id;
    const found = await findChange(changeId);
    if (!found) {
      reply.code(404);
      return { ok: false, error: `change "${changeId}" not found` };
    }
    const current = readChangeAutomationLocal(found.fm);
    if (!current) {
      reply.code(400);
      return { ok: false, error: 'automation not configured — call enable first' };
    }
    const nowIso = new Date().toISOString();
    const next: ChangeAutomation = {
      ...current,
      state: {
        phase: 'idle',
        current_step: null,
        iteration_count: 0,
        paused_reason: null,
        paused_at: null,
        last_transition: nowIso,
        last_run_id: null,
      },
    };
    await writeChangeAutomation(found.path, next);
    recordAudit('change-automation-reset', { change: changeId }, [relative(REPO_ROOT, found.path)]);
    return buildChangeStatusResponse(changeId);
  });
};
