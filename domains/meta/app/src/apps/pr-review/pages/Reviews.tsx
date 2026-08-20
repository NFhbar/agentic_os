// Reviews — list of all reviews with tabs + filters + search.

import { useEffect, useMemo, useState } from 'react';
import { Empty, Icons, ResultBadge, StatusBadge } from '../../../shared';
import type { ReviewRow } from '../data';
import { SeverityCounts } from './Dashboard';

type TabId = 'all' | 'running' | 'changes' | 'approve' | 'failed';

// A review is "settled" when its PR can no longer change: the linked change
// reached a terminal status, or the PR itself is merged or closed on GitHub.
//
// The second half is what covers external PRs. A review with no linked change
// has no OS-side lifecycle to read, so before the PR-state refresh existed
// those rows stayed in the active list forever no matter what happened
// upstream. `prState` is written straight onto the review entry, which gives
// every review — linked or not — a way to leave.
function isSettled(r: ReviewRow): boolean {
  if (r.changeStatus === 'merged' || r.changeStatus === 'abandoned') return true;
  return r.prState === 'merged' || r.prState === 'closed';
}

export function Reviews({
  reviews,
  onOpen,
  onRefreshPrStates,
}: {
  reviews: ReviewRow[];
  onOpen: (id: string) => void;
  // Batch re-check of open PRs' merged/closed state. Server-side TTL makes
  // repeated presses cheap, so this is a plain button rather than a gated one.
  onRefreshPrStates: () => Promise<void>;
}) {
  const [tab, setTab] = useState<TabId>('all');
  const [filter, setFilter] = useState('');
  const [repoFilter, setRepoFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  // Settled reviews collapse into a dedicated section below the active rows.
  // Default collapsed so a repo with hundreds of historical merges doesn't
  // crowd the view; click the divider to expand. Persists via localStorage.
  const [mergedExpanded, setMergedExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem('agentic-os/reviews-merged-expanded') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('agentic-os/reviews-merged-expanded', mergedExpanded ? '1' : '0');
    } catch {
      /* unavailable */
    }
  }, [mergedExpanded]);

  const counts = useMemo(
    () => ({
      all: reviews.length,
      running: reviews.filter((r) => r.status === 'running').length,
      changes: reviews.filter((r) => r.result === 'changes').length,
      approve: reviews.filter((r) => r.result === 'approve').length,
      failed: reviews.filter((r) => r.status === 'failed').length,
      merged: reviews.filter(isSettled).length,
    }),
    [reviews],
  );

  // Newest PR-state check across the list — the honest answer to "as of when?"
  // on the refresh button.
  const lastChecked = useMemo(() => {
    let best: string | null = null;
    for (const r of reviews) {
      const t = r.prStateCheckedAt;
      if (t && (best === null || t > best)) best = t;
    }
    return best;
  }, [reviews]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshPrStates();
    } finally {
      setRefreshing(false);
    }
  }

  const filtered = reviews.filter((r) => {
    if (tab === 'running' && r.status !== 'running') return false;
    if (tab === 'changes' && r.result !== 'changes') return false;
    if (tab === 'approve' && r.result !== 'approve') return false;
    if (tab === 'failed' && r.status !== 'failed') return false;
    if (repoFilter !== 'all' && r.repo !== repoFilter) return false;
    if (filter && !`${r.title} ${r.pr} ${r.author}`.toLowerCase().includes(filter.toLowerCase())) {
      return false;
    }
    return true;
  });

  // Split into active vs settled so the settled tail can collapse into a
  // dedicated section below the active rows. Same filter applied to both.
  const activeFiltered = filtered.filter((r) => !isSettled(r));
  const mergedFiltered = filtered.filter(isSettled);

  const repos = Array.from(new Set(reviews.map((r) => r.repo)));

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div>
          <h1 className="h1">Reviews</h1>
          <div className="subtle" style={{ marginTop: 2 }}>
            Every review the agents have performed against your indexed repos.
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn"
          onClick={refresh}
          disabled={refreshing}
          title={`Re-checks every PR that might still be open against GitHub, then collapses the ones that merged or closed. Each PR is only re-checked every 30 minutes, so pressing this again straight away costs nothing. PRs that can't be reached are skipped, not failed.${
            lastChecked ? ` Last check: ${new Date(lastChecked).toLocaleString()}.` : ''
          }`}
        >
          <Icons.Refresh size={13} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Checking…' : 'Refresh PR states'}
        </button>
      </div>

      <div className="filter-row">
        <div className="tabs">
          {(
            [
              ['all', 'All', counts.all],
              ['running', 'Running', counts.running],
              ['changes', 'Changes', counts.changes],
              ['approve', 'Approved', counts.approve],
              ['failed', 'Failed', counts.failed],
            ] as const
          ).map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              className="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label} <span className="count">{n}</span>
            </button>
          ))}
        </div>
        <div className="search-wrap">
          <Icons.Search size={14} />
          <input
            className="input"
            placeholder="Filter by title, PR, author…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <select
          className="input"
          style={{ width: 180, height: 34 }}
          value={repoFilter}
          onChange={(e) => setRepoFilter(e.target.value)}
        >
          <option value="all">All repos</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>PR</th>
              <th>Title</th>
              <th style={{ width: 130 }}>Repo</th>
              <th style={{ width: 110 }}>Author</th>
              <th style={{ width: 130 }}>Result</th>
              <th style={{ width: 160 }}>Severity</th>
              <th style={{ width: 90 }}>Changes</th>
              <th style={{ width: 90 }}>Duration</th>
              <th style={{ width: 90 }}>Started</th>
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {activeFiltered.map((rv) => (
              <ReviewRowItem key={rv.id} rv={rv} onOpen={onOpen} />
            ))}
            {mergedFiltered.length > 0 && (
              <tr
                className="merged-divider"
                onClick={() => setMergedExpanded((v) => !v)}
                style={{ cursor: 'pointer' }}
                title={mergedExpanded ? 'Hide merged reviews' : 'Show merged reviews'}
              >
                <td
                  colSpan={10}
                  style={{
                    padding: '8px 14px',
                    background: 'var(--bg-2, rgba(255,255,255,0.02))',
                    borderTop: '1px solid var(--border)',
                    borderBottom: mergedExpanded ? '1px solid var(--border)' : 'none',
                    color: 'var(--text-2)',
                    fontSize: 12,
                    fontWeight: 500,
                    userSelect: 'none',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span aria-hidden="true">{mergedExpanded ? '▾' : '▸'}</span>
                    Merged / closed <span className="count">{mergedFiltered.length}</span>
                    <span className="subtle" style={{ marginLeft: 6, fontWeight: 400 }}>
                      {mergedExpanded ? '(click to collapse)' : '(click to expand)'}
                    </span>
                  </span>
                </td>
              </tr>
            )}
            {mergedExpanded &&
              mergedFiltered.map((rv) => <ReviewRowItem key={rv.id} rv={rv} onOpen={onOpen} />)}
          </tbody>
        </table>
        {activeFiltered.length === 0 && mergedFiltered.length === 0 && (
          <Empty
            title="No reviews match"
            hint="Adjust filters or start a new review from the dashboard."
            icon={<Icons.Reviews size={28} />}
          />
        )}
      </div>
    </div>
  );
}

