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
export interface PrReviewConfig {
  primary_model: string;
  analyzer_model: string;
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
// loud.
export interface PrReviewConfigUpdateBody {
  primary_model?: string;
  analyzer_model?: string;
  comment_style?: CommentStyle;
  focus_areas?: string[];
  context_strategy?: 'full-diff';
  custom_instructions?: string;
}
