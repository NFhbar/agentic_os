---
name: dev-pr-review
description: 'Review a pull request — read the diff, produce categorized comments, write a structured pr-review archetype entry to the vault. Supports multi-pass review: re-running on the same PR appends a new pass. Also runs in response mode, drafting answers to external comments nobody has answered yet.'
user-invocable: true
recommended_effort: max
version: 6
domain: development
tags: [review, pr, github, mcp, archetype, lifecycle]
inputs:
  pr:
    type: string
    required: true
    description: 'PR identifier — URL (https://github.com/owner/repo/pull/N) or shorthand (owner/repo#N)'
  change:
    type: string
    required: false
    pattern: '^[a-z0-9][a-z0-9-]*$'
    description: 'Optional change id to link this review to. If omitted, the skill searches the vault for a change with matching pr_url.'
  pass_kind:
    type: string
    required: false
    default: auto
    description: '"new" (force new entry, error if one exists), "continuation" (force new pass on existing entry), or "auto" (detect by file existence — recommended)'
  mode:
    type: string
    required: false
    default: review
    enum: [review, response]
    description: '`review` (default) runs the find-new-issues analysis over the diff. `response` pivots to answering: it reads the external comments that nobody has answered yet and drafts one reply per comment, each carrying an `in_reply_to` header so [[dev-pr-review-publish]] can send it into the right GitHub thread. Response mode never opens new findings, skips the head_sha debounce (the head has not moved — the conversation has), and produces a pass with no verdict.'
  focus_notes:
    type: string
    required: false
    description: 'Free-text guidance to inject into the analysis prompt — used by the dashboard''s Re-analyze flow to target a specific concern (e.g. "focus on the auth handler", "ignore style nits, look for race conditions"). Appended to CUSTOM INSTRUCTIONS in the review prompt without replacing the config-level custom_instructions.'
  force:
    type: boolean
    required: false
    default: false
    description: 'Skip the head_sha debounce gate (step 8a) and re-review even when the PR head is unchanged since the prior pass. Use when the surrounding context changed (config tweak, focus_notes shift, custom_instructions update) even though the diff did not.'
outputs:
  - kind: file
    path: 'vault/wiki/<domain>/pr-review/pr-review-<owner>-<repo>-<n>.md'
  - kind: event
    path: '.claude/state/events.db (kind: dashboard, action: pr-review, change_id: <change?>, files_touched: [vault/wiki/.../pr-review-*.md])'
spawns: []
model: claude-fable-5
model_policy: required
effort: max
wall_time_cap_minutes: 60
---

# dev-pr-review

## Purpose

Run a structured review against a pull request and persist the result as a [[archetype-pr-review]] entry in the vault. Each invocation produces one **pass** — a single review snapshot. Re-running the skill on the same PR after new commits land appends a new pass to the existing entry, with `prior:` links so the UI can diff resolved/new/unresolved comments across passes.

The review is a **single-model, single-call** review: one prompt that asks the model to consider the PR across all configured `focus_areas` and tag each comment with its category. This intentionally collapses the multi-agent fan-out pattern into one model call — see [[archetype-pr-review]] § Comments for the rationale.

## When to use

