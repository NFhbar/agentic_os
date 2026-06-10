// /api/tuning-suggestions — Phase 4 of the Overseer arc.
//
// Endpoints route a single tuning_suggestions[] entry out of an audit into a
// user-actionable next step. The AI-dispatching paths (propose + apply) were
// removed as part of #416 — both UI sites now go through the canonical
// startRun()-based dispatch (PendingSuggestionsPanel and audit-detail's
// TuningSuggestionActions both call useDispatch().startSkillRun directly),
// which gives first-class runs-db rows + drawer rendering + cost capture.
// This module is now scaffold-only:
//
//   POST /api/tuning-suggestions/promote
//        Pure vault-scaffold: reads the audit + suggestion, writes a new
//        decision-archetype entry pre-filled with the suggestion's evidence
//        and the `implements_tuning_suggestions` gate field. No AI spawn.
//        User opens the entry in the Vault to fill in rationale.
//
//   POST /api/tuning-suggestions/dismiss
//        Appends to dismissed-action-items.jsonl. Same pattern as audit
//        finding dismissals; id format `tuning-suggestion:<audit_id>:<index>`.
//
//   GET  /api/tuning-suggestions/pending
//        Cross-audit roll-up of suggestions awaiting promote/dismiss (kept
//        when proposed-but-not-promoted so the UI can show the badge).
//
// All write endpoints dual-write to events.db via record-dashboard-action.mjs
// for the audit trail.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { parseFrontmatter } from '../frontmatter.js';
import { REPO_ROOT } from '../repo.js';
import { loadDecisionsByTuningRef, loadDismissals } from './audits.js';

const AUDITS_DIR = join(REPO_ROOT, 'vault', 'wiki', 'meta', 'lifecycle-audit');
const DECISIONS_DIR = join(REPO_ROOT, 'vault', 'wiki', 'meta', 'decision');
const PROPOSALS_DIR = join(REPO_ROOT, 'vault', 'output', 'meta', 'tuning-proposals');
const DISMISSAL_PATH = join(REPO_ROOT, '.claude', 'state', 'dismissed-action-items.jsonl');

interface TuningSuggestion {
  skill: string;
  suggestion: string;
  confidence: 'low' | 'medium' | 'high';
  evidence_summary: string;
  target_change: string;
}

// Find and load one audit by its id (slug from filename). Returns the parsed
// frontmatter + the file path so callers can cite it.
async function loadAuditById(
  auditId: string,
): Promise<{ fm: Record<string, unknown>; path: string } | null> {
  const candidate = join(AUDITS_DIR, `audit-${auditId.replace(/^audit-/, '')}.md`);
  // Audits saved by meta-overseer-review are named `audit-<change-id>.md` and
  // their `id:` frontmatter is `audit-<change-id>`. The dashboard passes the
  // full id. Try both shapes.
  const paths = [join(AUDITS_DIR, `${auditId}.md`), candidate];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const content = await readFile(p, 'utf8');
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'lifecycle-audit') continue;
      if (String(fm.id) !== auditId && String(fm.id) !== auditId.replace(/^audit-/, '')) continue;
      return { fm, path: p };
    } catch {
      /* try next */
    }
  }
  return null;
}

// Slugify the suggestion's intent for a decision entry filename. Keeps the
// slug short by combining skill + first ~40 chars of suggestion summary.
function deriveDecisionSlug(skill: string, suggestion: string): string {
  const skillSlug = skill
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const intentSlug = suggestion
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 8)
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return `${skillSlug}-${intentSlug}`.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Dual-write to events.db via record-dashboard-action.mjs
// ---------------------------------------------------------------------------

