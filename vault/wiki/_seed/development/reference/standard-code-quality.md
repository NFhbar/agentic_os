---
id: standard-code-quality
type: reference
domain: development
created: 2026-05-21T23:55:00Z
updated: 2026-05-21T23:55:00Z
tags: [standard, code, quality, conventions]
source: manual
private: false
title: Code quality standard
url: internal://standard/code-quality
kind: doc
last_verified: 2026-05-21
---

# Code quality standard

Universal guidelines that apply to every code change in every repo this OS works with. Repo-specific overrides (stack-specific lint rules, framework idioms) live in the repo's entity entry under `## Conventions` and take precedence over this standard where they conflict — but the standard is the floor.

Consumed by [[dev-write-change]] (PLAN composes plans that respect this; EXECUTE follows it during edits) and [[dev-review-change]] (rejects plans/PRs that violate without rationale).

## 1. Code shape

- **Idiomatic for the language.** Match the conventions a native speaker of the language would use. Go: `gofmt`, error wrapping with `fmt.Errorf("...: %w", err)`, no unused imports. TypeScript: project's tsconfig + lint config. Python: PEP 8 + the project's formatter (ruff/black). When in doubt, read neighboring code and match.
- **Reuse before introducing.** Before writing a new utility, check the repo for an existing one. The repo's lib/ / utils/ / shared/ directory is the first place to look. If a similar function exists, extend or compose it rather than duplicating.
- **Small, focused units.** Functions do one thing. Files have one concern. If a single function exceeds ~50 lines or accumulates a third concern, split it.
- **Prefer composition over inheritance.** Even in OO languages where inheritance is idiomatic, default to composition for new code unless the repo's existing patterns are inheritance-heavy.

## 2. Dependencies

- **Default to the standard library.** Before reaching for a third-party package, check whether the standard library has the primitive you need. `time`, `sync`, `net/http`, `database/sql` in Go; `pathlib`, `dataclasses`, `concurrent.futures` in Python; etc.
- **Adding a new package requires justification.** Either explicit user approval at plan time, or a rationale captured in the plan's §Risk section explaining why no in-repo / stdlib option works. Never add a dep "just in case" or because it's familiar.
- **Pin versions deliberately.** When a new dep is approved, pin to a specific version (not `latest`, not `*`). Note the version choice in the plan.
- **Watch transitive size.** If a new direct dep pulls in dozens of transitive deps, surface this as a §Risk — the plan should acknowledge supply-chain expansion.

## 3. Backwards compatibility

- **No breaking changes by default.** Public APIs, exported types, CLI flags, config schemas, file formats, on-disk state — all of these have consumers (possibly outside this repo). Treat them as load-bearing.
- **If a breaking change is necessary**, the plan's §Risk section MUST: (a) explicitly identify every known consumer, (b) describe the migration path, (c) justify why an additive alternative isn't feasible.
- **Additive > destructive.** Add new fields / flags / variants. Mark old ones deprecated. Remove only in a separate later change once consumers have migrated.
- **Schema changes** to databases, configs, or persisted state require explicit migration steps in the plan's Approach — never assume the change is auto-reversible.

## 4. Security

- **Never commit secrets.** No API keys, passwords, tokens, private keys in code or commits. Use environment variables, secret managers, or `.env` files (which must be gitignored).
- **Validate at trust boundaries.** User input, external API responses, file contents from untrusted sources — all must be validated before use. Internal-to-internal code can trust internal contracts.
- **Don't disable security checks.** No `--no-verify` on commits, no `--insecure` on HTTP clients, no `eval()` on untrusted input, no SQL string-concat (parameterize). If a security check is genuinely wrong for the use case, raise it explicitly in the plan's §Risk section — don't silently bypass.
- **Match the repo's existing auth/permission patterns.** Don't introduce a new auth mechanism alongside an existing one — extend the existing one or surface the deviation in §Risk.

## 5. Tests

- **Code changes ship with tests** when the repo has a test framework. Behavior added → tests asserting the behavior. Behavior changed → tests updated. Bug fixed → regression test that reproduces the bug pre-fix.
- **Match the repo's test conventions.** Same framework, same file layout (`_test.go` siblings vs `__tests__/` directory vs `tests/` top-level), same naming patterns. Read existing tests before writing new ones.
- **Don't lower coverage.** If the repo has high coverage, your change shouldn't drop it. If coverage is uneven, match the level around the code you're touching.
- **Don't introduce coverage where none exists** as a side-effect of an unrelated change. That's a separate change.
- **All tests pass before commit.** The EXECUTE phase runs the repo's `test_command` from the entity entry. Tests failing = the change isn't done, regardless of how complete the implementation looks.
- **Test types depend on the change** — pure logic: unit. Integration with DB / network / filesystem: integration. UI changes: visual or interaction tests if the framework supports them.

## 6. Comments

- **Default to no comments.** Well-named identifiers, small functions, and clear control flow do the documenting. If you find yourself writing a comment to explain WHAT code does, refactor the code first.
- **Only comment WHY when non-obvious.** A hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a future reader.
- **Never reference current context.** No `// added for issue #123`, `// fixes the X flow`, `// used by Y`. That information rots; it belongs in the commit message or PR description, not the code.
- **No section banners.** `// ====== HELPERS ======` adds noise. File and function organization should make this implicit.
- **Doc-comments only for public APIs** that ship to consumers. Internal helpers don't need them.

## 7. Repo convention adherence

- **Read the repo's entity entry** at `vault/wiki/<domain>/entity/<repo>.md` before starting. The `## Conventions` section captures repo-specific overrides: code style tool, test framework, commit style, deployment quirks.
- **Match neighboring code style** when the repo doesn't have explicit conventions — look at 3 files near the change and adopt their patterns.
- **Don't reformat unrelated code.** A bug fix shouldn't touch 50 files of formatting. Keep the diff scoped to the change.
- **Follow the repo's commit conventions** — see [[standard-git-hygiene]].

## 8. When in doubt

Surface the question in the plan's §Risk section explicitly rather than guess. The reviewer can answer it before EXECUTE proceeds. Cost of asking < cost of getting it wrong silently.

## See also

- [[standard-git-hygiene]] — branch + commit + PR conventions (the workflow side of code quality)
- [[standard-change-workflow]] — the change lifecycle this is consumed by
- [[dev-write-change]] · [[dev-review-change]] — the skills that consume this
- [[archetype-entity]] — repo-specific overrides live in the entity entry's `## Conventions` section