- Right after [[dev-open-pr]] opens a PR for an OS-tracked change (the natural follow-up)
- When you want a review of an external PR (paste a URL into the dashboard's PR Review app)
- When the PR you reviewed has new commits and you want a fresh pass
- With `mode: response`, when [[dev-pull-pr-comments]] has ingested comments or author replies that ask something and nobody has answered them yet

## When NOT to use

- The PR has no commits / is empty — the skill will report nothing useful
- You want to write code in response to review comments — that's `dev-address-comments` (planned)
- You want to publish the review back to GitHub as inline comments — that's `dev-pr-review-publish` (planned)

## Prerequisites

- `github` MCP configured + authenticated. Verify via:

  ```bash
  node scripts/check-mcp.mjs github
  ```

- `gh` CLI installed and authenticated (`gh auth status`). The skill uses `gh pr diff` until the github MCP gains `get_pull_request_diff` (Phase 2 work).
- `git` CLI on PATH (used by [[dev-cache-pr-review-repo]], invoked as a sub-step to maintain a read-only shallow clone of the PR's base branch for code context).
- [[reference-pr-review-config]] exists at `vault/wiki/development/reference/reference-pr-review-config.md` — ships in `_seed/` so this is satisfied by default.
- For OS-tracked PRs: the change entry's `pr_url` matches the `pr` input (the skill auto-links).
- For external PRs: ideally the repo is ingested as a `[[archetype-entity]]` with `kind: repo`. If not, the skill stores the GitHub `<owner>/<repo>` reference without an entity link.

## Procedure

1. **Pre-flight: verify the github MCP.** Run:

   ```bash
   node scripts/check-mcp.mjs github --json
   ```

   If exit code is non-zero, surface the script's `hint` field verbatim and stop.

2. **Parse the `pr` input.** Accept two forms:
   - URL: `https://github.com/<owner>/<repo>/pull/<n>`
   - Shorthand: `<owner>/<repo>#<n>`

   Extract `owner`, `repo`, `n` (integer). Compute canonical URL: `https://github.com/<owner>/<repo>/pull/<n>`. Reject malformed input with: `Invalid pr identifier: <input>. Expected URL or owner/repo#N shorthand.`

   **Fallback when `pr` is absent but `change` is set** (the orchestrator dispatch shape — both orchestrators send only `- change: <id>`): read `vault/wiki/*/change/<change>.md` and use its `pr_url` as the pr input. If that change has no `pr_url`, reject with: `change <id> has no pr_url — run dev-open-pr first.`

3. **Compute the pr-review id**: `pr-review-<owner>-<repo>-<n>`, normalized EXACTLY as: lowercase `owner` and `repo`, replace every character run outside `[a-z0-9]` with a single `-`, trim leading/trailing `-` (so `NFhbar/agentic_os#12` → `pr-review-nfhbar-agentic-os-12`). The file lives at `vault/wiki/development/pr-review/<id>.md`. This is the same rule as [[dev-analyze-repo-for-review]] / [[dev-cache-pr-review-repo]] — divergent normalizations have already produced three id forms for one repo, orphaning pass history.

4. **Determine pass kind** based on file existence at the path from step 3. **Guard against normalization drift first**: before declaring "new", glob `vault/wiki/development/pr-review/*.md` for any entry whose `pr_number == <n>` and `pr_url` matches the canonical URL (case-insensitive) — a hit IS the continuation target even if its filename uses an older id form; use that path for the rest of the run. Then:
   - File missing + `inputs.pass_kind` in `{auto, new}` → this is a **new review** (Pass 1)
   - File exists + `inputs.pass_kind` in `{auto, continuation}` → this is a **continuation** (Pass N+1 where N is current `pass_count`)
   - File missing + `inputs.pass_kind == continuation` → reject with: `No prior pr-review entry exists for <pr_url>. Run with pass_kind=new (or auto) for the first pass.`
   - File exists + `inputs.pass_kind == new` → reject with: `pr-review entry already exists at <path>. Use pass_kind=continuation (or auto) to append a pass, or delete the entry first.`

   **Response mode is always a continuation.** When `inputs.mode == response`, the entry must already exist — its comments are the thing being answered. File missing → reject with: `No pr-review entry exists for <pr_url> — nothing to answer. Run a review pass first, then pull comments.`

5. **Resolve `change_id` link** (sets the `change_id:` frontmatter field):
   - If `inputs.change` is set, use it directly (do NOT verify — surface as-is).
   - Else, search `vault/wiki/*/change/*.md` for an entry with `pr_url == <canonical pr_url from step 2>`. If exactly one matches, capture its `id`. If zero matches, leave `change_id` unset (external PR). If more than one matches, log a warning to the report ("multiple changes claim this PR"), pick the most recently `updated`, and continue.

6. **Resolve `repo` entity id** (sets the `repo:` frontmatter field):
   - If `change_id` is set, use that change's `repo` field.
   - Else, search `vault/wiki/*/entity/*.md` for `kind: repo` entities whose `remote_url` parses to `<owner>/<repo>`. If found, use that entity's id.
   - Else, set `repo: '<owner>/<repo>'` (raw string, no entity link). The audit will surface this as a "repo not ingested" suggestion.

7. **Load config** from `vault/wiki/development/reference/reference-pr-review-config.md` if present, else fall back to `vault/wiki/_seed/development/reference/reference-pr-review-config.md` (the shipped default — same live-first precedence as `pr-review-config.ts`). If neither exists, stop with: `pr-review config missing — restore vault/wiki/_seed/development/reference/reference-pr-review-config.md from upstream`. Parse frontmatter; capture:
   - `comment_style`
   - `comment_tone` (string; may be empty or absent — see the tone block below)
   - `focus_areas` (list)
   - `context_strategy` (v1: must be `full-diff`; reject anything else with a "not yet supported in v1" message)
   - `custom_instructions` (string; may be empty)

   **Comment tone.** The tone block applies to **every** comment body this skill writes, in both modes, on top of whatever `comment_style` asks for. Style sets length and depth; tone sets how it sounds — they stack, they don't compete. When `comment_tone` is set in config, use it verbatim. When it is empty or absent, use this default, verbatim:

   > Write PR review comments in friendly, conversational language, like one engineer talking to another. Use collaborative phrases such as: "Maybe we should…", "Could we…", "Should we…", "Do you think it would make sense to…", "I think this might…", "Would it be safer to…?". State confirmed behavior clearly, but phrase recommendations collaboratively. Explain the practical impact, suggest a fix, and mention a regression test when useful. Keep each comment to 2–5 sentences and avoid sounding formal, robotic, or accusatory.

   Capture the resolved text as `<comment_tone>` for step 11's prompt.

   **Note**: `primary_model` is NOT read from config. The model running this skill is whichever model the dispatcher resolved from Settings → Model (project default + per-skill override). Capture it from your own runtime context — your system prompt declares "The exact model ID is `<id>`" — and write that into the entry's `config.primary_model` field at step 12. Same convention as `dev-analyze-repo-for-review`'s `analyzer_model`. Don't infer the model id from the config file — it's not authoritative there.

   Compute `custom_instructions_hash`: if empty/null → `null`. Else `sha256(custom_instructions)`, first 12 hex chars. Implementation:

   ```bash
   echo -n "$instructions" | shasum -a 256 | cut -c1-12
   ```

8. **Fetch PR metadata** via the github MCP's `get_pull_request` tool:

   ```json
   {"owner": "<owner>", "repo": "<repo>", "pull_number": <n>}
   ```

   The custom github MCP (`mcps/github/server.mjs`) returns a **flat** shape — capture: `title`, `body`, `user_login` (author), `head_ref` (branch), **`head_sha` (the PR's current head commit — required by step 8a)**, `base_ref` (base), `merged`, `state`. There is no nested `head.ref`/`user.login`; the fields are flat, and this tool does NOT return `additions`/`deletions`/`changed_files`/`commits` — read those from the stats sub-step below.

   **Diff stats** (`get_pull_request` doesn't carry them) — read from the `gh` CLI (already a prerequisite):

   ```bash
   gh pr view <canonical_pr_url> --json additions,deletions,changedFiles,commits \
     --jq '{additions, deletions, files_changed: .changedFiles, commits: (.commits | length)}'
   ```

   Capture `additions`, `deletions`, `files_changed`, `commits` for the frontmatter + Stats block in step 12.

   If the MCP call fails with auth errors → surface `Run mcps/github/.env setup — see decision-github-mcp-custom-not-hosted.md` and stop.

8a. **Pre-flight: head_sha debounce (continuations only).** Mirrors the `meta-overseer-review` 24h-debounce pattern — same shape, content-based instead of time-based. Wasteful re-reviews against an unchanged commit are the dominant cost pattern in PR-review audits (`pr-review-re-runs-against-unchanged-head-sha` tag); this gate stops them before any LLM token is spent.

    Run this gate only when `pass_kind == continuation` (from step 4) AND `inputs.mode == review`. Skip entirely on Pass 1 (no prior pass to compare) and in response mode — a response pass answers comments, and an unchanged head is the normal case there, not a reason to skip. Blocking it would make questions unanswerable until someone happened to push a commit.

    - Read the existing entry's frontmatter `last_head_sha` field (written by step 12 on the prior pass — falls back to scanning the body for the last `## Pass N` block's recorded head SHA if the field is absent for entries created before this gate landed).
    - Compare against the current `head_sha` from step 8's PR metadata.
    - If they match AND `inputs.force != true` → **short-circuit with no-op**. Skip steps 9–14 entirely. JUMP TO step 15 to record the event (use `action_label = "no-op-head-sha-unchanged"` and `status = "success"` — this is a successful no-op, not a failure), THEN step 16 to confirm. The confirm message MUST include the hint for the orchestrator:

      ```
      ⊘ PR review skipped — head_sha unchanged from pass <N>
        prior pass head: <sha-7>
        current pr head: <sha-7>
        no new commit since last review; advance the orchestrator only after a new commit lands
        (override with force: true if config/focus_notes/custom_instructions changed
         and you genuinely want a fresh pass against the same commit)
      ```

      Do NOT write a new pass body, do NOT mutate the pr-review entry, do NOT call the model. The vault state is unchanged; the only side effect is the event row in step 15 (for traceability — every dispatch produces exactly one event).

    - Else (head_sha differs OR force=true) → set `gate_result = "proceed"` and continue with step 9.

    Steps 9–16 read `gate_result`; do NOT re-evaluate this gate later — by then step 12 may have written a new `last_head_sha` and the check would self-trip.

9. **Fetch the diff + annotate it.** Fetch to a temp file so the raw bytes survive for step 11a's validation, then produce the line-numbered form the review reads:

   ```bash
   TMPDIFF=$(mktemp)
   gh pr diff <canonical_pr_url> > "$TMPDIFF"
   node scripts/annotate-diff-lines.mjs < "$TMPDIFF"    # → annotated_diff (review reads THIS)
   ```

   Capture the raw diff (`$TMPDIFF` contents) as `raw_diff` and the annotator's stdout as `annotated_diff`. The annotated form is a **strict superset** of the raw diff — every body row is prefixed with its explicit `L<old>` (old-file) and `R<new>` (new-file) line numbers, so the review READS anchors off the columns instead of computing them from `@@` headers (the off-by-N source). **Keep `$TMPDIFF`** — step 11a validates the composed anchors against these same bytes.

   If `gh` is not authenticated, surface: `gh CLI not authenticated. Run \`gh auth login\` and re-run.`and stop. If the diff is empty (no-op PR), surface:`PR has no diff — nothing to review.` and stop without writing.

10. **Ensure the repo cache is fresh + load repo knowledge.** Two sub-steps:

    **a. Cache pull + PR-head worktree.** Invoke [[dev-cache-pr-review-repo]] with `pr: <canonical_pr_url>` **and `pr_head_worktree: true`**. The sub-skill owns its own 5-minute staleness gate for the base pull, materializes the PR head as a detached sibling worktree, and on the first-ever clone auto-triggers [[dev-analyze-repo-for-review]]. Back-to-back reviews on the same repo don't trigger redundant base fetches.

    Set `cache_path` (where step 11's code reads resolve) per the **degradation ladder**:
    - **Worktree materialized** (sub-skill reported `worktree: <created|reused|refreshed> <path>@<sha>`): `cache_path = .claude/state/pr-review-cache/<owner>/<repo>--pr-<n>` and `code_context = "PR head worktree @ <pr_head_sha-7>"`. Code reads now see the PR head — the same commit the diff anchors against.
    - **Worktree failed but base cache pulled** (sub-skill logged a `pr-worktree materialize failed` bullet): `cache_path = .claude/state/pr-review-cache/<owner>/<repo>` (base, on origin/HEAD) and `code_context = "base cache @ <base_head_sha-7> (degraded — worktree unavailable)"`. Surface a **loud warning** in the final report: reads reflect the base, not the PR head, so new-file / head-only context may be missing.
    - **Cache failed entirely** (network, private-repo auth, git not installed): `cache_path = null`, `knowledge_path = null`, `code_context = "diff-only"`. The review is **diff-only** — degraded but still useful. A degraded review beats no review when the cache is briefly broken.

    **Repo-knowledge (sub-step b) and the import graph (sub-step c) stay keyed to the BASE cache**, never the worktree — they describe the repo's origin/HEAD structure and `based_on_commit` / the import-graph walk are computed against it. Only step 11's raw code reads follow `cache_path` to the worktree.

    **b. Load repo knowledge.** Compute `knowledge_id = repo-knowledge-<owner>-<repo>` using step 3's exact normalization rule (lowercase, non-`[a-z0-9]` runs → `-`; the file on disk is e.g. `repo-knowledge-nfhbar-agentic-os.md` — underscore-preserving forms silently miss it). Check for `vault/wiki/development/repo-knowledge/<knowledge_id>.md`:
    - If present + `status: ready`: capture `knowledge_path` for step 11. Read it once into the model's context.
    - If present + `status: error` or `status: analyzing`: skip (treat as missing); flag in final report.
    - If absent: leave `knowledge_path = null`. Flag in final report: "no repo knowledge — convention judgments may be generic; consider /os analyze repo <owner>/<repo>".

    Knowledge absence is **not an error** — first reviews on a freshly-added external repo may race the analyze skill. The review proceeds against diff + cache files, just without prose conventions to guide it.

    **c. Load the import graph (if present).** Check the cache entry's frontmatter for `import_graph_path`. If set + the file exists, read it; otherwise skip this sub-step and treat `import_graph = null` (the IMPORT GRAPH block in step 11's prompt becomes "(unavailable)" and the model falls back to filename-only reasoning).

    The import graph is a sidecar JSON produced by `dev-cache-pr-review-repo` at cache-pull time via `scripts/extract-imports.mjs`. Shape:

    ```json
    {
      "files": {
        "<rel-path>": {
          "lang": "go|tsjs|py",
          "imports": ["<rel-path>", ...],
          "imported_by": ["<rel-path>", ...],
          "tests": ["<rel-path>", ...]
        }
      },
      "hubs": [{"file": "<rel-path>", "callers": <n>}, ...]
    }
    ```

    From the diff (step 9), extract the set of `touched_files` (file paths after the `+++ b/...` markers, normalized to repo-relative). For each touched file, look it up in `import_graph.files` and capture its `imports` / `imported_by` / `tests` arrays. Also compute `touched_hubs = touched_files ∩ hubs` so the prompt can flag hub-file changes prominently.

    Absence is **not an error** — graph extraction may have failed at cache time (unsupported language, etc.), or the cache may predate the import-graph feature. The review degrades gracefully to filename-only reasoning.

11. **Run the analysis.** Two modes, selected by `inputs.mode`. Mode A (`review`, the default) is below; Mode B (`response`) is step 11r and replaces this step entirely — a response pass never runs the find-new-issues prompt.

    **Mode A — review.** Compose a prompt to yourself (the model running this skill) with this structure. **The skeleton below is the contract; the knobs come from config.**

    ```
    You are reviewing the pull request below. Produce a list of review comments.

    REPO: <owner>/<repo>
    PR: #<n> — <title>
    AUTHOR: <pr_author>
    BRANCH: <head> → <base>

    PR DESCRIPTION:
    <pr_body>

    DIFF (annotated — read the RIGHT (new-file) and LEFT (old-file) line numbers off the `R`/`L` columns; NEVER compute an anchor from the `@@` header):
    <annotated_diff>

    CODE CONTEXT:
    - Code at <cache_path> (PR head worktree when available, else base cache on origin/HEAD, else "(unavailable — diff-only review)"). Read tool works on any file under it. Do NOT edit anything there — read-only by contract.
    - Repo knowledge at <knowledge_path> (or "(none — generic-judgment review)" if absent). Read this FIRST, before forming opinions on style, conventions, error handling, or testing patterns. It describes how THIS REPO does things — review by those standards, not generic best practices.
    When a convention is documented in the knowledge entry, prefer the repo's convention over your defaults. When the knowledge entry is silent on a topic, fall back to general principles + what you see in the cache.

    IMPORT GRAPH (touched files):
    <for each touched file, render one block — or "(unavailable — no import graph for this cache)" if step 10c had nothing to load>
        <touched-file-rel-path>
          imports:     <comma-list of imports, or "(none)">
          imported by: <comma-list of imported_by, or "(none — leaf / entry point)">
          tests:       <comma-list of tests, or "(none — no co-located tests detected)">

    HUBS IN THIS REPO (>3 callers, top 20):
    <render each hub as one line:>
        <hub-file-rel-path> (<callers> callers)<flag with " ← TOUCHED BY THIS PR" if file is in touched_hubs>
    <if hubs list is empty, render "(none above threshold)">

    Use the import graph as blast-radius context: when a touched file is imported by many others, review the changed behavior with extra care for backwards compatibility. When a touched file is itself a hub, treat that as a prompt to consider every downstream caller's assumptions. Tests adjacent to a touched file are the natural place to verify behavior — if the PR doesn't update those tests, flag it.

    PERSISTENT-STATE RULE: when the diff introduces persistent state (CREATE
    TABLE statements, a new on-disk file format, or a new long-lived in-memory
    cache with non-trivial lifetime), explicitly check what the codebase's
    existing rewind, migration, reorg, snapshot, and checkpoint machinery
    expect of persistent state, and whether the new state correctly extends
    those invariants. Surface the interaction in a comment even when the
    answer is "compatible" — silent compatibility assumptions are how
    rewind gaps ship.

    FOCUS AREAS: <comma-joined focus_areas from config>
    COMMENT STYLE: <comment_style from config>
    COMMENT TONE (applies to every comment body, on top of COMMENT STYLE):
    <comment_tone from step 7, verbatim>
    CUSTOM INSTRUCTIONS:
    <custom_instructions from config — included verbatim if non-empty, else "(none)">
    <if inputs.focus_notes is set: append a second line block:
        "Focus for this pass: <inputs.focus_notes>"
     — this overrides nothing in the config; it's additional targeted guidance
     supplied via the Re-analyze flow. If unset, omit this line entirely.>

    Output requirements:
    1. Produce zero or more comments. A clean PR with no concerns is a valid review — output zero comments and a Summary saying so.
    2. Each comment carries:
       - category: ONE of <focus_areas>
       - severity: ONE of nit | suggestion | bug | blocker
       - file: the path relative to the repo root (or null for PR-level comments)
       - line: the anchor line, READ off the annotated diff's R column (new file) — or the L column when the comment is about deleted code (then also set side: LEFT). For a finding that spans multiple lines, set line to the END line and start_line to the START line — both read off the columns, SAME side, SAME hunk, start_line < line. Use null for file-level / PR-level comments. Do NOT author range strings like "42-58"; emit line + start_line instead.
       - side / start_side: omit for the common RIGHT-side case; set side: LEFT only when anchoring to deleted (old-file) lines. start_side is only needed on the rare cross-side range and otherwise defaults to side.
       - quote: the exact code the comment is about, copied off the annotated diff at that anchor — the code only, with the L/R gutter and the leading +/-/space marker stripped. One line for a single-line anchor; for a range, the lines of the span joined with spaces. Bare text: no wrapping backticks, no ellipsis, no paraphrase, no commentary. Emit it on EVERY comment that carries a line; omit it only on file-level comments (line: null). Step 11a checks the anchor against this text — quoting the code is what turns "this line number is postable" into "this comment is about this code", and a quote you cannot copy off the diff means the anchor is wrong.
       - body: the comment text. Respect the COMMENT STYLE knob and the COMMENT TONE block.
    3. Suggest a `result` for the review overall: one of approved | request-changes | comment | none
       - approved: no blockers, optional suggestions only
       - request-changes: at least one blocker or bug-severity comment
       - comment: observations only, no action requested
       - none: zero comments produced
    ```

    Do the analysis. Produce comments matching the requirements.

11r. **Mode B — response.** Runs INSTEAD of step 11 when `inputs.mode == response`. The question is no longer "what is wrong with this PR" but "what did these people ask, and what is the honest answer". Hunting for fresh findings here is a failure: someone asked something and got a lecture instead of an answer.

     **Build the unanswered set.** Walk every pass in the entry (parsed in step 4's continuation branch — read the file if you haven't). A comment is a candidate when ALL of:
     - it lives in a pass whose config carries `- agent: external`, or it carries an `- author:` header (both mark text a person wrote, not the model);
     - its `status` is not terminal (`dismissed`, `resolved`, `wontfix`, and `acted-on` are already dealt with — leave them alone);
     - no comment anywhere in the entry carries `- in_reply_to:` pointing at it. That is the "already answered" test: the OS's own answer, published or still a draft, means the question is handled.

     If the unanswered set is empty, stop without writing a pass:

     ```
     ⊘ Nothing to answer — no unanswered external comments on <id>
       run dev-pull-pr-comments first if new comments landed on the PR
     ```

     Record the event (step 15) with `action_label = "no-op-nothing-to-answer"` and `status = "success"`, then confirm. This is a successful no-op, not a failure.

     **Compose the prompt.** Same CODE CONTEXT / IMPORT GRAPH / diff blocks as Mode A — answering well needs the same context reviewing does — with the analysis instruction replaced:

     ```
     People have commented on this pull request and are waiting for an answer.
     For each comment below, answer what was actually asked.

     UNANSWERED COMMENTS:
     <for each candidate, render one block:>
         ref:    pass-<N>-comment-<M>
         author: <author header, or "(unknown)">
         file:   <file>:<line-or-"file-level">
         asked:  <comment body verbatim>
         <when the comment is itself a reply, also render the parent it answers:>
         re:     pass-<N>-comment-<M> — <parent body verbatim>

     COMMENT TONE (applies to every reply body):
     <comment_tone from step 7, verbatim>

     CUSTOM INSTRUCTIONS:
     <custom_instructions from config — verbatim if non-empty, else "(none)">
     <if inputs.focus_notes is set: append "Focus for this response pass: <inputs.focus_notes>">

     Output requirements:
     1. Produce exactly one reply per comment you can answer, and none for the
        ones you cannot. Fewer honest answers beat one answer per comment.
     2. Each reply carries:
        - in_reply_to: the `ref` of the comment it answers — copied exactly.
        - file / line: mirrored from the comment being answered, so the entry
          renders the reply next to the code under discussion. The reply is
          routed by in_reply_to, never by the anchor.
        - body: the answer. Address what was asked; say plainly when the
          answer is "you're right, that's a bug" or "I was wrong about this".
     3. Answer from the code, not from the diff alone — read the files under
        CODE CONTEXT when the question is about behavior beyond the changed
        lines.
     4. When a comment asks for a change rather than an answer, say what will
        change and who will do it; do not edit code here.
     5. Produce NO new findings. A concern this pass surfaces that nobody asked
        about belongs in a review pass, not in someone's thread.
     6. Suggest NO overall result. A response pass has no verdict.
     ```

     Do the analysis. Produce replies matching the requirements.

11a. **Validate + snap every anchor (layer 1 — write time).** Skip in response mode — a reply's anchor is mirrored from the comment it answers and is display-only; `in_reply_to` is what routes it. Running the validator would snap replies onto lines nobody was talking about. Before formatting the entry, run the composed comments' anchors through the annotator's validator against the SAME raw diff bytes from step 9 (`$TMPDIFF`). Build a JSON array — one object per comment that has a `file` + non-null `line`, each carrying that comment's `quote` — and validate:

    ```bash
    node scripts/annotate-diff-lines.mjs --validate \
      --anchors '[{"id":"c1","file":"<file>","line":<line>,"start_line":<start_or_omit>,"side":"<LEFT_or_omit>","start_side":"<LEFT_or_omit>","quote":"<the quoted code>"}, ...]' \
      < "$TMPDIFF"
    ```

    **The validator confirms content, not just position.** A line number only says whether GitHub will accept an anchor there; the quote says whether that is the line the comment is about. So send the quote on every anchor that has one: the validator then confirms the code is at the claimed lines, or moves the anchor to where that code actually lives, or refuses the anchor outright. Matching is whitespace-normalized (indentation, re-wrapping, and internal spacing are ignored), so copy the code exactly as the diff shows it and don't fuss over alignment. An anchor sent without a quote gets position-only checking — the old behavior, where a comment can validate cleanly onto a line that has nothing to do with the finding.

    (File-level comments — `line: null` — are excluded from the array; they need no anchor.) The validator returns one verdict per anchor, plus a `quote` block when a quote was sent; apply each:
    - `valid` → keep the anchor as authored. With `quote.status: confirmed`, the quoted code is verified to be at those lines.
    - `snapped` → adopt the returned `line`, and the returned `start_line` when the anchor came back as a range. `quote.status: relocated` means the anchor moved to where the quoted code actually is (which supersedes nearest-line snapping and is not bounded by the ±3 window) — trust it over the line you authored, and re-read the diff there to confirm the comment still says the right thing about the code it landed on. Without a quote it is the old nearest-in-diff move within ±3 (tie → higher). Mention the shift in the comment body's first line only when it's material to the reader; otherwise adopt silently.
    - `degraded-to-endpoint` → adopt the returned single `line` (the range collapsed to its valid endpoint) and drop `start_line`. Keep the intended range in the body prose if it aids the reader.
    - `file-level` → the anchor can't be placed; read `reason` to know why. `quote-not-found` means the quoted code appears nowhere in the diff's commentable lines — usually the quote was paraphrased or reflowed (fix the quote off the annotated diff and re-validate), sometimes the comment is genuinely about code the diff doesn't contain. `beyond-snap-window` / `file-not-in-diff` mean the line or the file isn't in the diff at all. Either way: re-read the annotated diff you already hold and correct the anchor if you mis-read it; if the comment genuinely targets code outside the diff, convert it to file-level (`line: null`) and name the intended location in the body.
    - Any verdict carrying `quote.status: ambiguous` → the quoted code appears in several places and none of them is the claimed anchor, so content couldn't decide and the verdict fell back to position alone. Lengthen the quote (pull in the line above or below until the span is unique) and re-validate rather than shipping a coin-flip anchor.

    **No comment is written with an anchor the validator rejected**, and no comment is written with an anchor its own quote contradicts. This is the write-time half of the layered defense; [[dev-pr-review-publish]] re-validates against the LIVE head at publish time (layer 2), since the head may move between review and publish.

12. **Format the entry body.** Two cases:

    **Case A — New review (Pass 1)**: Compose the full file.

    ```markdown
    ---
    id: <pr-review-id>
    type: pr-review
    domain: development
    created: <ISO now>
    updated: <ISO now>
    tags: [review]
    source: dev-pr-review
    private: false
    title: 'PR Review: #<n> <pr_title>'
    pr_url: <canonical>
    pr_number: <n>
    repo: <repo_id_or_raw>
    change_id: <change_id_or_omit>
    pr_author: <author>
    branch: <head>
    base: <base>
    status: completed
    result: <suggested_result>
    started: <ISO_start>
    completed: <ISO_now>
    pass_count: 1
    last_head_sha: <head_sha from step 8>
    files_changed: <files_changed>
    additions: <additions>
    deletions: <deletions>
    commits: <commits>
    config:
      primary_model: <model id from your runtime context — see step 7 note>
      comment_style: <style>
      focus_areas: <list>
      context_strategy: full-diff
      custom_instructions_hash: <hash_or_null>
    ---

    # PR Review: #<n> <pr_title>

    ## Summary
    <one paragraph: overall assessment + counts by category, e.g. "Clean PR — 3 logic suggestions, 1 docs nit. Approved with optional follow-ups.">

    ## Pass 1 — <local_start>

    <!-- Pass header timestamp: format as user's local-TZ readable string,
         e.g. "Jun 2, 2026 1:53 PM PDT" — generated via `date -j -f
         '%Y-%m-%dT%H:%M:%SZ' '<ISO_start>' '+%b %-d, %Y %-I:%M %p %Z'` on
         macOS. Same rule as meta-status-report § "Timestamp formatting in
         BODY content": frontmatter stays ISO 8601 UTC (sortable, machine-
         parsed), body text uses local TZ (human-readable). The frontmatter
         `started:`/`completed:` fields below stay UTC. Per Task #406. -->


    ### Pass config
    - model: <model>
    - focus areas: <comma-joined>
    - style: <style>
    - code context: <code_context from step 10a — e.g. "PR head worktree @ a1b2c3d", "base cache @ e4f5a6b (degraded)", or "diff-only">

    ### Comments

    <for each comment, in order:>

    #### Comment <n>: <category> · <severity>
    - file: `<file_or_null>`
    - line: <line_or_null>
    - start_line: <start>        ← emit ONLY for a multi-line range (else omit this line entirely)
    - side: <LEFT>               ← emit ONLY when anchoring to the old (deleted) side (else omit)
    - start_side: <LEFT>         ← emit ONLY on the rare cross-side range (else omit)
    - quote: <code at the anchor> ← the validated quote from step 11a, bare on one line; omit only when line is null
    - status: new

    <comment body>

    <end for>

    ### Stats
    - files: <files_changed>
    - +<additions> / -<deletions>
    - commits: <commits>
    ```

    If zero comments: omit the `### Comments` section's items but keep the heading with an italic "_No comments — clean review._" line.

    **Case B — Continuation (Pass N+1)**: Edit the existing file.
    1. Read the existing entry. Parse frontmatter + body.
    2. Compute the new `pass_count = old + 1`. Capture old comments by `(file, line, body[:50])` signature for `prior:` linking — only for comments with `status: new` (resolved/dismissed are terminal).
    3. Update frontmatter:
       - `updated`: now
       - `status`: `completed`
       - `result`: new suggested result
       - `completed`: now
       - `pass_count`: new value
       - `last_head_sha`: `<head_sha from step 8>` — required for step 8a's debounce gate on the NEXT pass; without this the gate has no anchor and re-reviews against unchanged commits will recur
       - `files_changed`, `additions`, `deletions`, `commits`: refresh from step 8
       - `config.*`: re-snapshot (config may have changed between passes)
    4. Update the Summary (rewrite as: "Pass <N>: <new assessment>. <delta vs prior: e.g. '2 prior comments resolved, 1 new'>".)
    5. Append a new `## Pass <N>` section mirroring Case A's Pass 1 structure, with one addition: any new comment whose body matches an old comment's location gets `- prior: <old-comment-section-anchor>` (e.g. `- prior: pass-1-comment-3`).

    **Case C — Response pass (`inputs.mode == response`)**: Case B's mechanics with three differences, all of them about not pretending an answer is a judgment.
    1. **The verdict is suppressed.** Leave `result` in frontmatter exactly as the last review pass set it. Do not compute one, do not overwrite it, do not blank it. A pass that answers questions has said nothing about whether the PR should merge, and the last real verdict is still the truth. Record the suppression in the pass config so the entry is self-explanatory:

       ```markdown
       ### Pass config
       - model: <model>
       - mode: response
       - result: suppressed — response pass carries no verdict
       - style: <style>
       - code context: <code_context from step 10a>
       ```

    2. **Every comment is a reply.** Each is headed `#### Comment <n>: response · suggestion` (a reply is not a finding, so it takes neither a focus-area category nor a blocking severity) and carries `- in_reply_to: pass-<N>-comment-<M>` (the `ref` copied from step 11r's prompt, unchanged) plus the mirrored `file` / `line`, and `- status: new` like any other draft comment — a human still triages before it goes out. Emit no `start_line` / `side` / `start_side` / `quote`; a reply has no range and no anchor of its own — the mirrored `line` is display context, and quoting code would invite a validator that this pass deliberately skips. Emit no `prior:` — that field links re-raised findings across passes, and a reply re-raises nothing.

    3. **The Summary records the exchange, not an assessment.** Rewrite it as: `Pass <N> (response): answered <n> of <m> unanswered comment(s) from <comma-joined authors>.` Leave the prior pass's assessment prose intact below it if the Summary carries any — a response pass adds to the record instead of overwriting the review's conclusion.

    Everything else follows Case B: `pass_count`, `updated`, `completed`, `last_head_sha`, and the stats refresh all behave the same way.

13. **Write the file** via Write tool (new) or Edit tool (continuation). The directory `vault/wiki/development/pr-review/` may not exist on a fresh clone — `mkdir -p` first via Bash if writing new.

14. **Write back PR review summary onto the change entry — only when `change_id` is set** (the OS-authored PR flow). The pr-review entry holds the authoritative content; these four fields on the change are a roll-up so the change's PR tab + Lifecycle stepper can render review state without a second fetch. See [[archetype-change]] § "PR review fields".

    Read `vault/wiki/<domain>/change/<change_id>.md` and surgically update its frontmatter (Edit tool, NOT a full rewrite — preserve comments, ordering, and unrelated fields):

    | field              | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
    | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `pr_review_path`   | path to the pr-review entry from step 3 (e.g. `vault/wiki/development/pr-review/<id>.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
    | `pr_review_passes` | `<pass_n>` (current pass number from step 4 — 1 on new, N+1 on continuation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
    | `pr_review_status` | `needs-changes` when `<suggested_result>` is `request-changes` (the model flagged blockers); `approved` when `<suggested_result>` is `approved` or `comment` AND no comment on the just-written latest pass has `severity` in `{blocker, bug}` with a status still standing (i.e. not `resolved`/`dismissed`/`acted-on`/`wontfix`) — loop-state meaning "review clean, human comment-triage + Mark ready pending"; else `pending` (approving verdict but a blocker/bug-severity comment still stands — rare; also remains the legacy meaning "review ran, undistinguished"). This skill NEVER sets `ready-for-human` — that's `dev-mark-pr-ready`'s job. |
    | `pr_reviewed_at`   | now (ISO 8601 UTC)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
    | `updated`          | now (bump the change's own `updated` so freshness audits don't fire)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

    **In response mode**: write `pr_review_path`, `pr_review_passes`, and `updated` as usual, but leave `pr_review_status` and `pr_reviewed_at` untouched. Those two describe the standing verdict, and a response pass produced none — moving them would make an answer look like a fresh review of the code.

    **When `change_id` is null** (external PR — no change entry): skip this step entirely. The pr-review entry is the sole source of truth.

    **On failure** (change entry missing, permission error, etc.): log a warning in the final report and continue to step 15. The pr-review entry already exists and is the canonical record; missing the change writeback is a UX regression, not data loss.

15. **Record the event** via the dual-write wrapper:

    ```bash
    node scripts/record-dashboard-action.mjs \
      --action pr-review \
      --skill dev-pr-review \
      --args '{"pr":"<canonical_url>","change":"<change_id_or_null>","pass":<pass_n>,"mode":"<review_or_response>","result":<"<suggested_result>" in review mode, null in response mode>,"comment_count":<n>,"answered_count":<a in response mode, else omit>,"severity_breakdown":{"bug":<n>,"nit":<n>,"suggestion":<n>,"blocker":<n>},"category_breakdown":{"logic":<n>,"security":<n>,"performance":<n>,"style":<n>,"tests":<n>,"docs":<n>}}' \
      --files-touched '<["vault/wiki/development/pr-review/<id>.md", "vault/wiki/<domain>/change/<change_id>.md"] if change_id was set in step 14, else just the pr-review path>' \
      --exit-status 0
    ```

    The shared event-attribution helper picks up `change_id` from `args.change` (when set), so OS-tracked reviews land in `events.db` tagged to the owning change. External PR reviews land with `change_id: null`. The `files_touched` list reflects every vault file actually mutated this run — including the change entry when step 14 fired — so the manifest rebuild (auto-triggered by `record-dashboard-action.mjs` on any `vault/wiki/` path) catches both writes.

    **In response mode**: `result` is `null` (the pass carried no verdict — recording one would put a judgment in the timeline that was never made) and `answered_count` is how many comments got a reply. The breakdowns still describe the comments written this pass — all `response` category, all `suggestion` severity — so a response pass reads as answers in the metrics rather than as a fresh crop of findings.

    **`severity_breakdown` and `category_breakdown` semantics** — counts of THIS pass's comments grouped by their `severity` and `category` header fields respectively. These are aggregates of the comment headers you just emitted to the entry's body, NOT cross-pass totals. The dashboard's metrics endpoint reads these directly so it never has to body-parse historical reviews. Always emit all standard keys (zeros included) for clean SQL queries — but DO include any custom category labels the model produced (e.g. `"accessibility": 2`) as extra keys; the endpoint sums any non-standard categories into an `other` bucket.

16. **Confirm to user** with a tight report:

    ```
    ✓ PR review complete — <id> · pass <pass_n>
      pr:        <canonical_url>
      result:    <suggested_result>
      comments:  <n> (<by-category breakdown, e.g. "3 logic, 1 docs">)
      entry:     vault/wiki/development/pr-review/<id>.md
      change:    <change_id or "(external PR)">
      next:      <next-hint>
    ```

    `<next-hint>` depends on `<suggested_result>`:
    - `approved` → triage comments (Accept/Dismiss on the dashboard), then Mark ready — or re-review after new commits
    - `request-changes` → the Address-comments dispatch on the change's PR tab (dev-write-change address mode) or hand-edit and push
    - `comment` → review the comments at the entry path; act as appropriate
    - `none` → nothing to do

    Response-mode variant — no result line, because the pass produced no verdict:

    ```
    ✓ Responses drafted — <id> · pass <pass_n>
      pr:        <canonical_url>
      answered:  <a> of <m> unanswered comment(s) (<comma-joined authors>)
      unanswered: <one line per comment left without a reply, with why>
      entry:     vault/wiki/development/pr-review/<id>.md
      change:    <change_id or "(external PR)">
      next:      accept the replies you want sent, then publish — replies land in
                 their threads and post no verdict
    ```

## Inputs schema notes

- `pr`: required. URL or shorthand — see step 2 for parsing rules.
- `change`: optional override. When set, the skill skips the auto-link search in step 5 and uses this id verbatim.
- `pass_kind`: defaults to `auto`. Set explicitly only when you need to force a new entry over an existing one (`new`) or guarantee an append even on a missing file (`continuation` — will reject, since you can't continue what doesn't exist).
- `mode`: defaults to `review`. Set `response` to answer external comments instead of hunting for findings — the dashboard's Draft-response action dispatches with this. Response mode is always a continuation on an existing entry, ignores `pass_kind`, skips the head_sha debounce, and writes a pass with no verdict.

## Outputs

- A new or updated `pr-review` entry at `vault/wiki/development/pr-review/<id>.md` — a review pass in review mode, a verdict-free pass of `in_reply_to` replies in response mode
- When `change_id` is set: the linked change entry's five roll-up fields updated per step 14 (`pr_review_path`, `pr_review_passes`, `pr_review_status`, `pr_reviewed_at`, `updated`) — in response mode, only `pr_review_path`, `pr_review_passes`, and `updated`
- An `events.db` row with `kind: dashboard`, `action: pr-review`, `skill: dev-pr-review`, `change_id: <change?>`, `files_touched: [<entry-path>, <change-path when step 14 fired>]`
- GitHub-side comments are NOT posted here — publishing is [[dev-pr-review-publish]]'s job

## Errors

- `Invalid pr identifier: <input>` → fix the URL/shorthand format
- `MCP github not configured` → run `/os add-mcp` and add the github MCP (`mcps/github/` is the canonical setup)
- `GitHub MCP auth failed` → configure `mcps/github/.env` per `decision-github-mcp-custom-not-hosted.md`
- `gh CLI not authenticated` → run `gh auth login` and re-run
- `PR has no diff — nothing to review.` → not an error; idempotent stop
- `pr-review entry already exists` → pass `pass_kind: continuation` or delete the entry
- `No prior pr-review entry exists for <pr_url>` → pass `pass_kind: new` (or `auto`)
- `context_strategy "<value>" not yet supported in v1` → edit `reference-pr-review-config.md` to set `context_strategy: full-diff`
- `pr-review config missing` → neither the live nor the `_seed/` copy of `reference-pr-review-config.md` exists; restore from upstream
- `change <id> has no pr_url — run dev-open-pr first` → the change-only dispatch shape needs an open PR to resolve
- `No pr-review entry exists for <pr_url> — nothing to answer` → response mode needs an entry with comments in it; run a review pass, then [[dev-pull-pr-comments]]
- `Nothing to answer — no unanswered external comments` → not an error; idempotent stop in response mode

## What this skill must NOT do

- **Edit the reviewed PR's code.** This skill only reads diffs and writes review entries to the vault. Code mutations belong to dev-write-change's address-comments mode.
- **Post comments to GitHub.** Publishing is [[dev-pr-review-publish]]'s job. The vault entry is the authoritative source of the review until published.
- **Modify the change entry beyond step 14's five roll-up fields** (`pr_review_path`, `pr_review_passes`, `pr_review_status`, `pr_reviewed_at`, `updated`). The change's body, `status`, `review_status`, `branch`, `pr_url`, and everything else are owned by [[dev-write-change]] / [[dev-open-pr]].
- **Block on CI.** This skill reviews the diff; CI state is the [[runbook-pr-ci-monitor]]'s domain.
- **Run multiple model calls.** Single call, categorized output. See [[archetype-pr-review]] § Comments for why.
- **Emit a verdict from a response pass.** No `result`, no `pr_review_status` move, no review event downstream. Answering a question says nothing about whether the PR should merge.
- **Raise new findings in response mode.** A concern that surfaces while answering belongs in a review pass, where it gets an anchor and a severity — not appended to someone's question.
- **Answer a comment twice.** A comment with a reply already pointing at it is answered, draft or published. Re-answering makes the thread argue with itself.

## See also

- [[archetype-pr-review]] — the archetype this skill produces (the data contract)
- [[reference-pr-review-config]] — the singleton config this skill reads
- [[dev-cache-pr-review-repo]] — sub-skill invoked at step 10a to maintain the read-only repo cache used as code context
- [[archetype-pr-review-repo-cache]] — the cache archetype the sub-skill produces
- [[dev-analyze-repo-for-review]] — produces the Stage 2 prose knowledge consumed at step 10b
- [[archetype-repo-knowledge]] — the prose knowledge archetype loaded into the CODE CONTEXT block
- [[dev-open-pr]] — the upstream skill that creates the PR being reviewed
- [[dev-pull-pr-comments]] — ingests the external comments and author replies that response mode answers
- [[dev-pr-review-publish]] — sends the drafted replies into their GitHub threads; a replies-only publish posts no verdict
- [[archetype-change]] — the change this review may link to via `change_id`
- [[archetype-entity]] — repos this review may link to via `repo`
- [[standard-mcp-usage]] — calling MCP tools from a skill (pre-flight + naming + auth + errors)
- [[decision-github-mcp-custom-not-hosted]] — why the github MCP uses PAT, not OAuth
- `scripts/check-mcp.mjs` — pre-flight helper used in step 1
- `scripts/annotate-diff-lines.mjs` — deterministic diff line-numbering (step 9) + write-time anchor validate/snap (step 11a), including the quote layer that confirms a comment's code is where the anchor claims
- `scripts/record-dashboard-action.mjs` — event-recording wrapper used in step 15