async function recordEvent(args: {
  action: string;
  payload: Record<string, unknown>;
  filesTouched: string[];
  description: string;
}): Promise<void> {
  const scriptPath = join(REPO_ROOT, 'scripts', 'record-dashboard-action.mjs');
  if (!existsSync(scriptPath)) return; // graceful skip — telemetry is best-effort
  await new Promise<void>((resolve) => {
    const child = spawn(
      'node',
      [
        scriptPath,
        '--action',
        args.action,
        '--skill',
        'meta-apply-tuning-suggestion',
        '--args',
        JSON.stringify(args.payload),
        '--files-touched',
        JSON.stringify(args.filesTouched),
        '--exit-status',
        '0',
        '--description',
        args.description,
      ],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
    child.on('close', () => resolve());
    child.on('error', () => resolve()); // never propagate event-recording failures
  });
}

// ---------------------------------------------------------------------------

export const tuningSuggestionsRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/tuning-suggestions/promote — vault scaffold of a decision entry
  // citing this suggestion. No AI spawn — pure write of frontmatter +
  // stubbed body the user fills in.
  fastify.post<{
    Body: { audit_id: string; suggestion_index: number };
  }>('/promote', async (req, reply) => {
    const { audit_id, suggestion_index } = req.body || {};
    if (!audit_id || typeof suggestion_index !== 'number') {
      reply.code(400);
      return { ok: false, error: 'audit_id and suggestion_index are required' };
    }
    const audit = await loadAuditById(audit_id);
    if (!audit) {
      reply.code(404);
      return { ok: false, error: `audit "${audit_id}" not found` };
    }
    const suggestions = Array.isArray(audit.fm.tuning_suggestions)
      ? (audit.fm.tuning_suggestions as TuningSuggestion[])
      : [];
    if (suggestion_index < 0 || suggestion_index >= suggestions.length) {
      reply.code(400);
      return { ok: false, error: `suggestion_index ${suggestion_index} out of range` };
    }
    const suggestion = suggestions[suggestion_index];

    const slug = deriveDecisionSlug(suggestion.skill, suggestion.suggestion);
    const decisionId = `decision-${slug}`;
    const decisionPath = join(DECISIONS_DIR, `${decisionId}.md`);
    if (existsSync(decisionPath)) {
      reply.code(409);
      return {
        ok: false,
        error: `decision entry already exists at ${decisionPath} — edit it directly or choose a different slug`,
        existing_path: `vault/wiki/meta/decision/${decisionId}.md`,
      };
    }

    const now = new Date().toISOString();
    // YAML stringification for the implements_tuning_suggestions block — flat
    // JSON-on-one-line for manifest parser compatibility, mirroring how
    // meta-overseer-review emits its arrays.
    const implementsBlock = JSON.stringify([{ audit_id, suggestion_index }]);

    const body = `---
id: ${decisionId}
type: decision
domain: meta
created: ${now}
updated: ${now}
tags: [skill-tuning, overseer]
source: dashboard/overseer-promote
private: false
title: '${escapeYamlSingle(deriveDecisionTitle(suggestion))}'
status: proposed
alternatives: []
implements_tuning_suggestions: ${implementsBlock}
target_metric:
  type: tag_frequency_decrease
  name: <audit-tag-name-or-skill-dimension>
  baseline: <observed-rate-in-pre-acceptance-audits>
  target: <expected-rate-after-fix>
  scope: <audit-filter-e.g.-changes-with-address-comments-cycle>
  window_audits: 5
validation_result: pending
validation_observations: []
---

# ${deriveDecisionTitle(suggestion)}

## Context

Overseer audit \`${audit_id}\` (verdict ${audit.fm.verdict_overall ?? 'unknown'}) raised this tuning suggestion against \`${suggestion.skill}\` at confidence **${suggestion.confidence}**.

**Suggestion text:**
> ${suggestion.suggestion.replace(/\n/g, '\n> ')}

**Evidence summary:**
> ${(suggestion.evidence_summary || '').replace(/\n/g, '\n> ')}

**Target change:**
> ${(suggestion.target_change || '').replace(/\n/g, '\n> ')}

## Options considered

_(fill in rejected alternatives — e.g. "do nothing", "wider scope than suggested", "narrower scope")_

## Decision

_(fill in: accept the suggestion as-is / accept with modifications / reject. If modified, describe the actual change you intend to apply.)_

## Rationale

_(fill in: why this is worth shipping now. Cite recurrence count + confidence + leverage. If single-instance evidence, name why you're acting anyway.)_

## Consequences

_(fill in: which skill(s) change, what the expected metric impact is — e.g. "expect \`missed-issue\` tag on \`dev-review-change\` to drop in subsequent audits of changes with \`parent_change\` populated".)_

## Validation

Fill in the \`target_metric\` block above before flipping \`status\` to \`accepted\`. The structured shape lets you (and a future \`meta-validate-decision\` skill) measure whether the fix actually moved the named signal.

Pick the type that fits:

- **\`tag_frequency_decrease\`** — when the fix targets a recurring \`audit_tags\` entry (e.g., \`fix-introduces-defect-at-boundary\`)
- **\`skill_score_increase\`** — when the fix targets a per-skill rubric dimension (\`<skill>.<dimension>\`)
- **\`pattern_absence\`** — when the fix targets a specific scenario that should never recur (free-form pattern label)

After \`status: accepted\` + the SKILL.md change ships, qualifying audits (those whose lifecycle ran the modified skill AND match \`scope\`) get logged to \`validation_observations[]\` over time. Once \`window_audits\` qualifying audits accumulate, flip \`validation_result\` to \`validated\` (metric moved) or \`regressed\` (it didn't).

## How to apply

Once this decision is filled in and approved (status \`accepted\`), run:

\`\`\`
/os apply tuning suggestion audit=${audit_id} suggestion_index=${suggestion_index} mode=apply decision_entry_path=vault/wiki/meta/decision/${decisionId}.md
\`\`\`

The skill validates the gate (this entry exists, type is decision, implements_tuning_suggestions cites this audit+index) and applies the edit to the target SKILL.md.

## See also

- [[${audit_id}]] — the audit that surfaced this suggestion
- [[meta-apply-tuning-suggestion]] — the skill that applies the edit
- [[archetype-decision]] — § implements_tuning_suggestions
`;

    await mkdir(DECISIONS_DIR, { recursive: true });
    await writeFile(decisionPath, body, 'utf8');
    const relPath = `vault/wiki/meta/decision/${decisionId}.md`;

    await recordEvent({
      action: 'tuning-suggestion-promote',
      payload: { audit_id, suggestion_index, decision_id: decisionId, skill: suggestion.skill },
      filesTouched: [relPath],
      description: `Promoted tuning suggestion ${audit_id}#${suggestion_index} to decision`,
    });

    return {
      ok: true,
      decision_id: decisionId,
      decision_path: relPath,
      title: deriveDecisionTitle(suggestion),
    };
  });

  // POST /api/tuning-suggestions/dismiss — append to dismissed-action-items.jsonl.
  // Same shape as audit-finding dismissals so the dashboard can filter uniformly.
  fastify.post<{
    Body: { audit_id: string; suggestion_index: number; rationale?: string | null };
  }>('/dismiss', async (req, reply) => {
    const { audit_id, suggestion_index, rationale = null } = req.body || {};
    if (!audit_id || typeof suggestion_index !== 'number') {
      reply.code(400);
      return { ok: false, error: 'audit_id and suggestion_index are required' };
    }
    const id = `tuning-suggestion:${audit_id}:${suggestion_index}`;
    const entry = {
      id,
      ts: new Date().toISOString(),
      rationale: rationale && rationale.trim() ? rationale.trim() : null,
    };
    await mkdir(dirname(DISMISSAL_PATH), { recursive: true });
    await appendFile(DISMISSAL_PATH, `${JSON.stringify(entry)}\n`);

    await recordEvent({
      action: 'tuning-suggestion-dismiss',
      payload: { audit_id, suggestion_index, rationale },
      filesTouched: ['.claude/state/dismissed-action-items.jsonl'],
      description: `Dismissed tuning suggestion ${audit_id}#${suggestion_index}`,
    });

    return { ok: true, dismissal_id: id };
  });

  // GET /api/tuning-suggestions/pending — cross-audit roll-up of suggestions
  // that need further action (not yet promoted to a decision and not
  // dismissed). Powers the Overseer Overview's "Pending suggestions" panel.
  //
  // Filtering: a suggestion is included when BOTH of these are true:
  //   - no dismissal entry for `tuning-suggestion:<audit>:<idx>` in
  //     .claude/state/dismissed-action-items.jsonl  (terminal)
  //   - no decision-archetype entry's implements_tuning_suggestions cites
  //     {audit_id, suggestion_index}  (next action is Apply, not Promote)
  //
  // Proposed-but-not-promoted suggestions ARE kept in the list — the response
  // surfaces `proposal_state` so the UI can render a "proposed" badge and
  // emphasize "Promote" as the next action. This is the UX fix for the gap
  // where a successful Propose run produced artifacts but the row vanished
  // (or stayed unchanged) and the user couldn't tell whether to re-propose
  // or move on to Promote.
  //
  // Sort: recurrence count desc (most-recurring first), then confidence
  // (high > medium > low), then audit recency desc. Recurrence count comes
  // from grouping suggestions across audits by (skill + first-60-chars-of-
  // suggestion-text), same shape as the aggregate endpoint.
  fastify.get('/pending', async () => {
    const auditFiles: string[] = [];
    try {
      const entries = await readdir(AUDITS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md')) auditFiles.push(join(AUDITS_DIR, e.name));
      }
    } catch {
      // No audits dir → no pending suggestions. Return empty list cleanly.
      return { pending: [] };
    }

    // Reuse the existing index loaders so the filter logic stays single-source.
    const [dismissals, decisionsByRef] = await Promise.all([
      loadDismissals(),
      loadDecisionsByTuningRef(),
    ]);

    interface PendingSuggestion {
      audit_id: string;
      audit_completed_at: string | null;
      suggestion_index: number;
      skill: string;
      suggestion: string;
      confidence: 'low' | 'medium' | 'high' | string;
      evidence_summary: string;
      target_change: string;
      recurrence_count: number;
      // 'none' when no propose run has produced artifacts yet.
      // 'diff' when a unified diff exists (real proposal — most common).
      // 'rationale-only' when only the rationale.md exists (non-skill target,
      // or a skill detected the target wasn't a SKILL.md and short-circuited).
      proposal_state: 'none' | 'diff' | 'rationale-only';
      proposal_diff_path: string | null;
      proposal_rationale_path: string | null;
    }

    // First pass: collect every suggestion + its eligibility for the pending set.
    const candidates: PendingSuggestion[] = [];
    for (const file of auditFiles) {
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const { fm, parseError } = parseFrontmatter(content);
      if (parseError) continue;
      if (fm.type !== 'lifecycle-audit') continue;
      const auditId = String(fm.id ?? '');
      if (!auditId) continue;
      const completedAt =
        typeof fm.overseer_completed_at === 'string'
          ? fm.overseer_completed_at
          : fm.overseer_completed_at instanceof Date
            ? fm.overseer_completed_at.toISOString()
            : null;
      const suggestions = Array.isArray(fm.tuning_suggestions)
        ? (fm.tuning_suggestions as TuningSuggestion[])
        : [];
      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        // Filter: dismissed? (terminal — user explicitly said no)
        if (dismissals.has(`tuning-suggestion:${auditId}:${i}`)) continue;
        // Filter: promoted? (any decision cites this audit + index — once
        // a decision exists, the next action is Apply via the Decisions panel,
        // not Promote via this one)
        if ((decisionsByRef.get(`${auditId}::${i}`) ?? []).length > 0) continue;
        // NOT filtered when proposed — kept in the list so the UI can show
        // "proposed" state + emphasize Promote as the next step. The original
        // filter swallowed successful Propose runs, leaving users wondering
        // whether their click did anything.
        const diffPath = join(PROPOSALS_DIR, `${auditId}-${i}.diff`);
        const rationalePath = join(PROPOSALS_DIR, `${auditId}-${i}.rationale.md`);
        const diffExists = existsSync(diffPath);
        const rationaleExists = existsSync(rationalePath);
        const proposalState: 'none' | 'diff' | 'rationale-only' = diffExists
          ? 'diff'
          : rationaleExists
            ? 'rationale-only'
            : 'none';
        candidates.push({
          audit_id: auditId,
          audit_completed_at: completedAt,
          suggestion_index: i,
          skill: String(s.skill ?? ''),
          suggestion: String(s.suggestion ?? ''),
          confidence: String(s.confidence ?? 'medium'),
          evidence_summary: String(s.evidence_summary ?? ''),
          target_change: String(s.target_change ?? ''),
          recurrence_count: 1, // filled in below
          proposal_state: proposalState,
          proposal_diff_path: diffExists
            ? `vault/output/meta/tuning-proposals/${auditId}-${i}.diff`
            : null,
          proposal_rationale_path: rationaleExists
            ? `vault/output/meta/tuning-proposals/${auditId}-${i}.rationale.md`
            : null,
        });
      }
    }

    // Recurrence: group by skill + first 60 chars of suggestion-text. Same
    // similarity key as the aggregate endpoint's top-suggestions roll-up.
    const groupCounts = new Map<string, number>();
    const keyOf = (c: { skill: string; suggestion: string }) =>
      `${c.skill}::${c.suggestion.slice(0, 60).trim().toLowerCase()}`;
    for (const c of candidates) {
      const k = keyOf(c);
      groupCounts.set(k, (groupCounts.get(k) ?? 0) + 1);
    }
    for (const c of candidates) {
      c.recurrence_count = groupCounts.get(keyOf(c)) ?? 1;
    }

    // Sort: recurrence desc, then confidence priority, then completed_at desc.
    // The high→medium→low order ensures that single-instance high-confidence
    // suggestions surface ahead of single-instance low-confidence noise.
    const confidencePriority = (c: string): number => {
      if (c === 'high') return 0;
      if (c === 'medium') return 1;
      return 2;
    };
    candidates.sort((a, b) => {
      if (b.recurrence_count !== a.recurrence_count) return b.recurrence_count - a.recurrence_count;
      const cp = confidencePriority(a.confidence) - confidencePriority(b.confidence);
      if (cp !== 0) return cp;
      return (b.audit_completed_at ?? '').localeCompare(a.audit_completed_at ?? '');
    });

    return { pending: candidates };
  });
};

function deriveDecisionTitle(s: TuningSuggestion): string {
  // First sentence of the suggestion, trimmed to a reasonable title length.
  const firstSentence = (s.suggestion || '').split(/[.!?]\s+/)[0] || s.suggestion;
  const compact = firstSentence.replace(/\s+/g, ' ').trim();
  return compact.length > 110 ? `${compact.slice(0, 107)}...` : compact;
}

function escapeYamlSingle(s: string): string {
  return s.replace(/'/g, "''");
}
