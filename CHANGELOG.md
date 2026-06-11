# Changelog

All notable changes to the Agentic OS are recorded here. The OS uses loose semver: minor versions add features, patch versions ship fixes, major versions only ship breaking changes that require migration.

The canonical version is recorded at [`vault/wiki/_seed/meta/reference/os-version.md`](vault/wiki/_seed/meta/reference/os-version.md). Teams pull updates via `git pull` from their fork's upstream; see [CONTRIBUTING.md § Upgrading](CONTRIBUTING.md#upgrading) for the merge-conflict resolution pattern.

## [Unreleased]

### Upgrading from ≤ 0.4.x (existing installs)

This release carries the Fable self-review wave (18 recommendations from `research-fable-os-review-2026-06-11`). Code upgrades ship via `git pull` as usual; four things touch per-install state:

1. **Review-state migration (required if you have project entries).** Project frontmatter moved to the shared review-state contract — `plan_status` is lifecycle-only and verdicts live in `review_status` (see `standard-review-state`). Run `node scripts/migrate-review-state.mjs` once (idempotent, `--dry-run` to preview; re-running `./install.sh` also applies it). Until you do, `node scripts/audit.mjs` ERRORs on legacy values like `plan_status: reviewed-pending`, and the old `plan_review_path` / `plan_reviewed_at` fields are no longer read. Change and research-report entries need nothing — their existing values are subsets of the shared enum. events.db and the runs table migrate themselves on first boot.
2. **Historical cost rows are ~3× overstated until recomputed.** The model registry had wrong Opus-family rates; pricing is now validated against CLI-reported `total_cost_usd`. Run `node scripts/import-session-usage.mjs --recompute-costs` once to fix history (idempotent; new imports are correct regardless).
3. **Expect `note-run-telemetry` audit WARNs if you curated run logs into the wiki.** Date-bucketed notes sourced from telemetry JSONL now warn — telemetry stays in events.db/raw per the OS.md layer contract. The finding's hint walks through collapsing them into an analysis note; `meta-curate` won't create new ones.
4. **Claude Code CLI version.** Dispatch now passes `--effort`/`--model`, and telemetry reads stream-json result fields. `scripts/check-cc-contract.mjs` verifies your CLI exposes the contract (the session brief WARNs on drift); if it fails, update Claude Code.

### Changed

- **PR Review's `primary_model` / `analyzer_model` config fields removed — Settings → Model is now the single source of truth for which model `dev-pr-review` and `dev-analyze-repo-for-review` run under (#451).** PR Review used to carry its own model dropdowns on Settings → Models, edited via `PUT /api/pr-review/config { primary_model, analyzer_model }`, persisted into `reference-pr-review-config.md` frontmatter. That parallel surface predated the centralized Settings → Model app (#450) and was redundant the moment that shipped: dispatch already resolves the model via `resolveModelForRun(skill)` from `.claude/settings.{local,}.json` + per-skill SKILL.md frontmatter, ignoring whatever was in `config.primary_model`. Removed `primary_model` / `analyzer_model` from `PrReviewConfig`, `PrReviewConfigUpdateBody`, `EDITABLE_FIELDS`, the GET response, and the seed reference doc. PR Review Settings → Models tab now renders read-only "resolved verdict" cards driven by a new `GET /api/settings/skills/:skill/resolved` endpoint that returns the winning value + per-layer breakdown (skill / local / project / cli-default) — operators can see exactly _why_ a model was picked without bouncing to the Settings app. `dev-pr-review` SKILL.md step 7 no longer reads `primary_model` from config; the entry template now mirrors `dev-analyze-repo-for-review`'s existing pattern — stamp `config.primary_model` from the skill's own runtime context, so the entry records what _actually ran_ rather than what was configured. **Migration:** if you have a hand-edited `vault/wiki/development/reference/reference-pr-review-config.md`, the `primary_model` / `analyzer_model` lines are now ignored — you can remove them on next edit (no automatic rewrite). The seed ships without them as of 0.4.3

### Added

