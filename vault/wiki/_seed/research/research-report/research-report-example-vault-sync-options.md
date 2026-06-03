---
id: research-report-example-vault-sync-options
type: research-report
domain: research
created: 2026-01-15T10:00:00Z
updated: 2026-02-08T14:30:00Z
tags: [example, distribution, sync, team-install]
source: seed
private: false
title: Vault sync options for multi-engineer team installs
project: build-agentic-os-v1
status: reviewed
materials_path: vault/raw/project-research/build-agentic-os-v1/research-report-example-vault-sync-options/
last_data_ingest: 2026-02-05T00:00:00Z
update_count: 0
review_required: true
review_status: approved
review_path: vault/output/research/reports/research-report-example-vault-sync-options-review.md
reviewed_at: 2026-02-06T16:00:00Z
report_generated_at: 2026-02-05T18:00:00Z
report_revision: 1
recommended_changes: [{"id":null,"summary":"Spike a git-based vault sync mode — opt-in subfolder pattern with merge driver","domain":"development","size":"medium","status":"proposed"},{"id":null,"summary":"Add CRDT-backed events.db aggregation for cross-engineer Pulse metrics","domain":"development","size":"large","status":"proposed"},{"id":null,"summary":"Document the per-user-vault model as canonical in distribution-v1 (no sync)","domain":"meta","size":"small","status":"scaffolded"}]
notes_log: [{"ts":"2026-01-22T14:00:00Z","severity":"info","body":"Worth checking how Obsidian Sync handles three-way merges on wiki entries — they've solved a similar problem and the patterns may transfer.","considered_by":[{"skill":"research-revise","ts":"2026-02-05T17:30:00Z"}]}]
dismissed_triggers: []
---

# Vault sync options for multi-engineer team installs

## Why

Distribution v1 ships with a per-user vault model — each engineer's `vault/wiki/<domain>/` is gitignored and lives locally. Knowledge stays siloed; team-wide metrics aren't possible. The model is deliberately simple (no merge conflicts, no sync infrastructure, no shared-state coordination) but it leaves three real capabilities on the table:

- **Cross-engineer Pulse** — the team's aggregated cost / throughput / cycle metrics
- **Shared decision history** — when one engineer captures a decision, the team sees it
- **Coordinated PR-review state** — multiple engineers can collaborate on a single PR review

This report evaluates four sync architectures, weighs them against the team-scale (2-10 engineer) constraint, and recommends a phased path to v2 sync.

## Findings

Four families of sync architecture were investigated:

### 1. Git-based sync (vault folder committed)

Each engineer commits their vault entries to a shared git branch; reconciliation via standard merge. The simplest mental model — engineers already understand `git pull` / `git push`.

**Strengths:** zero new infrastructure, version history for free, every entry has an author + timestamp via git blame, conflict resolution uses existing tools.

**Weaknesses:** merge conflicts on every concurrent edit, vault becomes a busy git history (every research-update bumps `updated:` and conflicts with concurrent edits on the same file), engineers must run `git pull` constantly to stay current, no real-time visibility (you don't see a teammate's new decision until they push + you pull).

### 2. CRDT-backed merge (events.db, manifest aggregation)

Engineers' local events.db files sync via a CRDT layer (e.g., automerge); the dashboard reads from a merged view. Wiki entries stay file-based + per-user; only operational telemetry is shared.

**Strengths:** correct concurrent updates without conflicts, real-time-ish team metrics (sub-minute propagation), no merge UI required, preserves the "wiki is personal" boundary.

**Weaknesses:** new infrastructure (sync server or P2P transport), schema-migration story unclear (events.db schema evolves with the OS), debug complexity (when metrics look wrong, root cause is hard to trace through CRDT history).

### 3. Server-side vault store (canonical instance)

A shared server (cloud or self-hosted) holds the canonical vault; each engineer's local install treats it as a remote. Reads cache locally; writes go through the server.

**Strengths:** single source of truth, conflict resolution server-side (last-write-wins or per-field merge), team-wide queries are trivial, real-time updates via server push.

**Weaknesses:** breaks the "plain files, no databases" principle the OS was designed around, requires self-hosting infrastructure per team OR a hosted offering (compliance, billing, security review), the OS stops working offline.

### 4. Hybrid: shared wiki, per-user state

Wiki entries (changes, decisions, projects) go through git-style PR review like code. Per-user state (events.db, runs, dashboard prefs) stays local. The boundary follows entry archetype — knowledge artifacts ship via PRs, operational telemetry stays per-engineer.

**Strengths:** wiki entries get peer review, vault history is auditable, no new infrastructure (uses GitHub PR flow), respects the file-based architecture.

**Weaknesses:** every wiki-entry edit becomes a PR (slow iteration), the PR-review surface gets noisy with vault edits, the synchronous review gate slows down quick-capture flows like adding a note mid-meeting.

## Recommended changes

Three changes capture the recommended phased path:

1. **Document the per-user-vault model as canonical for v1** (already scaffolded — this is what the OS shipped with). Reduces ambiguity for early adopters; sets expectations that sync is a v2+ feature.

2. **Spike a git-based vault sync mode** as an opt-in alternative. Engineers who want it can flip a config flag; vault entries land under a tracked subfolder + git push/pull cycle. Worth ~1-2 weeks to validate ergonomics before broader investment.

3. **Add CRDT-backed events.db aggregation** as the long-term answer for team-wide metrics. Largest investment but unlocks the "Pulse across the whole team" surface that's the highest-value distribution-readiness feature.

The order matters: lock in the v1 model (1), validate sync-via-git as a low-cost extension (2), then commit to CRDT for the metric layer (3). Skipping step 1 leaves teams confused about what they're getting. Skipping step 2 means CRDT carries unproven design weight.

## Notes

- Obsidian Sync's three-way-merge approach was reviewed (per the notes_log entry from 2026-01-22). Their pattern — line-level merge with conflict markers in frontmatter — is adaptable but ties strongly to their iCloud transport. The git-based recommendation borrows the line-level conflict shape but uses git's existing merge driver rather than a new transport.

- Two contenders that didn't make the shortlist: SQLite-on-shared-NFS (too brittle on macOS / Windows) and Dropbox-style file sync (resolves conflicts to "Filename (graviton conflicted copy).md" which silently fragments the vault).

- The decision-distribution-v1-architecture entry mentions this as deferred to v2+. This report is the input to that v2 decision.

## Lifecycle state

This example research-report ships in `vault/wiki/_seed/research/research-report/` as a canonical demonstration of the archetype. Frontmatter shows the post-review state (`status: reviewed`, `review_status: approved`, `report_revision: 1`); recommended_changes mix the `proposed` and `scaffolded` lifecycle values. notes_log carries one folded-in note showing the `considered_by` pattern.

A new install browsing the Research app sees this report as the only entry until they scaffold their own via `research-write`. Delete or archive once you don't need the reference.

## Related

- [[archetype-research-report]] — full archetype spec
- [[walkthrough-add-research-report]] — how to create your own
- [[archetype-change]] — what `recommended_changes` items become downstream
- [[archetype-project]] — the parent container
