// ReviewDetail — passes timeline + summary + filter row + grouped comments.
// Heaviest page in the prototype. Single-file port for now; can extract
// sub-components if it gets unwieldy.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Rendered } from '../../../components/EditableMarkdown';
import { useDispatch } from '../../../lib/dispatch';
import {
  AgentChip,
  CodeLine,
  Empty,
  Icons,
  ResultBadge,
  SharedModal,
  StatusBadge,
  sevClass,
  sevIcon,
  sevLabel,
} from '../../../shared';
import type {
  CommentState,
  PassStats,
  RecentRun,
  ReviewComment,
  ReviewDetail as ReviewDetailType,
  ReviewPass,
} from '../data';
import { Field } from './Repos';

export function ReviewDetail({
  detail,
  onBack,
  onPublish,
  onReanalyze,
  onPullComments,
  onReimplement,
  onReReview,
  onMarkReady,
  toast,
}: {
  detail: ReviewDetailType;
  onBack: () => void;
  // Triggered when the user confirms the Publish modal. The parent dispatches
  // dev-pr-review-publish for the named pass via ActionRunner; we don't call
  // the github MCP inline here. After the run completes the parent refetches
  // /api/reviews and the new github_comment_id/github_review_id surface on
  // each comment card automatically.
  onPublish: (passN: number) => void;
  // Triggered when a reviewer asks for a re-analysis of a single comment.
  // The parent dispatches dev-pr-review with focus_notes scoped to that
  // comment; we don't run the model inline here.
  onReanalyze: (args: { passN: number; commentN: number; hint: string; file: string }) => void;
  // Triggered by the "Pull external comments" button — parent dispatches
  // dev-pull-pr-comments which ingests external reviewer feedback as a
  // new pass on this entry.
  onPullComments: () => void;
  // Triggered by the "Re-implement" button — parent dispatches
  // dev-write-change against the linked change so ADDRESS-COMMENTS phase
  // folds accepted comments into a new commit on the existing branch.
  // Receives the change_id (resolved from detail.linkedChange.id).
  onReimplement: (changeId: string) => void;
  // Triggered by the "Re-review" button — parent dispatches dev-pr-review
  // with pass_kind: continuation. Same skill the change's PR-tab Run-review
  // button fires; this is the convergence point so both surfaces share one
  // dispatch path.
  onReReview: () => void;
  // Triggered by the "Mark ready" button — parent dispatches
  // dev-mark-pr-ready against the linked change. Receives the change_id
  // (only renders when detail.linkedChange?.id is set).
  onMarkReady: (changeId: string) => void;
  toast: (m: string) => void;
}) {
  // Local copy of passes so we can mutate comment state + append new passes.
  // Preserve the state/acceptNote/dismissReason coming from the API — those
  // reflect file-of-record truth from accept/dismiss writes. Only fall back to
  // 'open' for legacy mock data that omits the field.
  const [passes, setPasses] = useState<ReviewPass[]>(() =>
    detail.passes.map((p) => ({
      ...p,
      comments: p.comments.map((c) => ({
        ...c,
        state: (c.state ?? 'open') as CommentState,
      })),
    })),
  );
  // Re-sync local passes when the `detail` prop changes (parent refetched
  // after a new pass landed via dev-pr-review re-review). Without this, the
  // useState initializer's once-at-mount snapshot becomes permanently stale —
  // new passes written to the server are invisible until full page navigate.
  // The mapping mirrors the initializer so accept/dismiss state from the
  // server takes precedence (the server has the canonical truth post-mutation).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — sync only when the server-side passes change, not on every render
  useEffect(() => {
    setPasses(
      detail.passes.map((p) => ({
        ...p,
        comments: p.comments.map((c) => ({
          ...c,
          state: (c.state ?? 'open') as CommentState,
        })),
      })),
    );
  }, [detail.passes]);
  // Track in-flight comment mutations so cards can show pending UI.
  const [mutating, setMutating] = useState<string | null>(null);
  const [currentPassId, setCurrentPassId] = useState<string>(passes[passes.length - 1].id);
  // When a new pass lands via refetch, advance the visible pass to the
  // freshest one so the user sees the new verdict + comments without having
  // to manually click the new pass tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: same — only advance when count actually changes
  useEffect(() => {
    if (detail.passes.length > 0) {
      const latest = detail.passes[detail.passes.length - 1];
      setCurrentPassId(latest.id);
    }
  }, [detail.passes.length]);
  const currentPass = passes.find((p) => p.id === currentPassId) ?? passes[passes.length - 1];
  const passIdx = passes.findIndex((p) => p.id === currentPassId);

  const [sev, setSev] = useState<'all' | 'bug' | 'nit' | 'suggestion'>('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'resolved' | 'unresolved' | 'new'>(
    'all',
  );
  const [retriggering, setRetriggering] = useState(false);
  const [retrigProgress, setRetrigProgress] = useState(0);
  const [publishOpen, setPublishOpen] = useState(false);

  // Live PR state from GitHub — fetched once on mount when there's a linked
  // change (OS-authored PRs). External-PR reviews (no change_id) skip this;
  // their PR state stays out of the live-pill until we wire a dedicated
  // /api/reviews/:id/pr endpoint.
  const linkedChangeId = detail.linkedChange?.id ?? null;
  const [livePrState, setLivePrState] = useState<{
    state: string;
    merged: boolean;
    draft: boolean;
    merged_at: string | null;
  } | null>(null);
  useEffect(() => {
    if (!linkedChangeId) {
      setLivePrState(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/changes/${encodeURIComponent(linkedChangeId)}/pr`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j?.ok && j.pr) {
          setLivePrState({
            state: j.pr.state,
            merged: !!j.pr.merged,
            draft: !!j.pr.draft,
            merged_at: j.pr.merged_at ?? null,
          });
        }
      })
      .catch(() => {
        /* silent — pill just won't render */
      });
    return () => {
      cancelled = true;
    };
  }, [linkedChangeId]);

  const comments = currentPass.comments;

  useEffect(() => {
    if (!retriggering) return;
    setRetrigProgress(0);
    const t = setInterval(() => {
      setRetrigProgress((p) => {
        if (p >= 100) {
          clearInterval(t);
          setRetriggering(false);
          toast('Review re-triggered against latest commit');
          return 0;
        }
        return p + 7;
      });
    }, 90);
    return () => clearInterval(t);
  }, [retriggering, toast]);

  const counts = useMemo(
    () => ({
      all: comments.length,
      bug: comments.filter((c) => c.severity === 'bug').length,
      nit: comments.filter((c) => c.severity === 'nit').length,
      suggestion: comments.filter((c) => c.severity === 'suggestion').length,
    }),
    [comments],
  );

  const passCounts = useMemo(
    () => ({
      resolved: comments.filter((c) => c.passStatus === 'resolved').length,
      unresolved: comments.filter((c) => c.passStatus === 'unresolved').length,
      new: comments.filter((c) => c.passStatus === 'new').length,
    }),
    [comments],
  );

  const filtered = comments.filter((c) => {
    if (sev !== 'all' && c.severity !== sev) return false;
    if (agentFilter !== 'all' && c.agent !== agentFilter) return false;
    if (statusFilter !== 'all' && c.passStatus !== statusFilter) return false;
    return true;
  });

  const groups = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of filtered) {
      if (!m.has(c.file)) m.set(c.file, []);
      m.get(c.file)?.push(c);
    }
    return [...m.entries()];
  }, [filtered]);

  function updatePassComments(mutator: (cs: ReviewComment[]) => ReviewComment[]) {
    setPasses((ps) =>
      ps.map((p) => (p.id === currentPassId ? { ...p, comments: mutator(p.comments) } : p)),
    );
  }
  function editMessage(id: string, message: string) {
    updatePassComments((cs) => cs.map((c) => (c.id === id ? { ...c, message } : c)));
  }

  // Parse a comment id like `pass-2-comment-3` into its passN / commentN pair
  // for the mutation endpoint. The id shape is set server-side by
  // toReviewComment; mock-data ids of the form `p1` are not mutable.
  function parseCommentId(id: string): { passN: number; commentN: number } | null {
    const m = id.match(/^pass-(\d+)-comment-(\d+)$/);
    if (!m) return null;
    return { passN: Number(m[1]), commentN: Number(m[2]) };
  }

  async function mutateComment(
    id: string,
    action: 'accept' | 'dismiss',
    note: string,
  ): Promise<boolean> {
    const parsed = parseCommentId(id);
    if (!parsed) {
      toast('This comment is not persistable (legacy mock data)');
      return false;
    }
    setMutating(id);
    try {
      const url =
        `/api/reviews/${encodeURIComponent(detail.id)}` +
        `/comments/${parsed.passN}/${parsed.commentN}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: note.trim() || null }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        toast(`Save failed${txt ? ` — ${txt.slice(0, 80)}` : ''}`);
        return false;
      }
      const j = (await res.json()) as { review: { passes: ReviewPass[] } };
      // Merge the fresh server passes back into local state. Server is the
      // source of truth for status/acceptNote/dismissReason; preserve local
      // ReviewPass commit/duration/recommendation fields the API doesn't carry
      // by overlaying onto current `passes`.
      setPasses((local) =>
        j.review.passes.map((srv) => {
          const prior = local.find((p) => p.id === srv.id);
          return prior ? { ...prior, ...srv, comments: srv.comments } : srv;
        }),
      );
      toast(action === 'accept' ? 'Comment accepted' : 'Comment dismissed');
      return true;
    } catch (err) {
      toast(`Save failed — ${(err as Error).message}`);
      return false;
    } finally {
      setMutating(null);
    }
  }

  const allAgents = Array.from(new Set(passes.flatMap((p) => p.comments.map((c) => c.agent))));
  const acceptedCount = comments.filter((c) => c.state === 'accepted').length;
  // Open = `passStatus: new` AND state still `open`. The server's bulk
  // endpoint targets `status: new` specifically; we mirror that filter here
  // so the button's tooltip reports an accurate count.
  const openCount = comments.filter((c) => c.state === 'open' && c.passStatus === 'new').length;
  // Comments the ADDRESS-COMMENTS phase would re-implement against: accepted
  // (or terminally accepted via publish) but not yet acted on in code.
  // Mirrors detail.comments_to_address that the changes API computes server
  // side — calculated client-side here from the same source of truth.
  const addressableCount = comments.filter((c) => c.state === 'accepted' && !c.actedOnAt).length;
  const linkedChangeForReimplement = detail.linkedChange?.id ?? null;
  const [acceptingAll, setAcceptingAll] = useState(false);

  async function acceptAllOpen() {
    if (openCount === 0) {
      toast('No open comments to accept');
      return;
    }
    setAcceptingAll(true);
    try {
      const url = `/api/reviews/${encodeURIComponent(detail.id)}/comments/accept-all`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passN: currentPass.n }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        toast(`Accept-all failed${txt ? ` — ${txt.slice(0, 80)}` : ''}`);
        return;
      }
      const j = (await res.json()) as {
        accepted: number;
        review: { passes: ReviewPass[] };
      };
      setPasses((local) =>
        j.review.passes.map((srv) => {
          const prior = local.find((p) => p.id === srv.id);
          return prior ? { ...prior, ...srv, comments: srv.comments } : srv;
        }),
      );
      toast(`Accepted ${j.accepted} comment${j.accepted !== 1 ? 's' : ''}`);
    } catch (err) {
      toast(`Accept-all failed — ${(err as Error).message}`);
    } finally {
      setAcceptingAll(false);
    }
  }

  return (
    <div className="page page-wide">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          title="Back"
          style={{ marginTop: 2 }}
        >
          <Icons.ChevronLeft size={16} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="hstack" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span className="mono" style={{ color: 'var(--muted)', fontSize: 13 }}>
              {detail.repo}
            </span>
            <span style={{ color: 'var(--faint)' }}>/</span>
            <span className="mono" style={{ color: 'var(--text-2)', fontSize: 13 }}>
              {detail.pr}
            </span>
            <span className="badge">
              <Icons.GitBranch size={11} /> {detail.branch} → {detail.base}
            </span>
            <StatusBadge status={currentPass.status} />
            {currentPass.result && <ResultBadge result={currentPass.result} />}
            <span className="badge accent">
              <Icons.GitCommit size={11} /> {passes.length} pass{passes.length !== 1 ? 'es' : ''}
            </span>
            {livePrState && (
              <LivePrStateBadge
                state={livePrState.state}
                merged={livePrState.merged}
                draft={livePrState.draft}
                mergedAt={livePrState.merged_at}
                prUrl={detail.url}
              />
            )}
            {detail.linkedChange && (
              <LinkedChangeBadge
                changeId={detail.linkedChange.id}
                status={detail.linkedChange.prReviewStatus}
                readyAt={detail.linkedChange.prReadyAt}
              />
            )}
          </div>
          <h1 className="h1">{detail.title}</h1>
          <div className="tiny" style={{ marginTop: 6 }}>
            opened by <span className="mono">{detail.author}</span> · {detail.files} files ·{' '}
            <span style={{ color: 'var(--success-text)' }}>+{detail.additions}</span>{' '}
            <span style={{ color: 'var(--danger-text)' }}>−{detail.deletions}</span>
          </div>
          {detail.recentRuns && detail.recentRuns.length > 0 && (
            <RecentRunsStrip runs={detail.recentRuns} />
          )}
        </div>
        <div className="hstack" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn"
            onClick={() => setRetriggering(true)}
            disabled={retriggering}
            title="Re-run the entire review from scratch — discards prior pass context"
          >
            <Icons.Refresh size={13} className={retriggering ? 'spin' : ''} />
            {retriggering ? 'Re-triggering…' : 'Re-trigger'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onReReview}
            disabled={retriggering}
            style={{
              borderColor: 'var(--accent-border)',
              background: 'var(--accent-soft)',
              color: 'var(--accent-text)',
            }}
            title="Dispatches dev-pr-review with pass_kind: continuation — keeps the prior pass's context, sees the latest commit, and marks each prior comment resolved/unresolved. Same skill the change's PR-tab Run-review fires. Use after Re-implement to verify the fixes. Watch the drawer for live output."
          >
            <Icons.GitPullRequest size={13} />
            Re-review
          </button>
          <button
            type="button"
            className="btn"
            onClick={onPullComments}
            title="Pull external reviewers' comments from GitHub as a new pass. Each ingested comment lands status: new — you triage via the Accept/Dismiss buttons just like model-generated ones. Idempotent: re-runs skip comments already pulled."
          >
            <Icons.Refresh size={13} /> Pull comments
          </button>
          <a className="btn" href={detail.url} target="_blank" rel="noreferrer">
            <Icons.External size={13} /> Open PR
          </a>
          <button
            type="button"
            className="btn"
            onClick={acceptAllOpen}
            disabled={openCount === 0 || acceptingAll}
            title={
              openCount === 0
                ? 'No open comments to accept (all have been triaged already).'
                : `Marks the ${openCount} open comment${openCount !== 1 ? 's' : ''} in this pass as accepted (status: new → accepted). Skips already-triaged comments. Idempotent — safe to re-click.`
            }
          >
            <Icons.Check size={13} className={acceptingAll ? 'spin' : ''} />
            {acceptingAll ? 'Accepting…' : `Accept all${openCount > 0 ? ` (${openCount})` : ''}`}
          </button>
          {linkedChangeForReimplement && addressableCount > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => onReimplement(linkedChangeForReimplement)}
              title={`Runs dev-write-change in ADDRESS-COMMENTS mode against change ${linkedChangeForReimplement}: reads accepted-but-not-acted-on comments, makes the code edits on the existing branch, commits the follow-up, then marks each comment status: acted-on. Same action as the Re-implement button on the change's PR tab — reachable from either surface.`}
            >
              <Icons.Code size={13} /> Re-implement ({addressableCount})
            </button>
          )}
          {detail.linkedChange?.id && detail.linkedChange?.prReviewStatus === 'pending' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => detail.linkedChange?.id && onMarkReady(detail.linkedChange.id)}
              title={`Runs dev-mark-pr-ready against change ${detail.linkedChange.id}: flips pr_review_status to ready-for-human and stamps pr_ready_at. Vault-only — NO GitHub calls. Same action as the Mark Ready button on the change's PR tab. Merge the PR on GitHub yourself after.`}
            >
              <Icons.Check size={13} /> Mark ready
            </button>
          )}
          {detail.linkedChange?.prReviewStatus === 'ready-for-human' && (
            <span
              className="badge success"
              title={
                detail.linkedChange.prReadyAt
                  ? `Signed off via Mark ready for human on ${detail.linkedChange.prReadyAt}`
                  : 'Signed off via Mark ready for human'
              }
              style={{ alignSelf: 'center' }}
            >
              <Icons.Check size={11} /> Ready
            </span>
          )}
          <PublishButton
            pass={currentPass}
            comments={comments}
            onOpen={() => setPublishOpen(true)}
          />
        </div>
      </div>

      {retriggering && (
        <div
          style={{
            marginBottom: 14,
            padding: '10px 12px',
            border: '1px solid var(--accent-border)',
            background: 'var(--accent-soft)',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span className="dot running" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--accent-text)' }}>
              Re-triggering review against latest commit (fresh context)…
            </div>
            <div className="progress running" style={{ marginTop: 6 }}>
              <i style={{ width: `${retrigProgress}%` }} />
            </div>
          </div>
          <span className="mono tiny" style={{ color: 'var(--accent-text)' }}>
            {retrigProgress}%
          </span>
        </div>
      )}

      <PassesTimeline passes={passes} currentId={currentPassId} onSelect={setCurrentPassId} />

      <SummaryCard
        pass={currentPass}
        isInitialPass={passIdx === 0}
        acceptedCount={acceptedCount}
        totalComments={comments.length}
      />

      <ConfigSnapshotCard config={detail.config} />

      <div className="filter-row" style={{ marginTop: 18 }}>
        <div className="tabs">
          {(
            [
              ['all', 'All', counts.all, null],
              ['bug', 'Bugs', counts.bug, 'var(--danger)'],
              ['nit', 'Nits', counts.nit, 'var(--warning)'],
              ['suggestion', 'Suggestions', counts.suggestion, 'var(--accent)'],
            ] as const
          ).map(([id, label, n, color]) => (
            <button
              key={id}
              type="button"
              className="tab"
              aria-selected={sev === id}
              onClick={() => setSev(id)}
            >
              {color && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: color,
                    display: 'inline-block',
                  }}
                />
              )}
              {label} <span className="count">{n}</span>
            </button>
          ))}
        </div>
        {passIdx > 0 && passCounts.resolved + passCounts.unresolved + passCounts.new > 0 && (
          <div className="tabs">
            {(
              [
                ['all', 'All', comments.length],
                ['resolved', 'Resolved', passCounts.resolved],
                ['unresolved', 'Still open', passCounts.unresolved],
                ['new', 'New', passCounts.new],
              ] as const
            ).map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                className="tab"
                aria-selected={statusFilter === id}
                onClick={() => setStatusFilter(id)}
              >
                {label} <span className="count">{n}</span>
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <select
          className="input"
          style={{ width: 160, height: 34 }}
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
        >
          <option value="all">All agents</option>
          {allAgents.map((a) => (
            <option key={a} value={a}>
              {a.charAt(0).toUpperCase() + a.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {currentPass.status === 'running' ? (
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <span className="dot running" style={{ width: 14, height: 14 }} />
            <div className="h2">Re-reviewing…</div>
            <div className="subtle" style={{ maxWidth: 420 }}>
              Comparing the new commit against pass {passes[passes.length - 2]?.n ?? 1}. Resolved
              comments will be marked, new findings flagged.
            </div>
            <div className="progress running" style={{ width: 280, marginTop: 4 }}>
              <i style={{ width: `${currentPass.progress ?? 5}%` }} />
            </div>
            <span className="mono tiny" style={{ color: 'var(--accent-text)' }}>
              {currentPass.progress ?? 5}%
            </span>
          </div>
        </div>
      ) : groups.length === 0 ? (
        <Empty
          title="No comments match the filter"
          hint="Try clearing severity or status filters."
          icon={<Icons.Check size={28} />}
        />
      ) : (
        groups.map(([file, items]) => (
          <FileGroup
            key={file}
            file={file}
            items={items}
            showStatus={passIdx > 0}
            mutating={mutating}
            prUrl={detail.url}
            reviewId={detail.id}
            onMutate={mutateComment}
            onReanalyze={onReanalyze}
            onEdit={editMessage}
          />
        ))
      )}

      {publishOpen && (
        <PublishModal
          detail={detail}
          pass={currentPass}
          comments={comments}
          onClose={() => setPublishOpen(false)}
          onConfirm={() => {
            setPublishOpen(false);
            onPublish(currentPass.n);
          }}
        />
      )}
    </div>
  );
}

function PassesTimeline({
  passes,
  currentId,
  onSelect,
}: {
  passes: ReviewPass[];
  currentId: string;
  onSelect: (id: string) => void;
}) {
  // Vertical single-row list. Each pass is one click-target row showing the
  // headline state inline (dot · Pass N · stats · timestamp · badge). Scales
  // cleanly from 1 to N passes — the container caps height so the runs scroll
  // rather than push the comment view down. Replaces the prior horizontal-
  // strip layout which compressed badly past ~3 passes.
  return (
    <div
      style={{
        marginBottom: 18,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--panel)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          maxHeight: 240,
          overflowY: 'auto',
        }}
      >
        {passes.map((p, i) => {
          const active = p.id === currentId;
          const dotCls =
            p.status === 'running'
              ? 'dot running'
              : p.result === 'approve'
                ? 'dot success'
                : p.result === 'block'
                  ? 'dot failed'
                  : p.result === 'changes'
                    ? 'dot warning'
                    : 'dot idle';
          // Headline stats one-liner: prefer the action shapes (resolved/open/new)
          // over a raw "N comments total" count, since the action shapes carry
          // more signal at a glance.
          const statsBits: React.ReactNode[] = [];
          if (p.stats.resolved > 0) {
            statsBits.push(
              <span key="resolved" style={{ color: 'var(--success-text)' }}>
                {p.stats.resolved} resolved
              </span>,
            );
          }
          if (p.stats.stillOpen > 0) {
            statsBits.push(
              <span key="open" style={{ color: 'var(--warning-text)' }}>
                {p.stats.stillOpen} open
              </span>,
            );
          }
          if (p.stats.fresh > 0) {
            statsBits.push(
              <span key="fresh" style={{ color: 'var(--accent-text)' }}>
                {p.stats.fresh} new
              </span>,
            );
          }
          if (statsBits.length === 0 && p.status === 'completed') {
            const total = p.comments?.length ?? 0;
            statsBits.push(
              <span key="total" style={{ color: 'var(--muted)' }}>
                {total === 0 ? 'no comments' : `${total} comment${total === 1 ? '' : 's'}`}
              </span>,
            );
          }
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: 10,
                textAlign: 'left',
                background: active ? 'var(--panel-2)' : 'transparent',
                border: 0,
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                padding: '8px 14px 8px 11px',
                cursor: 'pointer',
                color: 'inherit',
                fontSize: 13,
                minHeight: 36,
              }}
            >
              <span className={dotCls} style={{ flexShrink: 0 }} />
              <span style={{ fontWeight: 600, minWidth: 56, flexShrink: 0 }}>Pass {p.n}</span>
              {statsBits.length > 0 && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {statsBits.map((b, ix) => (
                    <span
                      key={`stat-${ix}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <span style={{ fontSize: 8 }}>●</span>
                      {b}
                    </span>
                  ))}
                </span>
              )}
              {statsBits.length === 0 && <span style={{ flex: 1 }} />}
              <span
                className="tiny mono"
                style={{ color: 'var(--muted)', flexShrink: 0 }}
                title={p.started}
              >
                {p.started}
              </span>
              {p.published ? (
                <span className="badge success" style={{ fontSize: 10.5, flexShrink: 0 }}>
                  <Icons.Check size={10} /> Published
                </span>
              ) : p.status === 'completed' ? (
                <span className="badge muted" style={{ fontSize: 10.5, flexShrink: 0 }}>
                  Draft
                </span>
              ) : p.status === 'running' ? (
                <span className="badge accent" style={{ fontSize: 10.5, flexShrink: 0 }}>
                  Running
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SummaryCard({
  pass,
  isInitialPass,
  acceptedCount,
  totalComments,
}: {
  pass: ReviewPass;
  isInitialPass: boolean;
  acceptedCount: number;
  totalComments: number;
}) {
  if (pass.status === 'running') {
    return (
      <div className="summary-card">
        <div className="hstack">
          <span className="dot running" />
          <div className="h2" style={{ margin: 0 }}>
            Pass {pass.n} · running…
          </div>
        </div>
        <p className="summary-text" style={{ marginTop: 10 }}>
          {pass.summary}
        </p>
      </div>
    );
  }
  const rec = pass.recommendation || pass.result;
  const recLabel = (
    {
      approve: 'Recommended: Approve',
      changes: 'Recommended: Request changes',
      block: 'Recommended: Block merge',
    } as Record<string, string>
  )[rec ?? ''];
  return (
    <div className="summary-card">
      <div
        className={`rec-banner ${rec === 'approve' ? 'approve' : rec === 'changes' ? 'changes' : 'block'}`}
      >
        {rec === 'approve' ? (
          <Icons.Check size={13} />
        ) : rec === 'changes' ? (
          <Icons.AlertTriangle size={13} />
        ) : (
          <Icons.X size={13} />
        )}
        {recLabel}
      </div>
      <h2 className="summary-title">
        {isInitialPass ? 'Summary' : `Pass ${pass.n} · ${pass.label}`}
      </h2>
      <p className="summary-text">{pass.summary}</p>
      <div className="summary-stats">
        {!isInitialPass && pass.stats.resolved != null && (
          <>
            <SummaryStat v={pass.stats.resolved} l="Resolved" color="var(--success-text)" />
            <SummaryStat v={pass.stats.stillOpen} l="Still open" color="var(--warning-text)" />
            <SummaryStat v={pass.stats.fresh} l="New" color="var(--accent-text)" />
          </>
        )}
        <SummaryStat v={pass.stats.bugs} l="Bugs" color="var(--danger-text)" />
        <SummaryStat v={pass.stats.nits} l="Nits" color="var(--warning-text)" />
        <SummaryStat v={pass.stats.suggestions} l="Suggestions" color="var(--accent-text)" />
        <SummaryStat v={pass.duration} l="Duration" />
        <SummaryStat v={`${acceptedCount}/${totalComments}`} l="Accepted" />
      </div>
    </div>
  );
}

function SummaryStat({
  v,
  l,
  color,
}: {
  v: number | string;
  l: string;
  color?: string;
}) {
  return (
    <div className="summary-stat">
      <div className="v" style={color ? { color } : undefined}>
        {v}
      </div>
      <div className="l">{l}</div>
    </div>
  );
}

function FileGroup({
  file,
  items,
  showStatus,
  mutating,
  prUrl,
  reviewId,
  onMutate,
  onReanalyze,
  onEdit,
}: {
  file: string;
  items: ReviewComment[];
  showStatus: boolean;
  mutating: string | null;
  // PR URL — passed to each CommentCard so published comments can render a
  // deep link to the GitHub-side comment via `<pr_url>#discussion_r<id>`.
  prUrl: string;
  // Review entry id — used by the per-comment SourceSnippet fetcher to
  // resolve the repo's local_path via /api/reviews/:id/snippet.
  reviewId: string;
  onMutate: (id: string, action: 'accept' | 'dismiss', note: string) => Promise<boolean>;
  onReanalyze: (args: { passN: number; commentN: number; hint: string; file: string }) => void;
  onEdit: (id: string, message: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 22 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'transparent',
          border: 0,
          padding: '8px 0 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        {open ? (
          <Icons.ChevronDown size={14} style={{ color: 'var(--muted)' }} />
        ) : (
          <Icons.ChevronRight size={14} style={{ color: 'var(--muted)' }} />
        )}
        <Icons.File size={14} style={{ color: 'var(--muted)' }} />
        <span className="mono" style={{ fontWeight: 500 }}>
          {file}
        </span>
        <span className="tiny" style={{ marginLeft: 4 }}>
          {items.length} comment{items.length !== 1 ? 's' : ''}
        </span>
      </button>
      {open &&
        items.map((c) => (
          <CommentCard
            key={c.id}
            c={c}
            showStatus={showStatus}
            busy={mutating === c.id}
            prUrl={prUrl}
            reviewId={reviewId}
            onMutate={(action, note) => onMutate(c.id, action, note)}
            onReanalyze={(hint) => {
              const m = c.id.match(/^pass-(\d+)-comment-(\d+)$/);
              if (!m) return;
              onReanalyze({
                passN: Number(m[1]),
                commentN: Number(m[2]),
                hint,
                file: c.file,
              });
            }}
            onEdit={(msg) => onEdit(c.id, msg)}
          />
        ))}
    </div>
  );
}

// Chip showing the linked change's OS-side workflow state. Renders only when
// the review's frontmatter carries `change_id` (OS-authored PRs). Clickable
// — navigates to the Changes app's detail page for that change.
// Live GitHub PR state pill — open / merged / closed / draft. Fetched on
// mount from /api/changes/:id/pr (only when the review has a linked change).
// Color-coded for muscle memory: merged = success-purple, open = info, closed
// (without merge) = danger, draft = muted. Clickable — opens the PR.
function LivePrStateBadge({
  state,
  merged,
  draft,
  mergedAt,
  prUrl,
}: {
  state: string;
  merged: boolean;
  draft: boolean;
  mergedAt: string | null;
  prUrl: string;
}) {
  // Compute label + color from the live state. merged trumps state (a merged
  // PR is technically `state: closed` on GitHub, so the precedence matters).
  let label: string;
  let cls: string;
  let title: string;
  if (merged) {
    label = mergedAt ? `merged · ${new Date(mergedAt).toLocaleDateString()}` : 'merged';
    cls = 'badge success';
    title = `PR merged on GitHub${mergedAt ? ` at ${mergedAt}` : ''}. Click to open.`;
  } else if (state === 'closed') {
    label = 'closed';
    cls = 'badge muted';
    title = 'PR closed without merge. Click to open on GitHub.';
  } else if (draft) {
    label = 'draft';
    cls = 'badge muted';
    title = 'PR is in draft mode on GitHub. Click to open.';
  } else {
    label = 'open';
    cls = 'badge';
    title = 'PR is open on GitHub. Click to open.';
  }
  return (
    <a
      className={cls}
      href={prUrl}
      target="_blank"
      rel="noreferrer"
      title={title}
      style={{ textDecoration: 'none', gap: 4 }}
    >
      <Icons.GitPullRequest size={11} /> {label}
    </a>
  );
}

function LinkedChangeBadge({
  changeId,
  status,
  readyAt,
}: {
  changeId: string;
  status: string | null;
  readyAt: string | null;
}) {
  // Color per status (matches the Changes app's PrReviewSummaryCard for visual
  // consistency): needs-changes = warn, ready-for-human = success, else muted.
  const color =
    status === 'needs-changes'
      ? 'var(--warn-text)'
      : status === 'ready-for-human'
        ? 'var(--success-text)'
        : 'var(--muted)';
  const label = status ?? 'no review state';
  const hover =
    status === 'ready-for-human'
      ? `Signed off via Mark ready for human${readyAt ? ` (${readyAt})` : ''}. Click to open the linked change.`
      : status === 'needs-changes'
        ? 'Latest review has blockers — comments must be addressed before sign-off. Click to open the linked change.'
        : `Linked change is "${changeId}" — click to open it.`;
  return (
    <Link
      to={`/changes/${changeId}`}
      className="badge"
      title={hover}
      style={{
        color,
        borderColor: 'currentColor',
        gap: 4,
        textDecoration: 'none',
      }}
    >
      <Icons.GitBranch size={11} />
      <span className="mono" style={{ fontSize: 11 }}>
        {changeId}
      </span>
      <span style={{ opacity: 0.7 }}>·</span>
      <span style={{ fontWeight: 500 }}>{label}</span>
    </Link>
  );
}

// Tiny chip showing one recent skill dispatch for this review. Hover for the
// full action name + ISO timestamp. Silent-completion runs (ai-prompt fired
// but no follow-up completion event) get a warning color so the user can
// spot publish/mutate runs that didn't actually write anything.
function RecentRunChip({ run }: { run: RecentRun }) {
  const isSilent = run.silentCompletion;
  const isError = run.exitStatus != null && run.exitStatus !== 0;
  const color = isError
    ? 'var(--danger-text)'
    : isSilent
      ? 'var(--warn-text, var(--accent-text))'
      : 'var(--muted)';
  const icon = isError ? (
    <Icons.X size={10} />
  ) : isSilent ? (
    <Icons.AlertTriangle size={10} />
  ) : (
    <Icons.Check size={10} />
  );
  const label = run.action === 'ai-prompt' ? run.summary.replace(/^dispatched /, '') : run.action;
  const hover = isSilent
    ? `Skill dispatched at ${run.ts} but no completion event followed — the model exited without reaching its writeback step. Re-running the action is safe (idempotent).`
    : `${run.action} at ${run.ts}${run.summary ? ` — ${run.summary}` : ''}`;
  return (
    <span
      className="badge"
      title={hover}
      style={{
        color,
        borderColor: 'currentColor',
        background: isSilent ? 'var(--warn-bg, var(--accent-soft))' : undefined,
        fontSize: 11,
        gap: 4,
      }}
    >
      {icon} {label} {isSilent && <span style={{ opacity: 0.85 }}>· silent</span>}
    </span>
  );
}

function RecentRunsStrip({ runs }: { runs: RecentRun[] }) {
  // Cap visible at 3 to keep the header compact; the rest are still tracked
  // by the API but elided in the chip strip.
  const visible = runs.slice(0, 3);
  const hidden = runs.length - visible.length;
  return (
    <div
      className="hstack"
      style={{
        marginTop: 8,
        gap: 6,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <span className="tiny" style={{ color: 'var(--muted)' }}>
        Recent runs:
      </span>
      {visible.map((run) => (
        <RecentRunChip key={`${run.ts}-${run.action}`} run={run} />
      ))}
      {hidden > 0 && (
        <span className="tiny" style={{ color: 'var(--muted)' }}>
          +{hidden} more
        </span>
      )}
    </div>
  );
}

function PassStatusBadge({ status }: { status: ReviewComment['passStatus'] }) {
  if (status === 'resolved')
    return (
      <span className="badge success">
        <Icons.Check size={11} /> Resolved in this pass
      </span>
    );
  if (status === 'unresolved')
    return (
      <span className="badge warning">
        <Icons.AlertTriangle size={11} /> Still open from prior pass
      </span>
    );
  if (status === 'new')
    return (
      <span className="badge accent">
        <Icons.Sparkles size={11} /> New in this pass
      </span>
    );
  return null;
}

// Read-only render of an accept_note or dismiss_reason saved on a comment.
// Kept tonally distinct (success vs. muted) so a glance at the card answers
// "what did the human decide and why?".
function NoteCallout({ kind, text }: { kind: 'accept' | 'dismiss'; text: string }) {
  const accent = kind === 'accept' ? 'var(--success)' : 'var(--muted)';
  const label = kind === 'accept' ? 'Accept note' : 'Dismiss reason';
  const Icon = kind === 'accept' ? Icons.Check : Icons.X;
  return (
    <div
      style={{
        background: 'var(--panel-2)',
        border: `1px solid ${accent}`,
        borderRadius: 6,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span
        className="tiny"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          color: accent,
        }}
      >
        <Icon size={11} /> {label}
      </span>
      <span style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{text}</span>
    </div>
  );
}

// Inline form opened by Accept / Dismiss. Optional rationale; Enter confirms.
// The textarea is small on purpose — multi-paragraph rationale belongs in the
// comment body, not this header field.
function ActionNoteForm({
  action,
  note,
  setNote,
  busy,
  onConfirm,
  onCancel,
}: {
  action: 'accept' | 'dismiss';
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const accent = action === 'accept' ? 'var(--success)' : 'var(--muted)';
  const label = action === 'accept' ? 'Accept this comment' : 'Dismiss this comment';
  const placeholder =
    action === 'accept'
      ? "Optional — why you're accepting (will be written to the comment header)…"
      : "Optional — why this isn't actionable (informs future passes + audit trail)…";
  const Icon = action === 'accept' ? Icons.Check : Icons.X;
  return (
    <div
      style={{
        background: 'var(--panel-2)',
        border: `1px solid ${accent}`,
        borderRadius: 8,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        className="tiny"
        style={{ display: 'flex', alignItems: 'center', gap: 6, color: accent }}
      >
        <Icon size={12} /> {label}
      </div>
      <textarea
        className="textarea"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={placeholder}
        disabled={busy}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter confirms; plain Enter adds a newline so users can
          // write a multi-line rationale without surprise submission.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onConfirm();
        }}
        style={{ fontSize: 12.5 }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? (
            <>
              <Icons.Refresh size={12} className="spin" /> Saving…
            </>
          ) : (
            <>
              <Icon size={12} /> Confirm {action}
            </>
          )}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <span className="tiny" style={{ color: 'var(--muted)' }}>
          ⌘/Ctrl+Enter to confirm
        </span>
      </div>
    </div>
  );
}

// SourceSnippet — fetches the actual source lines around a comment's
// target line from the linked repo's local clone (via
// /api/reviews/:id/snippet) and renders them with the focus line highlighted.
// Falls back to a small hint when the file can't be resolved (e.g. the
// local working tree is on a different branch).
function SourceSnippet({
  reviewId,
  file,
  line,
}: {
  reviewId: string;
  file: string;
  line: number;
}) {
  type SnippetResp =
    | {
        ok: true;
        lines: Array<{ n: number; t: string; kind?: 'highlight' | 'context' }>;
        focus: number;
        file: string;
        totalLines: number;
      }
    | { ok: false; error: string };
  const [data, setData] = useState<SnippetResp | null>(null);

  useEffect(() => {
    // Only meaningful when both file and a positive line number are present.
    // dev-pr-review can produce comments with line=null (file-level or
    // architectural notes) — skip the fetch entirely in that case.
    if (!file || !Number.isInteger(line) || line < 1) {
      setData(null);
      return;
    }
    let cancelled = false;
    const url =
      `/api/reviews/${encodeURIComponent(reviewId)}/snippet` +
      `?file=${encodeURIComponent(file)}&line=${line}&context=5`;
    fetch(url)
      .then((r) => r.json())
      .then((j: SnippetResp) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setData({ ok: false, error: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, file, line]);

  if (!file || !Number.isInteger(line) || line < 1) {
    // File-level comment — no anchor to show source for.
    return (
      <div className="tiny subtle" style={{ padding: '6px 12px', fontStyle: 'italic' }}>
        File-level comment — no specific line.
      </div>
    );
  }

  if (!data) {
    return (
      <div className="tiny subtle" style={{ padding: '6px 12px' }}>
        Loading source…
      </div>
    );
  }
  if (!data.ok) {
    return (
      <div
        className="tiny"
        style={{
          padding: '8px 12px',
          color: 'var(--muted)',
          fontStyle: 'italic',
        }}
        title={data.error}
      >
        Source unavailable — {data.error}
      </div>
    );
  }
  return (
    <div className="code-body">
      {data.lines.map((l) => (
        <CodeLine key={l.n} n={l.n} t={l.t} kind={l.kind} />
      ))}
    </div>
  );
}

function CommentCard({
  c,
  showStatus,
  busy,
  prUrl,
  reviewId,
  onMutate,
  onReanalyze,
  onEdit,
}: {
  c: ReviewComment;
  showStatus: boolean;
  busy: boolean;
  // Used to build the GitHub-side deep link for published comments.
  prUrl: string;
  // Review entry id — used by SourceSnippet to fetch source context.
  reviewId: string;
  onMutate: (action: 'accept' | 'dismiss', note: string) => Promise<boolean>;
  onReanalyze: (hint: string) => void;
  onEdit: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.message);
  const [reanalyzeOpen, setReanalyzeOpen] = useState(false);
  const [hint, setHint] = useState('');
  // Inline accept/dismiss form: when non-null, render the note input + Confirm.
  const [pendingAction, setPendingAction] = useState<'accept' | 'dismiss' | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  useEffect(() => {
    setDraft(c.message);
  }, [c.message]);

  function openActionForm(action: 'accept' | 'dismiss') {
    setPendingAction(action);
    // Prefill with the existing note for that action — lets users tweak prior
    // rationale without retyping. Switching action types starts blank.
    setNoteDraft(action === 'accept' ? (c.acceptNote ?? '') : (c.dismissReason ?? ''));
    setReanalyzeOpen(false);
  }

  async function confirmAction() {
    if (!pendingAction || busy) return;
    const ok = await onMutate(pendingAction, noteDraft);
    if (ok) {
      setPendingAction(null);
      setNoteDraft('');
    }
  }

  function runReanalyze() {
    // Re-analysis runs in the parent's ActionRunner (dev-pr-review skill with
    // focus_notes). We just hand the hint up and reset our local UI; the new
    // pass will land via the next /api/reviews refresh.
    onReanalyze(hint.trim());
    setReanalyzeOpen(false);
    setHint('');
  }

  const opacity = c.state === 'dismissed' || c.passStatus === 'resolved' ? 0.78 : 1;
  const borderColor =
    c.passStatus === 'resolved'
      ? 'var(--success)'
      : c.passStatus === 'new'
        ? 'var(--accent)'
        : c.passStatus === 'unresolved'
          ? 'var(--warning)'
          : c.state === 'accepted'
            ? 'var(--success)'
            : c.state === 'dismissed'
              ? 'var(--muted)'
              : null;
  const borderStyle: React.CSSProperties = borderColor
    ? { boxShadow: `inset 3px 0 0 ${borderColor}` }
    : {};

  return (
    <div className="comment-card" style={{ opacity, ...borderStyle }}>
      <div className="comment-head">
        <span className={sevClass(c.severity)}>
          {sevIcon(c.severity, 11)} {sevLabel(c.severity)}
        </span>
        <AgentChip agent={c.agent} />
        <span className="comment-loc mono">Line {c.startLine}</span>
        {showStatus && c.passStatus && <PassStatusBadge status={c.passStatus} />}
        <span className="spacer" />
        {c.actedOnAt && (
          <span
            className="badge success"
            title={`Addressed in code on ${c.actedOnAt} via dev-write-change`}
          >
            <Icons.Check size={11} /> Acted on
          </span>
        )}
        {c.githubCommentId != null ? (
          <a
            className="badge success"
            href={`${prUrl}#discussion_r${c.githubCommentId}`}
            target="_blank"
            rel="noreferrer"
            title="Open this comment on GitHub"
            style={{ textDecoration: 'none' }}
          >
            <Icons.Send size={11} /> Published <Icons.External size={10} />
          </a>
        ) : c.status === 'published-as-body' && c.githubReviewId != null ? (
          <a
            className="badge"
            href={`${prUrl}#pullrequestreview-${c.githubReviewId}`}
            target="_blank"
            rel="noreferrer"
            title="Couldn't be anchored to an inline diff line (file not in diff or file-level comment) — surfaced as a quoted block inside the parent review body. Click to open the review on GitHub."
            style={{
              textDecoration: 'none',
              color: 'var(--accent-text)',
              borderColor: 'var(--accent-border)',
              background: 'var(--accent-soft)',
            }}
          >
            <Icons.Send size={11} /> In review body <Icons.External size={10} />
          </a>
        ) : c.state === 'accepted' && !c.actedOnAt ? (
          <span className="badge success" title="Will be sent on next publish">
            <Icons.Check size={11} /> Accepted · will publish
          </span>
        ) : c.state === 'dismissed' ? (
          <span className="badge muted" title="Skipped on publish">
            Dismissed · skipped
          </span>
        ) : null}
        <button type="button" className="icon-btn" title="Copy permalink">
          <Icons.Copy size={13} />
        </button>
      </div>
      <div className="comment-body">
        <SourceSnippet reviewId={reviewId} file={c.file} line={c.startLine} />
      </div>
      <div className="comment-foot">
        {!editing ? (
          // Render through the markdown pipeline so fenced code blocks
          // (```go, ```ts, …) display as styled <pre> with the language badge
          // instead of literal backticks. Plain-text comments still render
          // cleanly — single paragraphs become <p>, no frontmatter to scrub.
          <div className="comment-msg">
            <Rendered content={c.message} />
          </div>
        ) : (
          <textarea
            className="textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
          />
        )}
        {c.suggestion && !editing && (
          <div
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '8px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-2)',
            }}
          >
            <span
              className="tiny"
              style={{
                display: 'block',
                textTransform: 'uppercase',
                letterSpacing: 0.6,
                marginBottom: 4,
                color: 'var(--muted)',
              }}
            >
              Suggested fix
            </span>
            {c.suggestion}
          </div>
        )}
        {c.state === 'accepted' && c.acceptNote && (
          <NoteCallout kind="accept" text={c.acceptNote} />
        )}
        {c.state === 'dismissed' && c.dismissReason && (
          <NoteCallout kind="dismiss" text={c.dismissReason} />
        )}
        {pendingAction && !editing && (
          <ActionNoteForm
            action={pendingAction}
            note={noteDraft}
            setNote={setNoteDraft}
            busy={busy}
            onConfirm={confirmAction}
            onCancel={() => {
              setPendingAction(null);
              setNoteDraft('');
            }}
          />
        )}
        {reanalyzeOpen && !editing && (
          <div
            style={{
              background: 'var(--panel-2)',
              border: '1px solid var(--accent-border)',
              borderRadius: 8,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              className="tiny"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--accent-text)',
              }}
            >
              <Icons.Sparkles size={12} /> Re-analyze this comment
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                placeholder="Optional hint — e.g. 'consider concurrency' or 'check the test fixtures'…"
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runReanalyze();
                }}
                style={{ fontSize: 12.5, height: 30 }}
              />
              <button type="button" className="btn btn-sm btn-primary" onClick={runReanalyze}>
                <Icons.Sparkles size={12} /> Re-analyze
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setReanalyzeOpen(false);
                  setHint('');
                }}
              >
                Cancel
              </button>
            </div>
            <div className="tiny" style={{ color: 'var(--muted)' }}>
              Dispatches dev-pr-review with focus on this comment — opens an action runner with the
              hint as <code>focus_notes</code>. The new pass lands when the run completes.
            </div>
          </div>
        )}
        <div className="comment-actions">
          {!editing ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openActionForm('accept')}
                disabled={
                  busy ||
                  c.githubCommentId != null ||
                  c.status === 'published-as-body' ||
                  !!c.actedOnAt
                }
                title={
                  c.githubCommentId != null
                    ? 'Already published to GitHub — cannot mutate'
                    : c.status === 'published-as-body'
                      ? 'Surfaced in the GitHub review body — cannot mutate'
                      : c.actedOnAt
                        ? 'Already addressed in code (status: acted-on) — cannot mutate'
                        : 'Mark this comment status: accepted (with an optional rationale note). Accepted comments are eligible for Publish to GitHub AND for Re-implement via dev-write-change (if a Change is linked).'
                }
                style={
                  c.state === 'accepted'
                    ? {
                        background: 'var(--success-soft, var(--accent-soft))',
                        borderColor: 'var(--success)',
                        color: 'var(--success)',
                      }
                    : undefined
                }
              >
                <Icons.Check size={12} /> {c.state === 'accepted' ? 'Update accept note' : 'Accept'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openActionForm('dismiss')}
                disabled={
                  busy ||
                  c.githubCommentId != null ||
                  c.status === 'published-as-body' ||
                  !!c.actedOnAt
                }
                title={
                  c.githubCommentId != null
                    ? 'Already published to GitHub — cannot mutate'
                    : c.status === 'published-as-body'
                      ? 'Surfaced in the GitHub review body — cannot mutate'
                      : c.actedOnAt
                        ? 'Already addressed in code (status: acted-on) — cannot mutate'
                        : 'Mark this comment status: dismissed (with an optional reason). Dismissed comments are skipped on Publish AND on Re-implement — they document a rejected suggestion for audit.'
                }
                style={
                  c.state === 'dismissed'
                    ? {
                        background: 'var(--panel-2)',
                        borderColor: 'var(--muted)',
                        color: 'var(--muted)',
                      }
                    : undefined
                }
              >
                <Icons.X size={12} />{' '}
                {c.state === 'dismissed' ? 'Update dismiss reason' : 'Dismiss'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setReanalyzeOpen((o) => !o);
                  setPendingAction(null);
                }}
                disabled={busy}
                title="Dispatches dev-pr-review with focus_notes scoped to this comment. Opens an action runner that runs a continuation pass — the model takes a fresh look at this specific comment against the latest commit, with your optional hint as guidance. The new pass appears in the pass timeline when complete."
                style={
                  reanalyzeOpen
                    ? {
                        background: 'var(--accent-soft)',
                        borderColor: 'var(--accent-border)',
                        color: 'var(--accent-text)',
                      }
                    : undefined
                }
              >
                <Icons.Sparkles size={12} /> Re-analyze
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setEditing(true)}
                disabled={busy}
              >
                Edit message
              </button>
              <span className="spacer" />
              {busy && (
                <span className="tiny" style={{ color: 'var(--muted)' }}>
                  <Icons.Refresh size={11} className="spin" /> Saving…
                </span>
              )}
              {c.priorId && (
                <span className="tiny mono" style={{ color: 'var(--subtle)' }}>
                  was {c.priorId} →
                </span>
              )}
              <span className="tiny mono">{c.id}</span>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  onEdit(draft);
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setDraft(c.message);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Phase 4 publish gate: only accepted comments that haven't already been
// published count toward the publishable set. Dismissed / new / resolved are
// filtered out by policy; already-published rows are filtered for
// idempotency. The button is hidden if the verdict isn't set (no review yet)
// and disabled if there's nothing to publish.
//
// Three terminal states exclude a comment from being re-published:
//   - github_comment_id set → posted as an inline GitHub comment
//   - status === 'published-as-body' → couldn't be inlined (file-level or
//     out-of-diff), surfaced in the parent review body instead. Still terminal.
//   - actedOnAt set (status: acted-on) → addressed in code via dev-write-change.
//     Already done in a different form; re-publishing would re-surface fixed work.
function countPublishable(comments: ReviewComment[]): number {
  return comments.filter(
    (c) =>
      c.state === 'accepted' &&
      c.githubCommentId == null &&
      c.status !== 'published-as-body' &&
      !c.actedOnAt,
  ).length;
}

function PublishButton({
  pass,
  comments,
  onOpen,
}: {
  pass: ReviewPass;
  comments: ReviewComment[];
  onOpen: () => void;
}) {
  const n = countPublishable(comments);
  // "All published" = every comment is terminal — either on GitHub (inline
  // or in the review body) OR addressed in code (acted-on). Drives the
  // button relabeling to "Published".
  const allPublished =
    comments.length > 0 &&
    comments.every(
      (c) => c.githubCommentId != null || c.status === 'published-as-body' || !!c.actedOnAt,
    );
  // In-flight detection: ANY dev-pr-review-publish run currently queued or
  // running. Dispatch tags only carry skill + domain, not a review-specific
  // id, so the filter is broad — but in practice two concurrent publishes
  // across separate reviews are rare, and the over-conservative block is
  // preferable to a double-click hazard that double-posts to GitHub.
  const { runs } = useDispatch();
  const publishInFlight = runs.some(
    (r) => r.skill === 'dev-pr-review-publish' && (r.state === 'queued' || r.state === 'running'),
  );
  const disabled = pass.status === 'running' || n === 0 || publishInFlight;
  // Long tooltip explains the action AND when to use it. Publish is the
  // external-PR completion: post accepted comments to GitHub as a single
  // batched review. For OS-authored PRs (where the OS wrote the code being
  // reviewed) it's optional — you can merge on GitHub directly. The same
  // accepted comments can also be addressed in code via dev-write-change's
  // ADDRESS-COMMENTS phase if a linked change entry exists.
  const title = publishInFlight
    ? 'A publish run is already in flight — wait for it to finish'
    : pass.status === 'running'
      ? 'Wait for the pass to finish'
      : n === 0
        ? allPublished
          ? 'All comments already published'
          : 'Accept at least one comment first'
        : `Runs dev-pr-review-publish: posts ${n} accepted comment${
            n !== 1 ? 's' : ''
          } to GitHub as a single batched review event. Verdict is derived from the review's result field. Idempotent on re-clicks. Primary use case: EXTERNAL PRs you reviewed but didn't author. For OS-authored PRs, the GitHub-side review event is optional — you can also address the comments in code via Re-implement on the linked Change.`;
  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={onOpen}
      disabled={disabled}
      title={title}
    >
      <Icons.Send size={13} />{' '}
      {publishInFlight
        ? 'Publishing…'
        : n === 0
          ? allPublished
            ? 'Published'
            : 'Publish'
          : `Publish ${n} comment${n !== 1 ? 's' : ''}`}
    </button>
  );
}

// Map the pr-review entry's `result` field to the GitHub event verbatim. The
// publish skill performs the same mapping server-side; mirroring it here is
// purely for the user-facing preview.
function resultToEvent(result: ReviewDetailType['result']): {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  label: string;
} {
  switch (result) {
    case 'approved':
      return { event: 'APPROVE', label: 'Approve' };
    case 'request-changes':
      return { event: 'REQUEST_CHANGES', label: 'Request changes' };
    default:
      return { event: 'COMMENT', label: 'Comment' };
  }
}

function PublishModal({
  detail,
  pass,
  comments,
  onClose,
  onConfirm,
}: {
  detail: ReviewDetailType;
  pass: ReviewPass;
  comments: ReviewComment[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const publishCount = countPublishable(comments);
  const dismissedCount = comments.filter((c) => c.state === 'dismissed').length;
  const newCount = comments.filter((c) => c.state === 'open').length;
  const alreadyPublishedCount = comments.filter((c) => c.githubCommentId != null).length;
  const verdict = resultToEvent(detail.result ?? null);

  return (
    <SharedModal
      title={`Publish pass ${pass.n} to GitHub`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={publishCount === 0}
          >
            <Icons.Send size={13} /> Publish {publishCount} comment{publishCount !== 1 ? 's' : ''}{' '}
            as {verdict.label}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--accent-border)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12.5,
          }}
        >
          <div
            className="tiny"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--accent-text)',
              marginBottom: 6,
            }}
          >
            <Icons.Send size={11} /> Submitting as <strong>{verdict.label}</strong>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            Verdict is derived from the pr-review's <code>result</code> field (currently{' '}
            <code>{detail.result ?? 'unknown'}</code>) — set by <code>dev-pr-review</code> when the
            pass finished. To change the verdict, re-run the review.
          </div>
        </div>
        <div
          style={{
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            fontSize: 12.5,
          }}
        >
          <Row k="Pass" v={`${pass.n} · ${pass.label}`} />
          <Row
            k="Target"
            v={
              <span className="mono">
                {detail.repo} {detail.pr}
              </span>
            }
          />
          <Row k="Accepted — will publish" v={publishCount} />
          <Row k="Already published (skipped)" v={alreadyPublishedCount} />
          <Row k="Dismissed (skipped)" v={dismissedCount} />
          <Row k="Not yet accepted (skipped)" v={newCount} />
        </div>
        <div className="tiny" style={{ color: 'var(--muted)' }}>
          One batched GitHub review will be created with the {publishCount} accepted comment
          {publishCount !== 1 ? 's' : ''} inlined. Already-published comments are skipped
          (idempotent re-runs). Dismissed and not-yet-accepted comments are skipped by policy — if
          you want them included, accept them first.
        </div>
      </div>
    </SharedModal>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
      <span style={{ color: 'var(--muted)' }}>{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Config snapshot card — surfaces the policy values active when Pass 1 of
// this review ran. Read-only; lives between SummaryCard and the comment
// filter row. Compact one-line layout when collapsed (default); expands on
// click for the full focus_areas list + custom_instructions_hash.
//
// Renders nothing when detail.config is null — entries that predate the
// config-snapshot convention OR that fall back to the legacy parser path
// don't carry the block. That's a graceful absence, not an error.

function ConfigSnapshotCard({
  config,
}: {
  config: ReviewDetailType['config'];
}) {
  const [expanded, setExpanded] = useState(false);
  if (!config) return null;

  // Compact pills shown in collapsed state. Click anywhere on the card body
  // toggles expanded; the Settings link uses stopPropagation so it doesn't
  // also toggle when clicked.
  const pillStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '3px 8px',
    background: 'var(--bg-2)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-2)',
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
  };

  return (
    <div
      className="card"
      style={{
        marginTop: 14,
        padding: '10px 14px',
        cursor: 'pointer',
      }}
      onClick={() => setExpanded(!expanded)}
      aria-expanded={expanded}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span
          className="tiny"
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: 'var(--muted)',
            fontWeight: 600,
          }}
        >
          Config snapshot
        </span>
        <span style={pillStyle} title="Review model active at Pass 1">
          {config.primary_model}
        </span>
        <span style={pillStyle} title="Comment style">
          {config.comment_style}
        </span>
        <span style={pillStyle} title="Context assembly strategy">
          {config.context_strategy}
        </span>
        <span style={pillStyle} title="Focus areas count — expand for the full list">
          {config.focus_areas.length} focus area{config.focus_areas.length !== 1 ? 's' : ''}
        </span>
        {config.custom_instructions_hash ? (
          <span style={pillStyle} title="Custom instructions hash (first 12 hex chars of SHA256)">
            instr: {config.custom_instructions_hash}
          </span>
        ) : (
          <span style={{ ...pillStyle, color: 'var(--text-3)' }} title="No custom instructions">
            no custom instructions
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Link
          to="/pr-review/settings"
          onClick={(e) => e.stopPropagation()}
          className="tiny"
          style={{ color: 'var(--accent-text)', textDecoration: 'none' }}
          title="Open current PR review settings"
        >
          Settings →
        </Link>
        <span
          className="tiny"
          style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 4 }}
          aria-hidden
        >
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: '1px solid var(--border)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 12px',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <span className="tiny subtle">Review model</span>
          <code className="mono" style={{ fontSize: 12 }}>
            {config.primary_model}
          </code>
          <span className="tiny subtle">Comment style</span>
          <span>{config.comment_style}</span>
          <span className="tiny subtle">Context strategy</span>
          <code className="mono" style={{ fontSize: 12 }}>
            {config.context_strategy}
          </code>
          <span className="tiny subtle">Focus areas</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {config.focus_areas.map((a) => (
              <code
                key={a}
                className="mono"
                style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  background: 'var(--bg-2)',
                  borderRadius: 3,
                }}
              >
                {a}
              </code>
            ))}
          </div>
          <span className="tiny subtle">Custom instructions</span>
          <span>
            {config.custom_instructions_hash ? (
              <span>
                <span className="tiny subtle">(hash: </span>
                <code className="mono" style={{ fontSize: 11 }}>
                  {config.custom_instructions_hash}
                </code>
                <span className="tiny subtle">
                  ) — text not stored on entry. Compare against current value in Settings to detect
                  policy drift.
                </span>
              </span>
            ) : (
              <span className="tiny subtle">(none — no extra prompt instructions were active)</span>
            )}
          </span>
          <span className="tiny subtle" style={{ alignSelf: 'start' }}>
            About
          </span>
          <span className="tiny subtle" style={{ lineHeight: 1.5 }}>
            These values were active when Pass 1 ran. Subsequent passes carry their own per-pass
            config in the body (see "Pass config" inside each Pass section); the snapshot here is
            the merge-time-of-review reference.
          </span>
        </div>
      )}
    </div>
  );
}

// PassStats unused warning silencer (used implicitly via stats access).
export type _PassStatsRef = PassStats;
