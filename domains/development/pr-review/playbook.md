---
domain: development/pr-review
version: 1
created: 2026-05-19T23:55:00Z
updated: 2026-05-19T23:55:00Z
---

# PR Review

## Purpose

PR review workflows. Read pull requests, run structured analysis, produce actionable reviews. The first OS-built sub-domain — proves the OS can extend itself end-to-end via the `meta-add-domain` and `meta-add-skill` scaffolders.

## Entities

- `entity` — repos this domain reviews (kind: `repo`)
- `reference` — external review guides, style guides
- `decision` — review heuristics worth documenting and reusing
- `project` — multi-PR efforts (e.g. a "migration review")

## Skills

- `dev-pr-review` — review a single pull request, produce a structured report

## Apps

(planned) `pr-review` app — visual dashboard for browsing reviews and their findings, with per-file annotations.

## Sub-domains

(none)

## Conventions

- Reviews land in `vault/output/development/pr-review/<owner>-<repo>-<num>.md`
- Repo-level knowledge stays in `vault/wiki/development/entity/` (per the parent domain's convention)
- Output slug format: `<owner>-<repo>-<num>` (lowercase kebab)

## Cross-domain links

- A review may produce decisions worth capturing under `[[development]]` or `[[research]]`
- Significant repos get tracked as `[[entity]]` in the parent development domain
