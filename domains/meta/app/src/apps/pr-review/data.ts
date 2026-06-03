// PR Review app — shared types. Re-exports the canonical wire shapes from
// the server routes per standard-shared-types so the View and its pages stay
// aligned with what GET /api/reviews and GET /api/repos actually emit.
//
// The mock data that used to live here (REPOS, AGENTS, REVIEWS, DETAIL,
// SPARKS, TREND_14) was deleted on 2026-05-30 — none of it was consumed by
// any component after the real backend wiring landed.

export type {
  CommentState,
  LinkedChange,
  PassStats,
  PassStatus,
  RecentRun,
  ReviewComment,
  ReviewDetail,
  ReviewPass,
  ReviewRow,
  Severity,
} from '../../../server/routes/reviews.types';

export type { Repo, ReposListResponse } from '../../../server/routes/repos.types';