- **`scripts/migrate-review-state.mjs` — committed per-install migration to the shared review-state contract.** The contract's mechanical migration previously ran only on the authoring install; other installs pulling the wave would hit `plan-status-enum` audit errors on their own project entries with no recipe. The script applies the `standard-review-state` mapping table (legacy `reviewed-pending` / `request-changes` / `approved` → `plan_status: drafted` + the matching `review_status`) and renames `plan_review_path` → `review_path`, `plan_reviewed_at` → `reviewed_at`. Idempotent with conflict detection (never clobbers an existing `review_status` / `review_path`), `--dry-run` mode, rebuilds the vault index when it changed anything. Wired into `install.sh` (no-op on fresh clones) and named by the `plan-status-enum` / `review-status-enum` audit error hints
- **Per-skill model selection (#450) — symmetric to the existing effort architecture.** The Settings app now has a dedicated **Model** tab alongside Effort and Usage analytics. Same three-tier resolution chain as effort: per-skill SKILL.md `model:` frontmatter > `.claude/settings.local.json` `model` (per-install override, gitignored) > `.claude/settings.json` `model` (team baseline) > Claude Code CLI's user-global default. Dispatch path appends `--model <id>` to `claude -p` when resolved — uses new `resolveModelForRun(skill)` that mirrors `resolveEffortForRun` exactly. Wired into all three current spawn sites (`runs.ts`, `action.ts`, `schedules.ts`). New endpoints: `PUT /api/settings/model` (writes settings.local.json) and `PUT /api/settings/skills/:skill/model` (surgical SKILL.md frontmatter edit). UI: project-wide model dropdown grouped by family (Mythos / Opus / Sonnet / Haiku) sourced from the registry; per-skill table with Effective / Override / Recommended columns + bulk **Apply recommendations** button — exactly the shape that's been working for effort. Optional `recommended_model:` frontmatter field on skills carries guidance without affecting dispatch. Skills can now mix-and-match effort + model independently — e.g. `dev-write-change` could be `model: claude-fable-5 + effort: xhigh` while `meta-add-note` runs `model: claude-haiku-4-5 + effort: medium`
- **Claude Opus 4.8 added to the registry.** Same pricing tier as the rest of the Opus family ($15 input / $75 output per million). Marked `latest: true` for the `opus` family; 4.7 demoted to `latest: false` (still in the registry — historical sessions tagged with `claude-opus-4-7` continue to resolve their pricing correctly). `pricingFor('claude-opus-4-8[1m]')` works via the existing `[<context-window>]` suffix-strip
- **Mythos-class models added to the registry — Claude Fable 5 + Mythos 5.** Anthropic shipped the new flagship tier on 2026-06-09 ([announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5)) — positioned above Opus with cheaper per-token pricing ($10 input / $50 output per million vs Opus's $15/$75). Added to `scripts/models-registry.mjs` and `scripts/import-session-usage.mjs` so the dashboard's model dropdowns, Usage analytics cost computation, and `pricingFor()` lookups all recognize the new ids. `claude-fable-5` is `latest: true` for the new `mythos` family; `claude-mythos-5` carries a `note:` flagging its restricted-access status (Project Glasswing partners + select biology researchers only). The `[1m]` context-window suffix variant works via the existing `pricingFor` regex strip. **Caveat:** Claude Code's CLI hasn't been updated to dispatch to these model ids yet — the OS registry is ready the moment it is. New optional `note?: string` field on `ModelEntry` lets future restricted-access or preview models carry their caveats inline

### Fixed

- **Wikilink to change entries now opens the Changes app's detail view (#449).** Clicking `[[some-change-id]]` in any rendered markdown (notably the Weekly triage card on the Changes app list view) previously navigated to `/vault/entries/<id>` — the generic Vault renderer with just the body + recent-activity panel. The Changes app's purpose-built detail view (status hero, lifecycle stepper, tabs, dispatch buttons) was unreachable from those links. `EditableMarkdown` now fetches the vault manifest's id→type map (shared cache with the Vault app) and routes polymorphically: `type: change` → `/changes/<id>`, `type: pr-review` → `/pr-review/reviews/<id>`, otherwise → `/vault/entries/<id>`. Skill wikilinks still route to `/skills/<name>` as before. Hover-tooltip on each wikilink names where it opens. Falls back to the Vault generic view when the manifest hasn't loaded yet — no regression for cold-start clicks

## [0.4.2] — 2026-06-09 — Dismissal-id drift + approved research surface

Two targeted fixes that compose to "trust the surface" — when you dismiss a finding, the dismissal sticks; when a project has approved research, you can see it without hunting through tabs.

### Added

- **Approved research card on the project Overview tab (#395).** Previously, the project's "About this project" body stayed as template placeholder text (`## Goal\nWhat success looks like, one paragraph.`) even after the research-driven flow had produced an approved research-report — the project's actual shape was invisible at a glance, and users had to open the Research tab to find it. New `ApprovedResearchCard` renders above the description card whenever the project has one or more reports with `review_status: approved`. Per row: report title (click → opens in Vault), revision number when > 1, "approved Nh ago" relative timestamp, and a one-line recommendation roll-up (e.g. "5 recommended changes · 3 scaffolded · 1 merged"). Sorted by `reviewed_at` desc. Non-destructive: the project body stays a human charter; the card is a sibling surface, not an auto-rewrite

### Fixed

- **Dismissal-id drift on time-based audit checks (#424).** Audit findings whose `message` interpolated drift-prone values (day counts, minute counts, "X days ago", failure counts in last 24h, etc.) computed a different `hash(message)` on every audit run — so when a user dismissed the finding, the stored dismissal-id no longer matched the freshly-recomputed id on the next run, and the finding re-fired. Fix: added optional `dedupe_key?: string` to `AuditFinding`; when present, `dismissalIdForAuditFinding` uses it instead of `hash(message)`. Set `dedupe_key: ''` on the 13 affected checks (project-stale, last-verified-stale, change-CI-passing-not-merged, events-db-stale, project-automation-running-long, project-automation-paused, plan-approved-not-scaffolded, materials-orphan, report-materials-stale, rule-rate-limited, rule-delivery-failed, notes-unconsidered-stale) — `path` already uniquely disambiguates these. For `report-recommends-stale` (where multiple recs per report each produce a finding), `dedupe_key: rec.id` provides the stable disambiguator. Empirically verified: day-1 and day-2 ids for the same finding now match (legacy: `ei2f67` vs `dw504u`; new: `45h` both days). Stable-message checks (no time interpolation) keep the old `hash(message)` behavior — backward-compatible with existing dismissals

## [0.4.1] — 2026-06-09 — Observability + dispatch consistency

Three closures that compose into a coherent theme: every tuning-suggestion dispatch now goes through the canonical `startRun()` path (uniform runs-db rows, drawer rendering, cost capture), the Pending Suggestions panel surfaces a `proposed` badge so successful Propose runs are visible (not silently filtered out), and the change-detail Automation tab now renders the orchestrator's decision narrative interleaved with the dispatched runs in time order. The runs drawer is now the single canonical surface for watching any dispatch — no more bespoke SSE streams to chase.

### Changed

- **Tuning-suggestion dispatch now uses the canonical `startRun()` path uniformly (#416).** The audit-detail page's `Propose edit` button previously dispatched via a bespoke SSE-streaming endpoint (`POST /api/tuning-suggestions/propose`) that spawned `claude -p` directly, managed its own stream, and re-read proposal artifacts on subprocess close. That diverged from the PendingSuggestionsPanel which already went through `useDispatch().startSkillRun`. Migrated `TuningSuggestionActions` to the same inline-dispatch pattern: click Propose → `startSkillRun` → runs-db row + runs-drawer streaming + cost/duration capture + effort propagation, all uniformly. The bespoke `/propose` route + matching `ProposeModal` component were deleted; the redundant `/apply` route was also removed (its UI caller `DecisionActions` migrated to `startSkillRun` earlier). `runStream` import dropped from Overseer view; `resolveEffortForRun` re-export dropped from tuning-suggestions.ts (only the canonical path needs it now)

### Added

- **`proposed` badge in the Pending Suggestions panel (#448).** After a successful Propose run produced diff + rationale artifacts, the row vanished from the panel (filtered out) so users couldn't tell whether the propose worked or if they needed to re-run. Now the panel keeps proposed-but-not-promoted rows visible with a green `✓ proposed` badge (or `✓ proposed (rationale only)` for non-skill targets); the `Propose` button relabels to `Re-propose`, and `Promote` is emphasized as the next action. Server-side: `GET /api/tuning-suggestions/pending` no longer filters by proposal state; response includes per-row `proposal_state` + `proposal_diff_path` + `proposal_rationale_path`. Only `dismissed` and `promoted` (decision exists) still filter the row out — those are terminal
- **Orchestrator decision log in the change detail's Automation tab (#429).** The orchestrator's narrative — which step it advanced to, when it paused, when it completed — was previously recorded as `change-automation-*` events in events.db but invisible in the UI; post-mortem reading required SQL. The Automation tab now renders an `Automation timeline` that interleaves orchestrator decisions with the dispatched runs in chronological order. Decisions show the verb (enabled/advance/pause/complete/...), the `step` + `iteration_count`, an optional reason, and link to the dispatched run via its truncated id. Visible always (not just on `complete`), so in-flight cycles show the running narrative too
- **`GET /api/changes/:id/automation/decisions`** — server route that returns the orchestrator's `change-automation-*` events for a given change, sorted chronologically. Args are parsed from each event's `raw` JSON so the response surfaces `step`, `run_id`, `iteration_count`, `reason`, and `marked_ready_for_human` as structured fields
- **`action` is now an exact-match filter on `queryEvents()`** (`scripts/events-db.mjs`). Previously the filter list omitted `action`, so callers passing `{action: 'change-automation-advance'}` silently got an unfiltered result. The decisions route depends on action filtering working correctly — same key was already supported by `countEvents()`, this aligns the helpers

## [0.4.0] — 2026-06-07 — Settings app + effort propagation + head_sha loop

The OS gains user-tunable reasoning depth. A **Settings** app lands in the sidebar with two tabs: **Effort & cost** (project-wide effort dropdown + editable per-skill overrides) and **Usage analytics** (mirrors Claude Code's `/usage` output sourced from `events.db`). Behind it, a bug fix that quietly enables the whole feature: every `claude -p` subprocess the OS dispatches now correctly propagates the configured effort level via an explicit `--effort` flag — previously, headless dispatches silently ignored the setting and ran at Claude Code's built-in default regardless of what the dashboard said. Empirically confirmed: dispatched runs at `max` now produce 8-21× larger thinking-blob fingerprints in the session JSONL vs the same skills at pre-fix baseline.

### Added

#### Settings app

- **`/settings`** — new top-level meta app with two tabs:
  - **Effort & cost** — project-wide effort dropdown (`low` / `medium` / `high` / `xhigh` / `max`) writing per-install to `.claude/settings.local.json` (gitignored). Per-install / inherited / built-in badges show which layer the active value comes from. Per-skill table is **editable**: each row has an Effective column (always visible, accent-colored when overridden) and an Override dropdown that writes to `.claude/skills/<name>/SKILL.md` frontmatter via the dispatch resolver's precedence chain
  - **Usage analytics** — mirrors `/usage` output. Window toggle (24h / 7d / 30d), totals tiles (cost / turns / tokens in/out / cache reads & writes / wall duration), by-skill + by-model breakdowns side by side, per-day cost bar chart. Sync button runs `import-session-usage.mjs --all` server-side to pull session-transcript data into `events.db`. Empty state guides users to the sync button
- **`effortLevel: "high"`** baseline in `.claude/settings.json` — team-tracked default. Documents the team's effort baseline so fresh installs don't run at Claude Code's model-tier-specific default (which differs across Opus 4.7 vs 4.8). Per-install overrides via `.claude/settings.local.json` still win
- **`/api/settings`** — GET returns both settings layers + effective effort + per-skill scan + valid effort levels. PUT `/api/settings/effort` writes effort to `settings.local.json`; refuses to clobber malformed JSON. PUT `/api/settings/skills/:skill/effort` surgically edits a single SKILL.md frontmatter's `effort:` field (replace / insert / strip cases) and refuses to touch a file whose frontmatter fails to parse
- **`/api/usage`** — GET aggregates `kind='session'` events.db rows within window into totals/by-skill/by-model/by-day shape. POST `/api/usage/sync` runs the import script and returns parsed counts (inserted / deduped / no-cost)

### Fixed

- **Per-skill "Recommended" column in the Settings app — replaces "Cost vs default".** Each skill can now ship a `recommended_effort:` field in its SKILL.md frontmatter (pure metadata, never affects dispatch — only the explicit `effort:` field reaches the resolver). The Settings → Effort & cost table reads this and surfaces it per-row: ✓ when the recommendation matches current effective effort, `↑ apply` / `↓ apply` button when a delta exists, `—` when no recommendation. A bulk "Apply recommendations (N)" button in the card header batch-applies every delta in one click — each row's apply uses the same `PUT /api/settings/skills/:skill/effort` endpoint the dropdown uses. Recommendations seeded for 33 skills: **xhigh** for synthesis-heavy work (`dev-write-change`, `dev-revise-plan`, `dev-review-change`, `dev-pr-review`, `dev-analyze-repo-for-review`, `meta-overseer-review`, `meta-apply-tuning-suggestion`, `meta-review-project-plan`, `meta-revise-project-plan`, all `research-*`), **medium** for mechanical / CRUD wrappers (all `meta-add-*`, `meta-rename`, `meta-delete`, `meta-reopen-project`, `meta-mark-research-approved`, `dev-mark-pr-ready`, `dev-close-change`, `dev-cache-pr-review-repo`, `dev-pull-pr-comments`, `dev-ingest-repo`). Default: every skill inherits the project-wide setting — recommendations are guidance, not auto-applied
- **Audit-trigger button in the dashboard (#445).** Previously, producing a lifecycle audit required dropping to a CLI: `/os audit lifecycle <change-id>`. Now: any merged or abandoned change shows an `Audit lifecycle` button in its detail-page header (next to `Abandon`). Click dispatches `meta-overseer-review` via the runs drawer, which means it's tracked, effort-aware (per today's earlier fix), and shows progress/cost in the drawer. The skill's gates (terminal state, opt-in or force, 24h debounce) self-validate and surface their rejection messages in the run output — re-dispatch with force from the drawer if needed. Overseer Overview's empty-state guidance updated to point at the new button instead of the CLI
- **Dangling-wikilink distribution bug — `meta-apply-tuning-suggestion` no longer writes per-install wikilinks into team-tracked SKILL.md files.** Previously, the `apply` mode wrote rationale prose with `[[audit-<id>]]` and `[[decision-<id>]]` wikilinks citing the originating audit + decision. Those targets live in `vault/wiki/meta/lifecycle-audit/` and `vault/wiki/meta/decision/` — both gitignored per-install paths — so the wikilinks shipped to other teams via the SKILL.md were dangling on every fresh install, firing `Dangling wikilink` warnings in the dashboard's Overview. Cleaned up the two existing offenders in `dev-write-change/SKILL.md` (converted to backtick code-span references) and added a hard rule to `meta-apply-tuning-suggestion`'s "What this skill must NOT do" section: audit/decision IDs in skill rationale prose MUST be backtick code spans, never wikilinks. Includes a parenthetical pattern (_"(per-install — these references are intentionally NOT wikilinks because the targets live in gitignored audit/decision paths)"_) for the model to use so future readers understand why the format differs from other wikilinks in the same file
- **`dev-pr-review` no longer wastes spend re-reviewing unchanged commits.** New step 8a pre-flight gate (mirrors `meta-overseer-review`'s 24h-debounce pattern, content-based instead of time-based): on continuation passes, compare the PR's current `head.sha` against the prior pass's `last_head_sha` and short-circuit with a no-op when they match. The short-circuit message includes a hint for the automation orchestrator to advance only after a new commit lands. Override via new `force: true` input when config/focus_notes/custom_instructions changed and a fresh pass against the same commit is genuinely desired. Closes the consumer side of the head_sha-drift waste pattern (audit `audit-mull-serve-http-json-query-api…` suggestion #0; documented $3.01 / 38% of pr-review spend wasted on one lifecycle alone via `pr-review-re-runs-against-unchanged-head-sha` recurrences). Skill version bumped 2 → 3
- **`last_head_sha:` field** added to `archetype-pr-review` — written by `dev-pr-review` step 12 on every pass write (both new and continuation). Powers the new debounce gate. Documented in `vault/wiki/_seed/meta/reference/archetype-pr-review.md`. Backwards-compatible: entries from prior versions fall back to body-scan for the last `## Pass N` block's recorded head SHA, then proceed if absent
- **`dev-analyze-repo-for-review` head_sha writeback is now non-negotiable** (#444). Previously the cache-entry writeback was conditional ("if drift detected") and easy for the model to skip when values happened to match — producing the `cache.head_sha drift` finding where the cache entry showed stale SHAs after analyze-repo fetched a newer HEAD. Prose hardened to require unconditional `head_sha` + `updated` writeback every run, with explicit anti-optimization wording. Closes the producer side of the head_sha-drift loop
- **Dispatch path now propagates `effortLevel` to all `claude -p` subprocesses.** Previously, the Settings → Effort dropdown only affected interactive Claude Code sessions — dispatched skill runs silently used Claude Code's built-in default regardless of the dashboard setting. `claude -p` doesn't read settings files on its own; it requires an explicit `--effort` CLI flag. New shared resolver `resolveEffortForRun(skill)` in `routes/runs.ts` (exported) walks the precedence chain (skill `effort:` frontmatter → `.claude/settings.local.json` → `.claude/settings.json` → omit flag); all five spawn sites — `routes/runs.ts` (canonical), `routes/action.ts` (legacy), `routes/schedules.ts` (cron-fired), and `routes/tuning-suggestions.ts` (Propose + Apply bespoke endpoints) — now use it and append `--effort <level>` to spawn args when set. Empirically confirmed: post-fix `meta-apply-tuning-suggestion` Propose run at `max` produced thinking-blob signatures up to 51KB (max), 6.5KB mean — vs pre-fix run at the same effort yielding 2.4KB max, 800B mean (8-21× delta). Server console logs the resolved effort on every spawn for traceability

### Known rough edges

- **`max` effort exposes pre-existing #418 subprocess fragility.** Runs at `max` take 2-4× longer than at `high`, which pushes more dispatches past the threshold where they hit silent OS-level kills (still tracked in #418). The skill's actual work often lands before death — verify the linked entity, don't trust the "failed" badge alone. Recommendation: use `high` as the project default and bump only synthesis-heavy skills (`dev-write-change`, `meta-overseer-review`, `dev-revise-plan`, `dev-pr-review`, `meta-apply-tuning-suggestion`) to `xhigh` via the per-skill Override column
- **Per-skill Override writes touch git-tracked files.** Setting a skill's effort in the dashboard modifies `.claude/skills/<name>/SKILL.md` frontmatter, which will appear in `git status` afterward. Commit to share the override with your team, or `git checkout` to discard. The Settings UI documents this above the table; it's a deliberate choice — per-skill effort is typically shared knowledge ("this skill genuinely benefits from deeper reasoning") rather than personal preference

### Compatibility

- Additive only. New API routes (`/api/settings`, `/api/usage`), new optional frontmatter field (`effort:` on skills), new optional settings key (`effortLevel` in settings.json / settings.local.json). All readers handle absent-when-missing
- No schema migrations, no skill renames, no breaking changes
- Fresh installs and `git pull` upgrades both work cleanly. Existing audits / decisions / cache entries continue rendering unchanged

## [0.3.0] — 2026-06-07 — Overseer arc + structural context

The OS becomes self-observing. A complete loop ships: lifecycle audits produce per-skill rubric scores + tuning suggestions, the dashboard surfaces patterns across audits, decisions gate skill changes, and validation runs in the next audit. The first end-to-end trip closed during this release: the `boundary-check` skill change was authored, accepted, applied, and validated against subsequent audit data — empirically reducing the `fix-introduces-defect-at-boundary` recurrence rate to zero on its qualifying lifecycle.

Two structural-context skills also ship, both lifted in shape from graphify's design (local-only Node scripts, no Python dependency): an **import graph** for PR review (blast-radius reasoning) and **rationale comments** surfacing for PLAN (institutional memory).

### Added

#### Overseer arc — self-improvement loop

- **`meta-overseer-review`** skill (Phase 1b) — audits one completed change lifecycle. Reads change + plan + plan-review + every PR-review pass + events.db; applies a 3-dimension rubric (correctness / completeness / efficiency) per skill that ran; emits a structured `lifecycle-audit` entry with scores, categorical tags, and concrete skill-tuning suggestions. Opt-in per project via `audit:` frontmatter block. Default off.
- **`archetype-lifecycle-audit`** (Phase 1a) — the data shape audits take. Rubric anchored levels (1-5 per dimension), 17-tag vocabulary with polarity (positive/negative/neutral), per-skill findings, tuning suggestions with confidence + evidence + target_change, optional `followup_signals[]` for forward-look adjustments
- **`meta-audit-followups`** skill (Phase 3) — daily scheduled sweep that finds subsequent changes touching the audited files, classifies them (fix / refactor / feat-extension / feat-rewrite / test / docs), and retroactively adjusts the audit's Correctness score. Promotes audits `provisional → final` when the 90-day window closes
- **`meta-apply-tuning-suggestion`** skill (Phase 4) — materializes one tuning suggestion into a SKILL.md edit. Two modes: `propose` (writes a unified diff + rationale to `vault/output/meta/tuning-proposals/`) and `apply` (requires a decision-archetype entry explicitly citing the audit + suggestion via `implements_tuning_suggestions`). Decision-entry gate ensures human-authored intent before any auto-edit
- **Overseer dashboard app** (Phase 2) — dedicated sidebar app at `/overseer` with Overview (verdict tiles, top recurring tuning suggestions, top tags, recent audits), Audits (filterable list + detail), By skill (per-skill diagnostic drill-in), Patterns (placeholder for v2.1)
- **Server routes** (Phase 1c) — `/api/audits` (list, detail, aggregate), `/api/tuning-suggestions/{propose,promote,dismiss,apply}`, `/api/decisions` (Phase 4 decisions list with status + validation progress)
- **Validation-v1** (light) on `archetype-decision` — three new optional frontmatter fields: `target_metric` (structured shape with `tag_frequency_decrease | skill_score_increase | pattern_absence` types), `validation_result` (`pending | validated | regressed | inconclusive`), `validation_observations[]` (append-only log). Closes the loop: decisions declare what they expect to move; future audits verify
- **Phase 4 dashboard actions** — Propose / Promote / Dismiss buttons on every tuning suggestion in the audit detail view; status badges showing proposal/decision/dismissed state; hybrid warning when evidence is `confidence: low` + `recurrence_count == 1`
- **Phase 4.1 Decisions surface** — `<DecisionsPanel>` on Overseer Overview lists every Phase 4 decision with inline Accept + Apply controls (no Vault navigation required); `<DecisionActions>` in the Vault renderer for in-context use. Apply migrated to use the runs-drawer dispatch — first-class tracked runs instead of modal-bound SSE
- **Phase 4.1 Pending suggestions panel** — cross-audit roll-up of tuning suggestions that haven't been actioned (no decision cites them, no proposal file exists, no dismissal recorded). Sorted by recurrence × confidence so high-leverage items surface first. Per-row Propose / Promote / Dismiss inline; Propose dispatches via the runs drawer; Promote scaffolds the decision entry and opens it in Vault; Dismiss uses an inline-expand rationale form (no modal). Panel auto-refreshes after any action
- **`applied_at` stamping** in `meta-apply-tuning-suggestion` — after a successful Edit, the skill surgically writes `applied_at: <ISO>` to the decision entry's frontmatter. Powers the "✓ applied" badge in Decisions panel + the "Re-apply" relabel on the button. Without it the dashboard couldn't distinguish "accepted, ready to apply" from "accepted, apply already done"
- **`walkthrough-overseer`** — comprehensive seed doc (300+ lines) walking through setup → audit production → reading audits → acting on suggestions → decision gate → validation. Surfaces in Guide → Walkthroughs and Quick Start ("Use the Overseer")

#### Structural-context signals (graphify-inspired)

- **`scripts/extract-imports.mjs`** — pure-Node file-level import graph extractor. Supports Go (via `go.mod` module prefix), TS/JS (handles the `.js`-in-source-but-`.ts`-on-disk convention), Python. Outputs `{ files: {rel: {imports, imported_by, tests}}, hubs }`. Runs at cache time via `dev-cache-pr-review-repo`; sidecar lives at `vault/output/development/repo-cache/<owner>-<repo>/import-graph.json`
- **`dev-pr-review` IMPORT GRAPH block** — injected into the analysis prompt: touched-file imports, imported-by callers, adjacent tests, plus a HUBS callout that flags when a touched file is one of the repo's top-imported files. Validated end-to-end on the multi-contract change: pass-1 reviews surfaced cross-file reasoning (downstream callers, test coverage gaps) that the prior baseline reviews lacked
- **`scripts/extract-rationale-comments.mjs`** — surfaces tagged inline comments (WHY/HACK/NOTE/FIXME/TODO/XXX/CAVEAT/IMPORTANT/WARNING/GOTCHA) with line numbers + code context. Single-line + multi-line tag handling; walks past comment continuations to land context on the actual code subject
- **`dev-write-change` PLAN step 7a** — runs the rationale extractor against candidate touched files; the prompt enumerates how each tag class should shape the plan (HACK/CAVEAT/WARNING/GOTCHA preserve workaround; WHY respect rationale; NOTE/IMPORTANT cite in Approach; TODO/FIXME/XXX preserve verbatim when moving code through)

#### Smaller wins

- **Models registry** (`scripts/models-registry.mjs`) — single source of truth for known Claude model IDs + pricing. Consumed by `import-session-usage.mjs` (cost computation) and a new `/api/models` route. PR Review Settings replaced text-input model fields with dropdowns sourced from the registry, with a "Show historical versions" toggle and graceful "not in registry" fallback for unknown values
- **Per-PR config snapshot card** in Review Detail — collapsible strip showing the policy values (model, comment style, focus areas, context strategy, custom-instructions hash) active when Pass 1 ran. Useful for "was this review under the old or new policy?"
- **Add Research Report page** (`/research/new`) — replaces the prior modal with a dedicated two-column page (form on the left, live preview sidebar on the right showing derived report ID, materials path, dispatch tally). Legacy `?add=1` URL redirects gracefully. The modal pattern bit users on textarea-resize-drag and other edge cases; pages don't have that class of issue

### Changed

- **PR-review entry `tags` field renamed to `audit_tags`** in the `lifecycle-audit` archetype to avoid YAML duplicate-key collision with the wiki-standard `tags: [audit, overseer]`. Older audits don't have the field; server route handles absence gracefully
- **`dev-cache-pr-review-repo`** step 10a now extracts the import-graph at every cache pull (first-time + refresh). Cache entry frontmatter gains `import_graph_path` field
- **`dev-pr-review`** sub-step 10c loads the sidecar when present; falls back to filename-only reasoning when absent (graceful degradation for stale caches)
- **`reviews.ts` route** now extracts the `config:` block from pr-review entry frontmatter and exposes it as `ReviewDetail.config` for the snapshot card
- **`audits.ts` route** computes `tuning_suggestion_status[]` per detail request — reads dismissed-action-items.jsonl + walks decisions directory to surface per-suggestion action state (dismissed, proposal_state, linked decisions). Powers the audit-detail action buttons
- **Audit-route status enrichment now uses `audit_tags` (not `tags`)** — Phase 4.1 rename propagated through

### Fixed

- **Duplicate YAML key in audit files** — the original `archetype-lifecycle-audit` example showed both wiki-standard `tags: [audit, overseer]` and pattern `tags: [...]` fields; YAML parser rejected the duplicate, audits became invisible to the dashboard. Renamed pattern field to `audit_tags` everywhere (archetype, skill, template, route, view)
- **`ref` reserved-prop collision** in DecisionActions ApplyModal — React intercepts `ref` props (forwardRef machinery); renamed to `target` + `allTargets`. Caught at runtime before initial use
- **YAML auto-Date coercion in `/api/decisions`** — js-yaml's default schema parses ISO timestamp strings into `Date` objects. Route's original `typeof v === 'string'` check silently returned null for `applied_at`, `created`, `updated`. New `asIsoString(v)` helper accepts string OR Date, coerces to ISO. Applied across all timestamp fields on the wire shape
- **Manifest rebuild after seed additions** — every new seed entry (archetype-lifecycle-audit, walkthrough-overseer, os-version, archetype-decision extensions, etc.) is now indexed correctly; manifest jumps from 282 → 293 entries

### Known rough edges (deferred to 0.3.x patches)

- **Propose flow is mixed-state** — from the new Pending Suggestions panel, Propose dispatches via the runs drawer (consistent with Apply). From the audit-detail tuning-suggestion rows (the original Phase 4 surface), Propose still uses the bespoke SSE modal. Functional in both modes; consistency cleanup deferred to 0.3.1
- **No audit-trigger button in dashboard** ([#445](https://github.com/your-org/agentic-os/issues/445)) — producing a new audit requires `/os audit lifecycle <change-id> force=true` from a Claude session. Natural location is the change detail page when `status: merged|abandoned`
- **`dev-cache-pr-review-repo` head_sha drift** ([#444](https://github.com/your-org/agentic-os/issues/444)) — analyze-repo fetch step doesn't write back to the cache entry's `head_sha` field; can cause "stale entry vs current cache HEAD" on re-pull
- **Dismissal-id drift** ([#424](https://github.com/your-org/agentic-os/issues/424)) — pre-existing; dismissed items can resurface on audit rerun because the dismissal id contains a hash that drifts

### Compatibility

All changes are additive — no schema migrations required, no skill IDs renamed, no API paths removed. Teams can pull and `./install.sh`; existing data continues to work. New frontmatter fields default to absent (handled-when-missing throughout).

To opt into Phase 4 audits on a project, add this block to the project's frontmatter:

```yaml
audit:
  enabled: true
  mode: on-complete
```

(or `manual` / `sampled` with `sample_rate: N`). Default is off.

To schedule the forward-link sweep: `/os add schedule meta-audit-followups` once a daily cadence makes sense (typically after ~5 audits accumulate).

## [0.2.0] — 2026-06-03 — Distribution v1

The OS becomes distributable as a team-install template. The core decision: per-user vault, shared code only — each engineer runs their own OS instance against a team-shared skill catalogue. Multi-machine validated.

### Added

- **Distribution architecture decision** ([`decision-distribution-v1-architecture`](vault/wiki/_seed/meta/decision/decision-distribution-v1-architecture.md)) — captures the four locked decisions (audience: small teams; state model: per-user vault; install: `git clone` + `./install.sh`; repo strategy: one repo, gitignore per-install state)
- **`CONTRIBUTING.md`** — extension model (how to add/edit skills, domains, MCPs, archetypes), review conventions, what ships vs gitignored, testing expectations
- **`TROUBLESHOOTING.md`** — 6-section common-failure guide (install, first-run, MCP setup, repo ingestion + lifecycle, vault state, commit + CI)
- **`standard-team-customization.md`** — the customization model for team forks (where custom code lives, naming conventions, upstream merge patterns, configuration over code)
- **`CLAUDE.md` per-team config block** — `<!-- team-config-start --> ... <!-- team-config-end -->` markers teams edit; OS-core sections above stay stable for clean upstream merges
- **`.github/workflows/ci.yml`** — typecheck + tests + manifest rebuild + markdown format on every PR
- **Pre-commit hook** (`scripts/git-hooks/pre-commit`) — same checks locally, symlinked by `install.sh` when `.git/` is present
- **`README.md` distribution surfaces** — TL;DR for new engineers, "First 10 minutes" walkthrough, Key files index pointing at CONTRIBUTING / TROUBLESHOOTING / distribution decision
- **`meta-add-skill-to-playbook`** + **`meta-add-skill-to-router-vocab`** skills — one-click resolvers for the `playbook-skill-coverage` and `router-vocab-skill-uncovered` audit findings; wired into `proposedActionForAudit` so the dashboard's Action Items panel dispatches them
- **`meta-add-note`** skill — generic note scaffolder for domain/project-scoped observations that don't fit decision / change / research-report archetypes
- **`research-report-example-vault-sync-options`** seed entry — canonical example of the research-report archetype shipped in `_seed/research/research-report/`
- **`development-domain`** entity entry — meta-domain's sibling; documents the dev-\* skill ownership
- **Project Pulse v1** card on Project Overview — four metric tiles (in-flight, PR-review state, spend, research upstream) + top-skills cost leaderboard + failed-runs warning chip. Pure render-time derivation from `owned_changes` + `rollup` + `research_reports`
- **Notification templates** for `dashboard.mark-pr-ready` and `dashboard.close-change`
- **PR-review-publish self-approve auto-downgrade** — when GitHub blocks an APPROVE event because the PAT identity matches the PR author, the skill auto-downgrades to COMMENT and prepends a verdict banner. Deterministic; previously non-deterministic
- **Line-range parser** in `dev-pr-review-publish` — `line: N-M` ranges now parse to last-line anchor + `_(re: lines N–M)_` body prefix instead of falling through to body-quoted
- **Branch cleanup three-tier resolve** in `dev-close-change` — `git symbolic-ref` → `git remote set-head origin --auto` → fall back to repo entity's `default_branch` field
- **`merged_at` from github MCP** — `dev-close-change` now records GitHub's actual merge timestamp instead of falling back to `now()`
- **Reviews list collapsible merged section** — `pr-review/Reviews` view groups merged PRs under a click-to-expand divider; default collapsed
- **`needs-triage` park** in change-automation state machine — when `pr_review_status: needs-changes` but no comments have been curated, orchestrator parks with a clear reason instead of dispatching no-op address-comments cycles
- **English-ordering attribution** — `extract-event-attribution.mjs` now parses both `research <verb> <id>` and `<verb> research <id>` intent forms
- **Local-TZ Pass header** in `dev-pr-review` — body timestamps format as user's local TZ (frontmatter stays ISO UTC for sortability)
- **Size enum short forms** — `dev-add-change` accepts `s/m/l` as aliases for `small/medium/large` (normalized to long form before writing)
- **Run-row phase hints** — manual `dev-write-change` dispatches now carry phase hints producing distinct run-row titles (`Planning change …` / `Executing change …` / `Addressing comments on …`)

### Changed

- **Sanitized example references** across shipped seed entries — replaced personal repo names (`NFhbar/mull` → `acme/api`), personal paths (`/Users/graviton/...`), personal usernames (`user-graviton` → `user-alice`) with generic equivalents
- **`README.md` Commands section** — replaced 4 stale tables with a curated "Starter commands" list (~10 rows) + pointer to `OS.md` for the full vocabulary
- **Project Pulse throughput strip removed** — at the densities typical for deliberate-change workflows the sparkline added visual noise without conveying signal beyond the In-flight tile. Space reserved for v2 metrics (lifecycle velocity, review efficiency, bottleneck stage)
- **`install.sh`** — added git + git-identity checks; symlinks pre-commit hook when `.git/` exists; rebuilds vault manifest from seed content (was leaving the manifest empty)
- **`.gitignore`** — added global `.env*` / `.envrc` / `.npmrc` / `.netrc` / `.pypirc` safety net (anywhere in the tree); allow-listed `.env.example` and `.npmrc.example` variants
- **`package.json`** — added `pretest` script that auto-rebuilds the manifest before `npm test`; CI and local installs both benefit
- **`research-scaffold-recommendations`** — no longer truncates research summaries to 80 chars when deriving change titles (was producing clipped headings everywhere)

### Fixed

- **CI manifest missing** — tests fail on fresh installs because `vault/.index/manifest.json` is gitignored. Fixed by adding the manifest rebuild as an explicit CI step + a `pretest` npm script
- **Empty install manifest** — `install.sh` was writing an empty manifest; new installs saw the Dashboard's Vault view as empty even though the 100+ seed entries existed on disk
- **Dangling wikilinks in seed entries + skills** — removed install-specific wikilink references (mull-project entries, OS-dev change entries) from shipped seed entries and SKILL.md files; converted to prose context
- **Dismissal-id format drift** — fixed one stale jsonl entry that had a non-canonical id; documented the canonical shape

### Architecture decisions deferred to v2+

- **Bot-account separation** ([#430](https://github.com/your-org/agentic-os/issues/430)) — each engineer using their own PAT means PR self-approval gets auto-downgraded to COMMENT. Long-term fix is a separate reviewer GitHub App identity per team. Mitigation shipped for v1
- **Team-shared metrics aggregation** — Pulse v1 is per-user; v2 will aggregate across engineers via a shared events.db backend
- **Skill marketplace / upstream pull** — teams fork independently; no upstream-tracking mechanism. Worth doing when a second team adopts the OS
- **Onboarding wizard / interactive tour** — `/os tour` skill that walks new engineers through the dashboard + first change + lifecycle. Nice-to-have; the README + dashboard's self-explanatory layout suffice for v1

## [0.1.0] — Pre-distribution (no version tracked)

Everything prior to 0.2.0 was the OS as a personal power tool. The dogfooding loop on `mull` (research → changes → automation → PR review → publish → close) was the validation that proved the OS works end-to-end before distribution.

Notable shipping milestones during this period (recovered from change entries):

- Per-change automation orchestrator (PLAN → REVIEW → EXECUTE → open-PR → PR-review → address-comments → mark-ready)
- Project Pulse v1 design + implementation
- Wall-time-cap watchdog + verify-state hint UX for orphan-style subprocess deaths
- Vault index manifest builder with backlinks
- Notification dispatch engine (dual-path: in-process hook + cross-process poller)
- Status report skill with continuous change-lifecycle tracking
- Test suite bootstrap (Tier 1 unit + Tier 2 structural; ~568 tests)
- Self-improvement test framework (extracted pure-function modules)
- Domain + archetype + standard infrastructure

The full history is in git log on the maintainer's fork. Distribution v0 was unversioned; treat 0.2.0 as the canonical baseline for team installs.
