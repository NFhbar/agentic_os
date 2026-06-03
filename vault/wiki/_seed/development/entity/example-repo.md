---
id: example-repo
type: entity
domain: development
created: 2026-05-21T00:00:00Z
updated: 2026-05-21T00:00:00Z
tags: [example, seed, repo]
source: seed
private: false
name: Example repo (seed)
kind: repo
links: []
remote_url: https://github.com/example-org/example-app
local_path: /tmp/example-repo
default_branch: main
current_branch: main
language: typescript
build_command: npm install
test_command: npm test
ci: github-actions
license: MIT
ingested_at: 2026-05-21T00:00:00Z
ingestion_source: github
---

# Example repo (seed)

## Purpose

A **synthetic** `kind: repo` entity that ships with the OS as a worked example. It is referenced by [[change-example-debounce]] so newcomers can see the full **change → repo** composition shape without first having to ingest a real repository.

This entry's `local_path` points at a directory that does not exist on disk. **Do not run `dev-write-change` against changes linked to this repo** — the EXECUTE phase will fail when it tries to `cd` into `/tmp/example-repo`.

## Stack

- **Language:** TypeScript (illustrative)
- **Build:** `npm install`
- **Test:** `npm test`
- **CI:** github-actions
- **License:** MIT

## Structure

```
src/
  search/
    Input.tsx
    __tests__/
  components/
  lib/
tests/
package.json
```

(Illustrative only — no real files behind this layout.)

## Entry points

- `src/index.tsx` — app bootstrap
- `src/search/Input.tsx` — the search component referenced by the seed change

## Conventions

- **Code style:** biome
- **Tests:** vitest in `src/**/__tests__/`
- **Commits:** conventional commits

## Development workflow

```bash
npm install
npm test
npm run dev
```

## Replacement guidance

To make this seed real, the typical path is: `/os ingest repo <your-actual-url>` produces a sibling entity at `vault/wiki/development/entity/<your-slug>.md`. The seed `example-repo` then becomes the template you compare against rather than a thing you operate on.

## Links

- [[change-example-debounce]] — the seed change that targets this repo
- [[standard-repo-ingestion]] — the canonical contract this entry illustrates
