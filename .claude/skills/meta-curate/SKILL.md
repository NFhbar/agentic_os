---
name: meta-curate
description: Promote items from vault/raw/ into structured wiki/ entries with archetype frontmatter
user-invocable: true
version: 1
domain: meta
tags: [memory, curation]
inputs:
  source_path:
    type: string
    required: false
    description: Specific raw file to curate. If omitted, processes the pending-curation queue.
outputs:
  - kind: wiki-entry
    description: One or more new entries under vault/wiki/<domain>/<archetype>/
---

# meta-curate

## Purpose

Promote unstructured content from `vault/raw/` into typed `vault/wiki/` entries with proper archetype frontmatter and provenance. Either processes a specific file or works through the pending-curation queue at `.claude/state/pending-curation.txt`.

## Procedure

1. Determine sources:
   - If `source_path` is given, process just that file
   - Otherwise read `.claude/state/pending-curation.txt` (one path per line) and iterate
2. For each source:
   a. Read content
   b. Classify by content:
   - URL or link → `reference`
   - Decision text ("we chose X because Y") → `decision`
   - Person/project/repo description → `entity`
   - Step-by-step procedure → `runbook`
   - Initiative with goals + status → `project`
   - Else → `note`

   **Telemetry is NEVER promoted to wiki** (Finding 5.2; OS.md layer contract: "vault holds knowledge … events.db holds telemetry"). Scheduler/run output (`scheduled-runs.jsonl`, run journals, tick logs, CI-poll results) does not become a date-bucketed note — events.db and the raw JSONL already hold the data, and restating it adds token noise to search while telling future sessions nothing. When a telemetry source surfaces in the queue:
   - If it reveals a DURABLE pattern (a recurring failure mode, an idiom worth naming, a design gap) → fold that observation into an existing pattern/retrospective note or the owning project's note — analysis, not event restatement, and never a date-bucketed id.
   - Otherwise → drop it from the queue (step 6) without creating an entry; archive the raw file if asked.
     The audit enforces this as `note-run-telemetry` (WARNs on `type: note` entries with a `.jsonl` source AND a date-bucketed id).
     c. Suggest a domain (use source path or content cues). If ambiguous, AskUserQuestion with 2-3 options. `Headless: default(highest-confidence domain)` — pick the highest-confidence domain and record the auto-decision per item in the run report; when no domain can be assigned with any confidence (genuinely unclassifiable), park the item via the needs-review path in Errors instead of guessing.
     d. Suggest a slug (kebab-case derived from title or first heading)
     e. Present the proposed archetype, domain, slug, and title to the user via AskUserQuestion. Allow corrections. `Headless: default(proceed with the proposed archetype/domain/slug/title)` — proceed with the proposal and record the four auto-decisions per item in the run report.

3. Read `_templates/wiki-entry/<archetype>.md.tmpl`.
4. Render with substitutions:
   - `{{slug}}`, `{{domain}}`, `{{datetime}}`, `{{source}}` (the raw path), archetype-specific fields
   - For body content: extract from the raw file rather than leaving TODO placeholders
5. Write to `vault/wiki/<domain>/<archetype>/<slug>.md`.
6. Remove the processed line from `.claude/state/pending-curation.txt`. If this raw path had a key in `.claude/state/curation-needs-review.json` (a prior park now resolved), delete that key — the sidecar is mutable state, so a successful curation clears any stale park.
7. AskUserQuestion: archive the raw file? If yes, move to `vault/raw/.archived/<date>/`. `Headless: default(archive)` — archive to `vault/raw/.archived/<date>/` (what the Curation dispatch prompt has always instructed); record the archive per item in the run report.
8. Audit log.

## Outputs

- New wiki entries with full frontmatter and provenance
- Cleaned pending-curation queue
- Optionally archived raw files
- On headless runs, a run-report summary enumerating **every** `default(...)` auto-decision (domain / proposal / archive, per item) and — under a `⚠ Parked for review` heading — every item parked to `.claude/state/curation-needs-review.json` with its reason, so no headless auto-decision is silent (the `default(...)` recording contract from [[standard-skill-format]] § "Headless behavior")

## Errors

- Source unreadable → leave in queue, log
- Existing target path (interactive) → ask before overwriting. `Headless: park (per item)` — NEVER overwrite in a headless run: leave the queue line intact, write the item into the needs-review sidecar (below) keyed by its raw path with reason `target-exists: <target>`, continue with the remaining items, and list every parked item under the `⚠ Parked for review` heading in the run report.
- Cannot classify confidently (interactive) → present options / ask. `Headless: park (per item)` — same per-item park into the needs-review sidecar with reason `unclassifiable: <one-line why>`. This replaces the former undefined `[needs-review]` queue-line marker, which corrupted the one-path-per-line queue contract.

### The needs-review sidecar

Parked items are recorded out-of-band in `.claude/state/curation-needs-review.json` — a single JSON object keyed by raw-file path, each value `{ "reason": "<why parked>", "at": "<ISO 8601 UTC>" }`. This is **mutable state, not a log**: on a re-attempt overwrite the key; when an item is later curated successfully, delete its key (step 6). It takes the keyed-object shape of `.claude/state/schedule-runs.json` (the existing mutable-state precedent under `.claude/state/`), NOT append-only JSONL — the JSONL convention is reserved for actual logs.

**Accepted race (no locking).** The sidecar is read-modify-write JSON with no lock, and the Curation app dispatches per-item runs — so unlike `schedule-runs.json`, whose sole writer is the scheduler, two concurrent headless curations that both park (or one parking while another clears) can last-writer-wins clobber a key. The blast radius is bounded and self-healing: a lost park reappears on the item's next curation attempt, and a stale key clears on the next successful curation of that path — so single-writer is the assumed-common case, not a guarantee.

The pending-curation queue file stays strictly one-path-per-line: the dashboard's Ignore filter matches exact lines and meta-brief's mtime walk unions queue lines with a disk scan, so a line mutated to `<path> [needs-review]` would become an unreadable phantom and break Ignore. The marker therefore lives only in the sidecar, never on the queue line. [[meta-brief]] surfaces the sidecar count alongside the pending-curation count so parked items stay visible.
