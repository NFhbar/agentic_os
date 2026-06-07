// Lifecycle-audit wire shapes — shared between server and client. The audit
// archetype is documented in vault/wiki/_seed/meta/reference/archetype-lifecycle-audit.md;
// these types are the runtime mirror of that contract.
//
// Two flavors:
//   - AuditSummary: list-view shape. Derivable from manifest frontmatter alone,
//     so the list endpoint can return many in one walk without reading bodies.
//   - AuditDetail: detail-view shape. Includes nested objects (scores, per-skill
//     findings, tuning suggestions, body) that require reading the entry file.

export type AuditStatus = 'pending' | 'provisional' | 'final';
export type VerdictOverall = 'good' | 'mixed' | 'poor';
export type TagPolarity = 'negative' | 'positive' | 'neutral';
export type SuggestionConfidence = 'low' | 'medium' | 'high';
export type FollowupType = 'fix' | 'refactor' | 'feat-extension' | 'feat-rewrite' | 'test' | 'docs';

export interface AuditScores {
  // Aggregate means across all per_skill_findings — for at-a-glance
  // comparison. Detail view shows per-skill breakdowns.
  correctness: number; // 1.0-5.0
  completeness: number;
  efficiency: number;
}

export interface PerSkillFinding {
  skill: string; // e.g., "dev-pr-review", "dev-write-change"
  phase: string; // e.g., "pass-1", "plan", "execute"
  scores: {
    correctness: number; // 1-5
    completeness: number;
    efficiency: number;
  };
  tags: string[]; // tag ids from the canonical vocabulary
  notes: string; // 2-3 sentences elaborating on scores + tags
  evidence_paths: string[]; // file paths the judgment cites
}

export interface TuningSuggestion {
  skill: string; // target skill for the suggestion
  suggestion: string; // concrete prose describing the SKILL.md change
  confidence: SuggestionConfidence;
  evidence_summary: string; // 1-2 sentences
  target_change: string; // where in SKILL.md the change lands
}

export interface FollowupSignal {
  followup_change_id: string;
  followup_type: FollowupType;
  followup_merged_at: string; // ISO
  days_after_audited_merge: number;
  overlap_severity: 'low' | 'medium' | 'high';
  correctness_signal: number; // adjustment to audited change's Correctness (-2 to +2)
  notes: string;
}

export interface HumanOverride {
  ts: string; // ISO
  reviewer: string;
  overridden_field: string; // dotted path, e.g., "scores.dev-pr-review.correctness"
  original_value: unknown;
  new_value: unknown;
  rationale: string;
}

// List-view shape. Derived from manifest frontmatter for fast list-many.
export interface AuditSummary {
  id: string;
  path: string; // repo-relative
  title: string;
  audited_change_id: string;
  audited_change_path: string;
  project: string;
  audit_status: AuditStatus;
  verdict_overall: VerdictOverall | null;
  scores: AuditScores | null; // aggregate means; null for pending audits
  overseer_model: string | null;
  overseer_dispatched_at: string | null;
  overseer_completed_at: string | null;
  rubric_version: string;
  audit_cost_usd: number | null;
  audit_duration_ms: number | null;
  tag_count: number; // length of tags array — quick signal on audit density
  tuning_suggestions_count: number; // length of tuning_suggestions — actionability signal
  has_human_override: boolean; // for filtering "audits the human disagreed with"
  has_followups: boolean; // for filtering "audits with forward-look signals"
  created: string | null;
  updated: string | null;
}

// Status of one tuning suggestion — what actions have been taken on it.
// Indexed in parallel with `tuning_suggestions[]`. Phase 4: surfaces the
// loop's progression in the dashboard ("propose written", "decision exists",
// "dismissed") instead of showing every suggestion as forever-actionable.
//
// proposal_state distinguishes three cases:
//   'none'           — propose has never been run for this suggestion
//   'diff'           — propose produced a real unified diff (target is a skill
//                       and the suggestion's intent mapped to a concrete edit)
//   'rationale-only' — propose ran but the target wasn't a skill / didn't yield
//                       a diff. Rationale exists with the routing decomposition;
//                       no .diff file was written (avoids the misleading
//                       "diff file containing 'no diff possible' comment" trap).
export interface TuningSuggestionStatus {
  dismissed: boolean;
  dismissal_rationale: string | null;
  proposal_state: 'none' | 'diff' | 'rationale-only';
  proposal_diff_path: string | null; // set when state === 'diff'
  proposal_rationale_path: string | null; // set when state === 'diff' OR 'rationale-only'
  // Decision entries whose `implements_tuning_suggestions` cites this audit+index.
  decisions: Array<{ id: string; path: string; status: string; title: string }>;
}

// Detail-view shape. Includes the body + the nested objects the manifest
// flat-parser can't fully represent (audit reads the file directly).
export interface AuditDetail extends AuditSummary {
  // Nested object frontmatter — populated by reading the file, not the manifest
  per_skill_findings: PerSkillFinding[];
  tags: string[];
  tuning_suggestions: TuningSuggestion[];
  // Phase 4 — per-suggestion action status. Length === tuning_suggestions.length.
  tuning_suggestion_status: TuningSuggestionStatus[];
  red_flags: string[];
  files_touched: string[];
  followup_signals: FollowupSignal[];
  human_override: HumanOverride | null;
  body: string; // raw markdown (no frontmatter)
}

// Aggregate endpoint shape — used by Pulse v2 + the future by-skill drill-in.
export interface AuditAggregate {
  // Scope: defaults to all audits; filterable to a project via query param.
  scope: { project: string | null };
  total_audits: number;
  verdict_distribution: {
    good: number;
    mixed: number;
    poor: number;
    unknown: number; // pending audits without a verdict yet
  };
  // Top tags by frequency across the scoped audits.
  top_tags: Array<{ tag: string; count: number }>;
  // Top tuning_suggestions grouped by skill + similarity. Surfaces the
  // patterns most ripe for actual skill changes.
  top_tuning_suggestions: Array<{
    skill: string;
    suggestion_summary: string; // condensed prose
    count: number; // how many audits raised similar suggestion
    sample_audit_ids: string[]; // up to 3 examples for click-through
  }>;
  // Mean scores across all audits in scope, for quick comparison vs project
  // baselines. Null when scope is empty.
  mean_scores: AuditScores | null;
  // Time range covered (oldest + newest audit timestamp) — useful for
  // labelling charts like "Last 30 days: X audits".
  time_range: { oldest: string | null; newest: string | null };
}