// Inline chip showing the linked change's lifecycle status next to the
// review title. Only renders for terminal-ish states that the user cares
// about at a glance — merged (success), abandoned (muted). Non-terminal
// states (planning / in-progress / in-review) are hidden because the
// row's other columns already convey them indirectly. Returns null for
// reviews without a linked change (external PRs).
function ChangeStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  if (status === 'merged') {
    return (
      <span
        className="badge success"
        title="The linked change has been merged on GitHub — change status is terminal."
        style={{ fontSize: 11, gap: 4 }}
      >
        <Icons.Check size={10} /> merged
      </span>
    );
  }
  if (status === 'abandoned') {
    return (
      <span
        className="badge muted"
        title="The linked change was abandoned — won't be merged."
        style={{ fontSize: 11 }}
      >
        abandoned
      </span>
    );
  }
  return null;
}

// Live GitHub state of the PR itself, as of the last batch refresh. Renders
// only when it adds something the change-status badge doesn't already say —
// which in practice means external PRs (no linked change) and the case where
// a PR was closed without merging.
function PrStateBadge({ row }: { row: ReviewRow }) {
  const state = row.prState;
  if (state !== 'merged' && state !== 'closed') return null;
  if (row.changeStatus === 'merged' && state === 'merged') return null;
  const asOf = row.prStateCheckedAt
    ? ` Checked ${new Date(row.prStateCheckedAt).toLocaleString()}.`
    : '';
  if (state === 'merged') {
    return (
      <span
        className="badge success"
        title={`Merged on GitHub${row.prMergedAt ? ` on ${new Date(row.prMergedAt).toLocaleDateString()}` : ''}.${asOf}`}
        style={{ fontSize: 11, gap: 4 }}
      >
        <Icons.Check size={10} /> merged
      </span>
    );
  }
  return (
    <span
      className="badge muted"
      title={`Closed on GitHub without merging.${asOf}`}
      style={{ fontSize: 11 }}
    >
      closed
    </span>
  );
}

