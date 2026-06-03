// PR Review — top-level tabbed view. Renders one of: Dashboard, Reviews,
// Repos, Settings. Selecting a review row from Reviews/Dashboard drills into
// ReviewDetail (Reviews tab stays active).
//
// Phase 2: reviews list + detail are backed by /api/reviews. Repos and Agents
// are still mock (Phase 3 work).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch, useRunTerminal } from '../../lib/dispatch';
import { Icons, Toast } from '../../shared';
import '../../shared/styles.css';
import type { Repo, ReviewDetail as ReviewDetailType, ReviewRow } from './data';
import { Dashboard } from './pages/Dashboard';
import { Repos } from './pages/Repos';
import { ReviewDetail } from './pages/ReviewDetail';
import { Reviews } from './pages/Reviews';
import { Settings } from './pages/Settings';

type Tab = 'dashboard' | 'reviews' | 'repos' | 'settings';

const VALID_TABS: ReadonlyArray<Tab> = ['dashboard', 'reviews', 'repos', 'settings'];

export default function PrReview() {
  const navigate = useNavigate();
  // URL shape (mounted at /pr-review/* by App.tsx):
  //   ''                       → tab=dashboard, reviewId=null
  //   'dashboard'              → tab=dashboard, reviewId=null
  //   'reviews'                → tab=reviews, reviewId=null
  //   'reviews/<id>'           → tab=reviews, reviewId=<id>
  //   'repos' / 'settings'     → matching tab
  const { '*': splat = '' } = useParams<{ '*': string }>();
  const { tab, reviewId } = useMemo(() => {
    const parts = splat.split('/').filter(Boolean);
    const first = parts[0] as Tab | undefined;
    if (!first) return { tab: 'dashboard' as Tab, reviewId: null as string | null };
    if (!VALID_TABS.includes(first)) {
      return { tab: 'dashboard' as Tab, reviewId: null as string | null };
    }
    return {
      tab: first,
      reviewId: first === 'reviews' && parts[1] ? parts[1] : null,
    };
  }, [splat]);
  const setTab = useCallback(
    (t: Tab) => {
      navigate(`/pr-review/${t}`);
    },
    [navigate],
  );
  const setReviewId = useCallback(
    (id: string | null) => {
      navigate(id ? `/pr-review/reviews/${id}` : '/pr-review/reviews');
    },
    [navigate],
  );
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [detail, setDetail] = useState<ReviewDetailType | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const { startSkillRun, runs, setDrawerOpen, setDrawerFilter } = useDispatch();

  // True when ANY pr-review-domain run is queued/running. Drives the
  // dashboard/repos "dispatching" state that previously gated buttons.
  const dispatching = useMemo(
    () =>
      runs.some(
        (r) =>
          (r.state === 'queued' || r.state === 'running') &&
          r.skill != null &&
          (r.skill.startsWith('dev-pr-review') ||
            r.skill === 'dev-cache-pr-review-repo' ||
            r.skill === 'dev-analyze-repo-for-review' ||
            r.skill === 'dev-pull-pr-comments'),
      ),
    [runs],
  );

  // Surface the currently in-flight repo (Add/Re-index/Re-analyze) so the
  // Repos table can highlight that row as in-progress. Reads the active run's
  // tags (the new dispatch carries repo as a structured tag, no regex).
  const pendingRepo = useMemo<{ owner: string; repo: string } | null>(() => {
    const active = runs.find(
      (r) =>
        (r.state === 'queued' || r.state === 'running') &&
        r.skill != null &&
        (r.skill === 'dev-cache-pr-review-repo' ||
          r.skill === 'dev-analyze-repo-for-review') &&
        r.repo != null,
    );
    if (!active || !active.repo) return null;
    // Tags carry `repo` as `<owner>-<name>` (the entity id). The Repos table
    // expects { owner, repo } — pull from the in-flight run's prompt as a
    // fallback (the skill prompt carries owner + repo on two separate lines).
    const m = active.prompt.match(/-\s+owner:\s+"([^"]+)"\s*\n-\s+repo:\s+"([^"]+)"/m);
    return m ? { owner: m[1], repo: m[2] } : null;
  }, [runs]);

  function toast(msg: string) {
    setToastMsg(msg);
  }

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 2400);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const refreshReviews = useCallback(async () => {
    try {
      const r = await fetch('/api/reviews');
      if (!r.ok) return;
      const j = (await r.json()) as { reviews: ReviewRow[] };
      setReviews(j.reviews ?? []);
    } catch {
      /* silent — list will retry on next mount/refresh */
    }
  }, []);

  const refreshRepos = useCallback(async () => {
    try {
      const r = await fetch('/api/repos');
      if (!r.ok) return;
      const j = (await r.json()) as { repos: Repo[] };
      setRepos(j.repos ?? []);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    refreshReviews();
    refreshRepos();
  }, [refreshReviews, refreshRepos]);

  // Refresh both lists whenever a pr-review-domain run reaches a terminal
  // state — replaces the old ActionRunner.onClose refresh trigger. The drawer
  // shows the run output; this hook keeps the underlying lists + the open
  // ReviewDetail fresh so a new continuation pass surfaces without a manual
  // navigate-away-and-back.
  useRunTerminal({ domain: 'development' }, () => {
    refreshReviews();
    refreshRepos();
    if (reviewId) {
      fetch(`/api/reviews/${encodeURIComponent(reviewId)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
        .then((j: { review: ReviewDetailType }) => setDetail(j.review))
        .catch(() => {
          /* keep prior detail */
        });
    }
  });

  function openReview(id: string) {
    // setReviewId navigates to /pr-review/reviews/<id> which already implies
    // the reviews tab — no need to call setTab as well (would race + lose).
    setReviewId(id);
  }

  useEffect(() => {
    if (!reviewId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetch(`/api/reviews/${encodeURIComponent(reviewId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((j: { review: ReviewDetailType }) => {
        if (!cancelled) setDetail(j.review);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId]);

  async function dispatchSkill(
    prompt: string,
    title: string,
    tags: {
      skill: string;
      change_id?: string | null;
      repo?: string | null;
      project?: string | null;
      domain?: string | null;
    },
  ) {
    const res = await startSkillRun(prompt, title, tags);
    if ('blocked' in res && res.blocked) {
      toast(
        `Already running: ${res.blocking.skill ?? 'unknown'} (${res.blocking.run_id}). Cancel or wait.`,
      );
      return;
    }
    if ('error' in res && res.error) {
      toast(`Dispatch failed: ${res.error}`);
    }
  }

  function submitPR(url: string) {
    const trimmed = url.trim();
    if (!trimmed) {
      toast('Paste a PR URL first');
      return;
    }
    const prompt = [
      `Run the dev-pr-review skill for PR ${trimmed}.`,
      'Read .claude/skills/dev-pr-review/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- pr: ${JSON.stringify(trimmed)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Default pass_kind to auto (skill picks new vs continuation by file existence).',
      '- Write the pr-review archetype entry to vault/wiki/development/pr-review/.',
      '- Report a tight summary (counts by category + final result) at the end.',
    ].join('\n');
    dispatchSkill(prompt, `Reviewing ${shortPrLabel(trimmed)}`, {
      skill: 'dev-pr-review',
      domain: 'development',
    });
    setTab('reviews');
  }

  function addRepo(r: Repo) {
    if (!r.org || !r.name) {
      toast('Need both owner and repo to cache');
      return;
    }
    const prompt = [
      `Run the dev-cache-pr-review-repo skill for ${r.org}/${r.name}.`,
      'Read .claude/skills/dev-cache-pr-review-repo/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- owner: ${JSON.stringify(r.org)}`,
      `- repo: ${JSON.stringify(r.name)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Report a tight summary (action, files, size, path) at the end.',
    ].join('\n');
    dispatchSkill(prompt, `Caching ${r.org}/${r.name}`, {
      skill: 'dev-cache-pr-review-repo',
      repo: `${r.org}-${r.name}`,
      domain: 'development',
    });
  }

  async function removeRepo(id: string) {
    try {
      const r = await fetch(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) {
        toast('Remove failed — check server log');
        return;
      }
      toast('Repo cache removed');
      refreshRepos();
    } catch {
      toast('Remove failed — network error');
    }
  }

  function reindexRepo(id: string) {
    const target = repos.find((x) => x.id === id);
    if (!target) {
      toast('Repo not found in list');
      return;
    }
    const prompt = [
      `Run the dev-cache-pr-review-repo skill for ${target.org}/${target.name} with force: true.`,
      'Read .claude/skills/dev-cache-pr-review-repo/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- owner: ${JSON.stringify(target.org)}`,
      `- repo: ${JSON.stringify(target.name)}`,
      '- force: true',
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- force: true bypasses the 5-min staleness gate.',
      '- Report a tight summary (action, files, size, path) at the end.',
    ].join('\n');
    dispatchSkill(prompt, `Re-indexing ${target.org}/${target.name}`, {
      skill: 'dev-cache-pr-review-repo',
      repo: `${target.org}-${target.name}`,
      domain: 'development',
    });
  }

  // Triggered from ReviewDetail when the user confirms the Publish modal.
  // Dispatches dev-pr-review-publish for the chosen pass; the skill posts the
  // accepted comments to GitHub and writes back github_comment_id/review_id
  // per comment. On ActionRunner close, the detail refetch picks up the new
  // ids and the per-comment cards switch to "Published" badges.
  // Dispatches dev-pr-review with `pass_kind: continuation` so the same
  // skill that initial reviews use produces a follow-up pass — same flow as
  // the change's PR-tab "Run review" button, but explicit about continuation
  // so it never races with auto-detect on a freshly-deleted entry. Carries
  // `change` when the review is linked so the new pass's frontmatter writes
  // change_id and the change entry's `pr_review_passes` increments.
  function reReviewPr(d: ReviewDetailType) {
    const lines = [
      `Run the dev-pr-review skill against PR ${d.url} as a continuation pass.`,
      'Read .claude/skills/dev-pr-review/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- pr: ${JSON.stringify(d.url)}`,
      '- pass_kind: continuation',
    ];
    if (d.linkedChange?.id) {
      lines.push(`- change: ${JSON.stringify(d.linkedChange.id)}`);
    }
    lines.push(
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- Append a new ## Pass N section to the existing pr-review entry.',
      '- For each prior-pass comment, mark passStatus resolved/unresolved based on',
      '  whether the latest commit addresses it.',
      '- Report a tight summary (resolved / unresolved / new) at the end.',
    );
    dispatchSkill(lines.join('\n'), `Re-reviewing ${shortPrLabel(d.url)}`, {
      skill: 'dev-pr-review',
      change_id: d.linkedChange?.id ?? null,
      domain: 'development',
    });
  }

  // Dispatches dev-mark-pr-ready against the linked change. Mirrors the
  // change's PR-tab Mark Ready button so both surfaces converge on the
  // same vault-only skill (flips pr_review_status to ready-for-human,
  // stamps pr_ready_at — NO GitHub calls).
  function markPrReadyForChange(changeId: string) {
    const prompt = [
      `Run the dev-mark-pr-ready skill to mark change "${changeId}" ready for human review.`,
      'Read .claude/skills/dev-mark-pr-ready/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- This skill is vault-only: NO GitHub calls, NO PR mutations.',
      '- Report the tight summary block at the end (✓ or ↻ format per the SKILL.md).',
    ].join('\n');
    dispatchSkill(prompt, `Marking ${changeId} ready for human`, {
      skill: 'dev-mark-pr-ready',
      change_id: changeId,
      domain: 'development',
    });
  }

  // Dispatches dev-write-change against the linked change. The skill detects
  // ADDRESS-COMMENTS phase by reading pr_review_path + finding comments with
  // status in {accepted, published, published-as-body} that have no
  // acted_on_at header. Re-implements on the existing branch, commits a
  // follow-up, and marks each addressed comment status: acted-on. Mirrors
  // the Re-implement button on the Change's PR tab so the same action is
  // reachable from either surface.
  function reimplementForChange(changeId: string) {
    const prompt = [
      `Run the dev-write-change skill for change "${changeId}".`,
      'Read .claude/skills/dev-write-change/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- change: ${JSON.stringify(changeId)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      "- Status is in-review and pr_review_path is set: enter the ADDRESS-COMMENTS phase, re-implement against accepted-but-not-acted-on comments on the existing branch, commit the follow-up, mark each comment status: acted-on.",
      '- Never deviate; if tests fail, write the log and stop.',
      '- Report a short summary of what changed and what comments were addressed.',
    ].join('\n');
    dispatchSkill(prompt, `Re-implementing comments for ${changeId}`, {
      skill: 'dev-write-change',
      change_id: changeId,
      domain: 'development',
    });
  }

  function publishReview(d: ReviewDetailType, passN: number) {
    const prompt = [
      `Run the dev-pr-review-publish skill to publish pass ${passN} of "${d.id}" to GitHub.`,
      'Read .claude/skills/dev-pr-review-publish/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- review: ${JSON.stringify(d.id)}`,
      `- pass: ${passN}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- The skill is non-interactive: it derives the verdict from the entry,',
      '  filters accepted-only, and submits one batched GitHub review.',
      '- Report the tight summary block at the end (✓ or ↻ format per the SKILL.md).',
    ].join('\n');
    dispatchSkill(prompt, `Publishing ${shortPrLabel(d.url)} pass ${passN}`, {
      skill: 'dev-pr-review-publish',
      domain: 'development',
    });
  }

  // Triggered from ReviewDetail's "Pull comments" button. Dispatches
  // dev-pull-pr-comments to ingest external reviewers' inline comments as a
  // new pass on the entry. The skill is idempotent — re-runs skip comments
  // already pulled, so the user can poll this whenever they want to check
  // for new feedback without worrying about duplicates.
  function pullExternalComments(d: ReviewDetailType) {
    const prompt = [
      `Run the dev-pull-pr-comments skill to ingest external comments from "${d.id}".`,
      'Read .claude/skills/dev-pull-pr-comments/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- review: ${JSON.stringify(d.id)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- The skill is idempotent: comments already in the entry (matched by',
      "  github_comment_id) are skipped; only new comments since the entry's",
      '  last `completed` timestamp are ingested.',
      '- Report the tight summary block at the end (✓ or ↻ format per the SKILL.md).',
    ].join('\n');
    dispatchSkill(prompt, `Pulling comments for ${shortPrLabel(d.url)}`, {
      skill: 'dev-pull-pr-comments',
      domain: 'development',
    });
  }

  // Triggered from ReviewDetail when a user re-analyzes a single comment.
  // Dispatches dev-pr-review as a continuation pass against this PR, passing
  // the (optional) hint through to focus_notes so the model knows which
  // comment to drill into. The new pass lands in the same pr-review entry;
  // ReviewDetail picks it up via refreshReviews → detail refetch on close.
  function reanalyzeComment(args: {
    passN: number;
    commentN: number;
    hint: string;
    file: string;
  }) {
    if (!detail) {
      toast('Open a review first');
      return;
    }
    const focusLine = `Pass ${args.passN}, comment ${args.commentN}${
      args.file ? ` (${args.file})` : ''
    }${args.hint ? ` — ${args.hint}` : ''}`;
    const prompt = [
      `Run the dev-pr-review skill to re-analyze a single comment on PR ${detail.url}.`,
      'Read .claude/skills/dev-pr-review/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- pr: ${JSON.stringify(detail.url)}`,
      '- pass_kind: continuation',
      `- focus_notes: ${JSON.stringify(focusLine)}`,
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- This is a focused re-analysis: bias toward re-examining the referenced comment',
      '  in light of the latest commit and the focus_notes hint, while still producing',
      '  a normal continuation pass body section.',
      '- Append a new ## Pass N section to the existing pr-review entry (do not create',
      '  a separate entry).',
      '- Report a tight summary at the end.',
    ].join('\n');
    dispatchSkill(
      prompt,
      `Re-analyzing ${shortPrLabel(detail.url)} comment ${args.commentN}`,
      { skill: 'dev-pr-review', domain: 'development' },
    );
  }

  function analyzeRepo(id: string) {
    const target = repos.find((x) => x.id === id);
    if (!target) {
      toast('Repo not found in list');
      return;
    }
    const prompt = [
      `Run the dev-analyze-repo-for-review skill for ${target.org}/${target.name} with force: true.`,
      'Read .claude/skills/dev-analyze-repo-for-review/SKILL.md and follow its Procedure exactly.',
      '',
      'Inputs:',
      `- owner: ${JSON.stringify(target.org)}`,
      `- repo: ${JSON.stringify(target.name)}`,
      '- force: true',
      '',
      'IMPORTANT — headless dashboard-driven call:',
      '- Do NOT use AskUserQuestion or any interactive prompt.',
      '- force: true bypasses the staleness gate; analysis runs even if recent.',
      '- Report a tight summary (sections produced, based_on_commit, model used) at the end.',
    ].join('\n');
    dispatchSkill(prompt, `Analyzing ${target.org}/${target.name}`, {
      skill: 'dev-analyze-repo-for-review',
      repo: `${target.org}-${target.name}`,
      domain: 'development',
    });
  }

  return (
    <div className="page-wide" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          padding: '20px 24px 0',
          flexWrap: 'wrap',
        }}
      >
        <h1 className="h1">PR Review</h1>
        <span className="tiny">multi-agent code review</span>
      </header>
      <div
        className="tabs"
        style={{
          padding: '12px 24px 0',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 4,
        }}
      >
        <TabBtn id="dashboard" current={tab} setTab={setTab} icon={<Icons.Home size={13} />}>
          Dashboard
        </TabBtn>
        <TabBtn id="reviews" current={tab} setTab={setTab} icon={<Icons.Reviews size={13} />}>
          Reviews
        </TabBtn>
        <TabBtn id="repos" current={tab} setTab={setTab} icon={<Icons.Repo size={13} />}>
          Repos
        </TabBtn>
        <TabBtn id="settings" current={tab} setTab={setTab} icon={<Icons.Settings size={13} />}>
          Settings
        </TabBtn>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'dashboard' && (
          <Dashboard
            reviews={reviews}
            repos={repos}
            onSubmitPR={submitPR}
            onOpenReview={openReview}
            onNavigate={(t) => setTab(t)}
            dispatching={dispatching}
          />
        )}
        {tab === 'reviews' && !reviewId && <Reviews reviews={reviews} onOpen={openReview} />}
        {tab === 'reviews' && reviewId && detail && (
          <ReviewDetail
            detail={detail}
            onBack={() => setReviewId(null)}
            onPublish={(passN) => publishReview(detail, passN)}
            onReanalyze={reanalyzeComment}
            onPullComments={() => pullExternalComments(detail)}
            onReimplement={(changeId) => reimplementForChange(changeId)}
            onReReview={() => reReviewPr(detail)}
            onMarkReady={(changeId) => markPrReadyForChange(changeId)}
            toast={toast}
          />
        )}
        {tab === 'reviews' && reviewId && !detail && (
          <div style={{ padding: 24, color: 'var(--fg-muted)' }}>
            {detailLoading ? 'Loading review…' : `Review "${reviewId}" not found.`}
          </div>
        )}
        {tab === 'repos' && (
          <Repos
            repos={repos}
            onAdd={addRepo}
            onRemove={removeRepo}
            onReindex={reindexRepo}
            onAnalyze={analyzeRepo}
            dispatching={dispatching}
            pendingRepo={pendingRepo}
            onShowOutput={() => {
              // Open the run drawer filtered to the in-flight repo run so
              // the user can see the live output. Replaces the old
              // ActionRunner-un-minimize semantic.
              if (pendingRepo) {
                setDrawerFilter({
                  repo: `${pendingRepo.owner}-${pendingRepo.repo}`,
                });
              } else {
                setDrawerFilter({ state: 'running' });
              }
              setDrawerOpen(true);
            }}
          />
        )}
        {tab === 'settings' && <Settings />}
      </div>
      <Toast msg={toastMsg} />
    </div>
  );
}

function TabBtn({
  id,
  current,
  setTab,
  icon,
  children,
}: {
  id: Tab;
  current: Tab;
  setTab: (t: Tab) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const active = id === current;
  return (
    <button
      type="button"
      className={active ? 'tab active' : 'tab'}
      onClick={() => setTab(id)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      {icon} {children}
    </button>
  );
}

function shortPrLabel(url: string): string {
  const m = url.match(/github\.com\/([\w-]+)\/([\w.-]+?)\/pull\/(\d+)/);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : 'PR';
}
