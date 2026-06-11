// Wire-shape types for the PR Review config route. Per standard-shared-types
// — the server (`pr-review-config.ts`) and the client (`apps/pr-review/pages/
// Settings.tsx`) consume the same shape; this is the canonical definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `pr-review-config.ts`.

export type CommentStyle = 'terse' | 'concise' | 'detailed';

// context_strategy is editable but only 'full-diff' is supported today.
// 'symbol-graph' and 'semantic' are documented future work — they appear in
// the union because the GET response could in principle carry one if a user
// edited the source file directly. The PUT validator only accepts 'full-diff'.
export type ContextStrategy = 'full-diff' | 'symbol-graph' | 'semantic';

// GET /api/pr-review/config response shape (under the `config` key).
//
// `primary_model` / `analyzer_model` are deliberately absent — model selection
// moved to Settings → Model (project default + per-skill override) as of
// 0.4.3. The dev-pr-review and dev-analyze-repo-for-review skills stamp the
// actually-running model id into the produced entry's frontmatter from their
// own runtime context; this config file no longer carries it.
export interface PrReviewConfig {
  comment_style: CommentStyle;
  focus_areas: string[];
  context_strategy: ContextStrategy;
  custom_instructions: string;
  custom_instructions_hash: string | null;
  // Provenance — surfaces "where this came from" so the Settings UI can show
  // a sensible "edit the file at X" hint while edit UI is still Phase B.
  source_path: string;
  updated: string | null;
}

// PUT /api/pr-review/config request body. All fields are optional — clients
// send only the dirty fields. Server validateUpdate rejects unknown fields
// loud. Model fields are absent here too — clients can't write them via this
// route; use /api/settings/model and /api/settings/skills/:skill/model.
export interface PrReviewConfigUpdateBody {
  comment_style?: CommentStyle;
  focus_areas?: string[];
  context_strategy?: 'full-diff';
  custom_instructions?: string;
}