// Surfaces the linked change's pr_review_status when it carries actionable
// signal — "ready-for-human" tells the user the PR is signed off and waiting
// for a merge, "needs-changes" tells them more address-comments work is
// queued. Suppressed once the change is merged (the merged badge already
// covers the terminal state). Null when there's no linked change.
function PrReviewStatusBadge({
  changeStatus,
  prReviewStatus,
}: {
  changeStatus: string | null;
  prReviewStatus: string | null;
}) {
  if (!prReviewStatus) return null;
  if (changeStatus === 'merged' || changeStatus === 'abandoned') return null;
  if (prReviewStatus === 'ready-for-human') {
    return (
      <span
        className="badge"
        title="Review signed off — waiting on a human to merge the PR on GitHub."
        style={{
          fontSize: 11,
          gap: 4,
          background: 'var(--accent-bg, rgba(80,160,250,0.12))',
          color: 'var(--accent-text, #5aa0fa)',
          border: '1px solid var(--accent-border, rgba(80,160,250,0.35))',
        }}
      >
        ready for human
      </span>
    );
  }
  if (prReviewStatus === 'needs-changes') {
    return (
      <span
        className="badge"
        title="Latest pass found issues — address-comments work queued."
        style={{
          fontSize: 11,
          gap: 4,
          background: 'var(--warning-bg, rgba(250,200,80,0.1))',
          color: 'var(--warning-text, #e0a02a)',
          border: '1px solid var(--warning-border, rgba(250,200,80,0.4))',
        }}
      >
        needs changes
      </span>
    );
  }
  if (prReviewStatus === 'approved') {
    return (
      <span
        className="badge"
        title="Latest pass approved — accept/dismiss its comments, then Mark ready."
        style={{
          fontSize: 11,
          gap: 4,
          background: 'var(--success-bg, rgba(80,200,120,0.1))',
          color: 'var(--success-text, #3fb950)',
          border: '1px solid var(--success-border, rgba(80,200,120,0.35))',
        }}
      >
        approved · triage
      </span>
    );
  }
  return null;
}

// One review row — extracted so the active section and the (collapsible)
// merged section can render the same markup without duplication.
function ReviewRowItem({ rv, onOpen }: { rv: ReviewRow; onOpen: (id: string) => void }) {
  return (
    <tr className="clickable" onClick={() => onOpen(rv.id)} style={{ cursor: 'pointer' }}>
      <td className="mono" style={{ color: 'var(--text-2)' }}>
        {rv.pr}
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {rv.status === 'running' && <span className="dot running" />}
          <span style={{ fontWeight: 500 }}>{rv.title}</span>
          <ChangeStatusBadge status={rv.changeStatus ?? null} />
          <PrStateBadge row={rv} />
          <PrReviewStatusBadge
            changeStatus={rv.changeStatus ?? null}
            prReviewStatus={rv.changePrReviewStatus ?? null}
          />
        </div>
        <div className="tiny mono" style={{ marginTop: 2 }}>
          <Icons.GitBranch
            size={11}
            style={{ verticalAlign: -1, marginRight: 3, color: 'var(--subtle)' }}
          />
          {rv.branch}
        </div>
      </td>
      <td className="mono" style={{ color: 'var(--text-2)' }}>
        {rv.repo}
      </td>
      <td className="mono" style={{ color: 'var(--muted)' }}>
        {rv.author}
      </td>
      <td>
        {rv.status === 'running' ? (
          <div style={{ width: 110 }}>
            <div className="tiny" style={{ marginBottom: 4, color: 'var(--accent-text)' }}>
              Analyzing… {rv.progress}%
            </div>
            <div className="progress running">
              <i style={{ width: `${rv.progress ?? 0}%` }} />
            </div>
          </div>
        ) : rv.status === 'failed' ? (
          <StatusBadge status="failed" />
        ) : rv.changeStatus === 'merged' ? (
          <span
            className="badge success"
            title={`PR merged on GitHub. Original review verdict: ${rv.result ?? 'none'}.`}
            style={{ gap: 4 }}
          >
            <Icons.Check size={11} /> merged
          </span>
        ) : (
          <ResultBadge result={rv.result} />
        )}
      </td>
      <td>
        <SeverityCounts s={rv.severity} />
      </td>
      <td className="mono" style={{ color: 'var(--muted)' }}>
        <span style={{ color: 'var(--success-text)' }}>+{rv.additions}</span>{' '}
        <span style={{ color: 'var(--danger-text)' }}>−{rv.deletions}</span>
      </td>
      <td className="mono" style={{ color: 'var(--muted)' }}>
        {rv.duration}
      </td>
      <td className="mono" style={{ color: 'var(--muted)' }}>
        {rv.started}
      </td>
      <td>
        <Icons.ChevronRight size={14} style={{ color: 'var(--subtle)' }} />
      </td>
    </tr>
  );
}
